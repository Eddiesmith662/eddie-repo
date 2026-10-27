"""Race off pit road: who won and lost spots on pit road during a pit cycle.

Under caution, the cycle starts by itself when a car comes down pit road (at least MIN_CARS have to pit for it to
count; real Talladega race, Oct 24: the leaders stayed out and only P12 back pitted). The running order at
that moment is the "in" order. Every car that comes in while the cycle is open is tracked to pit exit; the
"out" order is the order they leave pit road. Gained / lost is counted among the cars that pitted (cars that
stayed out don't count, they're listed separately). The box time comes from the pit stop timer.

The cycle closes once nobody new has come in for ENTRY_GAP seconds and everyone who pitted is back out
(or has been on pit road for STUCK seconds: repairs, parked). Then it's READY in the control panel, and goes
on air only when Show is pressed.
"""
import threading
import time

TOP = 10              # rows on the graphic
ENTRY_GAP = 30.0      # the cycle stays open for new cars until nobody has come in for this long
STUCK = 90.0          # on pit road longer than this: repairs or parked, the cycle doesn't wait for them
STAYED_MAX = 6        # names on the STAYED OUT line
MIN_CARS = 3          # fewer cars than this pitting isn't a pit cycle (one car in for repairs)

LOCK = threading.Lock()
STATE = {"status": "idle", "ver": 0}     # idle | capturing | ready
_cap = None            # the cycle being captured
_prev_pit = {}
_sess = None
_manual = False
_prev_flag = None


def capture_now():
    """Start a cycle by hand (e.g. green-flag stops)."""
    global _manual
    _manual = True


def snapshot():
    with LOCK:
        return dict(STATE)


def _publish(**kw):
    with LOCK:
        STATE.update(kw)
        STATE["ver"] += 1


def _start(live, t, manual, before=None):
    global _cap
    order = [c for c in (live.get("cars") or [])]
    _cap = {"before": before or STATE.get("status", "idle"), "t0": t, "lap": live.get("lap"), "caution": live.get("flag") == "caution", "manual": manual,
            "inPos": {c["idx"]: i for i, c in enumerate(order)},          # running order when the cycle began
            "cars": {}, "lastEntry": t}
    # the last finished cycle stays in "list" (and on air, if it is) until this one is ready
    _publish(status="capturing", lap=_cap["lap"], caution=_cap["caution"], count=0, lastOut=None)


