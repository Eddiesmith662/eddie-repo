"""League site upload: sends each race's results to the VSPEED league site (vspeedlivetiming.app/glr) when it ends.

Off until the producer switches it on in the control panel (Setup > League site upload) with a key from the site's
Overlay keys page. Results go when iRacing has them a minute after the checkered, and again when iRacing makes them
official; the site files them as Provisional until the iRacing results file is uploaded there.

Nothing is lost if the internet drops or the site is down: each race waits in data/league-upload/ and is sent once
the site answers. Only league races are sent (the sim says which iRacing league the session belongs to).
"""
import datetime
import json
import os
import threading
import time
import urllib.error
import urllib.request

import datafiles
import net

SITE = "https://vspeedlivetiming.app/glr"
DIR = os.path.join(datafiles.DATA, "league-upload")
RETRY = 60                     # seconds between tries while something is waiting
LOCK = threading.Lock()
_wake = threading.Event()
_cfg = {"on": False, "key": ""}
_log = print
STATUS = {"state": "off", "msg": "", "last": ""}
DEFAULTS = {"on": False, "key": ""}


def configure(cfg):
    """The saved settings (settings.json "leagueUpload"): on/off and the key."""
    cfg = cfg or {}
    with LOCK:
        changed = (_cfg["on"], _cfg["key"]) != (bool(cfg.get("on")), str(cfg.get("key") or "").strip())
        _cfg["on"] = bool(cfg.get("on"))
        _cfg["key"] = str(cfg.get("key") or "").strip()
    if changed:                              # a new key or switch: start the status over
        STATUS["state"], STATUS["msg"] = "ready", ""
    _wake.set()


def _ms(t):
    try:
        t = float(t)
    except (TypeError, ValueError):
        return None
    return int(round(t * 1000)) if t > 0 else None


def _status(r):
    s = str(r.get("ReasonOutStr") or "").strip()
    if r.get("ReasonOutId") == 32 or s.lower() == "disco":
        return "Disconnected"
    return s or "Running"


def build(live, sess, info, official):
    """The race in the site's "vspeed_overlay_result" form, from iRacing's own results for the session."""
    cars = {c["idx"]: c for c in live.get("cars") or []}
    rows = []
    lead = max([r.get("LapsComplete") or 0 for r in sess.get("ResultsPositions") or []] or [0])
    for r in sorted((r for r in sess.get("ResultsPositions") or [] if r.get("CarIdx") in cars), key=lambda r: r.get("Position") or 999):
        c = cars[r["CarIdx"]]
        down = max(0, lead - (r.get("LapsComplete") or 0)) if (r.get("Lap") or 0) > 0 else 0   # laps behind the leader, as iRacing's results file counts them
        inc = r.get("Incidents")
        rows.append({
            "custId": c.get("custId", ""), "name": c.get("name", ""), "carNumber": c.get("num", ""),
            "car": c.get("carFull") or c.get("car", ""), "carClass": c.get("cls", ""),
            "finish": r.get("Position"), "classPos": (r.get("ClassPosition") or 0) + 1, "start": c.get("startPos") or None,
            "laps": r.get("LapsComplete"), "lapsLed": r.get("LapsLed"), "incidents": inc if isinstance(inc, int) and inc >= 0 else None,
            "bestLapMs": _ms(r.get("FastestTime")), "bestLapNum": r.get("FastestLap") if (r.get("FastestLap") or 0) > 0 else None,
            "intervalMs": None if down else (_ms(r.get("Time")) or 0), "lapsDown": down, "reasonOut": _status(r),
        })
    return {
        "type": "vspeed_overlay_result", "version": 1, "subsessionId": info.get("subId"), "leagueId": info.get("leagueId"),
        "track": live.get("track") or info.get("track", ""),
        "startTime": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "laps": sess.get("ResultsLapsComplete"), "cautions": sess.get("ResultsNumCautionFlags"),
        "cautionLaps": sess.get("ResultsNumCautionLaps"), "leadChanges": sess.get("ResultsNumLeadChanges"),
        "official": bool(official), "results": rows,
    }


