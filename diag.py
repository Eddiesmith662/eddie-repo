"""Diagnostics: a daily log file, a "black box" of raw iRacing data, live status, and a
one-click diagnostics zip.

Everything stays on this PC, in data/logs and data/diagnostics. Nothing is sent anywhere.
"""
import collections
import datetime
import io
import json
import os
import platform
import queue
import sys
import threading
import time
import traceback
import zipfile

import datafiles

LOG_DIR = os.path.join(datafiles.DATA, "logs")
DIAG_DIR = os.path.join(datafiles.DATA, "diagnostics")
BLACKBOX_FILE = os.path.join(LOG_DIR, "blackbox.jsonl")
BLACKBOX_PREV = os.path.join(LOG_DIR, "blackbox-previous.jsonl")   # the run before this one
RESULTS_FILE = os.path.join(LOG_DIR, "results.jsonl")   # iRacing's own results list, each time it changes
KEEP_LOG_DAYS = 7
BLACKBOX_SECONDS = 3 * 3600         # keep the last 3 hours, one snapshot a second (a full race plus practice and qualifying)
BLACKBOX_REWRITE = 30 * 60          # the file is appended to every minute and rewritten (trimmed to 3 hours) every 30 minutes
KEEP_DIAG_ZIPS = 10

_q = queue.Queue()
_started = False
STATS = {
    "startedAt": time.time(), "version": "", "mode": "",
    "connected": False, "source": "", "session": "", "track": "",
    "ticks": 0, "rate": 0.0, "cars": 0,
    "carFlags": {"seen": False, "black": 0, "meatball": 0, "any": 0},   # per-car flags iRacing has sent
    "lastError": None, "errors": 0, "clientErrors": 0, "blackbox": True,
}
_bb = collections.deque(maxlen=BLACKBOX_SECONDS)   # compact JSON lines (strings use far less memory than dicts)
_bb_pending = []                                     # this minute's readings, turned into lines at the next flush
_bb_lock = threading.Lock()
_bb_rewritten = 0.0
_bb_last = 0.0
_res = collections.deque(maxlen=300)     # the last 300 versions of iRacing's results list
_res_key = None
_rate = collections.deque(maxlen=50)


# ---------------------------------------------------------------- log file
def _log_path(day=None):
    return os.path.join(LOG_DIR, "vspeed-%s.log" % (day or datetime.date.today().isoformat()))


def _writer():
    """Background thread: writes log lines and the black box, so a slow disk never holds up the overlay."""
    last_bb = time.time()
    while True:
        try:
            item = _q.get(timeout=5)
        except queue.Empty:
            item = None
        try:
            lines = [] if item is None else [item]
            while True:            # write everything that's waiting in one go
                try:
                    lines.append(_q.get_nowait())
                except queue.Empty:
                    break
            if lines:
                os.makedirs(LOG_DIR, exist_ok=True)
                with open(_log_path(), "a", encoding="utf-8") as f:
                    f.write("".join(lines))
            if time.time() - last_bb >= 60:
                last_bb = time.time()
                flush_blackbox()
        except Exception:
            pass


def log(msg, level="INFO"):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for line in str(msg).rstrip("\n").splitlines() or [""]:
        _q.put("%s [%s] %s\n" % (ts, level, line))


_throttle = {}


