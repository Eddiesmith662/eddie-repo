"""
VSPEED Broadcast Overlay - bridge server

Reads live data from iRacing (via pyirsdk) and serves:
  /overlay   -> full 1920x1080 transparent overlay for a web browser input in your broadcasting software
  /control   -> producer control panel (works from any device on your network)

Run:   python server.py            (live iRacing, falls back to "waiting" until the sim is running)
       python server.py --demo     (fake race so you can design/test without iRacing)

Only the Python standard library is needed for demo mode.
Live mode needs:  pip install pyirsdk
"""

import argparse
import copy
import json
import math
import os
import random
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote
import urllib.request
import urllib.error

import datafiles   # first: moves an older install's files into the data folder
import standings
import update
import diag
import incidents

ROOT = datafiles.ROOT
STATIC = os.path.join(ROOT, "static")
SETTINGS_FILE = datafiles.SETTINGS_FILE
SPONSOR_DIR = datafiles.SPONSOR_DIR            # sponsor images loaded from the Race tab
LOGO_DIR = datafiles.LOGO_DIR                  # league logos (top right)
SPONSOR_SLOTS = ["green", "restart", "white", "read1", "read2", "read3", "pole"]   # "pole" = the Pole Award badge (Grid)
SPONSOR_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

# --------------------------------------------------------------------------
# Producer settings (what the control panel changes). Saved to settings.json
# --------------------------------------------------------------------------
DEFAULT_SETTINGS = {
    "show": {
        "logo": True,          # VSPEED logo, top left
        "league": True,        # league logo + LIVE/REPLAY tag, top right
        "tower": False,        # vertical ticker / timing tower (starts off; turned on from the panel)
        "lowerthird": False,   # focused driver info (starts off)
        "flags": True,         # automatic flag banners
        "board": False,        # starting grid / results board
        "movers": False,       # biggest movers: top 5 positions gained since the start
    },
    "raceName": "VSPEED RACING LEAGUE",
    "leagueLogo": "league_logo.png",
    "logoStyle": "slant",      # VSPEED logo box: slant | straight (right-click the logo tile)
    "liveMode": "auto",        # auto | live | replay
    "towerMode": "leader",     # interval | leader
    "towerRows": 20,           # rows on the ticker
    "towerFixed": 15,          # top N always shown; the rows below them page through the rest of the field
    "towerPageSec": 8,         # seconds per page
    "classSplit": True,        # with more than one class, group the ticker by class (IMSA style)
    "classRowSlots": [5, 15],  # ticker rows for the fastest class and the next class when grouped
    "classFilter": "",         # "" = all classes, otherwise class short name
    "lowerThirdMode": "always",  # always | oncut (show 8s after each camera change)
    "boardTitle": "",            # empty = RESULTS
    "gridw": {"visible": False, "t": 0, "rowSec": 6, "end": "hide", "step": {"n": 0, "dir": 1},
              "pole": {"on": False, "t": 0}},   # Grid widget; pole = Pole Award shown over the pole sitter on Row 1
    "paintDir": "",            # iRacing paint folder; empty = Documents\\iRacing\\paint
    # address of iRacing's car render. {placeholders} are filled from the session's driver info
    "renderCustNum": "",       # extra render setting for custom-number paints (found by the Test button)
    "renderUrl": "http://127.0.0.1:32034/pk_car.png?size=2&view=1&licCol={licCol}&club={club}&sponsors={sponsors}&numPat={numPat}&numCol={numCol}&numSlnt={numSlnt}&carPath={carPath}&carPat={carPat}&carCol={carCol}&carRimType=2&carRimCol={rimCol}&carCustPaint={carCustPaint}&carSpecPaint={carSpecPaint}&numCustPaint={numCustPaint}",
    # widget positions/sizes from the Layout tab: { id: {x, y, s} } (VSPEED's own layout as the starting point)
    "layout": {
        "team": {"x": 933, "y": 965, "s": 0.81},
        "lower": {"x": 639, "y": 972},
        "flag": {"x": 1000, "y": 45, "s": 0.84},
        "league": {"x": 1835, "y": 223},
        "standings": {"x": 396, "y": 232, "s": 0.83},
        "board": {"x": 1002, "y": 232, "s": 1.11},
        "info": {"x": 1891, "y": 978},
        "sponsor": {"x": 960, "y": 34, "s": 1.15},
    },
    "trackGraphic": "",        # Drive graphic used by the Track graphic button on the Race tab
    "graphicsDir": "",         # Drive for desktop folder with ready-made graphics, e.g. G:\\My Drive\\VSPEED\\Graphics
    "gfx": {"file": "", "visible": False, "anim": "slide", "hold": 0, "t": 0},
    "flagTrigger": {"flag": "", "t": 0},  # manual flag banner from the panel
    "diag": {"blackbox": True},           # keep the last 30 minutes of raw iRacing data in data/logs (Setup tab)
    # sponsor graphics (Race tab): one image per slot, one on air at a time; hold = seconds before it hides itself (0 = stays)
    "sponsor": {"active": "", "t": 0, "hold": 0, "files": {k: "" for k in SPONSOR_SLOTS}},
}


def deep_merge(base, patch):
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


APP = {"version": update.local_version(), "update": None}   # shown in the control panel


def update_watch():
    """Look for a newer release now and then, so the panel can say an update is waiting.
    Installing only ever happens at startup (run.py), never while the server is running."""
    time.sleep(5)
    while True:
        info = update.check_latest(timeout=8)
        if info and (APP["update"] or {}).get("version") != info["version"]:
            APP["update"] = {"version": info["version"], "name": info["name"]}
            print("Update v%s is available: restart the overlay to install it." % info["version"])
            STATE.notify()
        time.sleep(6 * 3600)


class State:
    def __init__(self):
        self.lock = threading.Condition()
        self.version = 0
        self.settings = copy.deepcopy(DEFAULT_SETTINGS)
        self.live = {"connected": False, "source": "none", "cars": []}
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    deep_merge(self.settings, json.load(f))
            except Exception as e:
                print("Could not read settings.json:", e)

    def bump(self):
        self.version += 1
        self.lock.notify_all()

    def update_settings(self, patch):
        with self.lock:
            deep_merge(self.settings, patch)
            self.bump()
            snapshot = json.dumps(self.settings, indent=2)
        try:
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                f.write(snapshot)
        except Exception as e:
            print("Could not save settings.json:", e)

    def set_live(self, live):
        with self.lock:
            self.live = live
            self.bump()

    def snapshot(self):
        return json.dumps({"settings": self.settings, "live": self.live, "standings": standings.summary(), "app": APP,
                           "penalties": {"list": PEN["list"], "hide": PEN["hide"], "reasons": PEN_REASONS, "now": time.time()},
                           "incidentsVer": incidents.STATE["ver"]})

    def notify(self):
        with self.lock:
            self.bump()


STATE = State()

# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------
FLAG_CHECKERED = 0x0001
FLAG_WHITE = 0x0002
FLAG_GREEN = 0x0004
FLAG_RED = 0x0010
FLAG_GREEN_HELD = 0x0400
FLAG_CAUTION = 0x4000
FLAG_CAUTION_WAVING = 0x8000
FLAG_ONE_LAP_TO_GREEN = 0x0200


FLAG_ONE_TO_GREEN = 0x0200   # irsdk_oneLapToGreen: seen in real data ~2 min after the caution, until the green


def flag_from_bits(bits):
    if bits & FLAG_CHECKERED:
        return "checkered"
    if bits & FLAG_RED:
        return "red"
    if bits & (FLAG_CAUTION | FLAG_CAUTION_WAVING):
        return "caution"
    if bits & FLAG_WHITE:
        return "white"
    if bits & (FLAG_GREEN | FLAG_GREEN_HELD):
        return "green"
    return ""


def _try(ir, key):
    """An iRacing value that may not exist in every SDK version (None if it doesn't)."""
    try:
        return ir[key]
    except Exception:
        return None


def race_flags(store, is_race, state, bits, leader_prog, total):
    """The track flag, plus the white flag, checkered flag and overtime worked out ourselves.

    While spectating, iRacing's SessionFlags never carried the white or checkered bits (real Talladega race,
    Oct 24 2026: SessionFlags stayed 0x10000000 through the last lap and the finish), so in a race they come from
    the leader's lap and the session state. Overtime (green-white-checkered): after a restart that leaves less
    than two laps of the scheduled distance, the leader runs one green lap and the next lap is the final lap
    (that race: scheduled 50, green near the line on lap 52, white on lap 54, checkered at 54 laps)."""
    flag = flag_from_bits(bits) or ("green" if state == 4 else "")
    if is_race and state == 3:
        # parade / pace laps before the start (SessionState 3). iRacing sets the one-to-green and green-held bits here,
        # never caution, so it read as green; the ticker shows a yellow PACE LAP instead (real Talladega data, Oct 25)
        flag = "pace"
    out = {"flag": flag, "overtime": False, "finalLap": total}
    if not is_race or not total:
        return out
    yellow = flag in ("caution", "red")
    if store.get("prev") in ("caution", "red") and not yellow and state == 4 and leader_prog is not None:
        frac = leader_prog % 1
        # the lap the field runs under green after the restart (a green just before the line starts the next lap)
        store["greenLap"] = int(leader_prog) + 1 if frac >= 0.15 else int(leader_prog)
    store["prev"] = flag
    final = total
    lap = int(leader_prog) if leader_prog is not None else 0
    if store.get("greenLap") and store["greenLap"] + 1 > total:
        final = store["greenLap"] + 1
    elif lap > total:
        final = 0      # in overtime without having seen its restart (overlay started mid-race): final lap unknown, no white flag
    out["finalLap"] = final
    out["overtime"] = state <= 5 and (final > total or (state == 4 and lap > total))
    if state >= 5:
        out["flag"] = "checkered"
    elif state == 4 and flag == "green" and final and lap >= final:
        out["flag"] = "white"
    return out


def tow_fix(store, idx, progress, surf, num=None, log=True):
    """A towed car is put straight into its pit stall, which can be most of a lap further round than where it
    stopped (real Talladega race, Oct 25: #3 crashed at 23.53 laps and reappeared in his stall at 23.95, ahead of the
    leader, so the ticker showed him P1 until the field drove past the pits). While a towed car sits in its stall
    it keeps the distance it had actually driven; once it drives off it uses its real position again."""
    ts = store.get(idx)
    if progress is None:                 # out of the world (being towed, or in the garage)
        if ts:
            ts["gone"] = True
        return None
    if ts is None:
        ts = store[idx] = {"lastP": None, "frozen": None, "gone": False}
    in_stall = surf == 1
    if in_stall and ts["frozen"] is None and ts["lastP"] is not None and progress > ts["lastP"] + 0.02 \
            and (ts["gone"] or progress - ts["lastP"] > 0.25):   # appeared in the stall without driving there
        ts["frozen"] = ts["lastP"]
        if log:
            print("Towed to the pits: #%s (held at %.2f laps instead of %.2f while in the stall)" % (num or "?", ts["lastP"], progress))
    ts["gone"] = False
    if ts["frozen"] is not None:
        if in_stall:
            return min(progress, ts["frozen"])
        ts["frozen"] = None
    if not in_stall:
        ts["lastP"] = progress
    return progress


PIT_SHOW_AFTER = 8.0   # seconds the final stop time stays up after the car leaves pit road
PIT_HIDE_AT = 50.0     # a stop this long means the car is just parked: drop the tag until the next visit
PIT_MIN_STOP = 2.0     # shorter than this isn't a real stop (rolling over the box): not counted, no stop time


def pit_timer(store, idx, now, on_pit_road, in_stall, count=True):
    """Time each stop in the pit box. Returns (state, seconds): ('road', None) on pit road,
    ('stall', running time) while stopped, ('done', final time) for a while after the stop, else (None, None).
    Once a stop reaches PIT_HIDE_AT seconds the tag is hidden for the rest of that pit visit.
    Also counts stops in the pit box ("stops"); count=False while a replay plays so nothing is counted twice."""
    st = store.setdefault(idx, {"start": None, "last": None, "endAt": None, "parked": False, "lastStop": None})
    if st["endAt"] is not None and now < st["endAt"]:      # time went backwards (replay jump): forget
        st.update(start=None, last=None, endAt=None, parked=False)
    if st.get("parked"):
        if in_stall or on_pit_road:
            if st["start"] is not None and now < st["start"]:   # replay jump back to before it got long
                st.update(start=now, parked=False)
            else:
                return None, None
        else:
            if st["start"] is not None and now - st["start"] >= PIT_MIN_STOP:
                st["lastStop"] = now - st["start"]
            st.update(start=None, last=None, endAt=None, parked=False)
            return None, None
    if in_stall:
        if st["start"] is None or now < st["start"]:
            st["start"] = now
            st["counted"] = False
        t = max(0.0, now - st["start"])
        # count the stop once the car has really stopped in its box for a moment (ignores rolling over it, and flickers)
        if t >= PIT_MIN_STOP and not st.get("counted") and count and now - st.get("countAt", -1e9) > 20:
            st["stops"] = st.get("stops", 0) + 1
            st["countAt"] = now
            st["counted"] = True
        if t >= PIT_HIDE_AT:
            st["parked"] = True
            return None, None
        return "stall", t
    if st["start"] is not None:                             # just left the box
        dur = now - st["start"]
        if dur >= PIT_MIN_STOP:
            st.update(last=dur, endAt=now, start=None, lastStop=dur)
        else:                                               # rolled over the box: not a stop
            st.update(start=None)
    if st["last"] is not None and (on_pit_road or now - st["endAt"] < PIT_SHOW_AFTER):
        return "done", st["last"]
    if not on_pit_road and st["endAt"] is not None and now - st["endAt"] >= PIT_SHOW_AFTER:
        st.update(last=None, endAt=None)
    return ("road", None) if on_pit_road else (None, None)


