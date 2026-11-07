"""Replays a recorded race (a black box from data/logs, as saved in a diagnostics zip) through the overlay's real code:
IRacingSource.tick() reads it from a stand-in for iRacing, then server.process_reading() runs the penalties, incident
log, race off pit road and live points, exactly as on race night. No iRacing, no internet, no real data folder.

The black box keeps one reading a second (the overlay reads five a second), and doesn't record a few things, which are
filled in here: driver names (made up from the car number), each car's laps completed (its lap minus one), class
positions, and iRacing's results list (older black boxes don't have it).

Each recording has a "golden" file: what the overlay showed every second (flag, lap, running order, gaps, pit stops ...)
when it was last checked by a person. The tests replay the race and compare. When a change is meant to alter what the
overlay shows, look at the differences the test prints, and if they're right, save new golden files with:

    python tests\\replay.py --update
"""
import gzip
import json
import os
import sys

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import support  # noqa: E402,F401  (first: throwaway data folder)

import incidents  # noqa: E402
import pitrace  # noqa: E402
import recap  # noqa: E402
import server  # noqa: E402

# the recordings in tests/fixtures, with what the black box doesn't record about the race itself
RECORDINGS = {
    # Talladega, Oct 24 2026, laps 35 to the finish: cautions on laps 40 and 49, overtime, white and checkered flags
    "talladega-2026-10-24-finish": {"track": "Talladega Super Speedway", "length": "2.66 mi", "laps": 50},
    # the same race, laps 15 to 22: caution on lap 17 (pit stops under it), green again on lap 20
    "talladega-2026-10-24-caution": {"track": "Talladega Super Speedway", "length": "2.66 mi", "laps": 50},
}
SESSION_TYPES = ["Practice", "Lone Qualify", "Race"]


