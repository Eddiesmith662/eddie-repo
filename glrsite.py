"""GLR HUB series for the overlay's Series list (Nov 2026).

GLR HUB (the league site, glr/) is the replacement for Xtreme Scoring: it works the standings out from the results the
overlay sends it. This reads the site's public data, with no sign-in:

  /api/series               the series on the site (a series' number is its iRacing league ID), each with its logo
  /api/standings/<series>   the current season's standings, one group per class when classes race together
  /api/series/<series>/points   the season's scoring rules: points table, bonuses, playoff field
  /api/schedule             the races still to come, for the Next broadcast box

and turns a series' standings into the table the standings graphic, the bracket and live points already use (a header
row and driver rows, the same shape as an Xtreme pull or a CSV), plus each driver's iRacing ID, so live points can
match a car to its row by ID when the name in iRacing isn't the one on the site.

Nothing here runs by itself during a broadcast: the list is read at start-up and when asked, and standings only when the
producer picks a series or presses Refresh (profiles.py).
"""
import datetime
import json
import re
import threading
import time
import urllib.error
import urllib.request

import leagueupload
import net

HEADER = ["Pos", "#", "Driver", "Pts", "To Ldr", "To Nxt", "Wins", "Top 5", "Top 10", "Starts"]
TABLE_PLACES = 60        # the live points table in the control panel has this many places
LOGO_MAX = 3 * 1024 * 1024
BRACKET_SIZES = [12, 8, 4]   # the overlay's bracket and live points' playoff mode: Round of 12, Round of 8, Championship 4
NEXT_AFTER_H = 12            # Next broadcast skips a race starting within this many hours: that's tonight's show
LOGO_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}
MAX_ROWS = 200           # more than any field: live points needs everyone who races

LOCK = threading.Lock()
LIST = {"series": [], "at": 0.0, "error": "", "loading": False}     # the site's series, as last read


class SiteError(Exception):
    """GLR HUB couldn't be read; the message is for the producer."""


def _get(path, timeout=15):
    req = urllib.request.Request(leagueupload.SITE + path, headers={"User-Agent": "VSPEED-Overlay", "Accept": "application/json"})
    try:
        r = net.urlopen(req, timeout)
        return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            why = json.loads(e.read().decode("utf-8") or "{}").get("error")
        except ValueError:
            why = ""
        raise SiteError(why or "GLR HUB answered with error %d" % e.code)
    except (OSError, ValueError) as e:
        raise SiteError("Couldn't reach GLR HUB (%s)" % (getattr(e, "reason", None) or e))


def _slug(s):
    return re.sub(r"[^a-z0-9-]", "", str(s or "").lower())


def fetch_list():
    """The series on the site now. Past series (old seasons kept for the record) are left out: nothing races in them."""
    d = _get("/api/series")
    out = []
    for s in d.get("series") or []:
        slug = _slug(s.get("slug"))
        if not slug or s.get("past"):
            continue
        out.append({"slug": slug, "id": s.get("id"), "name": str(s.get("name") or s.get("short_name") or slug)[:80],
                    "short": str(s.get("short_name") or s.get("name") or slug)[:40], "hidden": bool(s.get("hidden")),
                    "logo": _logo_path(s.get("logo"))})
    return out


def _logo_path(v):
    """A logo's address on the site ("/logo/123?v=..." or "/theme/series-123.png"), or "" for none or anything else."""
    v = str(v or "")
    return v if re.match(r"^/(logo|theme)/[A-Za-z0-9._~%?=&:+-]+$", v) else ""


def logo_address(slug):
    """Where a series' logo is on the site now ("" = it has none)."""
    d = _get("/api/series/" + _slug(slug))
    return _logo_path((d.get("series") or {}).get("logo"))


def fetch_logo(address):
    """Download a series' logo. Returns (the image, its file ending like ".png")."""
    address = _logo_path(address)
    if not address:
        raise SiteError("That isn't a logo on GLR HUB")
    req = urllib.request.Request(leagueupload.SITE + address, headers={"User-Agent": "VSPEED-Overlay"})
    try:
        r = net.urlopen(req, 20)
        kind = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
        body = r.read(LOGO_MAX + 1)
    except urllib.error.HTTPError as e:
        raise SiteError("GLR HUB has no logo there (error %d)" % e.code)
    except OSError as e:
        raise SiteError("Couldn't download the logo (%s)" % (getattr(e, "reason", None) or e))
    if kind not in LOGO_EXT or not body or len(body) > LOGO_MAX:
        raise SiteError("The series logo on GLR HUB isn't an image the overlay can use")
    return body, LOGO_EXT[kind]


