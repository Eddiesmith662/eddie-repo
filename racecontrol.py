"""Race control: the steward's incident queue and decisions (start-race-control.bat).

Runs only in race control mode, on a steward's PC (a session admin in the iRacing session). It takes the incidents the
incident log detects (incidents.py, the same detection the live timing window uses) into a queue the steward works
through, and keeps every decision the steward makes, with who made it and why.

  data/race-control/<race>.json     one file per race (iRacing subsession), saved after every change, so a restart
                                    mid-race picks the queue and the calls back up

Queue status: new -> reviewing -> decided / no action. iRacing's own automatic penalties (black flag, warning,
disqualified) are recorded in the queue as "logged": they are not steward decisions, and nothing is sent anywhere.
Cautions and retirements are logged too, as context.

While the steward watches a replay, iRacing's per-car data is the replay, so the incident log pauses. Incident points
come from iRacing's session results, which stay live, so when the steward goes back to live any points gained during
the review are added as "found after review", with the time window to look at.

Sending to iRacing (phase 5b): a call that iRacing can give in the sim (warning, drive-through, stop-and-go, end of
line, DQ) shows the exact admin command, and the steward sends it with a second button. Race control then watches
iRacing's data: the black flag (or DQ) showing = "In the sim", the black flag going away = "Served". A warning or end
of line can't be checked that way, so those just say "Sent". Withdrawing a call that was sent can also send !clear.

Calls stay on this PC for now; sending them to the league site comes later (phase 5c).
"""
import datetime
import json
import os
import threading
import time

import datafiles
import incidents
import simchat

DIR = os.path.join(datafiles.DATA, "race-control")

# the kinds of call a steward can make: (key, label, what the number means or None)
KINDS = [
    ("warning", "Warning", None), ("drivethrough", "Drive-through", None), ("stopgo", "Stop-and-go", "seconds"),
    ("time", "Time penalty", "seconds"), ("eol", "End of line", None), ("positions", "Positions", "positions"),
    ("points", "Points", "points"), ("dq", "Disqualified", None), ("noaction", "No action", None),
]
KIND_LABEL = {k: lbl for k, lbl, _ in KINDS}
KIND_UNIT = {k: u for k, _, u in KINDS}
AUTO = {"penalty", "warning", "dq"}            # iRacing's own flags: logged, not for the steward to decide
INFO = {"caution", "retired"}                  # context for the steward: logged, nothing to decide
SKIP = {"pit"}                                 # incident log entries race control doesn't queue
STATUSES = ("new", "reviewing", "decided", "noaction", "logged")
CATCH_DUP_S = 3.0                              # the incident log's own copy of points found after a review: ignored

# what each call sends to iRacing (tested on a live session, Nov 2026). Calls not listed change the results later.
SIM_KINDS = ("warning", "drivethrough", "stopgo", "eol", "dq")
SIM_FLAGGED = ("drivethrough", "stopgo")       # these show as a black flag on the car, so race control can check them
HOLD_ADD = 25                                  # iRacing holds a !black stop-and-go 25 s longer than the number sent
                                               # (sent 30 -> 55 s hold, sent 10 -> 35 s), so it's sent 25 less
WAIT_S = 10.0                                  # live seconds to wait for the flag before saying it didn't take

LOCK = threading.Lock()
_log = print
_st = {"key": None, "path": None, "data": None, "ver": 0, "map": {}, "incVer": -1,
       "replay": False, "reviewFrom": None, "lastInc": {}, "lastT": None, "lastLap": None, "catch": {}, "catchT": None}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty(key, live):
    return {"version": 1, "race": key, "subId": live.get("subId"), "track": live.get("track", ""), "created": _now(),
            "seq": {"i": 0, "c": 0}, "queue": [], "calls": []}


def _race_key(live):
    if live.get("subId"):
        return str(live["subId"])
    # no subsession (the demo): one file per program run
    _st.setdefault("runKey", "demo-" + time.strftime("%Y%m%d-%H%M%S"))
    return _st["runKey"]