def error(msg, exc=None):
    """Log an error with its full details. The same error repeating is written at most every 30 seconds."""
    STATS["errors"] += 1
    STATS["lastError"] = {"t": time.time(), "msg": str(msg)[:300]}
    now = time.time()
    t = _throttle.get(str(msg))
    if t and now - t["at"] < 30:
        t["n"] += 1
        return
    repeats = t["n"] if t else 0
    _throttle[str(msg)] = {"at": now, "n": 0}
    log(str(msg) + (" (repeated %d more times)" % repeats if repeats else ""), "ERROR")
    if exc is not None:
        log("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)), "ERROR")


class _Tee(io.TextIOBase):
    """Everything printed to the console window also goes into the log file."""
    def __init__(self, stream, level):
        self.stream, self.level, self.buf = stream, level, ""

    def write(self, s):
        try:
            if self.stream:
                self.stream.write(s)
        except Exception:
            pass
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                if self.level == "ERROR" or "error" in line.lower() or "failed" in line.lower():
                    STATS["lastError"] = {"t": time.time(), "msg": line.strip()[:300]}
                    STATS["errors"] += 1
                log(line, self.level)
        return len(s)

    def flush(self):
        try:
            if self.stream:
                self.stream.flush()
        except Exception:
            pass


def _cleanup():
    cutoff = datetime.date.today() - datetime.timedelta(days=KEEP_LOG_DAYS)
    try:
        for name in os.listdir(LOG_DIR):
            if name.startswith("vspeed-") and name.endswith(".log"):
                try:
                    if datetime.date.fromisoformat(name[7:17]) < cutoff:
                        os.remove(os.path.join(LOG_DIR, name))
                except ValueError:
                    pass
    except OSError:
        pass


def setup(version, mode):
    global _started
    if _started:
        return
    _started = True
    os.makedirs(LOG_DIR, exist_ok=True)
    _cleanup()
    STATS.update(version=version, mode=mode)
    threading.Thread(target=_writer, daemon=True, name="diag-writer").start()
    sys.stdout = _Tee(sys.stdout, "INFO")
    sys.stderr = _Tee(sys.stderr, "ERROR")

    def hook(t, v, tb):
        error("Uncaught error: %s" % v, v)
        sys.__excepthook__(t, v, tb)
    sys.excepthook = hook
    threading.excepthook = lambda a: error("Uncaught error in %s: %s" % (a.thread.name if a.thread else "?", a.exc_value), a.exc_value)
    log("=" * 60)
    log("VSPEED Overlay v%s starting (%s mode)" % (version, mode))
    log("Python %s on %s" % (sys.version.split()[0], platform.platform()))
    log("Folder: %s" % datafiles.ROOT)


# ---------------------------------------------------------------- black box (raw iRacing data)
def blackbox(snap):
    """Called with each raw iRacing reading; keeps one a second for the last 3 hours."""
    global _bb_last
    flags = snap.get("carFlags") or []
    nz = [f for f in flags if f]
    if nz:
        cf = STATS["carFlags"]
        cf["seen"] = True
        cf["any"] += 1
        cf["black"] += sum(1 for f in nz if f & 0x00010000)
        cf["meatball"] += sum(1 for f in nz if f & 0x00100000)
    if not STATS["blackbox"]:
        return
    now = time.time()
    if now - _bb_last < 1.0:
        return
    _bb_last = now
    snap["wall"] = round(now, 2)
    with _bb_lock:
        _bb_pending.append(snap)      # kept as is for now: the caller adds the overlay's own gaps to it afterwards


def results(sess_num, session, wall=None):
    """iRacing's results for the session (positions, laps, times, incidents, reason out, ...), saved whenever
    iRacing changes them, so we can compare them with the overlay's own finish gaps."""
    global _res_key
    if not STATS["blackbox"]:
        return
    rows = session.get("ResultsPositions") or []
    extra = {k: v for k, v in session.items() if k.startswith("Results") and k != "ResultsPositions"}
    try:
        key = json.dumps([sess_num, rows, extra], sort_keys=True, default=str)
    except Exception:
        return
    if key == _res_key:
        return
    _res_key = key
    _res.append({"wall": round(wall or time.time(), 2), "sess": sess_num, "type": session.get("SessionType"),
                 "info": extra, "results": rows})


SESSION_FILE = os.path.join(LOG_DIR, "session.json")
_sess_key = None
_sess_line = None


def session_settings(weekend, session_info):
    """iRacing's weekend and session settings (track, options such as the green-white-checkered limit, incident
    limit, fast repairs, and each session's laps/time), saved whenever they change. Results are left out (results.jsonl has them)."""
    global _sess_key
    try:
        sessions = [{k: v for k, v in (s or {}).items() if not k.startswith("Results")} for s in (session_info or {}).get("Sessions", [])]
        data = {"WeekendInfo": weekend or {}, "Sessions": sessions}
        key = json.dumps(data, sort_keys=True, default=str)
        if key == _sess_key:
            return
        _sess_key = key
        opts = (weekend or {}).get("WeekendOptions") or {}
        line = ", ".join("%s=%s" % (k, opts[k]) for k in sorted(opts)
                         if any(w in k for w in ("GreenWhite", "Incident", "FastRepair", "Caution", "Restart", "StandingStart")))
        global _sess_line
        if line and line != _sess_line:           # only when the settings themselves change, not every session update
            _sess_line = line
            log("Race settings: " + line)
        os.makedirs(LOG_DIR, exist_ok=True)
        tmp = SESSION_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(dict(data, saved=datetime.datetime.now().isoformat(timespec="seconds")), indent=1, default=str))
        os.replace(tmp, SESSION_FILE)
    except Exception:
        pass


