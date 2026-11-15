"""Announcer page feed: sends a small update twice a second to the VSPEED relay (a Cloudflare Worker), which hands
it to every announcer who has the show's link open in a browser. Data only goes out: nothing comes back in.

Light on purpose: it runs in its own thread, sends only what the announcer page shows, skips updates that haven't
changed (but still sends one every 10 s so the page knows the feed is alive), gives up on an update after a few
seconds rather than wait, and backs off when the relay can't be reached. It never holds up the overlay.

In a league race, the driver on camera also gets their season in that series (stats, championship place and points)
and their own info (bio, team, sponsor, hometown) from the league site's public pages (SiteInfo, below).

Setup (control panel, Setup tab): switch it on. The producer code that lets this PC send to the relay
("https://<relay>/k/<show>.<signature>") comes from the league site (GLR HUB) with this PC's sign-in, one show per
producer (Nov 2026; before, it was made on the relay's /admin page and pasted in). It's saved, so the feed keeps going
if the site can't be reached later. The announcer link is https://<relay>/a/<show>/<view code>; the view code is made
here, and "New link" makes another one, which turns the old links off.
"""
import http.client
import json
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

import incidents
import leagueupload
import net
import standings

DEFAULTS = {"on": False, "code": "", "token": "", "notes": "", "notesAt": 0}
SEND_EVERY = 0.5           # seconds between updates (twice a second)
HEARTBEAT = 10.0           # send even when nothing changed, at least this often
TIMEOUT = 5.0              # give up on one update after this long
MAX_INC = 12               # incidents on the page
MAX_STANDINGS = 20
CODE_RETRY = 120           # after the league site didn't give the producer code: wait this long before asking again

STATUS = {"state": "off", "viewers": 0, "error": "", "link": "", "sentAt": 0, "sent": 0}
_lock = threading.Lock()


def parse_code(code):
    """'https://relay.example/k/glr-cup.SIG' -> ('https://relay.example', 'glr-cup', 'glr-cup.SIG') or None."""
    m = re.match(r"^\s*(https?://[^/\s]+)/k/([a-z0-9][a-z0-9-]{0,39})\.([A-Za-z0-9_-]{16,64})\s*$", str(code or ""))
    if not m:
        return None
    return m.group(1), m.group(2), "%s.%s" % (m.group(2), m.group(3))


def new_token():
    return secrets.token_urlsafe(12)


def link_for(cfg):
    p = parse_code(cfg.get("code"))
    if not p or not cfg.get("token"):
        return ""
    return "%s/a/%s/%s" % (p[0], p[1], cfg["token"])


# ---------------------------------------------------------------- what the page gets
def _col(header, *names):
    low = [str(h).strip().lower() for h in header]
    return next((low.index(n) for n in names if n in low), -1)