def _save():
    d, path = _st["data"], _st["path"]
    if not d or not path:
        return
    try:
        os.makedirs(DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1)
        os.replace(tmp, path)
    except OSError as e:
        _log("Race control: couldn't save %s (%s)" % (path, e))


def _changed():
    _st["ver"] += 1
    _save()


def _open(live):
    """The race this reading belongs to: load its file, or start one."""
    key = _race_key(live)
    if _st["key"] == key:
        return
    path = os.path.join(DIR, "%s.json" % key)
    data = None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        _log("Race control: picked up race %s (%d in the queue, %d calls)" % (key, len(data.get("queue") or []), len(data.get("calls") or [])))
    except (OSError, ValueError):
        pass
    _st.update(key=key, path=path, data=data or _empty(key, live), map={}, incVer=-1, lastInc={}, catch={}, catchT=None)
    if not data:
        _log("Race control: new race %s at %s" % (key, live.get("track", "")))
    _st["ver"] += 1


def _next(kind):
    d = _st["data"]
    d["seq"][kind] += 1
    return "%s%d" % (kind, d["seq"][kind])


def _car(live, idx):
    return next((c for c in live.get("cars") or [] if c.get("idx") == idx), None)


def _item_from(ev, live):
    c = _car(live, ev.get("idx")) or {}
    auto = ev["type"] in AUTO and ev.get("src") == "iracing"
    return {
        "id": _next("i"), "type": ev["type"], "src": ev.get("src", ""), "detail": ev.get("detail", ""), "pts": ev.get("pts"),
        "sess": ev.get("sess", 0), "sessName": ev.get("sessName", ""), "t": ev.get("t"), "lap": ev.get("lap"),
        "idx": ev.get("idx"), "num": ev.get("num", ""), "name": ev.get("name", ""), "custId": c.get("custId", ""),
        "pos": ev.get("pos"), "cars": ev.get("cars") or [], "status": "logged" if auto or ev["type"] in INFO else "new", "auto": auto,
        "afterReview": False, "at": _now(),
    }


_SYNC = ("type", "src", "detail", "pts", "cars")


def _mirror(live):
    """Take new incidents from the incident log into the queue, and keep ones it updated (points added, multi-car) in step."""
    with incidents.LOCK:
        ver = incidents.STATE["ver"]
        if ver == _st["incVer"]:
            return False
        evs = [dict(e) for e in incidents.STATE["list"]]
    _st["incVer"] = ver
    d, mp, changed = _st["data"], _st["map"], False
    by_id = {q["id"]: q for q in d["queue"]}
    for ev in evs:
        if ev["type"] in SKIP:
            continue
        if ev["id"] in mp:
            q = by_id.get(mp[ev["id"]])
            if q:
                for k in _SYNC:
                    if ev.get(k) != q.get(k) and not (k == "type" and q["auto"]):
                        q[k] = ev.get(k)
                        changed = True
            continue
        # points the incident log picks up on the first reading after a review: already added as "found after review"
        if (_st["catchT"] is not None and ev.get("src") == "iracing" and ev.get("pts") and ev.get("idx") in _st["catch"]
                and ev.get("t") is not None and abs(ev["t"] - _st["catchT"]) <= CATCH_DUP_S):
            mp[ev["id"]] = None
            continue
        q = _item_from(ev, live)
        if _st["catchT"] is not None and ev.get("t") is not None and abs(ev["t"] - _st["catchT"]) <= CATCH_DUP_S:
            q["afterReview"] = True        # e.g. a black flag that came out while the steward was in a replay
        d["queue"].append(q)
        mp[ev["id"]] = q["id"]
        by_id[q["id"]] = q
        changed = True
    return changed


