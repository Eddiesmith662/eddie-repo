"""Incident log for the live timing window.

Builds a list of incidents from each reading of the race (the same `live` snapshot the overlay
gets). Two kinds of source:

  iracing    - something iRacing itself reports: off-track (track surface), incident points
               (+1x / +2x / +4x from the session results), black flag, meatball, warning,
               disqualified, retired (results "reason out" or the car leaving the world),
               caution, pit stops.
  predicted  - worked out from the cars' speeds and positions, because iRacing doesn't say what
               happened: spin / crash, car contact, wall contact, multi-car, stopped, slow,
               mechanical. These are best guesses.

Incident points for other drivers depend on the session: in some sessions iRacing doesn't share
them while spectating. The black box records them so we can check.
"""
import collections
import threading
import time

TYPES = [   # (key, label) in the order of the Types list in live timing
    ("offtrack", "Off-track"), ("spin", "Spin / Crash"), ("contact", "Car Contact"), ("wall", "Wall Contact"),
    ("multi", "Multi-car"), ("stopped", "Stopped"), ("mechanical", "Mechanical"), ("slow", "Slow (on track)"),
    ("retired", "Retired / DNF"), ("caution", "Caution"), ("meatball", "Meatball / Damage"), ("penalty", "Penalty"),
    ("warning", "Warning"), ("dq", "Disqualified"), ("pit", "Pit stop"),
]
KEEP = 300                 # incidents kept in the list
NEAR_M = 22.0              # another car this close (metres along the track) = probably contact
MULTI_M = 80.0             # incidents this close together ...
MULTI_S = 4.0              # ... and this close in time = one multi-car incident
# crash / spin: speed falls below 25% of what it was in the last 8 s (from at least 60 mph), while the rest of the field
# keeps going (under 35% of the field's speed). Real Talladega crash (Oct 2026): 185 -> 18 mph over about 8 seconds.
SPIN_FROM, SPIN_FRAC, SPIN_FIELD, SPIN_WINDOW = 60, 0.25, 0.35, 8.0
WALL_FROM, WALL_TO, WALL_WINDOW = 80, 25, 1.2   # an almost instant stop: hit something
STOP_MPH, STOP_SECS = 5, 2.0
SLOW_FRAC, SLOW_SECS = 0.45, 4.0   # under 45% of the field's speed for 4 seconds
MECH_SECS = 15.0                   # slow this long with nothing else happening = probably mechanical
RETIRE_SECS = 30.0                 # out of the world this long during a race = retired
REPEAT = {"offtrack": 6.0, "spin": 8.0, "contact": 8.0, "wall": 8.0, "stopped": 20.0, "slow": 30.0}

LOCK = threading.Lock()
STATE = {"list": [], "seq": 0, "ver": 0}


def _new_store():
    return {"cars": {}, "sess": None, "flag": None, "greenAt": None, "replay": False}


_store = _new_store()


def snapshot():
    with LOCK:
        return {"list": list(STATE["list"]), "ver": STATE["ver"], "types": TYPES}


def clear():
    with LOCK:
        STATE["list"] = []
        STATE["ver"] += 1


def find(eid):
    with LOCK:
        return next((e for e in STATE["list"] if e["id"] == eid), None)


def _add(ev, log=None):
    with LOCK:
        STATE["seq"] += 1
        ev["id"] = STATE["seq"]
        STATE["list"].append(ev)
        del STATE["list"][:-KEEP]
        STATE["ver"] += 1
    if log:
        who = ("#%s %s" % (ev["num"], ev["name"])) if ev.get("num") else ""
        log("Incident: %s %s%s (%s)" % (dict(TYPES)[ev["type"]], who, (" - " + ev["detail"]) if ev.get("detail") else "", ev["src"]))
    return ev


def _touch(ev):
    with LOCK:
        STATE["ver"] += 1