def _n(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0
    return int(v) if v == int(v) else v


def to_rules(resp):
    """A series' scoring rules as the overlay's live points settings. Returns a dict:
      source      "table" (the site has a points table), or "iracing" / "field" (it doesn't: the overlay keeps its own)
      livePoints  the settings to use (table, bonuses, 0-laps rule), or None when the site has no table
      field       the playoff field size when the series has playoffs, else None (the cutoff line)
      skipped     rules the overlay's live points doesn't have (named, for the producer)"""
    source = str(resp.get("source") or "iracing")
    po = resp.get("playoffs") or {}
    field = int(_n(po.get("field"))) if po.get("enabled") and _n(po.get("field")) >= 1 else None
    out = {"source": source, "livePoints": None, "field": field, "skipped": []}
    table = resp.get("table") if isinstance(resp.get("table"), list) else []
    if source != "table" or not table:
        return out
    b = resp.get("bonus") or {}
    others = _n(resp.get("others"))
    out["livePoints"] = {"table": ([_n(x) for x in table] + [others] * TABLE_PLACES)[:max(TABLE_PLACES, 0)], "others": others,
                         "zeroLaps": bool(resp.get("zeroLaps")), "bonusLed": _n(b.get("led")), "bonusMost": _n(b.get("mostLed")),
                         "bonusPole": _n(b.get("pole")), "bonusWin": _n(b.get("win"))}
    if _n(b.get("fastLap")):
        out["skipped"].append("the fastest-lap bonus (+%s)" % _n(b.get("fastLap")))
    return out


def _eastern(utc):
    """A UTC time as US Eastern time (the league's clock): daylight time from the second Sunday of March to the first
    Sunday of November. Worked out here because Windows' Python has no time zone data of its own."""
    def sunday(month, nth):
        d = datetime.datetime(utc.year, month, 1)
        return d + datetime.timedelta(days=(6 - d.weekday()) % 7 + 7 * (nth - 1))
    summer = sunday(3, 2) + datetime.timedelta(hours=7) <= utc < sunday(11, 1) + datetime.timedelta(hours=6)
    return utc - datetime.timedelta(hours=4 if summer else 5)


def _ordinal(n):
    return "%d%s" % (n, "TH" if 10 <= n % 100 <= 20 else {1: "ST", 2: "ND", 3: "RD"}.get(n % 10, "TH"))


def next_race(races, slug, now=None):
    """The series' next broadcast from the site's schedule, as the Next broadcast box's text: {event, date, time}, or
    None when nothing is scheduled. A race starting in the next 12 hours (or already started) is tonight's show, so
    the one after it is the next broadcast."""
    now = now or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    best = None
    for r in races or []:
        if not isinstance(r, dict) or _slug(r.get("slug")) != _slug(slug):
            continue
        try:
            t = datetime.datetime.strptime(str(r.get("startsAt"))[:19], "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
        if t - now >= datetime.timedelta(hours=NEXT_AFTER_H) and (best is None or t < best[0]):
            best = (t, r)
    if not best:
        return None
    et = _eastern(best[0])
    hour = et.hour % 12 or 12
    return {"event": " ".join(str(best[1].get("track") or "").split()).upper()[:40],
            "date": "%s %s" % (et.strftime("%b").upper(), _ordinal(et.day)),
            "time": "%d:%02d %s ET" % (hour, et.minute, "AM" if et.hour < 12 else "PM")}


def fetch_next(slug):
    d = _get("/api/schedule")
    return next_race(d.get("races") or [], slug)


def fetch_rules(slug):
    resp = _get("/api/series/%s/points" % _slug(slug))
    if not resp.get("ok", True):
        raise SiteError(resp.get("error") or "GLR HUB couldn't give the points rules")
    return to_rules(resp)


def refresh_list():
    """Read the list again and keep it. Returns (ok, message). Never raises: the old list stays if the site is down."""
    with LOCK:
        if LIST["loading"]:
            return True, "Already reading the GLR HUB series"
        LIST["loading"] = True
    try:
        series = fetch_list()
        with LOCK:
            LIST.update(series=series, at=time.time(), error="")
        return True, "%d series on GLR HUB" % len(series)
    except SiteError as e:
        with LOCK:
            LIST["error"] = str(e)
        return False, str(e)
    except Exception as e:      # whatever the site sends, the overlay carries on
        with LOCK:
            LIST["error"] = "GLR HUB sent something unexpected (%r)" % (e,)
        return False, LIST["error"]
    finally:
        with LOCK:
            LIST["loading"] = False


def refresh_list_in_background():
    threading.Thread(target=refresh_list, name="glr-series", daemon=True).start()


def list_snapshot():
    with LOCK:
        return {"series": [dict(s) for s in LIST["series"]], "at": LIST["at"], "error": LIST["error"]}


def _fmt(x):
    x = float(x or 0)
    return str(int(round(x))) if abs(x - round(x)) < 1e-9 else ("%.3f" % x).rstrip("0").rstrip(".")


def _name_key(name):
    return re.sub(r"[^a-z]", "", str(name or "").lower())       # the same rule as standings.name_key and live points


def to_table(resp, cls=""):
    """One class's standings as the overlay's table. Returns a dict: header, rows, ids ({name key: iRacing ID}),
    classes (the class names, when the series has more than one), cls (the class used), season, playoffs (True when the
    playoffs have started: the drivers still in come first, on their playoff points, then the ones knocked out, then
    everyone else)."""
    groups = [g for g in (resp.get("groups") or []) if isinstance(g, dict)]
    season = (resp.get("season") or {}).get("name") or ""
    classes = [str(g.get("carClass") or "") for g in groups if g.get("carClass")]
    if not groups:
        raise SiteError("%s has no races in its standings yet" % (resp.get("series") or "This series"))
    g = next((x for x in groups if cls and str(x.get("carClass") or "") == cls), groups[0])
    po = g.get("playoffs") or {}
    if po.get("started") and (po.get("current") or {}).get("rows"):
        people = list(po["current"]["rows"]) + list(po.get("eliminated") or []) + list(po.get("others") or [])
        shared = False
    else:
        people = list(g.get("regular") or [])
        shared = True
    people = [p for p in people if isinstance(p, dict) and str(p.get("name") or "").strip()][:MAX_ROWS]
    if not people:
        raise SiteError("%s has no drivers in its standings yet" % (resp.get("series") or "This series"))
    rows, ids = [], {}
    top = float(people[0].get("points") or 0)
    for k, p in enumerate(people):
        pts = float(p.get("points") or 0)
        prev = float(people[k - 1].get("points") or 0) if k else pts
        pos = p.get("pos") if shared and p.get("pos") else k + 1
        rows.append([str(pos), str(p.get("number") or "").strip(), str(p["name"]).strip(), _fmt(pts), _fmt(pts - top), _fmt(pts - prev),
                     _fmt(p.get("wins")), _fmt(p.get("top5")), _fmt(p.get("top10")), _fmt(p.get("starts"))])
        if p.get("custId") and _name_key(p["name"]):
            ids.setdefault(_name_key(p["name"]), str(p["custId"]))
    return {"header": list(HEADER), "rows": rows, "ids": ids, "classes": classes if len(classes) > 1 else [],
            "cls": str(g.get("carClass") or "") if len(classes) > 1 else "", "season": season, "playoffs": not shared,
            "playoff": _playoff(resp, g)}


def _playoff(resp, g):
    """Where the series' playoffs stand, for the overlay's bracket and live points' playoff mode:
      enabled  the series has playoffs on the site
      fits     its rounds are the 12 / 8 / 4 the overlay's bracket shows (anything else: the bracket and playoff mode
               stay as the producer set them)
      started  the regular season is over and the playoffs are under way
      name     the round being run now; spots = how many go through from it (None in the last round)
      rounds   the bracket: who is in each round so far, seeded in the order they made the field, with a win or a
               missed race in the round marked, and the champion once the last round is complete"""
    rules = ((resp.get("rules") or {}).get("playoffs") or {})
    sizes = [int(_n(r.get("drivers"))) for r in (rules.get("rounds") or []) if isinstance(r, dict)]
    out = {"enabled": bool(rules.get("enabled")), "fits": bool(sizes) and sizes == BRACKET_SIZES[:len(sizes)], "started": False,
           "name": "", "spots": None, "rounds": None}
    po = g.get("playoffs") or {}
    done = [r for r in (po.get("rounds") or []) if isinstance(r, dict)]
    if not po.get("started") or not done:
        return out
    cur = done[-1]
    out.update(enabled=True, started=True, name=str(cur.get("name") or ""))
    if not cur.get("finale") and _n(cur.get("spots")) >= 1:
        out["spots"] = int(_n(cur["spots"]))
    if not out["fits"]:
        return out
    field = [s.get("custId") for s in (g.get("regular") or []) if s.get("inField")] or [r.get("custId") for r in done[0].get("rows") or []]
    seed = {cust: k + 1 for k, cust in enumerate(field)}
    rounds = [[], [], [], []]
    for k, rd in enumerate(done[:3]):
        for r in rd.get("rows") or []:
            if r.get("custId") in seed:
                rounds[k].append({"seed": seed[r["custId"]], "num": str(r.get("number") or "").strip(), "name": str(r.get("name") or "").strip(),
                                  "won": bool(r.get("won")), "missed": bool(r.get("missed"))})
        rounds[k].sort(key=lambda e: e["seed"])
    if cur.get("finale") and cur.get("complete"):
        champ = next((r for r in cur.get("rows") or [] if r.get("status") == "Champion" and r.get("custId") in seed), None)
        if champ:
            rounds[3] = [{"seed": seed[champ["custId"]], "num": str(champ.get("number") or "").strip(), "name": str(champ.get("name") or "").strip(),
                          "won": False, "missed": False}]
    out["rounds"] = rounds
    return out


def fetch_standings(slug, cls=""):
    """A series' standings from the site, as to_table() gives them. Raises SiteError with a message for the producer."""
    slug = _slug(slug)
    if not slug:
        raise SiteError("Pick a series first")
    resp = _get("/api/standings/" + slug)
    if not resp.get("ok", True):
        raise SiteError(resp.get("error") or "GLR HUB couldn't give the standings")
    return to_table(resp, cls)