def flush_blackbox():
    """Add the last minute's readings to the black box file; every 30 minutes rewrite it to trim it to 3 hours."""
    global _bb_rewritten
    _flush_results()
    flush_usage()
    try:
        with _bb_lock:
            pending = _bb_pending[:]
            del _bb_pending[:]
        lines = []
        for snap in pending:
            try:
                lines.append(json.dumps(snap, separators=(",", ":"), default=str))
            except Exception:
                pass
        _bb.extend(lines)
        if not _bb:
            return
        os.makedirs(LOG_DIR, exist_ok=True)
        if not _bb_rewritten and os.path.exists(BLACKBOX_FILE):
            # first write of this run: keep the previous run's black box (e.g. the overlay restarted for an update mid-race)
            os.replace(BLACKBOX_FILE, BLACKBOX_PREV)
        if time.time() - _bb_rewritten >= BLACKBOX_REWRITE or not os.path.exists(BLACKBOX_FILE):
            _bb_rewritten = time.time()
            tmp = BLACKBOX_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(_bb) + "\n")
            os.replace(tmp, BLACKBOX_FILE)
        elif lines:
            with open(BLACKBOX_FILE, "a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
    except Exception:
        pass


def _flush_results():
    try:
        data = list(_res)
        if not data:
            return
        os.makedirs(LOG_DIR, exist_ok=True)
        tmp = RESULTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for s in data:
                f.write(json.dumps(s, separators=(",", ":"), default=str) + "\n")
        os.replace(tmp, RESULTS_FILE)
    except Exception:
        pass


# ---------------------------------------------------------------- events the overlay noticed
_prev = {"cars": {}, "flag": None, "session": None, "connected": None}
_names = {}


def _who(c):
    return "#%s %s" % (c.get("num", "?"), c.get("name", "?"))


def watch(live):
    """Compare each reading with the last one and log what changed (connections, sessions, flags, pits, penalties)."""
    now = time.time()
    _rate.append(now)
    STATS["ticks"] += 1
    if len(_rate) > 2:
        STATS["rate"] = round((len(_rate) - 1) / max(0.001, _rate[-1] - _rate[0]), 1)
    conn = bool(live.get("connected"))
    if conn != _prev["connected"]:
        _prev["connected"] = conn
        log(("Connected to %s" % live.get("source", "?")) if conn else "Not connected to iRacing (waiting)")
    STATS.update(connected=conn, source=live.get("source", ""))
    if not conn:
        return
    cars = live.get("cars") or []
    STATS["cars"] = len(cars)
    sess = "%s (%s)" % (live.get("sessionName", ""), live.get("sessionType", ""))
    STATS.update(session=sess, track=live.get("track", ""))
    if sess != _prev["session"]:
        _prev["session"] = sess
        _prev["cars"] = {}
        log("Session: %s at %s, %d cars, %s laps" % (sess, live.get("track", "?"), len(cars), live.get("totalLaps") or "timed"))
    otg = bool(live.get("oneToGreen"))
    if otg != _prev.get("otg", False):
        _prev["otg"] = otg
        if otg:
            log("One to green (lap %s)" % live.get("lap"))
    flag = live.get("flag") or ""
    if flag != _prev["flag"]:
        if _prev["flag"] is not None:
            log("Flag: %s -> %s (lap %s)%s" % (_prev["flag"] or "none", flag or "none", live.get("lap"), " [replay]" if live.get("isReplay") else ""))
        _prev["flag"] = flag
    seen = _prev["cars"]
    first = not seen
    for c in cars:
        idx = c["idx"]
        p = seen.get(idx)
        cur = {"pit": bool(c.get("pit")), "stall": c.get("pitState") == "stall", "stops": c.get("stops") or 0,
               "black": bool(c.get("blackFlag")), "meat": bool(c.get("meatball")), "done": bool(c.get("qualDone"))}
        seen[idx] = cur
        if first or p is None:
            continue
        who = _who(c)
        if cur["pit"] and not p["pit"]:
            log("Pit road in: %s (P%s)" % (who, c.get("pos")))
        if p["pit"] and not cur["pit"]:
            log("Pit road out: %s%s" % (who, (", last stop %.1fs" % c["lastPit"]) if c.get("lastPit") else ""))
        if cur["stops"] > p["stops"]:
            log("Pit stop #%d in the box: %s" % (cur["stops"], who))
        if cur["black"] != p["black"]:
            log("Black flag %s: %s (P%s)" % ("ON" if cur["black"] else "cleared", who, c.get("pos")))
        if cur["meat"] != p["meat"]:
            log("Meatball flag %s: %s" % ("ON" if cur["meat"] else "cleared", who))
        if cur["done"] and not p["done"]:
            qd = c.get("qualDone") or {}
            log("Qualifying lap: %s %.3f -> P%s%s" % (who, qd.get("time") or 0, c.get("pos"), " (personal best)" if qd.get("improved") else ""))


# ---------------------------------------------------------------- usage: which buttons and graphics get used
USAGE_FILE = os.path.join(LOG_DIR, "usage.json")
_use_lock = threading.Lock()
_use = {"since": None, "presses": {}, "pages": {}, "onAir": {}, "shows": {}}   # this run
_use_total = None                                                             # every run, loaded from usage.json
_air_prev = set()
_use_dirty = False

_SHOW_NAMES = {"logo": "VSPEED logo", "league": "League logo", "tower": "Ticker", "lowerthird": "Driver info", "flags": "Flag banners",
               "board": "Results board", "movers": "Biggest movers", "pitrace": "Race off pit road",
               "nextrace": "Next broadcast"}


def _labels(path, data):
    """Plain names for a control panel command, e.g. 'Grid: show', 'Camera: pick a driver'."""
    d = data if isinstance(data, dict) else {}
    out = []
    if path == "/api/settings":
        for k, v in (d.get("show") or {}).items():
            out.append("%s: %s" % (_SHOW_NAMES.get(k, k), "show" if v else "hide"))
        gw = d.get("gridw") or {}
        if "visible" in gw:
            out.append("Grid: " + ("show" if gw["visible"] else "hide"))
        if "step" in gw:
            out.append("Grid: " + ("next row" if (gw["step"] or {}).get("dir", 1) > 0 else "previous row"))
        if "on" in (gw.get("pole") or {}) and "visible" not in gw and "step" not in gw:
            out.append("Pole Award: " + ("show" if gw["pole"]["on"] else "hide"))
        if "visible" in (d.get("gfx") or {}):
            out.append("Track graphic: " + ("show" if d["gfx"]["visible"] else "hide"))
        if "active" in (d.get("sponsor") or {}):
            a = d["sponsor"]["active"]
            out.append("Sponsor %s: show" % a if a else "Sponsor: hide")
        if "show" in (d.get("podium") or {}):
            n = d["podium"]["show"]
            out.append("Podium: " + ({1: "winner", 2: "2nd place", 3: "3rd place"}.get(n, "hide")))
        if "flagTrigger" in d:
            out.append("Flag banner: %s" % (d["flagTrigger"] or {}).get("flag", ""))
        if "layout" in d:
            out.append("Layout: move / resize")
        rest = [k for k in d if k not in ("show", "gridw", "gfx", "sponsor", "flagTrigger", "layout", "podium")]
        if rest and not out:
            out.append("Setting: " + ", ".join(sorted(rest))[:60])
    elif path == "/api/camera":
        out.append("Camera: pick a driver" if "carIdx" in d else "Camera: change camera")
    elif path == "/api/replay":
        out.append("Replay: %s" % d.get("cmd", "?"))
    elif path == "/api/standings":
        out.append("Standings: %s" % d.get("cmd", "?"))
    elif path == "/api/penalty":
        out.append("Penalty: %s" % d.get("cmd", "?"))
    elif path == "/api/incident":
        out.append("Incident log: %s" % d.get("cmd", "?"))
    elif path == "/api/gfx":
        out.append("Track graphic: %s" % d.get("cmd", "?"))
    elif path == "/api/pitrace":
        out.append("Race off pit road: %s" % d.get("cmd", "?"))
    else:
        out.append(path.replace("/api/", ""))
    return out


def _bump(dct, key, n=1):
    dct[key] = round(dct.get(key, 0) + n, 1)


def usage_press(path, data, page=""):
    """Count a button press (cheap: a few dictionary updates)."""
    global _use_dirty
    with _use_lock:
        _use["since"] = _use["since"] or datetime.datetime.now().isoformat(timespec="seconds")
        for lbl in _labels(path, data):
            _bump(_use["presses"], lbl)
        if page:
            _bump(_use["pages"], page)
        _use_dirty = True


def usage_on_air(names):
    """Called about once a second with the graphics on screen: adds up seconds on air and counts each time one goes up."""
    global _air_prev, _use_dirty
    names = set(names)
    with _use_lock:
        for n in names:
            _bump(_use["onAir"], n)
        for n in names - _air_prev:
            _bump(_use["shows"], n)
        if names or _air_prev:
            _use_dirty = True
        _air_prev = names


def _merge(total, run):
    for k in ("presses", "pages", "onAir", "shows"):
        for a, b in run.get(k, {}).items():
            _bump(total.setdefault(k, {}), a, b)


def flush_usage():
    """Write usage.json: this run plus the running total of all earlier runs (kept across restarts)."""
    global _use_total, _use_dirty
    with _use_lock:
        if not _use_dirty:
            return
        _use_dirty = False
        run = json.loads(json.dumps(_use))
    try:
        if _use_total is None:
            try:
                with open(USAGE_FILE, encoding="utf-8") as f:
                    old = json.load(f)
                _use_total = old.get("earlierRuns") or {}
                _merge(_use_total, old.get("thisRun") or {})      # the run before this one
            except (OSError, ValueError):
                _use_total = {}
        allt = json.loads(json.dumps(_use_total))
        _merge(allt, run)
        top = lambda d: dict(sorted(d.items(), key=lambda kv: -kv[1]))
        out = {"note": "Button presses and seconds on air, most used first. thisRun = since the overlay started; allTime includes earlier runs.",
               "thisRun": {k: (top(v) if isinstance(v, dict) else v) for k, v in run.items()},
               "allTime": {k: top(v) for k, v in allt.items()},
               "earlierRuns": _use_total}
        os.makedirs(LOG_DIR, exist_ok=True)
        tmp = USAGE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)
        os.replace(tmp, USAGE_FILE)
    except Exception:
        pass


