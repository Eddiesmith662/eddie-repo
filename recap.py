"""Race recap: cautions and lead changes so far, for the Race recap bar under the VSPEED logo (Race tab, RACE RECAP).

Two counts, and the bar shows the larger of the two:
  - iRacing's own (the session's ResultsNumCautionFlags and ResultsNumLeadChanges). It covers the whole race even when
    the overlay was started part-way through it.
  - the overlay's own, from the readings it sees: a caution each time the race goes from green to yellow, and a lead
    change each time a different car leads at the start/finish line (the way NASCAR counts them). It covers iRacing not
    having updated its numbers yet.

Only races, only while racing (not the pace laps, not after the checkered), and never from a replay. Everything starts
over with each new session.
"""
import threading

LOCK = threading.Lock()


def _new(key):
    return {"key": key, "cautions": 0, "leads": 0, "yellow": None, "lineLap": None, "lineLeader": None}


_st = _new(None)


def _num(v):
    try:
        n = int(v)
        return n if n >= 0 else None
    except (TypeError, ValueError):
        return None


def update(live):
    """Feed every reading (after the cars are in running order). Adds live["recap"] = {"cautions", "leadChanges"}."""
    global _st
    key = (live.get("subId"), live.get("sessNum"), live.get("sessionName"))
    with LOCK:
        if _st["key"] != key:
            _st = _new(key)
        st = _st
        racing = live.get("connected") and live.get("isRace") and live.get("sessionState") == 4 and not live.get("isReplay")
        if racing:
            yellow = live.get("flag") in ("caution", "red")
            # a new caution: green to yellow (a red flag during a caution is the same caution). Started under yellow
            # (the overlay opened mid-caution): not counted here, iRacing's own count has it
            if yellow and st["yellow"] is False:
                st["cautions"] += 1
            st["yellow"] = yellow
            cars = live.get("cars") or []
            leader = cars[0] if cars else None
            lap = (leader or {}).get("lapsCompleted") or 0
            if leader is not None and leader.get("progress") is not None and lap > (st["lineLap"] or 0):
                # the leader has just crossed the line: a different car from the last time = a lead change
                if st["lineLeader"] is not None and leader.get("idx") != st["lineLeader"]:
                    st["leads"] += 1
                st["lineLap"], st["lineLeader"] = lap, leader.get("idx")
        ir = live.get("irRecap") or {}
        out = {"cautions": max(st["cautions"], _num(ir.get("cautions")) or 0),
               "leadChanges": max(st["leads"], _num(ir.get("leadChanges")) or 0)}
    live["recap"] = out
    return out