def build(live, settings, on_air, site=None):
    """The update for the announcer page: only what it shows, with short keys. site: a SiteInfo, for the on-camera
    driver's season and bio."""
    live = live or {}
    cars_in = live.get("cars") or []
    is_race = bool(live.get("isRace"))
    flag = live.get("flag") or ""
    quiet = flag in ("caution", "pace", "red") or (live.get("sessionState") or 0) >= 5
    fastest = min((c.get("best") or 0 for c in cars_in if (c.get("best") or 0) > 0), default=0)
    cam_idx = live.get("camCarIdx")
    cars, cam = [], None
    for c in cars_in:
        iv = c.get("interval") or ""
        iv = "" if iv == "LEADER" else iv
        last, best = c.get("last") or 0, c.get("best") or 0
        out = (c.get("outReason") or "") if (c.get("outReason") or "Running").lower() != "running" else ""
        row = {
            "p": c.get("pos"), "n": c.get("num", ""), "d": c.get("name", ""),
            "g": c.get("gap") or "", "iv": iv, "ld": bool(c.get("lapsDown")),
            # red interval: within half a second, green flag, not on pit road (same rule as live timing)
            "ic": bool(is_race and not quiet and c.get("intS") is not None and c["intS"] <= 0.5 and not c.get("pit") and iv and "LAP" not in iv),
            "led": c.get("lapsLed") or c.get("led") or 0,
            "l": c.get("lastStr") or "", "b": c.get("bestStr") or "",
            "lc": "ob" if last > 0 and fastest and abs(last - fastest) < 0.0005 else ("pb" if last > 0 and best and abs(last - best) < 0.0005 else ""),
            "ob": bool(best > 0 and fastest and abs(best - fastest) < 0.0005),
            "st": c.get("stops") or 0, "sp": c.get("lapsSincePit"), "lp": c.get("lastPit"),
            "gn": c.get("gained"), "pit": bool(c.get("pit")), "bf": bool(c.get("blackFlag")), "mb": bool(c.get("meatball")),
            "out": out[:16], "cam": c.get("idx") == cam_idx,
        }
        cars.append(row)
        if row["cam"]:
            cam = {"p": row["p"], "n": row["n"], "d": row["d"]}

    # incidents of this session, newest first; caution count from the same list
    snap = incidents.snapshot()
    types = dict(snap.get("types") or [])
    this = [e for e in snap.get("list") or [] if e.get("sess") == live.get("sessNum", 0) and e.get("sessName") == live.get("sessionName", "")]
    inc = [{"lap": e.get("lap"), "k": e.get("type"), "type": types.get(e.get("type"), e.get("type")), "num": e.get("num") or "",
            "name": e.get("name") or "", "d": (e.get("detail") or "")[:80]}
           for e in reversed(this) if e.get("type") != "pit"][:MAX_INC]
    cautions = sum(1 for e in this if e.get("type") == "caution")

    lp = None
    lpv = live.get("livePoints") or {}
    if lpv.get("ok") and lpv.get("rows"):
        lp = {"title": lpv.get("title") or "Live points", "line": lpv.get("lineAfter", -1),
              "rows": [{"p": r.get("pos"), "n": r.get("num"), "d": r.get("name"), "pts": r.get("pts"), "cut": r.get("cut") or "",
                        "status": r.get("status"), "racing": bool(r.get("racing"))} for r in lpv["rows"][:40]]}

    st = None
    try:
        data = standings.eligible_data()         # excluded drivers left out
        header, rows = data.get("header") or [], data.get("rows") or []
        pi, ni, di, ti = _col(header, "pos"), _col(header, "#", "no", "num", "car"), _col(header, "driver"), _col(header, "pts", "points")
        if rows and di >= 0:
            g = lambda r, i: r[i] if 0 <= i < len(r) else ""
            with standings.STATE_LOCK:
                title = standings.STATE.get("title")
            st = {"title": title or "Standings",
                  "rows": [[g(r, pi) or k + 1, g(r, ni), g(r, di), g(r, ti)] for k, r in enumerate(rows[:MAX_STANDINGS])]}
    except Exception:
        st = None

    # the on-camera driver's season in this series and their own info, from the league site (nothing when it isn't known)
    if cam and site is not None:
        cam_car = next((c for c in cars_in if c.get("idx") == cam_idx), {})
        info = site.get(live.get("leagueId"), cam_car.get("custId"))
        if info:
            cam["x"] = info

    a = settings.get("announcer") or {}
    return {
        "v": 1, "series": settings.get("raceName") or "", "track": live.get("track") or "",
        "sess": {"name": live.get("sessionName") or "", "type": live.get("sessionType") or "", "race": is_race,
                 "state": live.get("sessionState") or 0, "lap": live.get("lap") or 0, "total": live.get("totalLaps") or 0,
                 "final": live.get("finalLap") or 0, "ot": bool(live.get("overtime")), "flag": flag, "otg": bool(live.get("oneToGreen")),
                 "time": live.get("timeRemain") or "", "cautions": cautions, "replay": bool(live.get("isReplay")),
                 "live": bool(live.get("connected"))},
        "cam": cam, "air": [n for n in on_air() if n not in ("VSPEED logo", "League logo", "Ticker")],
        "wx": live.get("weather"),
        "cars": cars, "inc": inc, "lp": lp, "st": st,
        "notes": {"text": (a.get("notes") or "")[:600], "t": a.get("notesAt") or 0},
    }