def class_color(value):
    try:
        n = int(value)
        if n <= 0:
            return ""
        return "#%06X" % (n & 0xFFFFFF)
    except Exception:
        return ""


def compute_gaps(cars, is_race, racing):
    """cars: list of dicts with progress, best, last, est. Sorted already.
    Adds 'gap' (to leader) and 'interval' (to car ahead) as display strings
    plus numeric 'gapS'."""
    if not cars:
        return
    leader = cars[0]
    if is_race:
        # seconds per lap used to turn "fraction of a lap behind" into seconds: the leader's BEST lap, so slow
        # caution and pit laps don't inflate every gap (real Talladega data: last-lap scaling read 2-2.5x too big
        # through a caution and for the whole first lap after the restart)
        ref = leader.get("best") or leader.get("last") or leader.get("est") or 60.0
        if ref <= 0:
            ref = leader.get("est") or 60.0
        prev = None
        for i, c in enumerate(cars):
            if i == 0:
                c["gap"] = "LEADER"
                c["interval"] = "LEADER"
                c["gapS"] = 0.0
                c["lapsDown"] = 0
                prev = c
                continue
            if not racing or c["progress"] is None or leader["progress"] is None:
                c["gap"] = c["interval"] = ""
                c["gapS"] = None
                c["lapsDown"] = 0
                prev = c
                continue
            diff = leader["progress"] - c["progress"]
            laps_down = int(math.floor(diff)) if diff >= 1 else 0
            c["lapsDown"] = laps_down
            c["gapS"] = diff * ref
            if laps_down:
                c["gap"] = "+%d LAP%s" % (laps_down, "" if laps_down == 1 else "S")
            else:
                c["gap"] = "+%.1f" % c["gapS"]
            pdiff = (prev["progress"] - c["progress"]) if prev["progress"] is not None else 0
            if laps_down:                      # a lapped car always shows how many laps down it is
                c["interval"] = c["gap"]
            elif pdiff >= 1:
                n = int(math.floor(pdiff))
                c["interval"] = "+%d LAP%s" % (n, "" if n == 1 else "S")
            else:
                c["interval"] = "+%.1f" % max(0.0, pdiff * ref)
            prev = c
    else:
        best0 = leader.get("best") or 0
        prev = None
        for i, c in enumerate(cars):
            b = c.get("best") or 0
            c["lapsDown"] = 0
            if b <= 0:
                c["gap"] = c["interval"] = "NO TIME"
                c["gapS"] = None
            elif i == 0:
                c["gap"] = c["interval"] = fmt_lap(b)
                c["gapS"] = 0.0
            else:
                c["gap"] = "+%.3f" % (b - best0)
                pb = (prev.get("best") or 0) if prev else 0
                c["interval"] = "+%.3f" % (b - pb) if pb > 0 else c["gap"]
                c["gapS"] = b - best0
            prev = c