def _catch_up(live):
    """Back from a replay: incident points gained while the steward was reviewing."""
    d = _st["data"]
    t, lap = live.get("sessTime"), live.get("lap")
    found = {}
    for c in live.get("cars") or []:
        before, now = _st["lastInc"].get(c["idx"]), c.get("inc")
        if isinstance(before, int) and isinstance(now, int) and now > before:
            pts = now - before
            kind = "contact" if pts >= 4 else "spin" if pts >= 2 else "offtrack"
            q = {
                "id": _next("i"), "type": kind, "src": "iracing", "pts": pts,
                "detail": "+%dx while you were in a replay (laps %s to %s)" % (pts, _st["lastLap"] or "?", lap or "?"),
                "sess": live.get("sessNum", 0), "sessName": live.get("sessionName", ""), "t": t, "lap": lap,
                "idx": c["idx"], "num": c.get("num", ""), "name": c.get("name", ""), "custId": c.get("custId", ""),
                "pos": c.get("pos"), "cars": [], "status": "new", "auto": False, "afterReview": True,
                "window": [_st["lastT"], t], "at": _now(),
            }
            d["queue"].append(q)
            found[c["idx"]] = q["id"]
    _st["catch"], _st["catchT"] = found, t
    if found:
        _log("Race control: %d car%s gained incident points during a replay review" % (len(found), "" if len(found) == 1 else "s"))
    return bool(found)


def update(live):
    """Each reading of the race, after incidents.update()."""
    if not live or not live.get("connected"):
        return
    with LOCK:
        _open(live)
        changed = False
        if live.get("isReplay"):
            _st["lastWall"] = None         # time in a replay doesn't count toward waiting for a flag
            if not _st["replay"]:
                _st["replay"] = True
                _st["ver"] += 1            # the page shows "in a replay"
            return
        if _st["replay"]:
            _st["replay"] = False
            changed = _catch_up(live) or changed
            _st["ver"] += 1
        changed = _mirror(live) or changed
        wall = time.time()
        dt = min(1.0, wall - _st["lastWall"]) if _st.get("lastWall") else 0.0
        _st["lastWall"] = wall
        changed = _check_sims(live, dt) or changed
        _st["lastInc"] = {c["idx"]: c.get("inc") for c in live.get("cars") or []}
        _st["lastT"], _st["lastLap"] = live.get("sessTime"), live.get("lap")
        if changed:
            _changed()


def sim_text(call):
    """The admin command or message for a call, as it's typed into iRacing's chat (None if it isn't given in the sim)."""
    car = call.get("car")
    if call["kind"] not in SIM_KINDS or not car:
        return None
    n, r = car["num"], simchat.clean(call.get("reason"))
    if call["kind"] == "warning":
        return simchat.clean("/#%s Race control warning: %s" % (n, r))     # a private message to that driver
    if call["kind"] == "drivethrough":
        return simchat.clean("!black #%s D %s" % (n, r))                   # the reason goes to everyone in the session
    if call["kind"] == "stopgo":
        return simchat.clean("!black #%s %d %s" % (n, max(0, (call["value"] or HOLD_ADD) - HOLD_ADD), r))
    if call["kind"] == "eol":
        return simchat.clean("!eol #%s %s" % (n, r))
    return simchat.clean("!dq #%s %s" % (n, r))


def _check_sims(live, dt):
    """Calls sent to iRacing: has the flag come up, and has it gone again (served)?"""
    cars = {c["idx"]: c for c in live.get("cars") or []}
    changed = False
    for c in _st["data"]["calls"]:
        sim = c.get("sim")
        if not sim or sim["state"] not in ("waiting", "inSim") or c["status"] != "active":
            continue
        car = cars.get(c["car"]["idx"])
        if not car:
            continue
        if sim["state"] == "waiting":
            if car.get("dq") if c["kind"] == "dq" else car.get("blackFlag"):
                sim.update(state="inSim", inSimAt=_now(), inSimLap=live.get("lap"))
                changed = True
            else:
                sim["waitS"] = sim.get("waitS", 0.0) + dt
                if sim["waitS"] > WAIT_S:
                    sim["state"] = "notTaken"
                    changed = True
        elif sim["state"] == "inSim" and c["kind"] in SIM_FLAGGED and not car.get("blackFlag"):
            sim.update(state="served", servedAt=_now(), servedLap=live.get("lap"))
            changed = True
            _log("Race control: #%s served the %s (call %s)" % (c["car"]["num"], KIND_LABEL[c["kind"]].lower(), c["id"]))
    return changed


