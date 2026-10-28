"""Series profiles: each series you broadcast keeps its own standings, bracket, points and branding.

A profile holds:
  - the standings (Xtreme Scoring link, the pulled or loaded table, any hand edits), the standings graphic's title,
    logo, logo size and playoff cutoff (on/off and the number), and the playoff bracket (with its round-win marks),
  - live points: the points table, bonuses, line, places and playoff mode,
  - the ticker header (race name) and the top-right league logo,
  - the Next broadcast text and logo.
Race info, the broadcast team and the sponsor images are shared by every series and don't switch.

Profiles live in data/profiles/<id>/ (settings.json + a copy of that series' standings files), so updates never
touch them. Switching saves the current series first (anything changed since it was loaded is kept), then loads
the other one. The first time this runs, whatever is set up now becomes the first profile.
"""
import json
import os
import re
import shutil
import threading
import time

import datafiles
import standings

DIR = os.path.join(datafiles.DATA, "profiles")
INDEX = os.path.join(DIR, "index.json")
SETTINGS_KEYS = ("livePoints", "raceName", "leagueLogo", "nextRace")       # settings.json keys that belong to a series
CONFIG_KEYS = ("xtreme", "title", "cutoff", "logo", "logo_name", "logo_size")   # standings/config.json keys that do
STANDINGS_FILES = ("standings.json", "bracket.json")
LOCK = threading.Lock()
_state = None          # the overlay's State (server.py), set by init()


def _read(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path, data):
    global _cache
    if path == INDEX:
        _cache = json.loads(json.dumps(data))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


_cache = None


def _index():
    global _cache
    if _cache is not None:
        return json.loads(json.dumps(_cache))
    idx = _read(INDEX, None)
    if not isinstance(idx, dict) or not isinstance(idx.get("list"), list):
        idx = {"active": None, "list": []}
    _cache = idx
    return json.loads(json.dumps(idx))


def _pdir(pid):
    return os.path.join(DIR, pid)


def _new_id(name, idx):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "series"
    pid, n = base, 2
    taken = {p["id"] for p in idx["list"]}
    while pid in taken or os.path.exists(_pdir(pid)):
        pid, n = "%s-%d" % (base, n), n + 1
    return pid


def _logo_files(folder):
    try:
        return [f for f in os.listdir(folder) if f.startswith("logo.") and os.path.splitext(f)[1].lower() in standings.LOGO_TYPES]
    except OSError:
        return []


# ---------------------------------------------------------------- save / load one series
def _save(pid):
    """Copy the series' part of what's live now into its profile folder."""
    d = _pdir(pid)
    sd = os.path.join(d, "standings")
    os.makedirs(sd, exist_ok=True)
    with _state.lock:
        settings = {k: json.loads(json.dumps(_state.settings.get(k))) for k in SETTINGS_KEYS if k in _state.settings}
    with standings.STATE_LOCK:
        graphic = {"playoff": bool(standings.STATE.get("playoff")), "cutoff": standings.STATE.get("cutoff")}
    cfg = standings.load_config()
    _write(os.path.join(d, "settings.json"), {"settings": settings, "config": {k: cfg[k] for k in CONFIG_KEYS if k in cfg},
                                               "graphic": graphic, "saved": time.strftime("%Y-%m-%d %H:%M:%S")})
    standings.save_data()
    standings.save_bracket()
    for f in STANDINGS_FILES:                       # the standings table and the bracket as they are now
        src = os.path.join(standings.CONFIG_DIR, f)
        dst = os.path.join(sd, f)
        if os.path.exists(src):
            shutil.copy2(src, dst)
        elif os.path.exists(dst):
            os.remove(dst)
    for f in _logo_files(sd):                       # the standings graphic's logo
        os.remove(os.path.join(sd, f))
    for f in _logo_files(standings.CONFIG_DIR):
        shutil.copy2(os.path.join(standings.CONFIG_DIR, f), os.path.join(sd, f))


