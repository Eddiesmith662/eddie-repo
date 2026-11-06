"""Race results, saved automatically as a CSV file for every race the overlay is connected to.

  data/results/<series>/<date> <track>.csv     (the series picked in the Series picker)

A first copy is written a minute after the checkered flag, from what iRacing has by then, so there's a file even if the
overlay is closed early. It's written again when iRacing makes the results official, and that copy replaces it.
Each race gets its own file: a second race at the same track on the same day is saved as "... (2).csv". The data
folder is never touched by updates.
"""
import csv
import io
import json
import os
import re
import threading
import time

import datafiles
import profiles

DIR = os.path.join(datafiles.DATA, "results")
FIRST_COPY_AFTER = 60          # seconds after the checkered: write what iRacing has so far
RETRY_AFTER = 30               # a copy that couldn't be saved (or queued for the league site) is tried again this much later
MAX_TRIES = 10                 # ... up to this many times (about 5 minutes)
LOCK = threading.Lock()
# race key -> {"path", "checkered": wall time, "csv" / "queued" / "done": None, "first" or "official" (the copy that
# was written / queued for the league site / fully handled), "fails", "retryAt"}
_done = {}


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
    datafiles.write_json(os.path.join(folder, "index.json"), idx, indent=1)
    return os.path.join(folder, name)


def _write(path, live, sess, official):
    cars = {c["idx"]: c for c in live.get("cars") or []}
    multi = len(live.get("classes") or []) > 1
    rows = sorted((r for r in sess.get("ResultsPositions") or [] if r.get("CarIdx") in cars),
                  key=lambda r: (r.get("Position") or 999))
    head = ["Pos"] + (["Class", "Class Pos"] if multi else []) + \
           ["#", "Driver", "Start", "Laps", "Led", "Gap", "Fastest Lap", "Incidents", "Status", "Cust ID"]
    out = [head]
    for r in rows:
        c = cars[r["CarIdx"]]
        gap = c.get("gap") or ""
        inc = r.get("Incidents")
        out.append([r.get("Position") or ""] +
                   ([c.get("cls", ""), (r.get("ClassPosition") or 0) + 1] if multi else []) +
                   [c.get("num", ""), c.get("name", ""), c.get("startPos") or "", r.get("LapsComplete", ""),
                    r.get("LapsLed", ""), "" if gap == "LEADER" else gap, _lap(r.get("FastestTime")),
                    inc if isinstance(inc, int) and inc >= 0 else "", _status(r),
                    c.get("custId", "")])          # iRacing customer ID: the same driver every week, whatever their name
    buf = io.StringIO(newline="")
    csv.writer(buf).writerows(out)
    datafiles.write_text(path, "﻿" + buf.getvalue(), newline="")   # BOM: Excel opens the names correctly
    return len(rows)


def update(live, sess, info, sess_num, log=print, on_saved=None):
    """Called every reading while a race session is at the checkered or later (not during replays).
    on_saved(official) runs after each copy is written (the league site upload uses it)."""
    if not sess.get("ResultsPositions"):
        return
    official = bool(sess.get("ResultsOfficial"))
    want = "official" if official else "first"
    now = time.time()
    key = "%s-%s" % (info.get("subId") or ("%s %s" % (time.strftime("%Y-%m-%d"), live.get("track", ""))), sess_num)
    with LOCK:
        st = _done.setdefault(key, {"path": None, "checkered": now, "csv": None, "queued": None, "done": None,
                                    "fails": 0, "retryAt": 0.0})
        if st["done"] in ("official", want) or (not official and now - st["checkered"] < FIRST_COPY_AFTER):
            return
        if now < st["retryAt"]:
            return
        problem = False
        # the CSV file and the league site upload are tried separately, so one failing never stops the other
        if st["csv"] != want:
            try:
                if not st["path"]:
                    base = "%s %s" % (time.strftime("%Y-%m-%d"), _safe(live.get("track") or "Race"))
                    st["path"] = _path_for(key, os.path.join(DIR, _safe(_series())), base)
                n = _write(st["path"], live, sess, official)
                st["csv"] = want
                log("Race results saved%s: %s (%d drivers)" % (" (official)" if official else " (not official yet)",
                                                               os.path.relpath(st["path"], datafiles.DATA), n))
            except Exception as e:
                problem = True
                log("Could not save the race results (try %d of %d): %r" % (st["fails"] + 1, MAX_TRIES, e))
        if on_saved and st["queued"] != want:
            try:
                on_saved(official)
                st["queued"] = want
            except Exception as e:
                problem = True
                log("League site upload: couldn't queue the race (try %d of %d): %r" % (st["fails"] + 1, MAX_TRIES, e))
        if not problem:
            st["done"], st["fails"] = want, 0
            return
        st["fails"] += 1
        if st["fails"] >= MAX_TRIES:
            st["done"] = "official"            # stop trying for this race
            log("Gave up saving this race's results after %d tries (see the errors above)" % MAX_TRIES)
        else:
            st["retryAt"] = now + RETRY_AFTER