def send_prepare(cid, steward, live):
    """Before a call's command is typed into iRacing. -> (ok, error, text)"""
    with LOCK:
        d = _st["data"]
        c = next((c for c in (d["calls"] if d else []) if c["id"] == cid), None)
        if not c:
            return False, "That call isn't in the log", None
        sim = c.get("sim")
        if not sim:
            return False, "This call isn't given in the sim", None
        if c["status"] != "active":
            return False, "That call was withdrawn", None
        if sim["state"] == "sending":
            return False, "It's being sent", None
        if sim["state"] in ("waiting", "inSim", "served", "sent"):
            return False, "It was already sent", None
        if not str(steward or "").strip():
            return False, "Type your name at the top first", None
        live = live or {}
        if not live.get("connected"):
            return False, "iRacing isn't connected", None
        car = _car(live, c["car"]["idx"])
        if not car:
            return False, "#%s isn't in the session any more" % c["car"]["num"], None
        if car.get("num") != c["car"]["num"]:
            return False, "That car's number changed: make the call again", None
        if c["kind"] == "eol" and live.get("flag") != "caution":
            return False, "End of line only works under caution", None
        sim.update(state="sending", by=str(steward).strip()[:60], at=_now(), hadFlag=bool(car.get("blackFlag")), waitS=0.0, error="")
        sim.pop("note", None)
        _changed()
        return True, "", sim["cmd"]


def send_done(cid, ok, error=""):
    with LOCK:
        d = _st["data"]
        c = next((c for c in (d["calls"] if d else []) if c["id"] == cid), None)
        if not c or not c.get("sim"):
            return
        sim = c["sim"]
        if not ok:
            sim.update(state="failed", error=error or "It couldn't be sent")
        else:
            sim["state"] = "waiting" if c["kind"] in SIM_FLAGGED + ("dq",) else "sent"
            if c["kind"] in SIM_FLAGGED and sim.get("hadFlag"):
                # the car already had a black flag (iRacing's own, or an earlier one), so this one can't be told apart
                # from it: say it was sent rather than wrongly say it didn't take (live test, Nov 2026)
                sim["state"] = "sent"
                sim["note"] = "#%s already had a black flag, so race control can't check this one" % c["car"]["num"]
            sim["sentAt"] = _now()
        _changed()
        _log("Race control: %s %s to iRacing: %s%s" % (sim.get("by", ""), "sent" if ok else "couldn't send", sim["cmd"],
                                                       "" if ok else " (%s)" % error))


def _mark_cleared(d, idx=None):
    """!clear (one car) or !clearall (idx None) went through: penalties race control sent are gone from the sim,
    so they mustn't later show as "Served". The calls themselves stand; they can be sent again."""
    for c in d["calls"]:
        sim = c.get("sim")
        if sim and c["status"] == "active" and sim["state"] in ("waiting", "inSim", "sent", "notTaken") \
                and (idx is None or (c.get("car") or {}).get("idx") == idx) and c["kind"] != "dq":
            sim["state"] = "cleared"


def clear_done(cid, ok, error=""):
    with LOCK:
        d = _st["data"]
        c = next((c for c in (d["calls"] if d else []) if c["id"] == cid), None)
        if not c or not c.get("sim"):
            return
        c["sim"]["clear"] = {"at": _now(), "ok": bool(ok), "error": error or ""}
        if ok:
            c["sim"]["state"] = "cleared"
            _mark_cleared(d, c["car"]["idx"])
        _changed()


