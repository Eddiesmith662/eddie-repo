"""Announcer page feed: sends a small update about once a second to the VSPEED relay (a Cloudflare Worker), which hands
it to every announcer who has the show's link open in a browser. Data only goes out: nothing comes back in.

Light on purpose: it runs in its own thread, sends only what the announcer page shows, skips updates that haven't
changed (but still sends one every 10 s so the page knows the feed is alive), gives up on an update after a few
seconds rather than wait, and backs off when the relay can't be reached. It never holds up the overlay.

Setup (control panel, Setup tab): paste the producer code made on the relay's /admin page
("https://<relay>/k/<show>.<signature>") and switch it on. The announcer link is https://<relay>/a/<show>/<view code>;
the view code is made here, and "New link" makes another one, which turns the old links off.
"""
import http.client
import json
import re
import secrets
import ssl
import threading
import time
from urllib.parse import urlparse

import incidents
import net
import standings

DEFAULTS = {"on": False, "code": "", "token": "", "notes": "", "notesAt": 0}
SEND_EVERY = 1.0           # seconds between updates
HEARTBEAT = 10.0           # send even when nothing changed, at least this often
TIMEOUT = 5.0              # give up on one update after this long
MAX_INC = 12               # incidents on the page
MAX_STANDINGS = 20

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


def build(live, settings, on_air):
    """The update for the announcer page: only what it shows, with short keys."""
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
        data = standings.data_snapshot()
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

    a = settings.get("announcer") or {}
    return {
        "v": 1, "series": settings.get("raceName") or "", "track": live.get("track") or "",
        "sess": {"name": live.get("sessionName") or "", "type": live.get("sessionType") or "", "race": is_race,
                 "state": live.get("sessionState") or 0, "lap": live.get("lap") or 0, "total": live.get("totalLaps") or 0,
                 "final": live.get("finalLap") or 0, "ot": bool(live.get("overtime")), "flag": flag, "otg": bool(live.get("oneToGreen")),
                 "time": live.get("timeRemain") or "", "cautions": cautions, "replay": bool(live.get("isReplay")),
                 "live": bool(live.get("connected"))},
        "cam": cam, "air": [n for n in on_air() if n not in ("VSPEED logo", "League logo", "Ticker")],
        "cars": cars, "inc": inc, "lp": lp, "st": st,
        "notes": {"text": (a.get("notes") or "")[:600], "t": a.get("notesAt") or 0},
    }


# ---------------------------------------------------------------- sending
class Sender:
    def __init__(self, state, on_air, log=print):
        self.state, self.on_air, self.log = state, on_air, log
        self.conn = None
        self.host = None
        self.last_text = None
        self.last_sent = 0.0
        self.backoff_until = 0.0
        self.fails = 0

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
        settings["announcer"] = cfg
        p = parse_code(cfg.get("code"))
        if not cfg.get("on") or not p or not cfg.get("token"):
            self._close()
            self.last_text = None
            if not cfg.get("on"):
                return self._set(state="off", viewers=0, error="", link=link_for(cfg))
            return self._set(state="setup", viewers=0, link=link_for(cfg),
                             error="Paste the producer code on the Setup tab" if not p else "Press New link on the Setup tab")
        self._set(link=link_for(cfg))        # the link shows even before the first update goes out
        now = time.time()
        if now < self.backoff_until:
            return
        data = build(live, settings, self.on_air)
        text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        if text == self.last_text and now - self.last_sent < HEARTBEAT:
            return
        body = json.dumps({"token": cfg["token"], "data": data}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
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
            return self._set(state="error", viewers=0, error=resp.get("error") or "The producer code isn't valid", link=link_for(cfg))
        if status != 200 or not resp.get("ok"):
            return self._fail(resp.get("error") or "Relay answered %s" % status)
        if self.fails:
            self.log("Announcer feed: connected again after %d tries" % self.fails)
        elif STATUS.get("state") != "live":
            self.log("Announcer feed: live (%s)" % link_for(cfg))
        self.fails = 0
        self.last_text, self.last_sent = text, now
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
    threading.Thread(target=Sender(state, on_air, log).run, daemon=True, name="announcer").start()


def status():
    with _lock:
        return dict(STATUS)
