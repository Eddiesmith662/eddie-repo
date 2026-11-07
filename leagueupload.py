"""League site upload: sends each race's results to the VSPEED league site (vspeedlivetiming.app/glr) when it ends.

Off until the producer switches it on in the control panel (Setup > League site upload) with a key from the site's
Overlay keys page. Results go when iRacing has them a minute after the checkered, and again when iRacing makes them
official; the site files them as Provisional until the iRacing results file is uploaded there.

Nothing is lost if the internet drops or the site is down: each race waits in data/league-upload/ and is sent once
the site answers. Only league races are sent (the sim says which iRacing league the session belongs to). A race the
site turns down (e.g. a league that isn't on the site yet) is never deleted: it's moved to data/league-upload/refused/,
and putting the file back in data/league-upload/ sends it again.
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
REFUSED_DIR = os.path.join(DIR, "refused")
RETRY = 60                     # seconds between tries while something is waiting
TRY_AGAIN = (408, 425, 429)   # turned down for now (timeout, too many requests): try again, like a site problem
LOCK = threading.Lock()
_wake = threading.Event()
_cfg = {"on": False, "key": ""}
_START = {}                    # queued file -> the race time of its first copy (the file is gone once it's sent)
_log = print
STATUS = {"state": "off", "msg": "", "last": ""}
DEFAULTS = {"on": False, "key": ""}
# race control (start-race-control.bat) sets this to its sign-in token: a steward signed in to the site sends the
# official results with it, so a race nobody broadcasts needs no overlay key (plan doc, phase 5c). The overlay key,
# when there is one and the upload is on, is used first.
TOKEN_SOURCE = None


def _key():
    """-> the key to send with, or "" (upload off and no race control sign-in)."""
    with LOCK:
        on, key = _cfg["on"], _cfg["key"]
    if on and key:
        return key
    try:
        return (TOKEN_SOURCE() or "") if TOKEN_SOURCE else ""
    except Exception:
        return ""


# The overlay key lives in a file of its own, not in settings.json (Nov 2026): settings.json is copied around (its
# .bak and .broken-... copies, folder copies, OneDrive), and race control already keeps its sign-in apart the same way.
# Only this module reads or writes it; the pages only ever learn whether one is saved.
KEY_FILE = os.path.join(datafiles.DATA, "league-site-key.json")
_stored = {"key": None}        # the key file's key once read ("" = none), so pages asking 5 times a second don't read the disk


def stored_key():
    """The overlay key saved on this PC, or ""."""
    if _stored["key"] is None:
        d = datafiles.load_json(KEY_FILE, {})
        _stored["key"] = str(d.get("key") or "").strip() if isinstance(d, dict) else ""
    return _stored["key"]


def save_key(key):
    """Save the overlay key ("" removes it)."""
    key = str(key or "").strip()
    if key:
        datafiles.write_json(KEY_FILE, {"key": key, "note": "The league site overlay key for this PC. Keep it private: "
                                                            "don't share this file. Remove it from the Setup tab."}, indent=1)
    else:
        try:
            os.remove(KEY_FILE)
        except OSError:
            pass
    _stored["key"] = key


def move_key_out_of_settings(state, log=print):
    """Before Nov 2026 the key was kept in settings.json ("leagueUpload": {"key": ...}). Move it into its own file, then
    take it out of settings.json and its last-good copy (settings.json.bak). Returns True if a key was moved."""
    with state.lock:
        lu = state.settings.get("leagueUpload")
        old = str((lu or {}).get("key") or "").strip() if isinstance(lu, dict) else ""
    if not old:
        return False
    if not stored_key():
        save_key(old)                        # saved on its own first, so it's never only in memory
    with state.lock:
        state.settings["leagueUpload"].pop("key", None)
    state.save()
    bak = datafiles.SETTINGS_FILE + ".bak"
    try:
        with open(bak, encoding="utf-8") as f:
            b = json.load(f)
        if isinstance(b, dict) and isinstance(b.get("leagueUpload"), dict) and "key" in b["leagueUpload"]:
            b["leagueUpload"].pop("key", None)
            datafiles.write_json(bak, b, indent=2)
    except (OSError, ValueError):
        pass
    log("League site upload: the overlay key moved out of settings.json into %s" % os.path.basename(KEY_FILE))
    return True


def configure(cfg):
    """On/off (settings.json "leagueUpload") and the key (the key file)."""
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
    if not _key():
        return
    if not info.get("leagueId") or not info.get("subId"):
        _log("League site upload: not a league race, nothing sent")
        return
    body = build(live, sess, info, official)
    if not body["results"]:
        return
    path = os.path.join(DIR, "%s-%s.json" % (info.get("subId"), sess_num))
    with LOCK:
        start = _START.get(path)
        if start is None:                    # keep the first copy's time as the race time when the official copy replaces it
            try:
                with open(path, encoding="utf-8") as f:
                    start = json.load(f).get("startTime")
            except (OSError, ValueError, AttributeError):
                pass
        body["startTime"] = start or body["startTime"]
        _START[path] = body["startTime"]
        datafiles.write_json(path, body)     # raises if it can't be saved: race results tries again
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
        on = _cfg["on"]
    key = _key()
    if not key:
        return _set("off", "") if not on else _set("setup", "Paste a key from the league site")
    files = pending()
    if not files:
        if STATUS["state"] not in ("ok", "error"):     # keep the last result or problem on show
            _set("ready", "On. Results go to the site when each race ends.")
        return
    for name in files:
        path = os.path.join(DIR, name)
        try:
            with open(path, "rb") as f:
                raw = f.read()
            body = json.loads(raw.decode("utf-8"))
        except OSError:
            continue                         # locked for a moment (OneDrive): next time
        except ValueError:
            _set_aside(path, None, "it couldn't be read")
            continue
        try:
            code, j = _request("/api/overlay/results", key, body)
        except Exception as e:
            return _set("waiting", "Can't reach the league site; %d race%s waiting, trying again every minute" % (len(files), "" if len(files) == 1 else "s"))
        if code in (401, 403):
            return _set("error", j.get("error") or "The site doesn't accept this key")
        if code == 200 and j.get("ok"):
            _done_with(path, raw)
            what = j.get("message") if j.get("skipped") else "%s results at %s sent (%d drivers)" % (j.get("series", ""), body.get("track", ""), len(body.get("results") or []))
            STATUS["last"] = time.strftime("%H:%M") + " · " + what
            _set("ok", what)
            _log("League site upload: " + what)
        elif 400 <= code < 500 and code not in TRY_AGAIN:   # the site can't use it (e.g. a league that isn't on the site)
            why = j.get("error") or "the site answered %s" % code
            _set_aside(path, raw, why)
            _set("error", "Race %s not taken: %s (kept in data\\league-upload\\refused)" % (body.get("subsessionId"), why))
        else:
            return _set("waiting", "The league site had a problem (%s); trying again every minute" % code)


def _done_with(path, raw):
    """Remove a sent race, unless a newer copy (e.g. the official results) was queued while it was being sent:
    that one stays and goes next. (Before, the newer copy was deleted unsent.)"""
    with LOCK:
        try:
            with open(path, "rb") as f:
                if f.read() != raw:
                    _wake.set()
                    return
            os.remove(path)
        except OSError:
            pass


def _set_aside(path, raw, why):
    """A race the site won't take, or a file that can't be read: moved to refused/, never deleted."""
    with LOCK:
        try:
            if raw is not None:
                with open(path, "rb") as f:
                    if f.read() != raw:      # a newer copy came in meanwhile: send that one instead
                        _wake.set()
                        return
            os.makedirs(REFUSED_DIR, exist_ok=True)
            dest = os.path.join(REFUSED_DIR, os.path.basename(path))
            if os.path.exists(dest):
                dest = os.path.join(REFUSED_DIR, "%s-%s.json" % (os.path.basename(path)[:-5], time.strftime("%Y%m%d-%H%M%S")))
            os.replace(path, dest)
            _log("League site upload: %s not taken (%s); kept as %s" % (os.path.basename(path), why, os.path.relpath(dest, datafiles.DATA)))
        except OSError as e:
            _log("League site upload: couldn't set %s aside: %r" % (os.path.basename(path), e))


def _loop():
    while True:
        _wake.wait(RETRY)
        _wake.clear()
        try:
            _send_all()
        except Exception as e:
            _log("League site upload: %r" % (e,))


def start(cfg, log=print):
    """cfg: settings.json's "leagueUpload" (on/off); the key comes from the key file."""
    global _log
    _log = log
    configure({"on": bool((cfg or {}).get("on")), "key": stored_key()})
    threading.Thread(target=_loop, daemon=True).start()


def status():
    return {"state": STATUS["state"], "msg": STATUS["msg"], "last": STATUS["last"], "waiting": len(pending())}