def action(path, data, page=""):
    """A command from the control panel or live timing."""
    try:
        usage_press(path, data, page)
    except Exception:
        pass
    try:
        txt = json.dumps(data, separators=(",", ":"))
    except Exception:
        txt = str(data)
    if len(txt) > 300:
        txt = txt[:300] + "..."
    log("Panel: %s %s" % (path, txt))


def client_error(data):
    STATS["clientErrors"] += 1
    page = str(data.get("page", "?"))[:40]
    msg = str(data.get("msg", ""))[:500]
    where = "%s:%s" % (str(data.get("src", ""))[-80:], data.get("line", ""))
    STATS["lastError"] = {"t": time.time(), "msg": "[%s page] %s" % (page, msg)[:300]}
    log("Browser error on the %s page: %s (%s)" % (page, msg, where), "ERROR")


# ---------------------------------------------------------------- status + diagnostics zip
def status():
    s = dict(STATS)
    s["uptime"] = round(time.time() - STATS["startedAt"])
    s["logDir"] = LOG_DIR
    s["blackboxSeconds"] = len(_bb) + len(_bb_pending)
    return s


def save_zip(settings):
    """Bundle recent logs, the black box, settings and system info into one zip; returns its path."""
    flush_blackbox()
    deadline = time.time() + 2                       # let the writer catch up so the log is complete
    while not _q.empty() and time.time() < deadline:
        time.sleep(0.05)
    os.makedirs(DIAG_DIR, exist_ok=True)
    name = "vspeed-diagnostics-%s.zip" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(DIAG_DIR, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("info.json", json.dumps({"saved": datetime.datetime.now().isoformat(timespec="seconds"),
                                            "python": sys.version, "platform": platform.platform(),
                                            "status": status()}, indent=2, default=str))
        z.writestr("settings.json", json.dumps(settings, indent=2, default=str))
        try:
            for f in sorted(os.listdir(LOG_DIR)):
                if f.endswith(".log") or f in ("blackbox.jsonl", "blackbox-previous.jsonl", "results.jsonl", "session.json", "usage.json"):
                    z.write(os.path.join(LOG_DIR, f), "logs/" + f)
        except OSError:
            pass
    zips = sorted(f for f in os.listdir(DIAG_DIR) if f.endswith(".zip"))
    for old in zips[:-KEEP_DIAG_ZIPS]:
        try:
            os.remove(os.path.join(DIAG_DIR, old))
        except OSError:
            pass
    log("Diagnostics saved: %s" % name)
    return path