def load(name):
    with gzip.open(os.path.join(support.FIXTURES, name + ".jsonl.gz"), "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class FakeIR:
    """Answers the way pyirsdk does (ir["Name"]), from one black box reading at a time."""
    is_initialized = is_connected = True

    def __init__(self, meta, readings):
        self.vals = {}
        cars = {}
        for r in readings:
            for c in r["cars"]:
                cars[c[0]] = c[1]
        self.size = max(cars) + 1 if cars else 64
        self.static = {
            "DriverInfo": {"Drivers": [{
                "CarIdx": i, "CarNumber": num, "UserName": "Test Driver %s" % num, "AbbrevName": "T. Driver%s" % num,
                "TeamName": "", "CarClassShortName": "", "CarClassColor": 0, "CarClassEstLapTime": 50.0,
                "CarScreenName": "Test Car", "CarScreenNameShort": "Test Car", "UserID": 900000 + i, "IRating": 2000,
                "CarPath": "", "CarDesignStr": "", "CarNumberDesignStr": ""} for i, num in sorted(cars.items())]},
            "WeekendInfo": {"TrackDisplayName": meta["track"], "TrackLength": meta["length"], "SubSessionID": 1, "LeagueID": 0,
                            "WeekendOptions": {}},
            "SessionInfo": {"Sessions": [{"SessionNum": k, "SessionType": t, "SessionName": t.upper(),
                                          "SessionLaps": meta["laps"] if t == "Race" else "unlimited"}
                                         for k, t in enumerate(SESSION_TYPES)]},
            "CameraInfo": {"Groups": [{"GroupNum": 1, "GroupName": "TV1"}]},
            "QualifyResultsInfo": {},
        }

    def set(self, r):
        n = self.size
        arr = lambda default: [default] * n
        lap, lapc, pct, pit, surf, pos, flags = arr(-1), arr(-1), arr(-1.0), arr(False), arr(-1), arr(0), arr(0)
        f2, est, last, best = arr(-1.0), arr(0.0), arr(-1.0), arr(-1.0)
        gear, rpm = arr(None), arr(None)       # in black boxes from Nov 2026 on (older ones: not recorded)
        for c in r["cars"]:
            i = c[0]
            lap[i], pct[i], pit[i], surf[i], pos[i], flags[i] = c[2], c[3], bool(c[4]), c[5], c[6] or 0, c[7] or 0
            lapc[i] = c[2] - 1 if (c[2] or 0) >= 1 else -1
            f2[i], est[i], last[i], best[i] = c[8], c[9], c[10], c[11]
            if len(c) >= 14:
                gear[i], rpm[i] = c[12], c[13]
        self.vals = dict(self.static, **{
            "SessionNum": r["sess"], "SessionState": r["state"], "SessionFlags": r["flags"], "SessionTime": r["sessTime"],
            "SessionTimeRemain": None, "IsReplayPlaying": bool(r.get("replay")), "ReplayFrameNumEnd": 1000,
            "ReplayPlaySpeed": 1, "ReplayPlaySlowMotion": False, "CamCameraState": 0, "CamCarIdx": r.get("cam"),
            "CamGroupNumber": 1, "CarIdxLap": lap, "CarIdxLapCompleted": lapc, "CarIdxLapDistPct": pct,
            "CarIdxOnPitRoad": pit, "CarIdxTrackSurface": surf, "CarIdxPosition": pos, "CarIdxClassPosition": arr(0),
            "CarIdxSessionFlags": flags, "CarIdxF2Time": f2, "CarIdxEstTime": est, "CarIdxLastLapTime": last,
            "CarIdxBestLapTime": best,
            "CarIdxGear": gear if any(v is not None for v in gear) else None,
            "CarIdxRPM": rpm if any(v is not None for v in rpm) else None,
        })

    def __getitem__(self, key):
        return self.vals.get(key)

    def freeze_var_buffer_latest(self):
        pass

    def unfreeze_var_buffer_latest(self):
        pass


def _fresh():
    """Start every replay from a clean overlay (the modules keep the race in memory)."""
    incidents.clear()
    incidents._store = incidents._new_store()
    pitrace._cap, pitrace._prev_pit, pitrace._sess, pitrace._manual, pitrace._prev_flag = None, {}, None, False, None
    with pitrace.LOCK:
        pitrace.STATE.clear()
        pitrace.STATE.update(status="idle", ver=0)
    server.PEN.update(seq=0, list=[], prev={}, init=False, hide=0)
    recap._st = recap._new(None)    # both Talladega recordings are the same session: start each replay's count over
    server.STATE.settings["paintDir"] = os.path.join(support.DATA, "no-paint")   # never look in the real Documents folder


def replay(name):
    """Run a recording through the overlay. Yields (black box reading, what the overlay made of it) each second."""
    readings = load(name)
    meta = RECORDINGS[name]
    _fresh()
    src = object.__new__(server.IRacingSource)      # the real class, without starting the iRacing SDK
    src.irsdk, src.ir = None, FakeIR(meta, readings)
    src.connected, src.last_info_update, src.drivers, src.info, src.pit_store = True, -1, {}, {}, {}
    for r in readings:
        src.ir.set(r)
        live = src.tick()
        server.process_reading(live)
        yield r, live


def summary(live):
    """What a viewer would see from one reading, kept small enough to store every second of a race."""
    cars = live.get("cars") or []
    return {
        "t": live.get("sessTime"), "flag": live.get("flag"), "lap": live.get("lap"), "final": live.get("finalLap"),
        "ot": live.get("overtime"), "otg": live.get("oneToGreen"),
        "order": [c["num"] for c in cars],
        "gap": [c.get("gap") for c in cars[:12]],
        "pit": sorted(c["num"] for c in cars if c.get("pit")),
        "stops": {c["num"]: c["stops"] for c in cars if c.get("stops")},
        "pr": pitrace.snapshot().get("status"),
        "inc": len(incidents.snapshot()["list"]),
        "recap": live.get("recap"),
    }


def golden_path(name):
    return os.path.join(support.FIXTURES, name + ".golden.json.gz")


def run_summaries(name):
    return [summary(live) for _, live in replay(name)]


def load_golden(name):
    try:
        with gzip.open(golden_path(name), "rt", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def save_golden(name, rows):
    with gzip.open(golden_path(name), "wt", encoding="utf-8") as f:
        json.dump(rows, f, separators=(",", ":"))


def differences(old, new, limit=8):
    """The first few seconds where the overlay now shows something else, in words."""
    out = []
    if len(old) != len(new):
        out.append("%d readings recorded, %d now" % (len(old), len(new)))
    for a, b in zip(old, new):
        keys = [k for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
        if keys:
            out.append("session time %s: " % a.get("t") + "; ".join("%s was %s, now %s" % (k, a.get(k), b.get(k)) for k in keys))
            if len(out) >= limit:
                out.append("...")
                break
    return out


if __name__ == "__main__":
    if "--update" not in sys.argv:
        print(__doc__)
        sys.exit(0)
    for name in RECORDINGS:
        rows = run_summaries(name)
        old = load_golden(name)
        diff = differences(old, rows) if old else ["(new)"]
        save_golden(name, rows)
        print("%s: %d readings saved. %s" % (name, len(rows), "Changes:\n  " + "\n  ".join(diff) if diff else "No changes."))
