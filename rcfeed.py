"""Race control's calls on the broadcast: the penalty box.

During a league race, race control (a steward's PC) sends every call to the league site. The overlay reads the calls
for the race it's showing from the site every few seconds, with its overlay key (the same one the results go with),
so the penalty box can say what race control gave instead of just BLACK FLAG:

- a car's black flag, matched to race control's in-race penalty for that car (drive-through, stop and go, end of
  line): the live timing row and the box show it (e.g. STOP & GO 30 SEC) with the steward's reason;
- calls with no black flag (time penalty, points, places, disqualified, warning): listed in the live timing window
  under "Race control", each with its own Show button.

Nothing goes on air by itself: the box still waits for the producer's Show. Calls withdrawn by race control or on the
site drop out. Off when there's no overlay key, outside league races, and for the demo. Never stops the overlay: a
site that can't be reached just means the box says BLACK FLAG, as before.
"""
import datetime
import threading
import time

import leagueupload

EVERY = 5.0                     # seconds between reads while a league race is on
IN_RACE = ("drivethrough", "stopgo", "eol")                  # served in the race: they come with a black flag
LISTED = ("time", "points", "positions", "dq", "warning")    # no black flag: the producer picks them from the list
MATCH_BEFORE, MATCH_AFTER = 300, 120   # a black flag matches a call made up to 5 min before it or 2 min after

LOCK = threading.Lock()
_wake = threading.Event()
_st = {"sub": None, "want": None, "calls": [], "ver": 0, "err": ""}
_log = print
_bump = None


def label(c):
    """What the penalty box's tag says for a call: STOP & GO 30 SEC, +5 SEC, -10 PTS, BACK 2 PLACES..."""
    n, k = abs(int(c.get("amount") or 0)), c.get("kind")
    if k == "drivethrough":
        return "DRIVE-THROUGH"
    if k == "stopgo":
        return "STOP & GO %d SEC" % n if n else "STOP & GO"
    if k == "eol":
        return "END OF LINE"
    if k == "time":
        return "+%d SEC" % n
    if k == "points":
        return "-%d PTS" % n
    if k == "positions":
        return "BACK %d PLACE%s" % (n, "" if n == 1 else "S")
    if k == "dq":
        return "DISQUALIFIED"
    if k == "warning":
        return "WARNING"
    return ""


def _secs(iso):
    try:
        return datetime.datetime.strptime(str(iso), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


def update(live):
    """Each reading: which race to read (a league race with a session number), or none."""
    want = live.get("subId") if live.get("subId") and live.get("leagueId") and live.get("source") == "iracing" else None
    with LOCK:
        if want != _st["want"]:
            _st["want"] = want
            _wake.set()


def calls():
    """Race control's active calls on the race being shown (the site's newest read)."""
    with LOCK:
        if not _st["sub"] or _st["sub"] != _st["want"]:
            return []
        return [c for c in _st["calls"] if c.get("status") == "active"]


def for_black_flag(num, t):
    """Race control's in-race penalty that goes with a black flag on car `num` that came out at time `t`, or None."""
    best = None
    for c in calls():
        if c.get("kind") not in IN_RACE or str(c.get("carNumber") or "") != str(num or ""):
            continue
        made = _secs(c.get("madeAt"))
        if made is None or not (t - MATCH_BEFORE <= made <= t + MATCH_AFTER):
            continue
        if best is None or abs(made - t) < abs(_secs(best["madeAt"]) - t):
            best = c
    return best


def listed():
    """Calls with no black flag, newest first, for the live timing window's Race control rows."""
    out = [c for c in calls() if c.get("kind") in LISTED]
    out.sort(key=lambda c: c.get("madeAt") or "", reverse=True)
    return out[:8]


def _read():
    with LOCK:
        want = _st["want"]
    if not want:
        with LOCK:
            changed = bool(_st["calls"])
            _st.update(sub=None, calls=[], err="")
        return changed
    key = leagueupload._key()
    if not key:
        return False
    try:
        code, j = leagueupload._request("/api/overlay/calls/%s" % want, key)
    except Exception as e:                      # no internet / site down: keep what we had
        with LOCK:
            _st["err"] = "Couldn't reach the league site (%s)" % (getattr(e, "reason", None) or e)
        return False
    if code != 200 or not j.get("ok"):
        with LOCK:
            _st["err"] = j.get("error") or "The league site said no (%s)" % code
        return False
    new = j.get("calls") or []
    with LOCK:
        changed = new != _st["calls"] or _st["sub"] != want
        _st.update(sub=want, calls=new, err="")
        if changed:
            _st["ver"] += 1
    return changed


def _loop():
    while True:
        _wake.wait(EVERY)
        _wake.clear()
        try:
            if _read() and _bump:
                _bump()                     # the control panel and the overlay get the new calls
        except Exception as e:              # never let the feed stop
            _log("Race control feed: %r" % (e,))


def start(bump=None, log=print):
    global _bump, _log
    _bump, _log = bump, log
    threading.Thread(target=_loop, daemon=True).start()


def status():
    with LOCK:
        return {"race": _st["sub"], "calls": len(_st["calls"]), "err": _st["err"]}
