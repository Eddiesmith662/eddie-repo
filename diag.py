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
KEEP_LOG_DAYS = 7
BLACKBOX_SECONDS = 30 * 60          # keep the last 30 minutes, one snapshot a second
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
_bb = collections.deque(maxlen=BLACKBOX_SECONDS)
_bb_last = 0.0
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
    """Called with each raw iRacing reading; keeps one a second for the last 30 minutes."""
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
    _bb.append(snap)


def flush_blackbox():
    try:
        data = list(_bb)
        if not data:
            return
        os.makedirs(LOG_DIR, exist_ok=True)
        tmp = BLACKBOX_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for s in data:
                f.write(json.dumps(s, separators=(",", ":")) + "\n")
        os.replace(tmp, BLACKBOX_FILE)
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


def action(path, data):
    """A command from the control panel or live timing."""
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
    s["blackboxSeconds"] = len(_bb)
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
                if f.endswith(".log") or f == "blackbox.jsonl":
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