def _load(pid):
    """Put a saved series live: its settings, its standings files, and the standings module's state."""
    d = _pdir(pid)
    sd = os.path.join(d, "standings")
    saved = _read(os.path.join(d, "settings.json"), {})
    # settings: replace these keys whole (a merge would keep the other series' leftovers, e.g. a longer points table)
    patch = {k: v for k, v in (saved.get("settings") or {}).items() if k in SETTINGS_KEYS}
    if patch:
        with _state.lock:
            for k, v in patch.items():
                _state.settings[k] = v
        _state.update_settings({})                  # saves settings.json and tells every page
    # standings files
    os.makedirs(standings.CONFIG_DIR, exist_ok=True)
    for f in STANDINGS_FILES:
        src, dst = os.path.join(sd, f), os.path.join(standings.CONFIG_DIR, f)
        if os.path.exists(src):
            shutil.copy2(src, dst)
        elif os.path.exists(dst):
            os.remove(dst)
    for f in _logo_files(standings.CONFIG_DIR):
        os.remove(os.path.join(standings.CONFIG_DIR, f))
    for f in _logo_files(sd):
        shutil.copy2(os.path.join(sd, f), os.path.join(standings.CONFIG_DIR, f))
    cfg_saved = saved.get("config") or {}
    standings.update_config(**{k: cfg_saved.get(k, "" if k != "logo_size" else 192) for k in CONFIG_KEYS if k != "cutoff"},
                            cutoff=cfg_saved.get("cutoff", 16))
    # the standings module's state from those files
    if not standings.load_data():
        standings.set_data([], [], "", pulled_at=0, edited_at=None, save=False)
    if os.path.exists(standings.BRACKET_PATH):
        standings.load_bracket()
    else:
        standings.set_bracket([[], [], [], []], save=False)
    standings.set_logo(standings.logo_file(standings.load_config()))
    g = saved.get("graphic") or {}
    try:
        cut = max(1, min(20, int(g.get("cutoff") or cfg_saved.get("cutoff") or 16)))
    except (TypeError, ValueError):
        cut = 16
    try:
        size = max(40, min(220, int(cfg_saved.get("logo_size") or 192)))
    except (TypeError, ValueError):
        size = 192
    standings.set_state(title=cfg_saved.get("title") or None, cutoff=cut, playoff=bool(g.get("playoff")), logoSize=size, visible=False)
    standings.bump("reload")                         # the standings graphic re-reads its data


# ---------------------------------------------------------------- what the control panel calls
def init(state):
    """Called once at startup. The first time, what's set up now becomes the first series."""
    global _state
    _state = state
    with LOCK:
        idx = _index()
        if idx["list"] and idx.get("active") in {p["id"] for p in idx["list"]}:
            return
        if not idx["list"]:
            name = " ".join(str(state.settings.get("raceName") or "").split())[:40] or "My series"   # the ticker header, as typed
            pid = _new_id(name, idx)
            idx["list"].append({"id": pid, "name": name})
        idx["active"] = idx["list"][0]["id"]
        _save(idx["active"])
        _write(INDEX, idx)
        print("Series profiles: '%s' created from the current setup" % idx["list"][0]["name"])


def summary():
    idx = _index()
    return {"active": idx.get("active"), "list": idx["list"]}


def command(d):
    """switch / new / rename / delete. Returns (ok, message)."""
    cmd = str(d.get("cmd") or "")
    with LOCK:
        idx = _index()
        ids = {p["id"]: p for p in idx["list"]}
        act = idx.get("active")
        if cmd == "switch":
            pid = str(d.get("id") or "")
            if pid not in ids:
                return False, "That series doesn't exist any more."
            if pid == act:
                return True, ""
            if act in ids:
                _save(act)
            _load(pid)
            idx["active"] = pid
            _write(INDEX, idx)
            return True, "Switched to %s" % ids[pid]["name"]
        if cmd == "new":
            name = " ".join(str(d.get("name") or "").split())[:40]
            if not name:
                return False, "Give the series a name."
            if any(p["name"].lower() == name.lower() for p in idx["list"]):
                return False, "There's already a series called %s." % name
            pid = _new_id(name, idx)
            if act in ids:
                _save(act)                          # keep the current one as it is
            idx["list"].append({"id": pid, "name": name})
            if d.get("blank"):
                # a fresh start: empty standings and bracket, default points; the ticker header becomes the name
                os.makedirs(os.path.join(_pdir(pid), "standings"), exist_ok=True)
                with _state.lock:
                    defaults = _state.defaults()
                _write(os.path.join(_pdir(pid), "settings.json"),
                       {"settings": {"livePoints": defaults["livePoints"], "raceName": name.upper(), "leagueLogo": _state.settings.get("leagueLogo", ""),
                                     "nextRace": defaults["nextRace"]},
                        "config": {}, "graphic": {"playoff": False, "cutoff": 16}})
            else:
                _save(pid)                           # a copy of the current series, to change from there
            _load(pid)
            idx["active"] = pid
            _write(INDEX, idx)
            return True, "Created %s" % name
        if cmd == "rename":
            pid, name = str(d.get("id") or act or ""), " ".join(str(d.get("name") or "").split())[:40]
            if pid not in ids or not name:
                return False, "Give the series a name."
            if any(p["name"].lower() == name.lower() and p["id"] != pid for p in idx["list"]):
                return False, "There's already a series called %s." % name
            ids[pid]["name"] = name
            _write(INDEX, idx)
            return True, "Renamed to %s" % name
        if cmd == "delete":
            pid = str(d.get("id") or "")
            if pid not in ids:
                return False, "That series doesn't exist any more."
            if pid == act:
                return False, "Switch to another series first: the one that's loaded can't be deleted."
            idx["list"] = [p for p in idx["list"] if p["id"] != pid]
            shutil.rmtree(_pdir(pid), ignore_errors=True)
            _write(INDEX, idx)
            return True, "Deleted %s" % ids[pid]["name"]
        if cmd == "save":                            # keep a copy of the current series now (switching does this too)
            if act in ids:
                _save(act)
            return True, "Saved"
    return False, "Unknown command: %s" % cmd