# ---------------------------------------------------------------- the on-camera driver, from the league site
SITE = leagueupload.SITE      # the league site (GLR HUB); VSPEED_SITE points it at a test copy
SEASON_EVERY = 600         # season stats and standings: looked up again every 10 minutes (they change once a race)
DRIVER_EVERY = 1800        # a driver's own info (bio, team, sponsor, hometown): kept for 30 minutes
SERIES_EVERY = 3600        # which iRacing league is which series on the site
RETRY = 120                # after the site didn't answer: wait this long before asking again
SITE_TIMEOUT = 10
BIO_MAX = 1000             # the site's own limit
MAX_CARDS = 64             # drivers' cards sent to the page (a full field)
FIELD_AT_ONCE = 4          # other drivers' own info looked up per pass ...
FIELD_PAUSE = 3            # ... with this many seconds between passes, so the site is never flooded
CARDS_MIN = 10.0           # the cards go to the relay at most this often (they change when the site's numbers do) ...
CARDS_EVERY = 120.0        # ... and at least this often while the feed is on, in case the relay lost them


def _num(v, nd=1):
    return round(v, nd) if isinstance(v, (int, float)) else None


def season_line(stats_row):
    """The site's season stats for one driver -> the short form the page shows."""
    r = stats_row or {}
    return {"st": r.get("starts") or 0, "w": r.get("wins") or 0, "t5": r.get("top5") or 0, "t10": r.get("top10") or 0,
            "po": r.get("poles") or 0, "as": _num(r.get("avgStart")), "af": _num(r.get("avgFinish")),
            "led": r.get("lapsLed") or 0, "dnf": r.get("dnf") or 0}


def championship(standings, cust):
    """The site's standings -> {pos, pts, behind[, round]} for one driver, {out: round} once they're out of the
    playoffs, or None when they aren't in them. In the playoffs, the place in the current round."""
    for g in (standings or {}).get("groups") or []:
        po = g.get("playoffs") or {}
        if po.get("started"):
            cur = po.get("current") or {}
            rows = cur.get("rows") or []
            for i, r in enumerate(rows):
                if r.get("custId") == cust:
                    lead = rows[0].get("points") if rows else None
                    return {"pos": r.get("pos") or i + 1, "pts": r.get("points"), "round": cur.get("name") or "",
                            "behind": (lead - r["points"]) if isinstance(lead, (int, float)) and isinstance(r.get("points"), (int, float)) else None}
            for r in po.get("eliminated") or []:
                if r.get("custId") == cust:
                    return {"out": r.get("outIn") or "the playoffs"}
            continue                 # not in the playoff field: no place to show
        for i, r in enumerate(g.get("regular") or []):
            if r.get("custId") == cust:
                return {"pos": r.get("pos") or i + 1, "pts": r.get("points"), "behind": r.get("behind")}
    return None


# ---------------------------------------------------------------- a driver's card: the season in a few lines
# Nov 15, 2026 (F.O.E. Grand National, Round of 12): announcers wanted each driver's season in words and what they
# need in the playoffs, not only the numbers. The lines are put together here from the site's numbers, by fixed rules:
# they only say what the numbers say (no crashes, no rivalries), so nothing made up can reach an announcer.
_WORDS = ("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten")


def _word(n):
    return _WORDS[n] if 0 <= n <= 10 else str(n)