def update(live, track_m=0.0, log=None):
    """Feed one reading of the race. Call after the server has filled in pit state, speeds and flags."""
    global _store
    if not live or not live.get("connected"):
        return
    st = _store
    if live.get("isReplay"):          # the data is the replay, not the race: pause, and start fresh afterwards
        st["replay"] = True           # (checked first: a replay of an earlier session isn't a session change)
        return
    sess = (live.get("sessNum", 0), live.get("sessionName", ""))
    if st["sess"] != sess:
        if st["sess"] is not None:    # a new session (e.g. qualifying -> race): start the log over
            clear()
        _store = st = _new_store()
        st["sess"] = sess
    t = live.get("sessTime")
    if t is None:
        t = time.time()
    if st["replay"]:
        st["replay"] = False
        for cs in st["cars"].values():
            cs.update(hist=collections.deque(maxlen=40), stopT=None, slowT=None, slowLogged=False, mechLogged=False)
    state = live.get("sessionState", 0)
    flag = live.get("flag") or ""
    is_race = bool(live.get("isRace"))
    yellow = flag in ("caution", "red")
    racing = state == 4
    if racing and st["greenAt"] is None:
        st["greenAt"] = t
    cars = live.get("cars") or []
    track_m = track_m or live.get("trackM") or 0.0
    base = {"sess": live.get("sessNum", 0), "sessName": live.get("sessionName", ""), "t": round(t, 2)}

    # caution (whole field)
    if flag != st["flag"]:
        if flag == "caution" and st["flag"] is not None and state >= 4:
            recent = [e for e in STATE["list"] if e.get("idx") is not None and t - e["t"] < 15 and e["sess"] == base["sess"]
                      and e["type"] in ("spin", "contact", "wall", "multi", "stopped")]
            why = ("after " + ", ".join("#%s" % e["num"] for e in recent[-3:])) if recent else ""
            _add(dict(base, type="caution", src="iracing", idx=None, num="", name="", lap=live.get("lap"), pos=None,
                      detail=("Lap %s" % live.get("lap")) + ((" · " + why) if why else "")), log)
        st["flag"] = flag

    # field speed for "slow"
    moving = sorted(c["mph"] for c in cars if c.get("mph") and c.get("onTrack") and not c.get("pit"))
    median = moving[len(moving) // 2] if len(moving) >= 3 else None
    prog = {c["idx"]: c.get("progress") for c in cars if c.get("onTrack") and c.get("progress") is not None}

    def near(idx, metres):
        p = prog.get(idx)
        if p is None or not track_m:
            return []
        out = []
        for o, q in prog.items():
            if o == idx:
                continue
            d = abs(((p - q) + 0.5) % 1.0 - 0.5) * track_m     # distance around the lap, ignoring which lap
            if d <= metres:
                out.append((d, o))
        # closest first, but a car that is also slowing sharply (the one it hit) comes before one driving past
        slow = lambda o: (by_idx.get(o, {}).get("mph") or 0) < (median or 999) * 0.5
        return [o for d, o in sorted(out, key=lambda x: (not slow(x[1]), x[0]))]

    by_idx = {c["idx"]: c for c in cars}
    for c in cars:
        idx = c["idx"]
        cs = st["cars"].get(idx)
        if cs is None:
            cs = st["cars"][idx] = {"hist": collections.deque(maxlen=40), "surf": c.get("surf"), "inc": c.get("inc"),
                                    "flags": {"penalty": bool(c.get("blackFlag")), "meatball": bool(c.get("meatball")),
                                              "warning": bool(c.get("warning")), "dq": bool(c.get("dq"))},
                                    "pitState": c.get("pitState"), "last": {}, "stopT": None, "slowT": None,
                                    "slowLogged": False, "mechLogged": False, "outT": None, "seen": False, "retired": False,
                                    "outReason": c.get("outReason") or ""}
            continue
        car = dict(base, idx=idx, num=c.get("num", ""), name=c.get("name", ""), pos=c.get("pos"),
                   lap=int(c["progress"]) if c.get("progress") is not None else None)

        def emit(kind, src, detail="", **kw):
            gap = REPEAT.get(kind)
            if gap and t - cs["last"].get(kind, -1e9) < gap:
                return None
            cs["last"][kind] = t
            return _add(dict(car, type=kind, src=src, detail=detail, **kw), log)

        # flags from iRacing (rising edges)
        for kind, on, text in (("penalty", c.get("blackFlag"), "Black flag"), ("meatball", c.get("meatball"), "Meatball flag (repairs needed)"),
                               ("warning", c.get("warning"), "Warning flag"), ("dq", c.get("dq"), "Disqualified")):
            on = bool(on)
            if on and not cs["flags"][kind]:
                emit(kind, "iracing", text)
            cs["flags"][kind] = on

        # pit stop finished (the stop time is known once the car leaves its box)
        ps = c.get("pitState")
        if ps == "done" and cs["pitState"] != "done" and c.get("pitTime") is not None:
            emit("pit", "iracing", "Stop %s · %.1fs" % (c.get("stops") or "", c["pitTime"]))
        cs["pitState"] = ps

        # retired / DNF
        on_track = bool(c.get("onTrack"))
        reason = c.get("outReason") or ""
        if on_track:
            cs["seen"] = True
            cs["outT"] = None
        elif cs["seen"] and cs["outT"] is None:
            cs["outT"] = t
        if is_race and racing and not cs["retired"]:
            if reason and reason.lower() not in ("running", "") and reason != cs["outReason"]:
                cs["retired"] = True
                emit("retired", "iracing", reason)
            elif cs["outT"] is not None and t - cs["outT"] >= RETIRE_SECS and not c.get("pit"):
                cs["retired"] = True
                emit("retired", "iracing", "Left the race (out of the car for %ds)" % RETIRE_SECS)
        cs["outReason"] = reason

        # off-track (iRacing's track surface)
        surf = c.get("surf")
        if surf == 0 and cs["surf"] not in (0, None) and on_track and not c.get("pit"):
            emit("offtrack", "iracing", "Off track")
            cs["offT"] = t
        cs["surf"] = surf

        # incident points from iRacing's results (+1x off-track, +2x loss of control, +4x heavy contact)
        inc = c.get("inc")
        if inc is not None and cs["inc"] is not None and inc > cs["inc"]:
            pts = inc - cs["inc"]
            recent = next((e for e in reversed(STATE["list"]) if e.get("idx") == idx and e["sess"] == car["sess"]
                           and t - e["t"] < 12 and e["type"] in ("offtrack", "spin", "contact", "wall", "stopped")), None)
            if recent:      # the points belong to what we already logged: add them to it
                recent["pts"] = recent.get("pts", 0) + pts
                if recent["src"] == "predicted":
                    recent["src"] = "both"
                if pts >= 4 and recent["type"] in ("spin", "wall", "stopped"):
                    recent["type"] = "contact"
                _touch(recent)
            else:
                kind = "contact" if pts >= 4 else "spin" if pts >= 2 else "offtrack"
                cs["last"].pop(kind, None)
                if pts >= 2:
                    cs["last"]["slow"] = cs["last"]["stopped"] = t   # the slow-down that follows is part of it
                emit(kind, "iracing", {1: "Off track", 2: "Loss of control"}.get(pts, "Contact"), pts=pts)
        if inc is not None:
            cs["inc"] = inc

        # speed-based guesses (racing, on track, not on pit road)
        mph = c.get("mph")
        # only in races: in practice and qualifying cars slow down and stop after their runs, which isn't an incident
        active = is_race and racing and on_track and not c.get("pit") and mph is not None and surf not in (1, 2)   # 1 pit stall, 2 pit entry lane
        settled = st["greenAt"] is not None and t - st["greenAt"] > 20
        if not active:
            cs["hist"].clear()
            cs["stopT"] = cs["slowT"] = None
            continue
        cs["hist"].append((t, mph))
        if not settled or state != 4:
            continue
        if flag == "red":
            continue
        hist = cs["hist"]
        crash = None
        wall_peak = max((m for (ht, m) in hist if t - ht <= WALL_WINDOW), default=0)
        spin_peak = max((m for (ht, m) in hist if t - ht <= SPIN_WINDOW), default=0)
        if mph < WALL_TO and wall_peak >= WALL_FROM:
            crash = "wall"
        elif spin_peak >= SPIN_FROM and mph < spin_peak * SPIN_FRAC and (not median or mph < median * SPIN_FIELD):
            crash = "spin"
        if crash:
            others = near(idx, NEAR_M)
            if others:
                o = by_idx.get(others[0], {})
                ev = emit("contact", "predicted", "Sudden stop next to #%s %s" % (o.get("num", "?"), o.get("name", "")),
                          speedFrom=round(max(spin_peak, wall_peak)))
            elif crash == "wall":
                ev = emit("wall", "predicted", "Stopped almost instantly from %d mph" % wall_peak, speedFrom=round(wall_peak))
            else:
                was_off = t - cs.get("offT", -1e9) < 4
                ev = emit("spin", "predicted", ("Off track, then " if was_off else "") + "slowed from %d to %d mph" % (spin_peak, mph),
                          speedFrom=round(spin_peak))
            if ev:
                _multi(ev, t, track_m, prog, log)
                _caution_cause(ev, t)
            for k in ("contact", "wall", "spin", "stopped", "slow"):   # one crash, one entry (not "stopped" / "slow" as well)
                cs["last"][k] = t

        # stopped on track
        if mph < STOP_MPH:
            cs["stopT"] = cs["stopT"] or t
            if t - cs["stopT"] >= STOP_SECS:
                ev = emit("stopped", "predicted", "Stopped on track")
                if ev:
                    _multi(ev, t, track_m, prog, log)
        else:
            cs["stopT"] = None

        # slow on track, and mechanical if it stays slow with nothing else going on
        if median and not yellow and STOP_MPH <= mph < median * SLOW_FRAC:
            cs["slowT"] = cs["slowT"] or t
            dur = t - cs["slowT"]
            if dur >= SLOW_SECS and not cs["slowLogged"]:
                cs["slowLogged"] = True
                emit("slow", "predicted", "%d mph, field at %d mph" % (mph, median))
            if dur >= MECH_SECS and not cs["mechLogged"]:
                trouble = [e for e in STATE["list"] if e.get("idx") == idx and e["sess"] == car["sess"] and 0 <= cs["slowT"] - e["t"] < 20
                           and e["type"] in ("offtrack", "spin", "contact", "wall", "stopped", "multi")]
                cs["mechLogged"] = True
                if not trouble:
                    emit("mechanical", "predicted", "Slow for %ds with no incident: possible mechanical problem" % MECH_SECS)
        elif mph >= (median or 0) * 0.7:
            cs["slowT"] = None
            cs["slowLogged"] = cs["mechLogged"] = False


def _caution_cause(ev, t):
    """A crash spotted just after the caution came out: name it on the caution entry."""
    with LOCK:
        c = next((e for e in reversed(STATE["list"]) if e["type"] == "caution" and e["sess"] == ev["sess"] and 0 <= t - e["t"] <= 15), None)
        if not c:
            return
        nums = c.setdefault("causes", [])
        if ev["num"] in nums:
            return
        nums.append(ev["num"])
        c["detail"] = "Lap %s · after %s" % (c.get("lap"), ", ".join("#" + n for n in nums[:4]))
        STATE["ver"] += 1


def _multi(ev, t, track_m, prog, log):
    """Group crashes close together in time and on track into one multi-car entry."""
    if not track_m:
        return
    p = prog.get(ev["idx"])
    if p is None:
        return
    with LOCK:
        lst = STATE["list"]
        group = None
        for e in reversed(lst):
            if t - e["t"] > MULTI_S + 6:
                break
            if e["type"] == "multi" and e["sess"] == ev["sess"] and t - e["t"] <= MULTI_S + 6:
                group = e
                break
        partners = []
        for e in reversed(lst):
            if t - e["t"] > MULTI_S:
                break
            if e is ev or e.get("idx") in (None, ev["idx"]) or e["sess"] != ev["sess"]:
                continue
            if e["type"] not in ("spin", "contact", "wall", "stopped"):
                continue
            q = prog.get(e["idx"])
            if q is None or abs(((p - q) + 0.5) % 1.0 - 0.5) * track_m > MULTI_M:
                continue
            partners.append(e)
    if not partners:
        return
    members = [{"idx": e["idx"], "num": e["num"], "name": e["name"]} for e in partners + [ev]]
    if group and any(m["idx"] in {g["idx"] for g in group["cars"]} for m in members):
        have = {g["idx"] for g in group["cars"]}
        for m in members:
            if m["idx"] not in have:
                group["cars"].append(m)
        group["detail"] = "%d cars: %s" % (len(group["cars"]), ", ".join("#" + m["num"] for m in group["cars"]))
        _touch(group)
        return
    first = partners[-1]
    _add({"sess": ev["sess"], "sessName": ev["sessName"], "t": first["t"], "type": "multi", "src": "predicted",
          "idx": first["idx"], "num": first["num"], "name": first["name"], "pos": first.get("pos"), "lap": first.get("lap"),
          "cars": members, "detail": "%d cars: %s" % (len(members), ", ".join("#" + m["num"] for m in members))}, log)