def fmt_lap(t):
    if not t or t <= 0:
        return ""
    m = int(t // 60)
    s = t - m * 60
    return "%d:%06.3f" % (m, s) if m else "%.3f" % s


def fmt_clock(t):
    if t is None or t < 0 or t > 360000:
        return ""
    t = int(t)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


# --------------------------------------------------------------------------
# iRacing source
# --------------------------------------------------------------------------
class IRacingSource:
    def __init__(self):
        import irsdk  # noqa: imported here so demo mode works without it
        self.irsdk = irsdk
        self.ir = irsdk.IRSDK()
        self.connected = False
        self.last_info_update = -1
        self.drivers = {}
        self.info = {}
        self.pit_store = {}

    def check_connection(self):
        if self.connected and not (self.ir.is_initialized and self.ir.is_connected):
            self.connected = False
            self.ir.shutdown()
            self.last_info_update = -1
            print("iRacing disconnected")
        elif not self.connected and self.ir.startup() and self.ir.is_initialized and self.ir.is_connected:
            self.connected = True
            print("iRacing connected")
        return self.connected

    def read_session_info(self):
        ir = self.ir
        # session info (driver list, cameras) changes rarely; re-read every 2s
        now = time.time()
        if self.info and now - self.last_info_update < 2.0:
            return
        self.last_info_update = now
        di = ir["DriverInfo"] or {}
        wi = ir["WeekendInfo"] or {}
        si = ir["SessionInfo"] or {}
        ci = ir["CameraInfo"] or {}
        qi = ir["QualifyResultsInfo"] or {}
        drivers = {}
        for d in di.get("Drivers", []) or []:
            idx = d.get("CarIdx")
            if idx is None:
                continue
            if d.get("CarIsPaceCar") or d.get("IsSpectator") or not d.get("UserName"):
                continue
            drivers[idx] = {
                "idx": idx,
                "num": str(d.get("CarNumber", "")),
                "name": d.get("UserName", ""),
                "abbrev": d.get("AbbrevName", ""),
                "team": d.get("TeamName", ""),
                "cls": d.get("CarClassShortName", "") or "",
                "clsColor": class_color(d.get("CarClassColor", 0)),
                "est": float(d.get("CarClassEstLapTime", 0) or 0),
                "car": d.get("CarScreenNameShort", "") or d.get("CarScreenName", ""),
                "carFull": d.get("CarScreenName", "") or d.get("CarScreenNameShort", ""),
                "custId": str(d.get("UserID", "") or ""),
                "irating": d.get("IRating", 0),
                # paint scheme details, used to ask iRacing for a render of the car
                "paint": {"carPath": d.get("CarPath", "") or "", "carId": d.get("CarID", ""),
                          "design": d.get("CarDesignStr", "") or "", "number": d.get("CarNumberDesignStr", "") or "",
                          "sponsor1": d.get("CarSponsor_1", 0) or 0, "sponsor2": d.get("CarSponsor_2", 0) or 0,
                          "licColor": d.get("LicColor", "") or "", "clubId": d.get("ClubID", 0) or 0,
                          "userId": str(d.get("UserID", "") or ""), "teamId": str(d.get("TeamID", "") or "")},
            }
        self.drivers = drivers
        sessions = si.get("Sessions", []) or []
        groups = [{"num": g.get("GroupNum"), "name": g.get("GroupName")} for g in (ci.get("Groups") or [])]
        qual_order = [r.get("CarIdx") for r in (qi.get("Results") or []) if r.get("CarIdx") is not None]
        # starting grid: qualifying results (order + fastest time). Falls back to a qualifying session's results.
        qres = sorted((r for r in (qi.get("Results") or []) if r.get("CarIdx") is not None), key=lambda r: r.get("Position", 999))
        if not qres:
            for sess in sessions:
                if "qualif" in (sess.get("SessionType") or "").lower() and sess.get("ResultsPositions"):
                    qres = sorted((r for r in sess["ResultsPositions"] if r.get("CarIdx") is not None), key=lambda r: r.get("Position", 999))
        grid_order = [(r["CarIdx"], float(r.get("FastestTime") or 0)) for r in qres]
        self.info = {
            "trackM": track_meters(wi.get("TrackLength")),
            "gridOrder": grid_order,
            "track": wi.get("TrackDisplayName", ""),
            "sessions": sessions,
            "camGroups": groups,
            "qualOrder": qual_order,
        }

    def tick(self):
        ir = self.ir
        ir.freeze_var_buffer_latest()
        try:
            self.read_session_info()
            sess_num = ir["SessionNum"] or 0
            if self.__dict__.get("pit_sess") != sess_num:   # new session: stop counts and pit times start over
                self.pit_sess = sess_num
                self.pit_store.clear()
                self.__dict__.setdefault("tow_store", {}).clear()
            sessions = self.info.get("sessions", [])
            sess = sessions[sess_num] if 0 <= sess_num < len(sessions) else {}
            # iRacing's own results for this session. Its live lap times (CarIdxBestLapTime etc.) go to -1 for a car
            # that isn't on track (e.g. back in the garage after setting a lap), so fall back to these.
            results = {r["CarIdx"]: r for r in (sess.get("ResultsPositions") or []) if r.get("CarIdx") is not None}
            diag.results(sess_num, sess)   # black box: iRacing's full results list whenever it changes
            stype = (sess.get("SessionType") or "").lower()
            is_race = "race" in stype
            state = ir["SessionState"] or 0  # 4 = racing, 5 = checkered
            racing = state >= 4
            total_laps = sess.get("SessionLaps")
            try:
                total_laps = int(total_laps)
            except Exception:
                total_laps = 0

            pos = ir["CarIdxPosition"] or []
            cpos = ir["CarIdxClassPosition"] or []
            lap = ir["CarIdxLap"] or []
            lapc = ir["CarIdxLapCompleted"] or []
            pct = ir["CarIdxLapDistPct"] or []
            pit = ir["CarIdxOnPitRoad"] or []
            surf = ir["CarIdxTrackSurface"] or []
            now_s = ir["SessionTime"] or 0.0
            last = ir["CarIdxLastLapTime"] or []
            best = ir["CarIdxBestLapTime"] or []
            replaying = bool(ir["IsReplayPlaying"]) and (ir["ReplayFrameNumEnd"] or 0) > 30
            try:
                cflags = ir["CarIdxSessionFlags"] or []   # per-car flags (meatball = repair)
            except Exception:
                cflags = []
            # black box: the raw values behind everything below, for diagnosing problems later
            ids = sorted(i for i in self.drivers if i < len(pos))
            g = lambda arr, i, d=None: arr[i] if i < len(arr) else d
            try:   # iRacing's own timing, recorded so we can compare it with the overlay's gap estimate
                f2 = ir["CarIdxF2Time"] or []
            except Exception:
                f2 = []
            try:
                est_t = ir["CarIdxEstTime"] or []
            except Exception:
                est_t = []
            r3 = lambda v: round(v, 3) if isinstance(v, (int, float)) else v
            bb = {
                "sessTime": round(now_s, 2), "sess": sess_num, "state": state, "flags": ir["SessionFlags"] or 0,
                "lapsRemain": _try(ir, "SessionLapsRemainEx"), "lapsTotal": _try(ir, "SessionLapsTotal"),
                "replay": replaying, "cam": ir["CamCarIdx"],
                # [idx, car number, lap, lap %, on pit road, track surface, position, per-car flags,
                #  F2Time (time behind leader), EstTime (reference time to this spot), last lap, best lap]
                "cars": [[i, self.drivers[i].get("num"), g(lap, i), round(g(pct, i, -1) or 0, 4), int(bool(g(pit, i))),
                          g(surf, i), g(pos, i), g(cflags, i, 0), r3(g(f2, i)), r3(g(est_t, i)), r3(g(last, i)), r3(g(best, i))] for i in ids],
                "carFlags": [g(cflags, i, 0) for i in ids],
                # iRacing's incident points per car (same order as cars), to check whether they're shared while spectating
                "inc": [(results.get(i) or {}).get("Incidents") for i in ids],
            }
            diag.blackbox(bb)

            cars = []
            for idx, d in self.drivers.items():
                if idx >= len(pos):
                    continue
                p = pct[idx] if idx < len(pct) else -1
                in_world = p is not None and p >= 0
                progress = (lap[idx] + p) if in_world and lap[idx] is not None and lap[idx] >= 0 else None
                progress = tow_fix(self.__dict__.setdefault("tow_store", {}), idx, progress,
                                   surf[idx] if idx < len(surf) else None, d.get("num"), not replaying)
                c = dict(d)
                c.update({
                    "officialPos": pos[idx] or (results.get(idx) or {}).get("Position") or 0,
                    "classPosOfficial": cpos[idx] or 0,
                    "lapsCompleted": max(0, lapc[idx] or 0),
                    "progress": progress,
                    "pit": bool(pit[idx]) if idx < len(pit) else False,
                    "onTrack": in_world,
                })
                c["pitState"], c["pitTime"] = pit_timer(self.pit_store, idx, now_s, c["pit"], count=not replaying, in_stall=
                                                        idx < len(surf) and surf[idx] == 1)
                c.update({
                    "last": last[idx] if last[idx] and last[idx] > 0 else max(0.0, float((results.get(idx) or {}).get("LastTime") or 0)),
                    "best": best[idx] if best[idx] and best[idx] > 0 else max(0.0, float((results.get(idx) or {}).get("FastestTime") or 0)),
                    "meatball": bool(idx < len(cflags) and (cflags[idx] or 0) & REPAIR_FLAG),
                    "blackFlag": bool(idx < len(cflags) and (cflags[idx] or 0) & BLACK_FLAG),
                    "warning": bool(idx < len(cflags) and (cflags[idx] or 0) & FURLED_FLAG),
                    "dq": bool(idx < len(cflags) and (cflags[idx] or 0) & DQ_FLAG),
                    "surf": surf[idx] if idx < len(surf) else None,   # -1 not in world, 0 off track, 1 pit stall, 2 pit lane, 3 on track
                    "inc": (results.get(idx) or {}).get("Incidents"),  # incident points from iRacing's results (may be hidden)
                    "outReason": (results.get(idx) or {}).get("ReasonOutStr") or "",
                    "resultLaps": (results.get(idx) or {}).get("LapsComplete"),
                })
                cars.append(c)

            cars = order_cars(cars, is_race, state, self.info.get("qualOrder", []))
            try:
                est_raw = ir["CarIdxEstTime"] or []
            except Exception:
                est_raw = []
            qual_track(cars, self.__dict__.setdefault("qual_store", {}), now_s,
                       {c["idx"]: est_raw[c["idx"]] for c in cars if c["idx"] < len(est_raw) and est_raw[c["idx"]]},
                       "qual" in stype and not replaying)
            compute_gaps(cars, is_race, racing)
            compute_class_gaps(cars, is_race, racing)
            fs = self.__dict__.setdefault("finish_store", {})
            if fs.get("sess") != sess_num:
                fs.clear()
                fs["sess"] = sess_num
            if not replaying:
                finish_gaps(fs, cars, is_race, state, now_s)
            elif fs.get("fin"):                 # replays: keep showing the locked finish gaps
                finish_gaps({"base": fs.get("base", {}), "fin": fs["fin"], "prev": {}}, cars, is_race, max(state, 5), now_s)
            finalize_positions(cars)
            # the overlay's own gap to the leader (seconds) next to iRacing's numbers in the same black box snapshot
            bb["ourGap"] = {str(c["idx"]): round(c["gapS"], 3) for c in cars if c.get("gapS") is not None}
            add_extras(cars, is_race, [i for i, _ in (self.info.get("gridOrder") or [])] or self.info.get("qualOrder", []),
                       self.pit_store, self.__dict__.setdefault("speed_store", {}), now_s, self.info.get("trackM", 0))

            leader_lap = cars[0]["progress"] if cars and cars[0]["progress"] is not None else 0
            cur_lap = int(leader_lap) if leader_lap else 0
            fstore = self.__dict__.setdefault("flag_store", {})
            if fstore.get("sess") != sess_num:
                fstore.clear()
                fstore["sess"] = sess_num
            rf = race_flags(fstore, is_race, state, ir["SessionFlags"] or 0, leader_lap or None, total_laps)
            if total_laps and (state >= 5 or not rf["overtime"]):   # after the finish the leader's lap counter keeps going
                cur_lap = min(cur_lap, rf["finalLap"]) if rf["finalLap"] else max(total_laps, cur_lap - 1)

            replay_end = ir["ReplayFrameNumEnd"] or 0
            live = {
                "connected": True,
                "source": "iracing",
                "track": self.info.get("track", ""),
                "sessionName": (sess.get("SessionName") or "").upper(),
                "sessionType": stype,
                "isRace": is_race,
                "sessionState": state,
                "lap": cur_lap,
                "totalLaps": total_laps,
                "finalLap": rf["finalLap"],       # the lap the white flag comes out (later than totalLaps in overtime)
                "overtime": rf["overtime"],
                "timeRemain": fmt_clock(ir["SessionTimeRemain"]),
                "sessTime": round(now_s, 2), "sessNum": sess_num, "trackM": self.info.get("trackM", 0),
                # iRacing only sets the green bit around the start; while racing with no other flag it's green.
                # White and checkered are worked out from the leader's lap (see race_flags)
                "flag": rf["flag"],
                "oneToGreen": bool((ir["SessionFlags"] or 0) & FLAG_ONE_TO_GREEN),
                "isReplay": bool(ir["IsReplayPlaying"]) and replay_end > 30,
                "replaySpeed": ir["ReplayPlaySpeed"] or 0,
                "replaySlow": bool(ir["ReplayPlaySlowMotion"]),
                "uiHidden": bool((ir["CamCameraState"] or 0) & 0x0008),
                "camLap": (lap[ir["CamCarIdx"]] if ir["CamCarIdx"] is not None and 0 <= ir["CamCarIdx"] < len(lap) else None),
                "camCarIdx": ir["CamCarIdx"],
                "camGroup": ir["CamGroupNumber"],
                "camGroups": self.info.get("camGroups", []),
                "grid": build_grid(self.drivers, self.info.get("gridOrder"), cars),
                "cars": cars,
                "classes": sorted({c["cls"] for c in cars if c["cls"]}),
                "t": time.time(),
            }
            return live
        finally:
            ir.unfreeze_var_buffer_latest()

    # ---- commands from the control panel ----
    def camera(self, car_idx, group=None):
        d = self.drivers.get(car_idx)
        if not d or not self.connected:
            return False
        g = group if group is not None else (self.ir["CamGroupNumber"] or 1)
        self.ir.cam_switch_num(d["num"], int(g), 0)
        return True

    def camera_group(self, group):
        if not self.connected:
            return False
        cam_car = self.ir["CamCarIdx"]
        d = self.drivers.get(cam_car)
        num = d["num"] if d else "0"
        self.ir.cam_switch_num(num, int(group), 0)
        return True

    def go_live(self):
        if not self.connected:
            return False
        self.ir.replay_search(self.irsdk.RpySrchMode.to_end)
        self.ir.replay_set_play_speed(1, False)
        return True

    def jump(self, sess_num, sess_time, num=None):
        """Replay from a moment in a session (incident log), with the camera on that car."""
        if not self.connected:
            return False
        ir = self.ir
        now_sess, now_t = ir["SessionNum"], ir["SessionTime"]
        if now_sess == sess_num and now_t:
            # same session: move the play head back from where it is now (live or replay), the same way the
            # REPLAY button does; the replay runs at 60 frames a second. (Searching by session time didn't move it.)
            ir.replay_set_play_position(self.irsdk.RpyPosMode.current, -int(max(0.0, now_t - sess_time) * 60))
        else:
            ir.replay_search_session_time(int(sess_num), int(sess_time * 1000))
        ir.replay_set_play_speed(1, False)
        if num:
            ir.cam_switch_num(num, int(ir["CamGroupNumber"] or 1), 0)
        return True

    # ---- replay controls (live timing window) ----
    def replay(self, cmd, value=None):
        if not self.connected:
            return False
        ir, R = self.ir, self.irsdk.RpySrchMode
        speed = ir["ReplayPlaySpeed"] or 0
        slow = bool(ir["ReplayPlaySlowMotion"])
        if cmd == "start":
            ir.replay_search(R.to_start)
        elif cmd == "live":
            return self.go_live()
        elif cmd == "play":
            ir.replay_set_play_speed(1, False)
        elif cmd == "pause":
            ir.replay_set_play_speed(0, False)
        elif cmd == "rew":       # each press rewinds faster: 1x, 2x, 4x, 8x, 16x backwards
            ir.replay_set_play_speed(max(-16, speed * 2) if speed < 0 and not slow else -1, False)
        elif cmd == "ff":        # 2x, 4x, 8x, 16x
            ir.replay_set_play_speed(min(16, speed * 2) if speed >= 2 and not slow else 2, False)
        elif cmd == "speed":     # 0.25, 0.5, 1, 2, 4  (slow motion n = 1/(n+1) speed in iRacing)
            v = float(value or 1)
            if v < 1:
                ir.replay_set_play_speed(max(1, int(round(1 / v)) - 1), True)
            else:
                ir.replay_set_play_speed(int(v), False)
        elif cmd == "back":      # jump back N seconds from where we are and play at normal speed
            secs = max(1.0, float(value or 30))
            # the replay runs at 60 frames a second; move the play head back relative to where it is now
            ir.replay_set_play_position(self.irsdk.RpyPosMode.current, -int(secs * 60))
            ir.replay_set_play_speed(1, False)
        elif cmd == "prevlap":   # start of the previous / next lap of the car on camera
            ir.replay_search(R.prev_lap)
        elif cmd == "nextlap":
            ir.replay_search(R.next_lap)
        elif cmd == "simui":     # show / hide iRacing's own on-screen UI
            state = ir["CamCameraState"] or 0
            ir.cam_set_state(state ^ 0x0008)
        else:
            return False
        return True


def order_cars(cars, is_race, state, qual_order):
    if is_race and state == 4:
        # live running order from track progress (updates mid-lap)
        def key(c):
            if c["progress"] is not None:
                return (0, -c["progress"])
            return (1, c["officialPos"] or 999)
        return sorted(cars, key=key)
    if any(c["officialPos"] > 0 for c in cars):
        return sorted(cars, key=lambda c: (c["officialPos"] <= 0, c["officialPos"]))
    if is_race and qual_order:
        rank = {idx: i for i, idx in enumerate(qual_order)}
        return sorted(cars, key=lambda c: rank.get(c["idx"], 999))
    return sorted(cars, key=lambda c: c["idx"])


def compute_class_gaps(cars, is_race, racing):
    """Same as compute_gaps but measured within each car class (classGap / classInterval)."""
    groups = {}
    for c in cars:
        groups.setdefault(c["cls"], []).append(c)
    for members in groups.values():
        tmp = [dict(c) for c in members]
        compute_gaps(tmp, is_race, racing)
        for c, t in zip(members, tmp):
            c["classGap"] = t["gap"]
            c["classInterval"] = t["interval"]


REPAIR_FLAG = 0x00100000   # irsdk_repair: the meatball (black flag with orange circle)
FURLED_FLAG = 0x00080000   # irsdk_furled: the warning flag
DQ_FLAG = 0x00020000       # irsdk_disqualify
BLACK_FLAG = 0x00010000    # irsdk_black: a penalty to serve (iRacing doesn't say what for)


QUAL_ABORT = 2.0   # seconds off pole pace at which a lap no longer counts as a flying lap


def qual_track(cars, store, now, est_at, is_qual):
    """Qualifying: follow each car's laps so the ticker can show who's on a flying lap, their live
    delta to the pole time and where that pace would put them.
    est_at = {idx: iRacing's estimate of the seconds a car of that class needs to reach where it is on the lap}."""
    if not is_qual:
        store.clear()
        for c in cars:
            c["qual"] = c["qualDone"] = None
        return
    timed = [c for c in cars if (c.get("best") or 0) > 0]
    pole = min(timed, key=lambda c: c["best"]) if timed else None
    for c in cars:
        idx = c["idx"]
        st = store.setdefault(idx, {"lap": None, "start": None, "hot": False, "splits": [], "bestSplits": None, "bestT": None, "done": None})
        prog = c.get("progress")
        c["qual"] = c["qualDone"] = None
        if prog is None:
            st.update(lap=None, start=None, hot=False, splits=[])
            continue
        lapn = int(prog)
        frac = prog - lapn
        if st["lap"] is None or lapn < st["lap"] or lapn > st["lap"] + 1:   # first sight, tow, reset or replay jump
            st.update(lap=lapn, start=None, hot=False, splits=[])
        elif lapn == st["lap"] + 1:                                        # crossed the line
            if st["hot"] and st["start"] is not None:
                lt = now - st["start"]
                st["done"] = {"time": lt, "t": now}
                if st["splits"] and (st["bestT"] is None or lt < st["bestT"]):
                    st["bestSplits"], st["bestT"] = st["splits"], lt
            st.update(lap=lapn, start=now, hot=not c.get("pit"), splits=[])
        if c.get("pit"):
            st["hot"] = False
        if st["start"] is not None:                                        # time at each 1% of the lap
            k = min(99, int(frac * 100))
            while len(st["splits"]) <= k:
                st["splits"].append(now - st["start"])
        if st["done"] and now - st["done"]["t"] < 6:
            lt = round(c.get("last") or st["done"]["time"], 3)
            c["qualDone"] = {"time": lt, "improved": bool(c.get("best")) and lt <= c["best"] + 0.002}   # did it beat their best?
        if not (st["hot"] and st["start"] is not None):
            continue
        c["qual"] = {"hot": True, "delta": None, "proj": None}
        if not pole:                       # nobody has a time yet: on a flying lap, but nothing to compare with
            continue
        elapsed = now - st["start"]
        ref = None
        ps = (store.get(pole["idx"]) or {}).get("bestSplits")
        if ps and len(ps) >= 90:                                            # the pole lap's own timing, if we saw it
            i = min(frac * 100, len(ps) - 1.001)
            a = int(i)
            ref = ps[a] + (ps[min(a + 1, len(ps) - 1)] - ps[a]) * (i - a)
            ref *= pole["best"] / (store[pole["idx"]]["bestT"] or pole["best"])   # match the official pole time
        elif est_at.get(idx) and (c.get("est") or 0) > 0:                  # otherwise iRacing's reference lap, scaled to pole
            ref = est_at[idx] / c["est"] * pole["best"]
        q = {"hot": True, "delta": None, "proj": None}
        if ref is not None and frac > 0.04:
            delta = elapsed - ref
            if delta > QUAL_ABORT:            # way off pole pace: an in lap or an aborted run, stop showing it
                st["hot"] = False
                c["qual"] = None
                continue
            proj_time = pole["best"] + delta
            q["delta"] = round(delta, 3)
            q["proj"] = 1 + sum(1 for o in timed if o["idx"] != idx and o["best"] < proj_time)
        c["qual"] = q


def track_meters(text):
    """WeekendInfo TrackLength ('4.02 km' / '2.50 mi') in meters."""
    m = re.match(r"\s*([\d.]+)\s*(km|mi)?", str(text or ""))
    if not m:
        return 0.0
    v = float(m.group(1))
    return v * (1609.344 if m.group(2) == "mi" else 1000.0)


def add_extras(cars, is_race, start_order, pit_store, speed_store, now_s, track_m):
    """Live timing extras: positions gained since the start, current speed (mph) and the last pit stop time."""
    start = {idx: i + 1 for i, idx in enumerate(start_order or [])}
    cls_of = {c["idx"]: c["cls"] for c in cars}
    start_cls, per = {}, {}
    for idx in start_order or []:
        k = cls_of.get(idx)
        if k is None:
            continue
        per[k] = per.get(k, 0) + 1
        start_cls[idx] = per[k]
    for c in cars:
        idx = c["idx"]
        sp = start.get(idx) if is_race else None
        c["startPos"] = sp
        c["gained"] = (sp - c["pos"]) if sp else None
        c["classGained"] = (start_cls[idx] - c["classPos"]) if is_race and idx in start_cls else None
        # speed from how far the car moved around the lap since the last reading, smoothed
        prog, mph = c.get("progress"), None
        prev = speed_store.get(idx)
        if prog is not None and track_m > 0:
            if prev and prev["p"] is not None and 0 < now_s - prev["t"] <= 2.0:
                d = prog - prev["p"]
                if -0.01 <= d < 0.25:                               # ignore resets, tows and replay jumps
                    raw = max(0.0, d) * track_m / (now_s - prev["t"]) * 2.23694
                    mph = raw if prev["mph"] is None else prev["mph"] + (raw - prev["mph"]) * 0.35
            speed_store[idx] = {"p": prog, "t": now_s, "mph": mph}
        else:
            speed_store.pop(idx, None)
        c["mph"] = round(mph) if mph is not None and c.get("onTrack", True) else None
        st = pit_store.get(idx) or {}
        c["lastPit"] = round(st["lastStop"], 1) if st.get("lastStop") else None
        c["stops"] = st.get("stops", 0)


def finish_gaps(store, cars, is_race, state, now_s):
    """Lock each car's gap to the winner as it takes the checkered flag, the way TV does, so the results keep
    their gaps after drivers park and leave (real Talladega race, Oct 25: once everyone had left their cars the
    results board had no gaps). Finish times are worked out between readings to the moment each car crossed the line."""
    prev = store.setdefault("prev", {})
    if not is_race or state < 4:
        store.clear()
        return
    known = store.setdefault("lc", {})     # laps completed, remembered (iRacing reports nothing once a car leaves the world)
    for c in cars:
        if c.get("progress") is not None:
            known[c["idx"]] = max(known.get(c["idx"], 0), c.get("lapsCompleted") or 0)
    if state == 4:                      # racing: remember laps completed, so a lap completed after the checkered is the finish
        store["base"] = {c["idx"]: c.get("lapsCompleted") or 0 for c in cars}
        store.pop("fin", None)
    else:
        base = store.setdefault("base", {c["idx"]: c.get("lapsCompleted") or 0 for c in cars})
        fin = store.setdefault("fin", {})
        for c in cars:
            idx, lc = c["idx"], c.get("lapsCompleted") or 0
            if idx in fin or lc <= base.get(idx, lc):
                continue
            t = now_s
            p1, pv = c.get("progress"), prev.get(idx)
            if p1 is not None and pv and pv[0] is not None and pv[0] < math.floor(p1) <= p1 and p1 > pv[0]:
                line = math.floor(p1)
                t = pv[1] + (line - pv[0]) / (p1 - pv[0]) * (now_s - pv[1])
            fin[idx] = {"t": t, "laps": lc, "cls": c.get("cls")}
        if fin:
            winner = min(fin.values(), key=lambda f: (-f["laps"], f["t"]))
            cls_win = {}
            for f in fin.values():
                w = cls_win.get(f["cls"])
                if w is None or (-f["laps"], f["t"]) < (-w["laps"], w["t"]):
                    cls_win[f["cls"]] = f

            def gap_to(f, w):
                if f is w:
                    return "LEADER", 0.0
                down = w["laps"] - f["laps"]
                if down > 0:
                    return "+%d LAP%s" % (down, "" if down == 1 else "S"), None
                return "+%.3f" % (f["t"] - w["t"]), f["t"] - w["t"]

            for c in cars:
                f = fin.get(c["idx"])
                if f:
                    c["gap"], c["gapS"] = gap_to(f, winner)
                    c["classGap"] = gap_to(f, cls_win[f["cls"]])[0]
                    c["finished"] = True
                elif c.get("progress") is None:     # parked or gone without taking the checkered
                    laps = known.get(c["idx"]) or c.get("resultLaps")     # else iRacing's results
                    if laps:
                        down = winner["laps"] - laps
                        c["gap"] = c["classGap"] = ("+%d LAP%s" % (down, "" if down == 1 else "S")) if down > 0 else (c.get("gap") or "")
    for c in cars:
        prev[c["idx"]] = (c.get("progress"), now_s)


def finalize_positions(cars):
    per_class = {}
    for i, c in enumerate(cars):
        c["pos"] = i + 1
        per_class[c["cls"]] = per_class.get(c["cls"], 0) + 1
        c["classPos"] = per_class[c["cls"]]
        c["lastStr"] = fmt_lap(c.get("last"))
        c["bestStr"] = fmt_lap(c.get("best"))


# --------------------------------------------------------------------------
# Demo source: a fake 24-car oval race so you can test without iRacing
# --------------------------------------------------------------------------
DEMO_NAMES = [
    "Ryan Carter", "Jake Morrison", "Tyler Brooks", "Cody Hensley", "Austin Reed",
    "Mason Pike", "Dylan Hart", "Chase Whitaker", "Brandon Cole", "Logan Fisher",
    "Evan Sutton", "Kyle Barrett", "Nate Delgado", "Garrett Lowe", "Hunter Vance",
    "Jordan Mills", "Cole Ramsey", "Blake Turner", "Trent Hollis", "Wyatt Doyle",
    "Shane Porter", "Derek Quinn", "Lucas Grant", "Owen Price",
]


class DemoSource:
    def __init__(self, multiclass=False):
        rnd = random.Random(7)
        nums = rnd.sample(range(1, 99), len(DEMO_NAMES))
        self.base = 29.6
        self.cars = []
        for i, name in enumerate(DEMO_NAMES):
            self.cars.append({
                "idx": i + 1, "num": str(nums[i]), "name": name, "abbrev": name,
                "team": "VSPEED Demo", "cls": "CUP", "clsColor": "#FF0D40",
                "est": self.base, "car": "Next Gen Camaro", "carFull": "NASCAR Chevrolet Camaro ZL1", "custId": str(100000 + i),
                "irating": 2000 + rnd.randint(0, 3000),
                "skill": 1.0 + i * 0.0018 + rnd.uniform(-0.002, 0.002),
                "progress": -0.002 * i - (i // 2) * 0.004,  # two-wide grid
                "lapStart": None, "last": 0.0, "best": 0.0, "pitUntil": 0,
            })
        self.multiclass = multiclass
        if multiclass:   # 8 GTP prototypes and 16 GT3 cars
            for i, c in enumerate(self.cars):
                gtp = i % 3 == 0
                c.update(cls="GTP" if gtp else "GT3", clsColor="#FF5FA2" if gtp else "#FFDA59",
                         est=self.base * (0.86 if gtp else 1.0), car="BMW M Hybrid V8" if gtp else "Porsche 911 GT3 R",
                         carFull="BMW M Hybrid V8" if gtp else "Porsche 911 GT3 R (992)")
                c["skill"] = c["skill"] * (0.86 if gtp else 1.0)
        self.total = 60
        self.t0 = time.time()
        self.last_t = self.t0
        self.cam = 1
        self.camGroup = 9
        self.caution_until = 0
        self.next_caution = self.t0 + 75
        self.state = 3
        self.finished = set()

    def tick(self):
        now = time.time()
        dt = now - self.last_t
        self.last_t = now
        elapsed = now - self.t0
        if self.state == 3 and elapsed > 6:
            self.state = 4
        caution = now < self.caution_until
        if self.state == 4 and now > self.next_caution and not caution:
            self.caution_until = now + 120   # about 2.5 caution laps
            self.next_caution = now + 260
            caution = True
        leader_prog = max(c["progress"] for c in self.cars)

        for c in self.cars:
            if self.state == 3 or caution:
                speed = 1.0 / (self.base * 1.6)
                if caution:  # bunch the field up behind the leader
                    ahead = [o["progress"] for o in self.cars if o["progress"] > c["progress"]]
                    if ahead and min(ahead) - c["progress"] > 0.012:
                        speed *= 1.25
            else:
                lap_time = self.base * c["skill"] * random.uniform(0.997, 1.006)
                speed = 1.0 / lap_time
            if c["pitUntil"] > now:
                speed *= 0.0 if c.get("stallFrom", 0) <= now < c.get("stallTo", 0) else 0.35
            if c["idx"] in self.finished:
                speed *= 0.4
            if c.get("spinUntil", 0) > now:      # demo incident: spins, slowing over ~2.5 s, then crawls
                speed *= 0.04 + 0.96 * max(0.0, 1 - (now - c.get("spinStart", now)) / 2.5)
            elif c.get("slowUntil", 0) > now:    # demo incident: a slow car (mechanical)
                speed *= 0.3
            before = c["progress"]
            c["progress"] += speed * dt
            if math.floor(c["progress"]) > math.floor(before) and before >= 0:
                if c["lapStart"] is not None and not caution:
                    lt = now - c["lapStart"]
                    c["last"] = lt
                    if not c["best"] or lt < c["best"]:
                        c["best"] = lt
                c["lapStart"] = now
                if random.random() < 0.05 and not caution:
                    c["pitUntil"] = now + 11
                    c["stallFrom"], c["stallTo"] = now + 2, now + 2 + random.uniform(5, 7.5)
                if self.state >= 4 and math.floor(c["progress"]) >= self.total:
                    self.finished.add(c["idx"])
            elif before < 0 <= c["progress"]:
                c["lapStart"] = now

        if self.state == 4 and now > self.__dict__.get("next_black", self.t0 + 25):   # demo: a black flag every ~45s
            self.next_black = now + 45
            random.choice(self.cars[2:18])["blackUntil"] = now + 60
        # demo incidents: an off-track every ~25s, a spin every ~40s (sometimes two cars), a slow car every ~100s,
        # and iRacing's incident points a couple of seconds later
        if self.state == 4 and not caution:
            if now > self.__dict__.get("next_off", self.t0 + 30):
                self.next_off = now + random.uniform(18, 32)
                c = random.choice(self.cars)
                c["offUntil"] = now + 2.5
                c.setdefault("incAt", []).append((now + 2, 1))
            if now > self.__dict__.get("next_spin", self.t0 + 45):
                self.next_spin = now + random.uniform(30, 50)
                c = random.choice(self.cars[1:])
                c["spinUntil"], c["offUntil"], c["spinStart"] = now + 7.5, now + 1.5, now
                c.setdefault("incAt", []).append((now + 3, 2))
                if random.random() < 0.4:       # the car behind gets caught up in it
                    behind = min((o for o in self.cars if o is not c and 0 < c["progress"] - o["progress"] < 0.02),
                                 key=lambda o: c["progress"] - o["progress"], default=None)
                    if behind:
                        behind["spinUntil"], behind["spinStart"] = now + 7, now
                        behind.setdefault("incAt", []).append((now + 3, 4))
                        c["incAt"][-1] = (now + 3, 4)
            if now > self.__dict__.get("next_slow", self.t0 + 100):
                self.next_slow = now + 100
                random.choice(self.cars[4:])["slowUntil"] = now + 22
            if now > self.__dict__.get("next_warn", self.t0 + 70):
                self.next_warn = now + 90
                random.choice(self.cars[5:])["warnUntil"] = now + 10
        for c in self.cars:
            for due in [x for x in c.get("incAt", []) if x[0] <= now]:
                c["inc"] = c.get("inc", 0) + due[1]
                c["incAt"].remove(due)
        if self.state == 4 and now > self.__dict__.get("next_meat", self.t0 + 40):   # demo: a meatball flag every ~50s
            self.next_meat = now + 50
            random.choice(self.cars[3:15])["meatUntil"] = now + 18
        leader_prog = max(c["progress"] for c in self.cars)
        if leader_prog >= self.total and self.state == 4:
            self.state = 5
        lap_now = max(0, int(math.floor(leader_prog)) + 1)

        flag = ""
        if self.state == 3:
            flag = "pace"  # pace laps
        elif self.state >= 5:
            flag = "checkered"
        elif caution:
            flag = "caution"
        elif lap_now == self.total:
            flag = "white"
        elif self.state == 4:
            flag = "green"

        cars = []
        for c in self.cars:
            p = c["progress"]
            cars.append({
                "idx": c["idx"], "num": c["num"], "name": c["name"], "abbrev": c["abbrev"],
                "team": c["team"], "cls": c["cls"], "clsColor": c["clsColor"], "est": c["est"],
                "car": c["car"], "carFull": c["carFull"], "custId": c["custId"], "irating": c["irating"],
                "officialPos": 0, "classPosOfficial": 0, "lapsCompleted": max(0, int(p)),
                "progress": p + 1, "pit": c["pitUntil"] > now, "onTrack": True,
                "pitState": None, "pitTime": None,
                "last": c["last"], "best": c["best"],
                "meatball": c.get("meatUntil", 0) > now,
                "blackFlag": c.get("blackUntil", 0) > now,
                "warning": c.get("warnUntil", 0) > now, "dq": False,
                "surf": 0 if c.get("offUntil", 0) > now else (2 if c["pitUntil"] > now else 3),
                "inc": c.get("inc", 0), "outReason": "",
            })
        store = self.__dict__.setdefault("pit_store", {})
        src = {c["idx"]: c for c in self.cars}
        for c in cars:
            sc = src[c["idx"]]
            stall = sc.get("stallFrom", 0) <= now < sc.get("stallTo", 0)
            c["pitState"], c["pitTime"] = pit_timer(store, c["idx"], now, c["pit"], stall)
        cars.sort(key=lambda c: -c["progress"])
        compute_gaps(cars, True, self.state >= 4)
        compute_class_gaps(cars, True, self.state >= 4)
        finish_gaps(self.__dict__.setdefault("finish_store", {}), cars, True, self.state, now)
        finalize_positions(cars)
        add_extras(cars, True, [c["idx"] for c in self.cars], store,
                   self.__dict__.setdefault("speed_store", {}), now, 2414.0)   # demo track: 1.5 mile oval
        if self.cam not in {c["idx"] for c in cars}:
            self.cam = cars[0]["idx"]
        return {
            "connected": True, "source": "demo", "track": "Demo Speedway",
            "sessionName": "RACE", "sessionType": "race", "isRace": True,
            "sessionState": self.state, "lap": min(lap_now, self.total), "totalLaps": self.total,
            "timeRemain": "", "flag": flag, "isReplay": self.__dict__.get("rp", {}).get("replay", False),
            "sessTime": round(now - self.t0, 2), "sessNum": 0, "trackM": 2414.0,
            "oneToGreen": caution and self.caution_until - now < self.base * 1.6,   # demo: the last caution lap, like iRacing
            "replaySpeed": self.__dict__.get("rp", {}).get("speed", 1), "replaySlow": self.__dict__.get("rp", {}).get("slow", False),
            "uiHidden": self.__dict__.get("rp", {}).get("ui", False),
            "camLap": max(1, int(next((c["progress"] for c in cars if c["idx"] == self.cam), 1)) + self.__dict__.get("rp", {}).get("lapOffset", 0)),
            "camCarIdx": self.cam, "camGroup": self.camGroup,
            "camGroups": [{"num": 9, "name": "TV1"}, {"num": 10, "name": "TV2"},
                          {"num": 3, "name": "Cockpit"}, {"num": 6, "name": "Chase"},
                          {"num": 12, "name": "Blimp"}],
            "grid": build_grid({c["idx"]: c for c in self.cars}, [(c["idx"], round(self.base * c["skill"] * 1.012, 3)) for c in self.cars], cars),
            "cars": cars, "classes": sorted({c["cls"] for c in cars}), "t": now,
        }

    def camera(self, car_idx, group=None):
        self.cam = car_idx
        if group is not None:
            self.camGroup = group
        return True

    def camera_group(self, group):
        self.camGroup = group
        return True

    def go_live(self):
        self.rp = {"speed": 1, "slow": False, "replay": False, "ui": self.rp["ui"] if hasattr(self, "rp") else False, "lapOffset": 0}
        return True

    def jump(self, sess_num, sess_time, num=None):
        car = next((c for c in self.cars if c["num"] == num), None)
        if car:
            self.cam = car["idx"]
        rp = self.__dict__.setdefault("rp", {"speed": 1, "slow": False, "replay": False, "ui": False})
        rp.update(replay=True, speed=1, slow=False)
        return True

    def replay(self, cmd, value=None):
        rp = self.__dict__.setdefault("rp", {"speed": 1, "slow": False, "replay": False, "ui": False})
        if cmd == "live":
            return self.go_live()
        if cmd == "simui":
            rp["ui"] = not rp["ui"]
            return True
        rp["replay"] = True
        if cmd == "start" or cmd == "back" or cmd == "play":
            rp.update(speed=1, slow=False)
        elif cmd == "pause":
            rp.update(speed=0, slow=False)
        elif cmd == "rew":
            rp.update(speed=max(-16, rp["speed"] * 2) if rp["speed"] < 0 else -1, slow=False)
        elif cmd == "ff":
            rp.update(speed=min(16, rp["speed"] * 2) if rp["speed"] >= 2 else 2, slow=False)
        elif cmd == "speed":
            v = float(value or 1)
            rp.update(speed=max(1, int(round(1 / v)) - 1), slow=True) if v < 1 else rp.update(speed=int(v), slow=False)
        elif cmd in ("prevlap", "nextlap"):
            rp["lapOffset"] = rp.get("lapOffset", 0) + (-1 if cmd == "prevlap" else 1)
        return True

    def check_connection(self):
        return True


class DemoQualSource(DemoSource):
    """Demo qualifying session: cars go out a few at a time for an out lap, two timed laps and an in lap."""
    def __init__(self, multiclass=False):
        super().__init__(multiclass)
        self.state = 4
        self.length = 600
        for i, c in enumerate(self.cars):
            c.update(progress=0.0, phase="pit", runAt=self.t0 + 4 + i * 16, runs=0, last=0.0, best=0.0)

    def tick(self):
        now = time.time()
        dt = now - self.last_t
        self.last_t = now
        for c in self.cars:
            lap_t = self.base * c["skill"]
            if c["phase"] == "pit":
                if now >= c["runAt"] and c["runs"] < 2:
                    c["phase"], c["laps"] = "out", 0
                    c["progress"] = math.floor(c["progress"]) + 0.08     # pit exit
                continue
            before = c["progress"]
            speed = 1.0 / (lap_t * (1.35 if c["phase"] in ("out", "in") else random.uniform(0.997, 1.006)))
            c["progress"] += speed * dt
            if math.floor(c["progress"]) > math.floor(before):           # crossed the line
                if c["phase"] == "hot":
                    lt = now - c["lapStart"]
                    c["last"] = lt
                    if not c["best"] or lt < c["best"]:
                        c["best"] = lt
                    c["laps"] += 1
                    if c["laps"] >= 2:
                        c["phase"] = "in"
                elif c["phase"] == "out":
                    c["phase"] = "hot"
                c["lapStart"] = now
            if c["phase"] == "in" and c["progress"] - math.floor(c["progress"]) > 0.92:
                c["phase"], c["runs"] = "pit", c["runs"] + 1
                c["runAt"] = now + 70 + random.uniform(0, 40)
        timed = sorted((c for c in self.cars if c["best"]), key=lambda c: c["best"])
        rank = {c["idx"]: i + 1 for i, c in enumerate(timed)}
        cars = []
        for c in self.cars:
            p = c["progress"]
            frac = p - math.floor(p)
            on_pit = c["phase"] == "pit" or (c["phase"] == "out" and frac < 0.14) or (c["phase"] == "in" and frac > 0.86)
            cars.append({
                "idx": c["idx"], "num": c["num"], "name": c["name"], "abbrev": c["abbrev"],
                "team": c["team"], "cls": c["cls"], "clsColor": c["clsColor"], "est": c["est"],
                "car": c["car"], "carFull": c["carFull"], "custId": c["custId"], "irating": c["irating"],
                "officialPos": rank.get(c["idx"], 0), "classPosOfficial": 0, "lapsCompleted": max(0, int(p)),
                "progress": p, "pit": on_pit, "onTrack": True, "pitState": None, "pitTime": None,
                "last": c["last"], "best": c["best"], "meatball": False, "blackFlag": False,
            })
        cars = order_cars(cars, False, 4, [])
        est_at = {c["idx"]: (c["progress"] - math.floor(c["progress"])) * c["est"] for c in cars}
        qual_track(cars, self.__dict__.setdefault("qual_store", {}), now, est_at, True)
        compute_gaps(cars, False, True)
        compute_class_gaps(cars, False, True)
        finalize_positions(cars)
        add_extras(cars, False, [], {}, self.__dict__.setdefault("speed_store", {}), now, 2414.0)
        left = max(0, self.length - (now - self.t0))
        return {
            "connected": True, "source": "demo", "track": "Demo Speedway",
            "sessionName": "QUALIFY", "sessionType": "lone qualify", "isRace": False,
            "sessionState": 4, "lap": 0, "totalLaps": 0, "timeRemain": fmt_clock(left), "flag": "green",
            "isReplay": False, "replaySpeed": 1, "replaySlow": False, "uiHidden": False, "camLap": 1,
            "camCarIdx": self.cam, "camGroup": self.camGroup,
            "camGroups": [{"num": 9, "name": "TV1"}, {"num": 10, "name": "TV2"}, {"num": 3, "name": "Cockpit"}],
            "grid": [], "cars": cars, "classes": sorted({c["cls"] for c in cars}), "t": now,
        }


SOURCE = None
SOURCE_LOCK = threading.Lock()


PEN = {"seq": 0, "list": [], "prev": {}, "init": False, "hide": 0}
PEN_REASONS = ["SPEEDING", "PASSING UNDER YELLOW"]   # picked in the live timing window


def track_penalties(live):
    """A car's black flag switching on = a new penalty in the live timing window's list (the penalty
    box only shows it when the producer presses Show). Flags already
    out when the overlay starts, and anything seen during a replay, don't count."""
    cars = live.get("cars") or []
    multi = len(live.get("classes") or []) > 1
    replay = bool(live.get("isReplay"))
    now = time.time()
    with STATE.lock:
        events = list(PEN["list"])
        for c in cars:
            idx, on = c["idx"], bool(c.get("blackFlag"))
            was = PEN["prev"].get(idx, False)
            PEN["prev"][idx] = on
            if on and not was and PEN["init"] and not replay:
                PEN["seq"] += 1
                events.append({"id": PEN["seq"], "idx": idx, "num": c.get("num", ""), "name": c.get("name", ""),
                               "pos": c.get("classPos") if multi else c.get("pos"), "reason": "",
                               "active": True, "t": now, "show": 0})   # shown only when Show is pressed
            elif was and not on:
                for e in reversed(events):
                    if e["idx"] == idx and e["active"]:
                        e["active"] = False
                        break
        PEN["init"] = True
        PEN["list"] = events[-20:]


def penalty_command(data):
    cmd = str(data.get("cmd") or "")
    with STATE.lock:
        if cmd == "hide":
            PEN["hide"] = time.time()
        else:
            ev = next((e for e in PEN["list"] if e["id"] == data.get("id")), None)
            if not ev:
                return {"ok": False, "error": "no such penalty"}
            if cmd == "reason":
                r = str(data.get("reason") or "")
                ev["reason"] = r if r in PEN_REASONS else ""
            elif cmd == "show":
                ev["show"] = time.time()
        STATE.bump()
    return {"ok": True}


def telemetry_loop(demo, multiclass=False, qual=False):
    global SOURCE
    if demo:
        SOURCE = DemoQualSource(multiclass) if qual else DemoSource(multiclass)
    else:
        try:
            SOURCE = IRacingSource()
        except ImportError:
            print("\n!! pyirsdk is not installed. Run:  pip install pyirsdk")
            print("!! Starting in demo mode instead.\n")
            SOURCE = DemoSource()
    waiting_printed = False
    while True:
        try:
            with SOURCE_LOCK:
                ok = SOURCE.check_connection()
                live = SOURCE.tick() if ok else None
            if live is None:
                if not waiting_printed:
                    print("Waiting for iRacing...")
                    waiting_printed = True
                STATE.set_live({"connected": False, "source": "iracing", "cars": []})
                diag.watch({"connected": False})
                time.sleep(1.0)
                continue
            waiting_printed = False
            track_penalties(live)
            try:
                incidents.update(live, log=diag.log)
            except Exception as e:      # the incident log must never stop the overlay
                diag.error("Incident log error: %r" % (e,), e)
            STATE.set_live(live)
            diag.STATS["blackbox"] = (STATE.settings.get("diag") or {}).get("blackbox", True)
            diag.watch(live)
        except Exception as e:  # keep the broadcast alive no matter what
            sys.__stdout__ and sys.__stdout__.write("Telemetry error: %r\n" % (e,))
            diag.error("Telemetry error: %r" % (e,), e)
            time.sleep(0.5)
        time.sleep(0.2)  # 5 updates per second


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript",
    ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".webm": "video/webm", ".mp4": "video/mp4", ".json": "application/json",
    ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # quiet console

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype, code=200, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_graphic(self, rel, base=None):
        base = graphics_dir() if base is None else base
        real = os.path.realpath(os.path.join(base, rel)) if base else ""
        if not base or not real.startswith(os.path.realpath(base) + os.sep) or not os.path.isfile(real) \
                or os.path.splitext(real)[1].lower() not in GFX_EXT:
            return self.send_error(404)
        size = os.path.getsize(real)
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(real)[1].lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(real, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def send_file(self, path):
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(STATIC)) or not os.path.isfile(real):
            self.send_error(404)
            return
        with open(real, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(real)[1].lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/control", "/timing"):
            return self.send_file(os.path.join(STATIC, "control.html"))
        if path == "/overlay":
            return self.send_file(os.path.join(STATIC, "overlay.html"))
        # Standings graphic (same page and URLs as the old Standings Control program)
        if path in ("/standings", "/graphic", "/analysis", "/team", "/standings-graphic.html"):
            return self.send_file(os.path.join(STATIC, "standings-graphic.html"))
        if path == "/state":
            return self.send_bytes(standings.state_json().encode(), "application/json")
        if path in ("/standings.csv", "/standings-example.csv"):
            if path == "/standings.csv":
                snap = standings.data_snapshot()
                if not snap["rows"]:
                    return self.send_bytes(b"No standings loaded yet.", "text/plain", 404)
                body = standings.rows_to_csv(snap["header"], snap["rows"])
            else:
                body = standings.rows_to_csv(*standings.example_csv())
            dl = "download" in parse_qs(urlparse(self.path).query)
            name = os.path.basename(path)
            return self.send_bytes(body.encode("utf-8-sig" if dl else "utf-8"), "text/csv; charset=utf-8",
                                   headers={"Content-Disposition": 'attachment; filename="%s"' % name} if dl else None)
        if path == "/logo":
            try:
                with open(standings.LOGO_PATH, "rb") as f:
                    body = f.read()
                ctype = standings.LOGO_TYPES.get(os.path.splitext(standings.LOGO_PATH)[1].lower(), "application/octet-stream")
                return self.send_bytes(body, ctype)
            except (OSError, TypeError, ValueError):
                return self.send_bytes(b"No logo set.", "text/plain", 404)
        if path == "/events":
            return self.stream_events()
        if path == "/api/state":
            with STATE.lock:
                return self.send_json({"settings": STATE.settings, "live": STATE.live})
        if path == "/api/incidents":
            return self.send_json(incidents.snapshot())
        if path == "/api/assets":
            return self.send_json(list_assets())
        if path == "/api/graphics":
            return self.send_json(list_graphics())
        if path == "/api/pickfolder":
            q = parse_qs(urlparse(self.path).query)
            if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                return self.send_json({"unsupported": True})   # panel opened from a phone/another PC: use the in-page browser
            return self.send_json(pick_folder((q.get("start") or [""])[0], (q.get("title") or ["Pick a folder"])[0]))
        if path == "/api/browse":
            q = parse_qs(urlparse(self.path).query)
            return self.send_json(browse_folder((q.get("path") or [""])[0]))
        if path.startswith("/carrender/"):
            try:
                idx = int(path[len("/carrender/"):].split(".")[0])
            except ValueError:
                return self.send_error(404)
            d = getattr(SOURCE, "drivers", {}).get(idx) if SOURCE else None
            body, ctype = fetch_render(d) if d else (None, "")
            if not body:
                return self.send_error(404)
            return self.send_bytes(body, ctype, headers={"Cache-Control": "max-age=3600"})
        if path == "/api/rendertest":
            drivers = getattr(SOURCE, "drivers", {}) if SOURCE else {}
            with_paint = [x for x in drivers.values() if x.get("paint")]
            # test on the driver with the most paint files (car, decal, number, spec) so every kind gets checked
            def n_files(x):
                v = render_url(x, "{carCustPaint}|{carSpecPaint}|{numCustPaint}|{carDecalPaint}").split("|")
                return (bool(v[0]), sum(1 for f in v if f))
            d = max(with_paint, key=n_files) if with_paint else None
            if not d:
                return self.send_json({"ok": False, "error": "No drivers with paint info yet. Join or watch an iRacing session first.", "url": ""})
            RENDER_CACHE.clear()
            results, winner = probe_renders(d)
            cn = next((x for x in with_paint if is_custom_number(x)), None)
            if winner and cn:
                r2, frag = probe_custom_number(cn, winner)
                results += [dict(x, name=x["name"] + " (tested on %s #%s)" % (cn.get("name", ""), cn.get("num", ""))) for x in r2[-1:]] if frag else r2
                STATE.update_settings({"renderCustNum": frag})
            elif winner:
                results.append({"name": "custom-number paints", "ok": False, "code": 0, "msg": "no driver with car_num_<id>.tga in this session to test on", "url": ""})
            if winner:
                STATE.update_settings({"renderUrl": winner})
                RENDER_CACHE.clear()
            return self.send_json({"ok": bool(winner), "results": results, "winner": winner or "",
                                   "cnIdx": cn["idx"] if cn else None, "cnName": cn.get("name", "") if cn else "",
                                   "cnFrag": STATE.settings.get("renderCustNum", ""),
                                   "idx": d["idx"], "name": d.get("name", ""), "paintDir": paint_dir(),
                                   "paint": d.get("paint"), "paintFound": "{carCustPaint" in (winner or ""),
                                   "paintFolder": car_paint_folder((d.get("paint") or {}).get("carPath", ""))})
        if path == "/api/paintcheck":
            drivers = getattr(SOURCE, "drivers", {}) if SOURCE else {}
            return self.send_json({"paintDir": paint_dir(), "drivers": paint_check(drivers)})
        if path == "/api/diag":
            return self.send_json(diag.status())
        if path.startswith("/diagnostics/"):
            name = os.path.basename(unquote(path[len("/diagnostics/"):]))
            fp = os.path.join(diag.DIAG_DIR, name)
            if not name.endswith(".zip") or not os.path.isfile(fp):
                return self.send_error(404)
            with open(fp, "rb") as f:
                return self.send_bytes(f.read(), "application/zip", headers={"Content-Disposition": 'attachment; filename="%s"' % name})
        if path.startswith("/logos/"):
            return self.send_graphic(unquote(path[len("/logos/"):]), base=LOGO_DIR)
        if path.startswith("/sponsor/"):
            return self.send_graphic(unquote(path[len("/sponsor/"):]), base=SPONSOR_DIR)
        if path.startswith("/gfx/"):
            return self.send_graphic(unquote(path[len("/gfx/"):]))
        if path.startswith("/static/"):
            return self.send_file(os.path.join(STATIC, path[len("/static/"):]))
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        if path == "/api/sponsor/upload":
            return self.send_json(sponsor_upload(parse_qs(urlparse(self.path).query), self.headers, self.rfile, length))
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self.send_json({"ok": False, "error": "bad json"}, 400)
        if path == "/api/clientlog":
            diag.client_error(data)
            return self.send_json({"ok": True})
        if path == "/api/diagnostics":
            try:
                zp = diag.save_zip(STATE.settings)
                return self.send_json({"ok": True, "name": os.path.basename(zp), "folder": diag.DIAG_DIR})
            except Exception as e:
                diag.error("Could not save diagnostics: %r" % (e,), e)
                return self.send_json({"ok": False, "error": str(e)})
        if path.startswith("/api/"):
            diag.action(path, data)
        if path == "/api/settings":
            STATE.update_settings(data)
            return self.send_json({"ok": True})
        if path == "/api/gfx":
            return self.send_json(gfx_command(data))
        if path == "/api/reset":
            fresh = copy.deepcopy(DEFAULT_SETTINGS)
            with STATE.lock:   # keep the graphics folder and the layout
                fresh["graphicsDir"] = STATE.settings.get("graphicsDir", "")
                fresh["trackGraphic"] = STATE.settings.get("trackGraphic", "")
                for k in ("renderUrl", "renderCustNum", "paintDir"):   # keep the working iRacing render setup
                    fresh[k] = STATE.settings.get(k, fresh.get(k))
                fresh["layout"] = copy.deepcopy(STATE.settings.get("layout", {}))
                fresh["sponsor"]["files"] = copy.deepcopy(STATE.settings.get("sponsor", {}).get("files", {}))   # keep loaded sponsor images
            STATE.update_settings(fresh)
            return self.send_json({"ok": True})
        if path == "/api/penalty":
            return self.send_json(penalty_command(data))
        if path == "/api/incident":
            cmd = str(data.get("cmd") or "")
            if cmd == "clear":
                incidents.clear()
                return self.send_json({"ok": True})
            if cmd == "jump":    # replay from a few seconds before the incident, camera on the car
                ev = incidents.find(int(data.get("id") or 0))
                if not ev:
                    return self.send_json({"ok": False, "error": "incident not found"})
                rewind = max(0.0, min(120.0, float(data.get("rewind") or 15)))
                with SOURCE_LOCK:
                    ok = SOURCE.jump(ev["sess"], max(0.0, ev["t"] - rewind), ev.get("num") or None)
                return self.send_json({"ok": bool(ok)})
            return self.send_json({"ok": False, "error": "unknown command"})
        if path == "/api/camera":
            with SOURCE_LOCK:
                if "carIdx" in data:
                    ok = SOURCE.camera(int(data["carIdx"]), data.get("group"))
                else:
                    ok = SOURCE.camera_group(int(data["group"]))
            return self.send_json({"ok": bool(ok)})
        if path == "/api/standings":
            cmd = str(data.pop("cmd", ""))
            try:
                ok, msg = standings.command(cmd, data)
            except Exception as e:
                ok, msg = False, "Error: %s" % e
            STATE.notify()
            return self.send_json({"ok": ok, "msg": msg})
        if path == "/api/golive":
            with SOURCE_LOCK:
                ok = SOURCE.go_live()
            return self.send_json({"ok": bool(ok)})
        if path == "/api/replay":
            cmd = str(data.get("cmd", ""))
            if cmd == "ontrack":
                return self.send_json({"ok": on_track_switch(int(data.get("dir") or 1))})
            try:
                with SOURCE_LOCK:
                    ok = SOURCE.replay(cmd, data.get("value"))
            except Exception as e:
                print("Replay command failed:", repr(e))
                ok = False
            return self.send_json({"ok": bool(ok)})
        self.send_error(404)

    def stream_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last = -1
        try:
            while True:
                with STATE.lock:
                    if STATE.version == last:
                        STATE.lock.wait(timeout=5)
                    if STATE.version != last:
                        last = STATE.version
                        payload = STATE.snapshot()
                    else:
                        payload = None
                if payload is None:
                    self.wfile.write(b": ping\n\n")
                else:
                    self.wfile.write(("data: " + payload + "\n\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return


# --------------------------------------------------------------------------
# Ready-made graphics from a Google Drive (Drive for desktop) folder
# --------------------------------------------------------------------------
def sponsor_upload(query, headers, rfile, length):
    """Save an image sent from the control panel as the picture for one sponsor slot."""
    slot = (query.get("slot") or [""])[0]
    name = unquote(headers.get("X-Filename") or "")
    ext = os.path.splitext(name)[1].lower()
    if slot not in SPONSOR_SLOTS:
        rfile.read(length)
        return {"ok": False, "error": "unknown sponsor slot"}
    if ext not in SPONSOR_EXT:
        rfile.read(length)
        return {"ok": False, "error": "use a PNG, JPG, WEBP, GIF or SVG image"}
    if length <= 0 or length > 40 * 1024 * 1024:
        rfile.read(length)
        return {"ok": False, "error": "image is empty or bigger than 40 MB"}
    body = rfile.read(length)
    os.makedirs(SPONSOR_DIR, exist_ok=True)
    for old in os.listdir(SPONSOR_DIR):            # drop the slot's previous picture
        if os.path.splitext(old)[0] == slot:
            try:
                os.remove(os.path.join(SPONSOR_DIR, old))
            except OSError:
                pass
    fname = slot + ext
    with open(os.path.join(SPONSOR_DIR, fname), "wb") as f:
        f.write(body)
    ref = "%s?v=%d" % (fname, int(time.time() * 1000))   # new address each time, so the broadcasting software never shows a cached old picture
    STATE.update_settings({"sponsor": {"files": {slot: ref}}})
    return {"ok": True, "file": ref, "name": name}


GFX_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".webm", ".mp4"}
VIDEO_EXT = {".webm", ".mp4"}
GFX_TIMER = {"t": None}


def graphics_dir():
    with STATE.lock:
        return (STATE.settings.get("graphicsDir") or "").strip().strip('"')


def drive_guesses():
    """Folders Drive for desktop usually creates, to suggest in the panel."""
    out = []
    for letter in "GHIJKLMNOPQRSTUVWXYZ":
        for sub in ("My Drive", "Shared drives"):
            pth = "%s:\\%s" % (letter, sub)
            if os.path.isdir(pth):
                out.append(pth)
    return out


def list_graphics():
    base = graphics_dir()
    res = {"dir": base, "ok": False, "error": "", "files": [], "guesses": drive_guesses() if os.name == "nt" else []}
    if not base:
        res["error"] = "No folder set yet."
        return res
    if not os.path.isdir(base):
        res["error"] = "Can't find that folder on this PC. Check the path (and, for a Google Drive folder, that Drive for desktop is running)."
        return res
    files = []
    try:
        for root, dirs, names in os.walk(base):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            depth = os.path.relpath(root, base).count(os.sep)
            if depth > 2:
                dirs[:] = []
            for n in sorted(names, key=str.lower):
                ext = os.path.splitext(n)[1].lower()
                if ext not in GFX_EXT or n.startswith("."):
                    continue
                full = os.path.join(root, n)
                rel = os.path.relpath(full, base).replace(os.sep, "/")
                try:
                    mt = os.path.getmtime(full)
                except OSError:
                    mt = 0
                folder = os.path.dirname(rel)
                files.append({"path": rel, "name": os.path.splitext(n)[0], "folder": folder,
                              "video": ext in VIDEO_EXT, "mtime": int(mt)})
                if len(files) >= 500:
                    break
    except OSError as e:
        res["error"] = str(e)
        return res
    res["ok"] = True
    res["files"] = files
    return res


SKIP_DIRS = {"$recycle.bin", "system volume information", "windows", "program files", "program files (x86)",
             "programdata", "appdata", "$windows.~bt", "recovery", "perflogs"}


# --------------------------------------------------------------------------
# Starting grid + iRacing car renders (with each driver's custom paint)
# --------------------------------------------------------------------------
def build_grid(drivers, grid_order, cars):
    """Starting grid for the Grid widget: qualifying order and time, plus the iRacing render of each car."""
    order = [(i, t) for i, t in (grid_order or []) if i in drivers]
    if not order:   # no qualifying results: use the current order
        order = [(c["idx"], c.get("best") or 0) for c in cars]
    out = []
    for pos, (i, t) in enumerate(order, 1):
        d = drivers[i]
        # the car as iRacing renders it, with the driver's custom paint from the paint folder
        img = "/carrender/%d.png?v=%s" % (i, render_key(d)[:10]) if d.get("paint") else ""
        out.append({"pos": pos, "idx": i, "num": d.get("num", ""), "name": d.get("name", ""),
                    "car": d.get("carFull") or d.get("car", ""), "time": fmt_lap(t) if t and t > 0 else "",
                    "img": img})
    return out


# ---- iRacing car renders ----
RENDER_CACHE = {}          # key -> (time, bytes or None, content type)
RENDER_LAST = {"url": "", "status": "", "error": ""}
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def documents_dirs():
    """Possible Documents folders: the real one from Windows (often moved into OneDrive), then the usual spots."""
    out = []
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class GUID(ctypes.Structure):
                _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD), ("d", ctypes.c_ubyte * 8)]
            docs = GUID(0xFDD39AD0, 0x238F, 0x46AF, (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
            ptr = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(docs), 0, None, ctypes.byref(ptr)) == 0:
                out.append(ptr.value)
                ctypes.windll.ole32.CoTaskMemFree(ptr)
        except Exception:
            pass
    home = os.path.expanduser("~")
    for od in (os.environ.get("OneDrive"), os.environ.get("OneDriveConsumer"), os.path.join(home, "OneDrive")):
        if od:
            out.append(os.path.join(od, "Documents"))
    out.append(os.path.join(home, "Documents"))
    seen, uniq = set(), []
    for d in out:
        if d and d.lower() not in seen:
            seen.add(d.lower())
            uniq.append(d)
    return uniq


def paint_dir():
    with STATE.lock:
        p = (STATE.settings.get("paintDir") or "").strip().strip('"')
    if p:
        return p
    cands = [os.path.join(d, "iRacing", "paint") for d in documents_dirs()]
    return next((c for c in cands if os.path.isdir(c)), cands[0])


def car_paint_folder(car_path):
    """The car's folder inside the paint folder (usually the car path, e.g. 'stockcars2 camaro2022')."""
    base = paint_dir()
    for name in (car_path, car_path.replace("\\", " ").replace("/", " "), car_path.replace(" ", "_"), car_path.split(" ")[-1]):
        f = os.path.join(base, name)
        if name and os.path.isdir(f):
            return f
    return os.path.join(base, car_path)


def hex_color(v):
    """iRacing gives some colors as a number (87003) or 0x0153db; the renderer wants 6-digit hex (0153db)."""
    if v in (None, ""):
        return ""
    if isinstance(v, (int, float)):
        return "%06x" % (int(v) & 0xFFFFFF)
    v = str(v).strip().lower().replace("#", "")
    if v.startswith("0x"):
        return "%06x" % (int(v, 16) & 0xFFFFFF)
    if v.isdigit() and len(v) != 6:
        return "%06x" % (int(v) & 0xFFFFFF)
    return v


def fill_template(tpl, vals):
    out = tpl
    for k, v in sorted(vals.items(), key=lambda kv: -len(kv[0])):   # longest names first ({carCustPaintFwd} before {carCustPaint})
        out = out.replace("{%s}" % k, quote(str(v), safe="" if k.endswith("Enc") else ",:\\/"))
    # leave out parameters that ended up empty (the renderer may reject them)
    base, _, query = out.partition("?")
    parts = [p for p in query.split("&") if p and not p.endswith("=")]
    return base + ("?" + "&".join(parts) if parts else "")


def render_url(d, template=None):
    """Fill the render address template from a driver's paint scheme (DriverInfo) and paint files."""
    pt = d.get("paint") or {}
    des = [x.strip() for x in (pt.get("design") or "").split(",")]
    num = [x.strip() for x in (pt.get("number") or "").split(",")]
    folder = car_paint_folder(pt.get("carPath", ""))

    def first_file(*names):
        for n in names:
            f = os.path.join(folder, n)
            if n and os.path.isfile(f):
                return f
        return ""
    uid, tid = pt.get("userId", ""), pt.get("teamId", "")
    vals = {
        "carPath": pt.get("carPath", ""), "carId": pt.get("carId", ""),
        "carPat": des[0] if des else "", "carCol": ",".join(des[1:4]), "rimCol": des[4] if len(des) > 4 else "",
        "numPat": num[0] if num else "", "numSlnt": num[1] if len(num) > 1 else "", "numCol": ",".join(num[2:5]),
        "sponsors": "%s,%s" % (pt.get("sponsor1", 0), pt.get("sponsor2", 0)),
        "licCol": hex_color(pt.get("licColor", "")), "club": pt.get("clubId", 0),
        "carPathBs": pt.get("carPath", "").replace(" ", "\\"), "carPathSlash": pt.get("carPath", "").replace(" ", "/"),
        "carCol1": des[1] if len(des) > 1 else "", "carCol2": des[2] if len(des) > 2 else "", "carCol3": des[3] if len(des) > 3 else "",
        "numFont": num[1] if len(num) > 1 else "", "numCol1": num[2] if len(num) > 2 else "", "numCol2": num[3] if len(num) > 3 else "",
        "numCol3": num[4] if len(num) > 4 else "",
        # a custom-number paint is the whole car with its number painted in, saved as car_num_<id>.tga
        "carCustPaint": first_file("car_team_%s.tga" % tid if tid and tid != "0" else "", "car_%s.tga" % uid,
                                   "car_num_team_%s.tga" % tid if tid and tid != "0" else "", "car_num_%s.tga" % uid),
        "carSpecPaint": first_file("car_spec_team_%s.mip" % tid if tid and tid != "0" else "", "car_spec_%s.mip" % uid),
        "numCustPaint": "",
        "carDecalPaint": first_file("car_decal_%s.tga" % uid),
        "userId": uid, "teamId": tid, "num": d.get("num", ""),
    }
    custom_number = os.path.basename(vals["carCustPaint"]).lower().startswith("car_num_")
    for k in ("carCustPaint", "carSpecPaint", "numCustPaint", "carDecalPaint"):
        vals[k + "Fwd"] = vals[k].replace("\\", "/")
        vals[k + "Enc"] = vals[k]
    if template is None:
        with STATE.lock:
            template = STATE.settings.get("renderUrl") or DEFAULT_SETTINGS["renderUrl"]
            extra = STATE.settings.get("renderCustNum") or ""
        if custom_number and extra:
            # the number is already painted on the car: tell iRacing (setting found by the Test button)
            template = drop_param(template, extra.split("=")[0]) + "&" + extra
    return fill_template(template, vals)


def is_custom_number(d):
    v = render_url(d, "{carCustPaint}")
    return os.path.basename(unquote(v)).lower().startswith("car_num_")


def drop_param(tpl, name):
    base, _, query = tpl.partition("?")
    return base + "?" + "&".join(p for p in query.split("&") if p and p.split("=")[0] != name)


# Ways of asking iRacing for a render, tried in order by the Test button. The first that returns
# an image is saved as the render address.
RENDER_VARIANTS = [
    ("full, car path as given", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&licCol={licCol}&club={club}&sponsors={sponsors}&numPat={numPat}&numCol={numCol}&numSlnt={numSlnt}&carPath={carPath}&carPat={carPat}&carCol={carCol}&carRimType=2&carRimCol={rimCol}&carCustPaint={carCustPaint}&carSpecPaint={carSpecPaint}&numCustPaint={numCustPaint}"),
    ("full, car path with backslash", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&licCol={licCol}&club={club}&sponsors={sponsors}&numPat={numPat}&numCol={numCol}&numSlnt={numSlnt}&carPath={carPathBs}&carPat={carPat}&carCol={carCol}&carRimType=2&carRimCol={rimCol}&carCustPaint={carCustPaint}&carSpecPaint={carSpecPaint}&numCustPaint={numCustPaint}"),
    ("full, car path with slash", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&licCol={licCol}&club={club}&sponsors={sponsors}&numPat={numPat}&numCol={numCol}&numSlnt={numSlnt}&carPath={carPathSlash}&carPat={carPat}&carCol={carCol}&carRimType=2&carRimCol={rimCol}&carCustPaint={carCustPaint}&carSpecPaint={carSpecPaint}&numCustPaint={numCustPaint}"),
    ("paint only, backslash path", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&carPath={carPathBs}&carPat={carPat}&carCol={carCol}&numPat={numPat}&numCol={numCol}&numSlnt={numSlnt}&sponsors={sponsors}&carCustPaint={carCustPaint}"),
    ("paint only, path as given", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&carPath={carPath}&carPat={carPat}&carCol={carCol}&numPat={numPat}&numCol={numCol}&numSlnt={numSlnt}&sponsors={sponsors}&carCustPaint={carCustPaint}"),
    ("minimal, backslash path", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&carPath={carPathBs}&carPat={carPat}&carCol={carCol}"),
    ("minimal, path as given", "http://127.0.0.1:32034/pk_car.png?size=2&view=1&carPath={carPath}&carPat={carPat}&carCol={carCol}"),
]


def try_render(url):
    """Ask iRacing for one render. Returns (ok, http status, message)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "VSPEED-Overlay"})
        with NO_PROXY.open(req, timeout=8) as r:
            body, ctype = r.read(), r.headers.get("Content-Type", "")
        if body and ctype.startswith("image"):
            return True, 200, "image (%d KB)" % (len(body) // 1024), body
        return False, 200, "not an image: " + body[:200].decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        try:
            msg = e.read()[:300].decode("utf-8", "replace").strip()
        except Exception:
            msg = ""
        return False, e.code, (e.reason or "") + (" - " + msg if msg else ""), None
    except Exception as e:
        return False, 0, str(e), None


PAINT_PARAMS = ("carCustPaint", "carSpecPaint", "numCustPaint", "carDecalPaint")


def strip_paint_params(tpl):
    base, _, query = tpl.partition("?")
    keep = [p for p in query.split("&") if p and not any("{%s" % k in p for k in PAINT_PARAMS)]
    return base + "?" + "&".join(keep)


def probe_renders(d):
    """1) request format, 2) custom paint, 3) car number. Each step keeps what actually changes the picture."""
    import hashlib
    results, tpl = _probe_paint(d)
    if not tpl:
        return results, None
    # car number: without it iRacing paints its default number on every car
    num = str(d.get("num", ""))
    if "{num}" not in tpl and num:
        ok, code, msg, plain = try_render(render_url(d, tpl))
        plain_hash = hashlib.md5(plain or b"").hexdigest()
        found = False
        for pname in ("carNum", "number", "num", "carNumber", "numVal", "numStr", "carNo"):
            t = tpl + "&%s={num}" % pname
            ok, code, msg, body = try_render(render_url(d, t))
            changed = ok and hashlib.md5(body).hexdigest() != plain_hash
            results.append({"name": "car number as %s" % pname, "ok": changed, "code": code,
                            "msg": ("number applied (#%s)" % num if changed else "no change") if ok else msg, "url": ""})
            if changed:
                tpl, found = t, True
                break
        if not found:
            results.append({"name": "car number", "ok": False, "code": 0, "msg": "couldn't find how iRacing takes the number", "url": ""})
    PROBE_EXTRA["custNum"] = None
    return results, tpl


PROBE_EXTRA = {}


def probe_custom_number(d, tpl):
    """For a car whose paint already has its number painted in (car_num_<id>.tga): find the setting that
    stops iRacing drawing its own number on top. Returns (results, fragment or '')."""
    import hashlib
    results = []
    ok, code, msg, base = try_render(render_url(d, tpl))
    if not ok:
        return [{"name": "custom-number paint", "ok": False, "code": code, "msg": msg, "url": ""}], ""
    base_hash = hashlib.md5(base).hexdigest()
    cands = ["numCustPaint={carCustPaint}", "carNumPaint={carCustPaint}", "carCustNum=1", "custNum=1", "numCust=1",
             "carNumCust=1", "useCustNum=1", "hideNum=1", "noNumber=1", "numPat=-1"]
    for frag in cands:
        name = frag.split("=")[0]
        t = drop_param(tpl, name) + ("&" + frag if not frag.endswith("=") else "")
        ok, code, msg, body = try_render(render_url(d, t))
        changed = ok and hashlib.md5(body).hexdigest() != base_hash
        results.append({"name": "custom number: " + (frag if not frag.endswith("=") else "leave out " + name), "ok": changed, "code": code,
                        "msg": ("picture changed, using this" if changed else "no change") if ok else msg, "url": ""})
        if changed:
            return results, (frag if not frag.endswith("=") else name + "=")
    return results, ""


def _probe_paint(d):
    """1) find a request format iRacing accepts, 2) find how it wants the custom paint file,
    by checking which request actually changes the picture."""
    import hashlib
    results, winner = [], None
    for name, tpl in RENDER_VARIANTS:
        url = render_url(d, tpl)
        ok, code, msg, body = try_render(url)
        results.append({"name": name, "ok": ok, "code": code, "msg": msg, "url": url})
        if ok:
            winner = tpl
            break
    if not winner:
        return results, None
    vals_probe = render_url(d, "{carCustPaint}|{carSpecPaint}|{numCustPaint}|{carDecalPaint}").split("?")[0].split("|")
    has = dict(zip(PAINT_PARAMS, [unquote(v) for v in vals_probe]))
    if not has["carCustPaint"]:
        results.append({"name": "custom paint", "ok": False, "code": 0, "msg": "no car_<id>.tga for this driver in " + car_paint_folder((d.get("paint") or {}).get("carPath", "")), "url": ""})
        return results, winner
    base_tpl = strip_paint_params(winner)
    ok, code, msg, plain = try_render(render_url(d, base_tpl))
    plain_hash = hashlib.md5(plain or b"").hexdigest()
    best = None
    for pname in ("carCustPaint", "carPaint", "custPaint", "carCustomPaint", "paint"):
        for enc, label in (("", "path as is"), ("Fwd", "forward slashes"), ("Enc", "fully encoded")):
            tpl = base_tpl + "&%s={carCustPaint%s}" % (pname, enc)
            ok, code, msg, body = try_render(render_url(d, tpl))
            changed = ok and hashlib.md5(body).hexdigest() != plain_hash
            results.append({"name": "custom paint as %s (%s)" % (pname, label), "ok": changed, "code": code,
                            "msg": ("paint applied" if changed else "same picture as without the paint") if ok else msg, "url": ""})
            if changed:
                best, best_enc, best_body = tpl, enc, body
                break
        if best:
            break
    if not best:
        return results, winner
    # extra paint files (spec map, decals, custom number): keep each one iRacing accepts
    for key, names in (("carDecalPaint", ("carDecalPaint", "decalPaint", "carDecal")),
                       ("numCustPaint", ("numCustPaint", "carNumPaint", "numPaint")),
                       ("carSpecPaint", ("carSpecPaint", "carSpecMap", "specPaint"))):
        if not has.get(key):
            continue
        for pname in names:
            tpl = best + "&%s={%s%s}" % (pname, key, best_enc)
            ok, code, msg, body = try_render(render_url(d, tpl))
            if ok:
                results.append({"name": "%s as %s" % (key, pname), "ok": True, "code": code, "msg": "accepted", "url": ""})
                best = tpl
                break
        else:
            results.append({"name": key, "ok": False, "code": 0, "msg": "iRacing didn't accept it, left out", "url": ""})
    return results, best


def paint_check(drivers):
    """For every driver: which paint files the overlay found for them, so missing schemes are easy to explain."""
    out = []
    for d in sorted(drivers.values(), key=lambda x: (len(str(x.get("num", ""))), str(x.get("num", "")))):
        pt = d.get("paint") or {}
        folder = car_paint_folder(pt.get("carPath", ""))
        uid, tid = pt.get("userId", ""), pt.get("teamId", "")
        v = render_url(d, "{carCustPaint}|{carSpecPaint}|{numCustPaint}|{carDecalPaint}").split("|")
        found = [os.path.basename(unquote(f)) for f in v if f]
        other = []
        try:
            if os.path.isdir(folder):
                ids = [i for i in (uid, tid) if i and i != "0"]
                other = sorted(n for n in os.listdir(folder)
                               if any(re.search(r"(^|[_\\-])%s([_.\\-]|$)" % re.escape(i), n) for i in ids) and n not in found)[:6]
        except OSError:
            pass
        out.append({"num": d.get("num", ""), "name": d.get("name", ""), "custId": uid, "teamId": tid,
                    "customNumber": bool(v[0]) and os.path.basename(unquote(v[0])).lower().startswith("car_num_"),
                    "folder": folder, "folderExists": bool(pt.get("carPath")) and os.path.isdir(folder), "found": found, "other": other,
                    "paint": bool(v[0])})
    return out


def render_key(d):
    import hashlib
    url = render_url(d)
    try:
        f = [p for p in url.split("&") if p.startswith("carCustPaint=")]
        mt = os.path.getmtime(unquote(f[0].split("=", 1)[1])) if f and f[0].split("=", 1)[1] else 0
    except OSError:
        mt = 0
    return hashlib.md5((url + str(mt)).encode()).hexdigest()


RENDER_LOCK = threading.Lock()   # one render at a time, so a full grid doesn't swamp iRacing


def fetch_render(d):
    key = render_key(d)
    hit = RENDER_CACHE.get(key)
    if hit and (hit[1] is not None or time.time() - hit[0] < 30):
        return hit[1], hit[2]
    with RENDER_LOCK:
        hit = RENDER_CACHE.get(key)
        if hit and (hit[1] is not None or time.time() - hit[0] < 30):
            return hit[1], hit[2]
        return _fetch_render(d, key)


def _fetch_render(d, key):
    url = render_url(d)
    RENDER_LAST["url"] = url
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "VSPEED-Overlay"})
        with NO_PROXY.open(req, timeout=15) as r:   # straight to iRacing on this PC, never through a proxy
            body, ctype = r.read(), r.headers.get("Content-Type", "image/png")
        if not body or not ctype.startswith("image"):
            raise ValueError("iRacing answered, but not with an image (%s)" % ctype)
        RENDER_LAST.update(status="ok", error="")
        RENDER_CACHE[key] = (time.time(), body, ctype)
    except Exception as e:
        RENDER_LAST.update(status="failed", error=str(e))
        RENDER_CACHE[key] = (time.time(), None, "")
    return RENDER_CACHE[key][1], RENDER_CACHE[key][2]


def browse_roots():
    """Starting points for the folder browser: drives plus the usual user folders."""
    roots = []
    home = os.path.expanduser("~")
    for name in ("Desktop", "Documents", "Pictures", "Downloads", "Videos"):
        p = os.path.join(home, name)
        if os.path.isdir(p):
            roots.append({"name": name, "path": p})
    for p in drive_guesses():
        roots.append({"name": p.split(":")[0] + ": " + p.split("\\")[-1], "path": p})
    if os.name == "nt":
        import string
        for letter in string.ascii_uppercase:
            p = letter + ":\\"
            if os.path.isdir(p):
                roots.append({"name": letter + ":", "path": p})
    else:
        roots.append({"name": "/", "path": "/"})
    return roots


def count_images(folder):
    try:
        with os.scandir(folder) as it:
            return sum(1 for e in it if e.is_file() and os.path.splitext(e.name)[1].lower() in GFX_EXT)
    except OSError:
        return 0


PICK_TK = r"""
import sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.update()
p = filedialog.askdirectory(parent=root, initialdir=sys.argv[1] or None, title=sys.argv[2], mustexist=True)
sys.stdout.write(p or "")
"""
PICK_PS = (
    "Add-Type -AssemblyName System.Windows.Forms;"
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:VS_TITLE; $d.ShowNewFolderButton = $false;"
    "if ($env:VS_START) { $d.SelectedPath = $env:VS_START };"
    "$f = New-Object System.Windows.Forms.Form -Property @{TopMost = $true};"
    "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
)
PICK_LOCK = threading.Lock()


def pick_folder(start, title):
    """Open the Windows folder picker on this PC (the same kind of window as the sponsor Load image button).
    Returns {"path": ...}, {"cancel": True}, or {"unsupported": True} when it can't open one here."""
    if os.name != "nt":
        return {"unsupported": True}
    if not PICK_LOCK.acquire(blocking=False):
        return {"error": "A folder window is already open on the broadcast PC"}
    try:
        start = start if start and os.path.isdir(start) else ""
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        tries = [([sys.executable, "-c", PICK_TK, start, title], None),
                 (["powershell", "-NoProfile", "-STA", "-Command", PICK_PS], dict(os.environ, VS_TITLE=title, VS_START=start))]
        for cmd, env in tries:
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=900, creationflags=flags, env=env)
            except Exception as e:
                print("Folder window failed:", repr(e))
                continue
            if r.returncode != 0:
                print("Folder window failed:", (r.stderr or "").strip()[-300:])
                continue
            out = (r.stdout or "").strip()
            return {"path": os.path.normpath(out)} if out else {"cancel": True}
        return {"unsupported": True}
    finally:
        PICK_LOCK.release()


def browse_folder(path):
    """List the subfolders of `path` (names only) for the control panel's folder browser."""
    res = {"path": "", "parent": "", "dirs": [], "images": 0, "roots": browse_roots(), "error": ""}
    if not path:
        return res
    path = os.path.abspath(os.path.expanduser(path.strip().strip('"')))
    if not os.path.isdir(path):
        res["error"] = "That folder doesn't exist."
        return res
    res["path"] = path
    parent = os.path.dirname(path.rstrip("\\/")) if path.rstrip("\\/") else ""
    res["parent"] = parent if parent and parent != path else ""
    if os.name == "nt" and len(path.rstrip("\\")) <= 2:      # a drive root like C:\
        res["parent"] = ""
    dirs = []
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    if not e.is_dir() or e.name.startswith(".") or e.name.lower() in SKIP_DIRS:
                        continue
                except OSError:
                    continue
                dirs.append(e.name)
    except OSError as e:
        res["error"] = "Can't open that folder (%s)." % e.strerror
        return res
    dirs.sort(key=str.lower)
    res["dirs"] = [{"name": n, "path": os.path.join(path, n), "images": count_images(os.path.join(path, n))} for n in dirs[:300]]
    res["images"] = count_images(path)
    return res


def gfx_command(d):
    """show / hide / replay the Drive graphic. hold > 0 hides it again after that many seconds."""
    cmd = d.get("cmd")
    with STATE.lock:
        g = dict(STATE.settings.get("gfx") or {})
    if cmd == "show":
        if d.get("file"):
            g["file"] = str(d["file"])
        if not g.get("file"):
            return {"ok": False, "msg": "Pick a graphic first"}
        g["visible"] = True
        g["t"] = int(g.get("t", 0)) + 1
    elif cmd == "hide":
        g["visible"] = False
    elif cmd == "cue":
        g["file"] = str(d.get("file") or "")
    else:
        return {"ok": False, "msg": "unknown command"}
    for k in ("anim", "hold"):
        if k in d:
            g[k] = d[k]
    STATE.update_settings({"gfx": g})
    if GFX_TIMER["t"]:
        GFX_TIMER["t"].cancel()
        GFX_TIMER["t"] = None
    hold = float(g.get("hold") or 0)
    if cmd == "show" and hold > 0:
        token = g["t"]

        def auto_hide():
            with STATE.lock:
                cur = STATE.settings.get("gfx") or {}
                same = cur.get("t") == token and cur.get("visible")
            if same:
                STATE.update_settings({"gfx": {"visible": False}})
        GFX_TIMER["t"] = threading.Timer(hold, auto_hide)
        GFX_TIMER["t"].daemon = True
        GFX_TIMER["t"].start()
    return {"ok": True, "msg": ""}


def list_assets():
    out = {"logos": []}
    try:
        out["logos"] = sorted(f for f in os.listdir(LOGO_DIR) if os.path.splitext(f)[1].lower() in IMAGE_EXT)
    except OSError:
        pass
    return out


class QuietServer(ThreadingHTTPServer):
    """Broadcasting software and browsers drop idle connections all the time (closing a tab, reloading an input).
    That's normal, so don't print a traceback for it."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        err = sys.exc_info()[1]
        if isinstance(err, (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def on_track_switch(direction):
    """Put the camera on the car physically ahead (+1) or behind (-1) on track, by lap distance."""
    with STATE.lock:
        live = STATE.live
        cars = [c for c in live.get("cars", []) if c.get("onTrack") and c.get("progress") is not None]
        cam = live.get("camCarIdx")
    if len(cars) < 2:
        return False
    pct = {c["idx"]: c["progress"] % 1.0 for c in cars}
    order = sorted(cars, key=lambda c: pct[c["idx"]])
    ids = [c["idx"] for c in order]
    if cam not in ids:
        target = ids[0]
    else:
        i = ids.index(cam)
        target = ids[(i + (1 if direction > 0 else -1)) % len(ids)]
    with SOURCE_LOCK:
        return bool(SOURCE.camera(target))


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description="VSPEED broadcast overlay server")
    ap.add_argument("--demo", action="store_true", help="run a fake race instead of reading iRacing")
    ap.add_argument("--multiclass", action="store_true", help="demo race with GTP and GT3 classes")
    ap.add_argument("--qual", action="store_true", help="demo qualifying session instead of a race")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    diag.setup(APP["version"], ("DEMO QUALIFYING" if args.qual else "DEMO") if args.demo else "iRacing")

    standings.init()
    standings.autopull(on_done=STATE.notify)
    threading.Thread(target=update_watch, daemon=True).start()
    threading.Thread(target=telemetry_loop, args=(args.demo, args.multiclass, args.qual), daemon=True).start()
    server = QuietServer(("0.0.0.0", args.port), Handler)
    ip = local_ip()
    print("=" * 60)
    print(" VSPEED Broadcast Overlay v%s  (%s mode)" % (APP["version"], "DEMO" if args.demo else "iRacing"))
    print("  Overlay      :  http://localhost:%d/overlay  (browser input in your broadcasting software)" % args.port)
    print("  Control panel:  http://localhost:%d/control" % args.port)
    print("  Standings only: http://localhost:%d/standings  (also /analysis and /team)" % args.port)
    print("  From a phone :  http://%s:%d/control" % (ip, args.port))
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