def clear_prepare(idx, steward, live):
    """The steward's Clear (one car) or Clear all. -> (ok, error, text, car)"""
    if not str(steward or "").strip():
        return False, "Type your name at the top first", None, None
    live = live or {}
    if not live.get("connected"):
        return False, "iRacing isn't connected", None, None
    if idx is None:
        return True, "", "!clearall", None
    car = _car(live, idx)
    if not car:
        return False, "That car isn't in the session", None, None
    return True, "", "!clear #%s" % car.get("num", ""), {"idx": idx, "num": car.get("num", ""), "name": car.get("name", ""),
                                                         "custId": car.get("custId", "")}


def clear_log(steward, car, text, ok, error="", live=None):
    """Every Clear / Clear all is kept in the race's file, with who sent it."""
    with LOCK:
        d = _st["data"]
        if d is None:
            return
        d.setdefault("seq", {}).setdefault("x", 0)
        lv = live or {}
        d.setdefault("clears", []).append({"id": _next("x"), "at": _now(), "by": str(steward).strip()[:60], "cmd": text,
                                           "car": car, "ok": bool(ok), "error": error or "", "lap": lv.get("lap")})
        if ok:
            _mark_cleared(d, car["idx"] if car else None)
        _changed()
    _log("Race control: %s %s %s%s" % (steward, "sent" if ok else "couldn't send", text, "" if ok else " (%s)" % error))


def version():
    return _st["ver"]


def snapshot():
    with LOCK:
        d = _st["data"] or {"queue": [], "calls": [], "race": None, "track": "", "subId": None}
        return {"ver": _st["ver"], "race": d.get("race"), "track": d.get("track", ""), "subId": d.get("subId"),
                "queue": list(d["queue"]), "calls": list(d["calls"]), "clears": list(d.get("clears") or []), "inReplay": _st["replay"],
                "kinds": [{"key": k, "label": lbl, "unit": u, "sim": k in SIM_KINDS} for k, lbl, u in KINDS], "types": incidents.TYPES,
                "holdAdd": HOLD_ADD,
                "file": os.path.relpath(_st["path"], datafiles.DATA) if _st["path"] else ""}


def find(qid):
    with LOCK:
        d = _st["data"]
        return next((dict(q) for q in (d["queue"] if d else []) if q["id"] == qid), None)


def _active_calls(d, qid):
    return [c for c in d["calls"] if c.get("incident") == qid and c["status"] == "active"]