def queue(live, sess, info, sess_num, official):
    """Called when the overlay saves a race's results. Queues them for the site if the upload is on."""
    with LOCK:
        if not (_cfg["on"] and _cfg["key"]):
            return
    if not info.get("leagueId") or not info.get("subId"):
        _log("League site upload: not a league race, nothing sent")
        return
    body = build(live, sess, info, official)
    if not body["results"]:
        return
    os.makedirs(DIR, exist_ok=True)
    path = os.path.join(DIR, "%s-%s.json" % (info.get("subId"), sess_num))
    try:                                     # keep the first copy's time as the race time when the official copy replaces it
        with open(path, encoding="utf-8") as f:
            body["startTime"] = json.load(f).get("startTime") or body["startTime"]
    except (OSError, ValueError):
        pass
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(body, f)
    os.replace(tmp, path)
    _log("League site upload: race %s queued (%d drivers%s)" % (info.get("subId"), len(body["results"]), ", official" if official else ""))
    _wake.set()


def _request(path, key, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SITE + path, data=data, method="POST" if data else "GET",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "VSPEED-Overlay"})
    try:
        r = net.urlopen(req, timeout)
        return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}


def check(key):
    """Is this key good? -> (ok, message)"""
    try:
        code, j = _request("/api/overlay/check", key)
    except Exception as e:
        return False, "Couldn't reach the league site (%s)" % (getattr(e, "reason", None) or e)
    if code == 200 and j.get("ok"):
        return True, "Key works (%s)" % j.get("name", "")
    return False, j.get("error") or "The site said no (%s)" % code


def pending():
    try:
        return sorted(f for f in os.listdir(DIR) if f.endswith(".json"))
    except OSError:
        return []


def _set(state, msg):
    STATUS["state"], STATUS["msg"] = state, msg


def _send_all():
    with LOCK:
        on, key = _cfg["on"], _cfg["key"]
    if not on:
        return _set("off", "")
    if not key:
        return _set("setup", "Paste a key from the league site")
    files = pending()
    if not files:
        if STATUS["state"] not in ("ok", "error"):     # keep the last result or problem on show
            _set("ready", "On. Results go to the site when each race ends.")
        return
    for name in files:
        path = os.path.join(DIR, name)
        try:
            with open(path, encoding="utf-8") as f:
                body = json.load(f)
        except (OSError, ValueError):
            os.remove(path)
            continue
        try:
            code, j = _request("/api/overlay/results", key, body)
        except Exception as e:
            return _set("waiting", "Can't reach the league site; %d race%s waiting, trying again every minute" % (len(files), "" if len(files) == 1 else "s"))
        if code in (401, 403):
            return _set("error", j.get("error") or "The site doesn't accept this key")
        if code == 200 and j.get("ok"):
            os.remove(path)
            what = j.get("message") if j.get("skipped") else "%s results at %s sent (%d drivers)" % (j.get("series", ""), body.get("track", ""), len(body.get("results") or []))
            STATUS["last"] = time.strftime("%H:%M") + " · " + what
            _set("ok", what)
            _log("League site upload: " + what)
        elif 400 <= code < 500:              # the site can't use it (e.g. a league that isn't on the site): don't keep trying
            os.remove(path)
            _set("error", j.get("error") or "The site couldn't use race %s (%s)" % (body.get("subsessionId"), code))
            _log("League site upload: race %s not taken: %s" % (body.get("subsessionId"), j.get("error") or code))
        else:
            return _set("waiting", "The league site had a problem (%s); trying again every minute" % code)


def _loop():
    while True:
        _wake.wait(RETRY)
        _wake.clear()
        try:
            _send_all()
        except Exception as e:
            _log("League site upload: %r" % (e,))


def start(cfg, log=print):
    global _log
    _log = log
    configure(cfg)
    threading.Thread(target=_loop, daemon=True).start()


def status():
    return {"state": STATUS["state"], "msg": STATUS["msg"], "last": STATUS["last"], "waiting": len(pending())}