def update(live, log=None):
    """Feed every reading of the race (after pit state and stop times are filled in)."""
    global _cap, _prev_pit, _sess, _manual, _prev_flag
    if not live or not live.get("connected") or live.get("isReplay"):
        return
    sess = (live.get("sessNum"), live.get("sessionName"))
    if sess != _sess:
        _sess, _cap, _prev_pit = sess, None, {}
        _publish(status="idle", list=[], stayed=[], count=0)
    if not live.get("isRace") or live.get("sessionState") != 4:
        _manual = False
        return
    t = live.get("sessTime") or time.time()
    flag = live.get("flag")
    if flag == "caution" and _prev_flag not in (None, "caution") and STATE.get("status") != "capturing":
        # a new caution: clear the last pit cycle so the graphic starts clean as cars come off pit road this time
        # (if it's left on air it disappears now and comes back with the first car out)
        _cap = None
        _publish(status="idle", list=[], live=[], stayed=[], count=0, listLap=None, liveLap=None, lastOut=None)
        if log:
            log("Race off pit road: cleared for the new caution (lap %s)" % live.get("lap"))
    _prev_flag = flag
    cars = live.get("cars") or []
    pos = {c["idx"]: i for i, c in enumerate(cars)}
    entering = [c for c in cars if c.get("pit") and not _prev_pit.get(c["idx"], True)]

    if _manual:
        _manual = False
        _start(live, t, True)
        if log:
            log("Race off pit road: capture started by hand (lap %s)" % live.get("lap"))
    elif (_cap is None or STATE["status"] != "capturing") and live.get("flag") == "caution" and entering:
        if _cap is None or t - _cap["t0"] > 60:    # a new caution pit cycle (not the stragglers of the last one)
            _start(live, t, False)
            if log:
                log("Race off pit road: caution pit cycle started (lap %s)" % live.get("lap"))

    if _cap is not None and STATE["status"] == "capturing":
        byi = {c["idx"]: c for c in cars}
        for c in entering:
            if (t - _cap["lastEntry"] > ENTRY_GAP and 0 < len(_cap["cars"]) < MIN_CARS and not _cap["manual"]
                    and live.get("flag") == "caution"):
                # the car(s) that started the cycle were on their own (in early for damage, a penalty): the real pit cycle
                # is this wave (Nashville, Oct 26: #52 came in alone 31 s before the field, and the field was missed)
                _start(live, t, False, before=_cap["before"])
                if log:
                    log("Race off pit road: restarted with the main wave (lap %s)" % live.get("lap"))
            if t - _cap["lastEntry"] <= ENTRY_GAP or not _cap["cars"]:
                _cap["cars"][c["idx"]] = {"in": t, "out": None, "stop": None, "pen": False,
                                          "num": c.get("num"), "name": c.get("name"), "cls": c.get("cls")}
                _cap["lastEntry"] = t
        for idx, e in _cap["cars"].items():
            c = byi.get(idx)
            if not c:
                continue
            if c.get("blackFlag"):
                e["pen"] = True
            if e["out"] is None and not c.get("pit") and t > e["in"] + 1:
                e["out"] = t
            if c.get("pitState") in ("stall", "done") and c.get("pitTime") is not None:
                e["stop"] = round(c["pitTime"], 1)       # the box time (final once the car has left)
        open_ = t - _cap["lastEntry"] <= ENTRY_GAP
        waiting = [e for e in _cap["cars"].values() if e["out"] is None and t - e["in"] < STUCK]
        # the live look: cars appear as they reach the pit lane exit (only once it's a real cycle, so one car in on its
        # own doesn't take the place of the last finished list on air)
        live = _rows(_cap) if (len(_cap["cars"]) >= MIN_CARS or _cap["manual"]) else []
        upd = {"count": len(_cap["cars"]), "lastOut": max((e["out"] for e in _cap["cars"].values() if e["out"]), default=None)}
        if live != STATE.get("live"):
            upd.update(live=live, liveLap=_cap["lap"], liveCaution=_cap["caution"])
        if any(STATE.get(k) != v for k, v in upd.items()):
            _publish(**upd)
        if not open_ and not waiting and _cap["cars"]:
            _finish(cars, t, log)
    _prev_pit = {c["idx"]: bool(c.get("pit")) for c in cars}


def _rows(cap):
    """Cars that have left pit road, in the order they left, with spots gained or lost: where each came in among the
    cars that came down pit road (running order when the cycle began) against where it came out. A car that comes in
    later is behind the earlier ones in the running order, so rows already shown keep their arrows."""
    entered = cap["cars"]
    in_rank = {i: r for r, i in enumerate(sorted(entered, key=lambda i: cap["inPos"].get(i, 999)))}
    out = sorted((i for i, e in entered.items() if e["out"] is not None), key=lambda i: entered[i]["out"])
    return [{"num": entered[i]["num"], "name": entered[i]["name"], "cls": entered[i]["cls"], "gained": in_rank[i] - r,
             "stop": entered[i]["stop"], "penalty": entered[i]["pen"]} for r, i in enumerate(out)]


def _finish(cars, t, log):
    cap = _cap
    pitted = {i: e for i, e in cap["cars"].items() if e["out"] is not None}
    if len(pitted) < MIN_CARS and not cap["manual"]:
        # one or two cars in (repairs, a penalty): not a pit cycle; keep whatever was there before
        _publish(status=cap["before"] if cap["before"] != "capturing" else "idle", live=[])
        return
    rows = _rows(cap)
    out = sorted(pitted, key=lambda i: pitted[i]["out"])
    # stayed out: cars that were running ahead of the last car shown on the graphic and didn't pit
    shown = out[:TOP]
    deepest = max((cap["inPos"].get(i, 0) for i in shown), default=-1)
    names = {c["idx"]: c for c in cars}
    stayed = [names[i] for i, p in sorted(cap["inPos"].items(), key=lambda kv: kv[1])
              if p <= deepest and i not in cap["cars"] and i in names]
    _publish(status="ready", list=rows, live=[], listLap=cap["lap"], listCaution=cap["caution"], stayed=[{"num": c.get("num"), "name": c.get("name")} for c in stayed],
             count=len(pitted), readyAt=time.time())
    if log:
        log("Race off pit road ready: %d cars pitted, first out #%s" % (len(rows), rows[0]["num"] if rows else "?"))
