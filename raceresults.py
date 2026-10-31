"""Race results, saved automatically as a CSV file for every race the overlay is connected to.

  data/results/<series>/<date> <track>.csv     (the series picked in the Series picker)

A first copy is written a minute after the checkered flag, from what iRacing has by then, so there's a file even if the
overlay is closed early. It's written again when iRacing makes the results official, and that copy replaces it.
Each race gets its own file: a second race at the same track on the same day is saved as "... (2).csv". The data
folder is never touched by updates.
"""
import csv
import json
import os
import re
import threading
import time

import datafiles
import profiles

DIR = os.path.join(datafiles.DATA, "results")
FIRST_COPY_AFTER = 60          # seconds after the checkered: write what iRacing has so far
LOCK = threading.Lock()
_done = {}                     # race key -> {"path": ..., "official": bool, "checkered": wall time}


def _safe(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", str(name or "")).strip(" .")
    return re.sub(r"\s+", " ", name)[:60] or "Series"


def _lap(t):
    try:
        t = float(t)
    except (TypeError, ValueError):
        return ""
    if t <= 0:
        return ""
    m = int(t // 60)
    return "%d:%06.3f" % (m, t - m * 60) if m else "%.3f" % t


def _status(r):
    """Running, or why they're out. iRacing shortens Disconnected to "Disco"."""
    s = str(r.get("ReasonOutStr") or "").strip()
    if r.get("ReasonOutId") == 32 or s.lower() == "disco":
        return "Disconnected"
    return s or "Running"


def _series():
    try:
        s = profiles.summary()
        return next((p["name"] for p in s["list"] if p["id"] == s["active"]), "") or "Series"
    except Exception:
        return "Series"


def _index(folder):
    try:
        with open(os.path.join(folder, "index.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _path_for(key, folder, base):
    """The file for this race: the one it already has (after a restart), or a new name that isn't taken."""
    idx = _index(folder)
    if key in idx:
        return os.path.join(folder, idx[key])
    name, n = base + ".csv", 2
    while os.path.exists(os.path.join(folder, name)) or name in idx.values():
        name, n = "%s (%d).csv" % (base, n), n + 1
    idx[key] = name
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, "index.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f, indent=1)
    os.replace(tmp, os.path.join(folder, "index.json"))
    return os.path.join(folder, name)


def _write(path, live, sess, official):
    cars = {c["idx"]: c for c in live.get("cars") or []}
    multi = len(live.get("classes") or []) > 1
    rows = sorted((r for r in sess.get("ResultsPositions") or [] if r.get("CarIdx") in cars),
                  key=lambda r: (r.get("Position") or 999))
    head = ["Pos"] + (["Class", "Class Pos"] if multi else []) + \
           ["#", "Driver", "Start", "Laps", "Led", "Gap", "Fastest Lap", "Incidents", "Status"]
    out = [head]
    for r in rows:
        c = cars[r["CarIdx"]]
        gap = c.get("gap") or ""
        inc = r.get("Incidents")
        out.append([r.get("Position") or ""] +
                   ([c.get("cls", ""), (r.get("ClassPosition") or 0) + 1] if multi else []) +
                   [c.get("num", ""), c.get("name", ""), c.get("startPos") or "", r.get("LapsComplete", ""),
                    r.get("LapsLed", ""), "" if gap == "LEADER" else gap, _lap(r.get("FastestTime")),
                    inc if isinstance(inc, int) and inc >= 0 else "", _status(r)])
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:      # -sig: Excel opens the names correctly
        csv.writer(f).writerows(out)
    os.replace(tmp, path)
    return len(rows)


def update(live, sess, info, sess_num, log=print):
    """Called every reading while a race session is at the checkered or later (not during replays)."""
    if not sess.get("ResultsPositions"):
        return
    official = bool(sess.get("ResultsOfficial"))
    now = time.time()
    key = "%s-%s" % (info.get("subId") or ("%s %s" % (time.strftime("%Y-%m-%d"), live.get("track", ""))), sess_num)
    with LOCK:
        st = _done.setdefault(key, {"path": None, "official": False, "checkered": now})
        if st["official"] or (not official and (st["path"] or now - st["checkered"] < FIRST_COPY_AFTER)):
            return
        try:
            series = _series()
            if not st["path"]:
                base = "%s %s" % (time.strftime("%Y-%m-%d"), _safe(live.get("track") or "Race"))
                st["path"] = _path_for(key, os.path.join(DIR, _safe(series)), base)
            n = _write(st["path"], live, sess, official)
            st["official"] = official
            log("Race results saved%s: %s (%d drivers)" % (" (official)" if official else " (not official yet)",
                                                           os.path.relpath(st["path"], datafiles.DATA), n))
        except Exception as e:
            st["official"] = True      # don't retry every reading
            log("Could not save the race results: %r" % (e,))