def command(data, live, steward=""):
    """From the Race Control page. -> (ok, message, extra)"""
    cmd = str(data.get("cmd") or "")
    with LOCK:
        d = _st["data"]
        if d is None:
            return False, "No race yet: waiting for iRacing", None
        by_id = {q["id"]: q for q in d["queue"]}

        if cmd == "status":                    # new <-> reviewing (decided / no action come from making a call)
            q = by_id.get(str(data.get("id") or ""))
            st = str(data.get("status") or "")
            if not q:
                return False, "That incident isn't in the queue", None
            if st not in ("new", "reviewing"):
                return False, "Unknown status", None
            if q["status"] in ("decided", "noaction") and _active_calls(d, q["id"]):
                return False, "This incident has a call. Withdraw the call first.", None
            q["status"] = st
            _changed()
            return True, "", None

        if cmd == "call":
            kind = str(data.get("kind") or "")
            if kind not in KIND_LABEL:
                return False, "Pick what the call is", None
            steward = str(steward or "").strip()
            if not steward:
                return False, "Type your name at the top first, so each call says who made it", None
            reason = str(data.get("reason") or "").strip()[:300]
            if kind != "noaction" and not reason:
                return False, "Give a reason: drivers will see it", None
            value = None
            if KIND_UNIT[kind]:
                try:
                    value = int(data.get("value"))
                except (TypeError, ValueError):
                    return False, "How many %s?" % KIND_UNIT[kind], None
                if value <= 0 or value > 9999:
                    return False, "The number of %s has to be above 0" % KIND_UNIT[kind], None
                if kind == "stopgo" and value < HOLD_ADD:
                    return False, "iRacing's shortest stop-and-go is %d seconds" % HOLD_ADD, None
            q = by_id.get(str(data.get("incident") or "")) if data.get("incident") else None
            if data.get("incident") and not q:
                return False, "That incident isn't in the queue", None
            car = None
            if data.get("idx") is not None:
                try:
                    idx = int(data["idx"])
                except (TypeError, ValueError):
                    return False, "Pick a car", None
                c = _car(live or {}, idx)
                if c:
                    car = {"idx": idx, "num": c.get("num", ""), "name": c.get("name", ""), "custId": c.get("custId", "")}
                elif q and q.get("idx") == idx:
                    car = {"idx": idx, "num": q["num"], "name": q["name"], "custId": q.get("custId", "")}
                elif q:
                    m = next((m for m in q.get("cars") or [] if m.get("idx") == idx), None)
                    if m:
                        car = {"idx": idx, "num": m.get("num", ""), "name": m.get("name", ""), "custId": m.get("custId", "")}
                if not car:
                    return False, "That car isn't in the session", None
            if kind != "noaction" and not car:
                return False, "Pick the car this is for", None
            if not q and not car:
                return False, "Pick an incident or a car", None
            lv = live or {}
            call = {
                "id": _next("c"), "at": _now(), "steward": steward[:60], "kind": kind, "value": value, "reason": reason,
                "incident": q["id"] if q else None, "car": car,
                "sess": q["sess"] if q else lv.get("sessNum", 0), "sessName": q["sessName"] if q else lv.get("sessionName", ""),
                "lap": q["lap"] if q else lv.get("lap"), "t": q["t"] if q else lv.get("sessTime"),
                "status": "active", "withdrawn": None,
            }
            text = sim_text(call)
            call["sim"] = {"cmd": text, "state": "ready"} if text else None
            d["calls"].append(call)
            if q:
                q["status"] = "decided" if any(c["kind"] != "noaction" for c in _active_calls(d, q["id"])) else "noaction"
            _changed()
            who = ("#%s %s" % (car["num"], car["name"])) if car else "incident %s" % q["id"]
            _log("Race control: %s - %s%s for %s (%s)" % (steward, KIND_LABEL[kind], (" (%s %s)" % (value, KIND_UNIT[kind])) if value else "",
                                                          who, reason or "no reason given"))
            return True, "", {"call": call}

        if cmd == "withdraw":                  # a call made by mistake: kept, marked withdrawn, with who and why
            c = next((c for c in d["calls"] if c["id"] == str(data.get("id") or "")), None)
            if not c:
                return False, "That call isn't in the log", None
            if c["status"] != "active":
                return False, "That call is already withdrawn", None
            steward = str(steward or "").strip()
            if not steward:
                return False, "Type your name at the top first", None
            reason = str(data.get("reason") or "").strip()[:300]
            if not reason:
                return False, "Say why it's withdrawn", None
            clear = None
            sim = c.get("sim")
            if data.get("clear") and sim and c.get("car") and sim["state"] in ("waiting", "inSim", "sent", "notTaken", "failed"):
                clear = "!clear #%s" % c["car"]["num"]      # clears all of that driver's penalties, iRacing's own too
            c["status"] = "withdrawn"
            c["withdrawn"] = {"at": _now(), "by": steward[:60], "reason": reason, "clear": bool(clear)}
            q = by_id.get(c.get("incident") or "")
            if q:
                left = _active_calls(d, q["id"])
                q["status"] = ("decided" if any(x["kind"] != "noaction" for x in left) else "noaction") if left else "reviewing"
            _changed()
            _log("Race control: %s withdrew call %s (%s)" % (steward, c["id"], reason))
            return True, "", {"clear": clear, "id": c["id"]}

        return False, "Unknown command", None


def start(log=print):
    global _log
    _log = log
    os.makedirs(DIR, exist_ok=True)