def _ord(n):
    n = int(n)
    return "%d%s" % (n, "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def _plural(n, one, many=None):
    return "%s %s" % (_word(n), one if n == 1 else (many or one + "s"))


def _cap(s):
    return s[:1].upper() + s[1:]


def _whole(v):
    return int(v) if isinstance(v, (int, float)) and float(v).is_integer() else v


def _finishes(standings, cust):
    """A driver's finishing positions this season, in race order, from the site's standings. In the playoffs the
    round's row has the whole season; otherwise the regular season's."""
    for g in (standings or {}).get("groups") or []:
        po = g.get("playoffs") or {}
        rows = list((po.get("current") or {}).get("rows") or []) + list(po.get("eliminated") or []) + list(g.get("regular") or [])
        for r in rows:
            if r.get("custId") == cust and r.get("finishes"):
                return [f for f in r["finishes"] if isinstance(f, int) and f > 0]
    return []


def _regular_champion(standings, cust):
    for g in (standings or {}).get("groups") or []:
        if (g.get("playoffs") or {}).get("started"):
            for r in g.get("regular") or []:
                if r.get("custId") == cust:
                    return r.get("pos") == 1
    return False


def blurb(row, finishes=None, led_rank=0, regular_champion=False):
    """The season in two to four short sentences, from the site's season stats for one driver and their finishes in
    race order. led_rank: 1 when nobody in the series has led more laps, 2 for the second most."""
    r = row or {}
    st, w, t5, t10 = (int(r.get(k) or 0) for k in ("starts", "wins", "top5", "top10"))
    if not st:
        return ""
    fin = [f for f in finishes or [] if isinstance(f, int) and f > 0]
    best = int(r.get("best") or (min(fin) if fin else 0) or 0)
    starts = "%d start%s" % (st, "" if st == 1 else "s")
    streak = 0                                   # wins in a row, up to the latest start
    for f in reversed(fin):
        if f != 1:
            break
        streak += 1
    out = ["Regular season champion."] if regular_champion else []
    if w >= 2:
        out.append("%s wins in %s%s." % (_cap(_word(w)), starts,
                                         "" if streak < 2 else ", all of them" if streak == st else ", including the last %s" % _word(streak)))
    elif w == 1:
        out.append("One win in %s, and no other top five." % starts if t5 == 1 else
                   "One win in %s, with %s." % (starts, _plural(t5, "top five")))
    elif t5:
        times = fin.count(best)
        out.append("No wins in %s. Best finish is %s%s, with %s." % (
            starts, _ord(best) if best else "a top five", "" if times < 2 else ", twice" if times == 2 else ", %s times" % _word(times),
            _plural(t5, "top five")))
    elif t10:
        out.append("%s in %s, but no top five.%s" % (_cap(_plural(t10, "top 10")), starts, " Best finish is %s." % _ord(best) if best else ""))
    else:
        out.append("No top 10s in %s.%s" % (starts, " Best finish is %s." % _ord(best) if best else ""))
    # up to two things that stand out
    led, poles, dnf = int(r.get("lapsLed") or 0), int(r.get("poles") or 0), int(r.get("dnf") or 0)
    facts = []
    if led and led_rank in (1, 2):
        facts.append("Has led %d lap%s, the %s in the series." % (led, "" if led == 1 else "s", "most" if led_rank == 1 else "second most"))
    if poles:
        facts.append("%s." % _cap(_plural(poles, "pole")))
    if st >= 4 and t10 >= max(4, st - 1) and (w or t5):
        facts.append("Top 10 in every start." if t10 == st else "Top 10 in %d of %d starts." % (t10, st))
    if dnf >= 2:
        facts.append("%s." % _cap(_plural(dnf, "DNF")))
    if not led and st >= 3:
        facts.append("Hasn't led a lap.")
    out += facts[:2]
    # how it's going lately
    if len(fin) >= 3 and streak < 2:
        out.append("Won last time out." if streak == 1 else
                   "Last three finishes: %s, %s and %s." % tuple(_ord(f) for f in fin[-3:]))
    return " ".join(out)


def tonight(standings, cust):
    """What a playoff driver needs, before the race: (the line, points to the cut line or None). ("", None) for a
    driver who isn't in the current round, or when the round is over."""
    for g in (standings or {}).get("groups") or []:
        po = g.get("playoffs") or {}
        if not po.get("started"):
            continue
        cur = po.get("current") or {}
        rows = cur.get("rows") or []
        r = next((x for x in rows if x.get("custId") == cust), None)
        if not r:
            continue
        left = int(cur.get("races") or 0) - int(cur.get("ran") or 0)
        if cur.get("complete") or left < 1:
            return "", None
        if cur.get("finale"):
            return "Championship race: the best finisher of the %s title drivers is champion." % _word(len(rows)), None
        win = bool(cur.get("winAdvances"))
        if win and r.get("won"):
            return "Already through to the next round on a win.", None
        if cur.get("missMustWin") and r.get("missed"):
            return "Missed a race in this round: must win to go through.", None
        cut = r.get("toCut")
        if not isinstance(cut, (int, float)):
            return "", None
        cut = _whole(cut)
        pts = lambda n: "%s point%s" % (n, "" if n == 1 else "s")
        if cut > 0:
            line = "%s over the cut line." % _cap(pts(cut))
        elif cut < 0:
            line = "%s below the cut line." % _cap(pts(-cut))
        else:
            level = sum(1 for x in rows if x is not r and x.get("points") == r.get("points"))
            line = "On the cut line%s." % (", level with %s" % _plural(level, "other") if level else "")
        line += " Last race of the round." if left == 1 else " %s races left in the round." % _cap(_word(left))
        if win:
            line += " A win goes straight through."
        return line, cut
    return "", None


def profile_line(profile):
    p = profile or {}
    out = {k: str(p.get(src) or "").strip() for k, src in (("team", "team"), ("sp", "sponsor"), ("home", "hometown"), ("bio", "bio"))}
    out["bio"] = out["bio"][:BIO_MAX]
    return {k: v for k, v in out.items() if v}


class SiteInfo:
    """The league site's season stats, standings and driver info, for the driver on camera. Looked up in its own
    thread and kept for a while, so the feed never waits on the site: get() only reads what's already here and asks
    for what's missing. A race that isn't a league race, a league that isn't a series on the site, a driver the site
    doesn't know, or a site that doesn't answer: nothing extra on the page."""

    def __init__(self, fetch=None, log=print):
        self.fetch = fetch or self._fetch
        self.log = log
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.series = {}          # iRacing league id -> site slug ("" when the league isn't on the site)
        self.series_at = 0.0
        self.seasons = {}         # slug -> {"at", "name", "stats": {cust: row}, "standings": {...}}
        self.drivers = {}         # cust -> {"at", "profile"}
        self.failed = {}          # what -> time the site last didn't answer it
        self.wanted = (None, None)
        self.field = []           # every driver in the session (cards()), for looking up their own info ahead of a tap
        self.logged = set()

    @staticmethod
    def _fetch(path):
        req = urllib.request.Request(SITE + path, headers={"User-Agent": "VSPEED-overlay"})
        with net.urlopen(req, SITE_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def get(self, league, cust):
        """-> what the page shows for this driver, or None. Never waits."""
        try:
            league, cust = int(league or 0), int(cust or 0)
        except (TypeError, ValueError):
            return None
        if not league or not cust:
            return None
        if self.wanted != (league, cust):
            self.wanted = (league, cust)
            self.wake.set()
        return self._card(league, cust)

    def _card(self, league, cust):
        with self.lock:
            slug = self.series.get(league)
            season = self.seasons.get(slug) if slug else None
            drv = self.drivers.get(cust)
        out = {}
        if season:
            row = season["stats"].get(cust)
            if row:
                out["season"] = season["name"]
                out["s"] = season_line(row)
                try:                     # the season in words: never worth losing the numbers over
                    text = blurb(row, _finishes(season["standings"], cust), season.get("led", {}).get(cust, 0),
                                 _regular_champion(season["standings"], cust))
                    if text:
                        out["bl"] = text
                except Exception as e:
                    self._once("blurb", "Announcer page: couldn't write a driver's season line (%r)" % (e,))
            ch = championship(season["standings"], cust)
            if ch:
                out["ch"] = ch
            try:
                line, cut = tonight(season["standings"], cust)
                if line:
                    out["to"] = line
                if cut is not None:
                    out["cut"] = cut
            except Exception as e:
                self._once("tonight", "Announcer page: couldn't work out a driver's playoff line (%r)" % (e,))
        if drv:
            out.update(profile_line(drv["profile"]))
        return out or None

    def _once(self, what, text):
        if what not in self.logged:
            self.logged.add(what)
            self.log(text)

    def cards(self, league, cars):
        """-> {car number: card} for every car in the session the site knows, for the page's tap-to-open cards.
        Never waits: a driver's own info (bio, team) is in their card once it has been looked up (a few drivers
        at a time, in the lookup thread)."""
        try:
            league = int(league or 0)
        except (TypeError, ValueError):
            return {}
        if not league:
            self.field = []
            return {}
        out, field = {}, []
        for c in (cars or [])[:MAX_CARDS]:
            try:
                cust = int(c.get("custId") or 0)
            except (TypeError, ValueError):
                continue
            num = str(c.get("num") or "")
            if not cust or not num:
                continue
            field.append(cust)
            card = self._card(league, cust)
            if card:
                out[num] = card
        self.field = field
        return out

    def _due(self, what, at, every, now):
        return now - at >= every and now - self.failed.get(what, 0) >= RETRY

    def _try(self, what, fn):
        try:
            fn()
            self.failed.pop(what, None)
            self.logged.discard(what)
        except Exception as e:
            self.failed[what] = time.time()
            if what not in self.logged:      # once until it works again, not every two minutes
                self.logged.add(what)
                self.log("Announcer page: couldn't get %s from the league site (%s)" % (what, type(e).__name__))

    def refresh(self, now=None):
        """Look up what the driver on camera needs and isn't here yet (or is old). Runs in the lookup thread."""
        now = time.time() if now is None else now
        league, cust = self.wanted
        if not league or not cust:
            return
        if self._due("the series list", 0 if league not in self.series else self.series_at, SERIES_EVERY, now):
            def series():
                j = self.fetch("/api/series")
                found = {int(s["id"]): str(s.get("slug") or "") for s in j.get("series") or [] if s.get("id")}
                found.setdefault(league, "")      # not a series on the site: not asked again for an hour
                with self.lock:
                    self.series, self.series_at = found, time.time()
            self._try("the series list", series)
        with self.lock:
            slug = self.series.get(league)
            have = self.seasons.get(slug, {}).get("at", 0) if slug else 0
            drv_at = self.drivers.get(cust, {}).get("at", 0)
        if slug and self._due("the season for " + slug, have, SEASON_EVERY, now):
            def season():
                stats = self.fetch("/api/series/%s/stats" % slug)
                standings = self.fetch("/api/standings/%s" % slug)
                rows = {int(r["custId"]): r for r in stats.get("drivers") or [] if r.get("custId")}
                # who has led the most laps in the series, and the second most (for the season in words)
                by_led = sorted((r for r in rows.values() if (r.get("lapsLed") or 0) > 0), key=lambda r: -r["lapsLed"])
                led = {int(r["custId"]): k + 1 for k, r in enumerate(by_led[:2])}
                with self.lock:
                    self.seasons[slug] = {"at": time.time(), "name": ((stats.get("season") or {}).get("name") or ""),
                                          "stats": rows, "standings": standings, "led": led}
            self._try("the season for " + slug, season)

        def driver(cust):
            def ask():
                try:
                    j = self.fetch("/api/drivers/%d" % cust)
                    profile = (j.get("driver") or {}).get("profile")
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        raise
                    profile = None           # a driver the site has never seen
                with self.lock:
                    self.drivers[cust] = {"at": time.time(), "profile": profile}
            self._try("driver %d" % cust, ask)

        if slug and self._due("driver %d" % cust, drv_at, DRIVER_EVERY, now):
            driver(cust)
        # the rest of the field, a few at a time, so a tapped driver's card has their team and bio too
        if not slug:
            return False
        with self.lock:
            due = [c for c in self.field if c != cust and self._due("driver %d" % c, self.drivers.get(c, {}).get("at", 0), DRIVER_EVERY, now)]
        for c in due[:FIELD_AT_ONCE]:
            driver(c)
        return len(due) > FIELD_AT_ONCE

    def run(self):
        more = False
        while True:
            self.wake.wait(FIELD_PAUSE if more else 30)
            self.wake.clear()
            try:
                more = bool(self.refresh())
            except Exception as e:           # never let the lookup take anything else down
                more = False
                self.log("Announcer page: league site lookup error %r" % (e,))


# ---------------------------------------------------------------- sending
class Sender:
    def __init__(self, state, on_air, log=print):
        self.state, self.on_air, self.log = state, on_air, log
        self.site = SiteInfo(log=log)     # the on-camera driver's season and bio (its own thread, started by start())
        self.conn = None
        self.host = None
        self.last_text = None
        self.last_sent = 0.0
        self.cards_text = "{}"    # the drivers' cards the relay last got (as text), and when
        self.cards_sent = 0.0
        self.backoff_until = 0.0
        self.fails = 0
        self.code_for = None      # the producer (site user id) the league site last gave the producer code for
        self.code_at = 0.0        # when the site last didn't give it
        self.code_said = None

    def ask_code(self, cfg):
        """Ask the league site for this producer's code (their show on the relay), with this PC's sign-in, and save it.
        Asked when the feed is switched on, and again for another producer or after the relay turned the code down.
        Returns the error to show, or "" (also when the site can't be reached but a saved code is there to use)."""
        who = leagueupload.signed_in()
        if not who:
            return "Sign in to GLR HUB first (Setup tab, League site)"
        if self.code_for == who["id"] or time.time() < self.code_at + CODE_RETRY:
            return ""
        old = parse_code(cfg.get("code"))
        try:
            code, j = leagueupload._request("/api/overlay/announcer", leagueupload.token(), {"show": old[1] if old else ""})
        except Exception as e:
            why = "Couldn't reach GLR HUB for the producer code (%s)" % (getattr(e, "reason", None) or type(e).__name__)
        else:
            new = parse_code(j.get("code")) if code == 200 and j.get("ok") else None
            if new:
                self.code_for = who["id"]
                patch = {"code": j["code"]}
                if not cfg.get("token"):
                    patch["token"] = new_token()
                if j["code"] != cfg.get("code") or patch.get("token"):
                    self.state.update_settings({"announcer": patch})
                    self.log("Announcer feed: show %s, from GLR HUB for %s" % (new[1], who["name"] or "this producer"))
                self.code_said = None
                return ""
            why = j.get("error") or "GLR HUB didn't give a producer code (%s)" % code
        self.code_at = time.time()           # didn't get it: ask again in a couple of minutes
        if why != self.code_said:            # once until it changes, not every two minutes
            self.code_said = why
            self.log("Announcer feed: %s%s" % (why, "; using the saved one" if old else ""))
        return "" if old else why

    def _set(self, **kw):
        with _lock:
            changed = any(STATUS.get(k) != v for k, v in kw.items() if k not in ("sentAt", "sent"))
            STATUS.update(kw)
        if changed:
            self.state.notify()          # the control panel shows the status

    def _close(self):
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = None

    def _post(self, base, key, body):
        host = urlparse(base).netloc
        if self.conn is None or self.host != host:
            self._close()
            cls = http.client.HTTPSConnection if base.startswith("https") else http.client.HTTPConnection
            kw = {"timeout": TIMEOUT}
            if cls is http.client.HTTPSConnection and net._ctx is not None:
                kw["context"] = net._ctx
            self.conn, self.host = cls(host, **kw), host
        self.conn.request("POST", "/push", body=body, headers={"Content-Type": "application/json", "Authorization": "Bearer " + key,
                                                               "User-Agent": "VSPEED-overlay"})
        r = self.conn.getresponse()
        text = r.read()
        try:
            data = json.loads(text or b"{}")
        except ValueError:
            data = {}
        return r.status, data

    def run(self):
        while True:
            time.sleep(SEND_EVERY)
            try:
                self.once()
            except Exception as e:           # never let the feed take anything else down
                self._close()
                self._set(state="error", error="Feed error: %r" % (e,))

    def once(self):
        with self.state.lock:
            settings = json.loads(json.dumps({k: self.state.settings.get(k) for k in ("announcer", "raceName")}))
            live = self.state.live
        cfg = dict(DEFAULTS, **(settings.get("announcer") or {}))
        if cfg.get("on"):
            why = self.ask_code(cfg)          # the producer code, from the league site
            with self.state.lock:
                cfg = dict(DEFAULTS, **(self.state.settings.get("announcer") or {}))
        settings["announcer"] = cfg
        p = parse_code(cfg.get("code"))
        if not cfg.get("on") or not p or not cfg.get("token"):
            self._close()
            self.last_text = None
            self.cards_text, self.cards_sent = "{}", 0.0
            if not cfg.get("on"):
                return self._set(state="off", viewers=0, error="", link=link_for(cfg))
            return self._set(state="setup", viewers=0, link=link_for(cfg),
                             error=why or "Getting the producer code from GLR HUB" if not p else "Press New link on the Setup tab")
        self._set(link=link_for(cfg))        # the link shows even before the first update goes out
        now = time.time()
        if now < self.backoff_until:
            return
        data = build(live, settings, self.on_air, self.site)
        text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        # every driver's card, for the page's tap-to-open: sent beside the update only when it changes (and now and
        # then), not twice a second, so the feed stays small
        cards, cards_text = None, self.cards_text
        try:
            found = self.site.cards((live or {}).get("leagueId"), (live or {}).get("cars"))
            found_text = json.dumps(found, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
            since = now - self.cards_sent
            if (found_text != self.cards_text and since >= CARDS_MIN) or (found and since >= CARDS_EVERY):
                cards, cards_text = found, found_text
        except Exception as e:
            self.log("Announcer feed: couldn't put the drivers' cards together (%r)" % (e,))
        if cards is None and text == self.last_text and now - self.last_sent < HEARTBEAT:
            return
        msg = {"token": cfg["token"], "data": data}
        if cards is not None:
            msg["cards"] = cards
        body = json.dumps(msg, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        base, _, key = p
        try:
            status, resp = self._post(base, key, body)
        except ssl.SSLCertVerificationError:
            self._close()
            try:                         # fix the certificate check once (net.py), then try again next second
                net.urlopen(base + "/", 10).read()
            except Exception:
                pass
            return self._fail("Couldn't check the relay's certificate")
        except Exception as e:
            self._close()
            return self._fail("Can't reach the relay (%s)" % (type(e).__name__,))
        if status == 401:
            self.backoff_until = now + 60
            self.code_for, self.code_at = None, 0.0     # ask the league site for the code again
            return self._set(state="error", viewers=0, error=resp.get("error") or "The producer code isn't valid", link=link_for(cfg))
        if status != 200 or not resp.get("ok"):
            return self._fail(resp.get("error") or "Relay answered %s" % status)
        if self.fails:
            self.log("Announcer feed: connected again after %d tries" % self.fails)
        elif STATUS.get("state") != "live":
            self.log("Announcer feed: live (%s)" % link_for(cfg))
        self.fails = 0
        self.last_text, self.last_sent = text, now
        if cards is not None:
            self.cards_text, self.cards_sent = cards_text, now
        self._set(state="live", viewers=int(resp.get("viewers") or 0), error="", link=link_for(cfg), sentAt=now,
                  sent=STATUS.get("sent", 0) + 1)

    def _fail(self, why):
        self.fails += 1
        # 1 s, 2 s, 4 s ... up to 30 s between tries while the relay can't be reached
        self.backoff_until = time.time() + min(30, 2 ** min(self.fails - 1, 5))
        if self.fails in (1, 10) or self.fails % 60 == 0:
            self.log("Announcer feed: %s (try %d)" % (why, self.fails))
        self._set(state="error", viewers=0, error=why)


def start(state, on_air, log=print):
    sender = Sender(state, on_air, log)
    threading.Thread(target=sender.run, daemon=True, name="announcer").start()
    threading.Thread(target=sender.site.run, daemon=True, name="announcer-site").start()


def status():
    with _lock:
        return dict(STATUS)
