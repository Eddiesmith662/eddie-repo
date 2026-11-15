"""Series profiles: each series you broadcast keeps its own standings, bracket, points and branding.

A profile holds:
  - the standings (Xtreme Scoring link, the pulled or loaded table, any hand edits), the standings graphic's title,
    logo, logo size and playoff cutoff (on/off and the number), the drivers excluded from the standings, and the
    playoff bracket (with its round-win marks),
  - live points: the points table, bonuses, line, places and playoff mode,
  - the ticker header (race name) and the top-right league logo,
  - the Next broadcast text and logo.
Race info, the broadcast team and the sponsor images are shared by every series and don't switch.

Profiles live in data/profiles/<id>/ (settings.json + a copy of that series' standings files), so updates never
touch them. Switching saves the current series first (anything changed since it was loaded is kept), then loads
the other one. The first time this runs, whatever is set up now becomes the first profile.

GLR HUB series (Nov 2026): the Series list also shows the series on the league site (glrsite.py). Picking one makes a
series here that is linked to it (index.json: "site": the site's address for it, its class when it has several), with
its standings pulled from the site and its names from the site's. It is a series like any other: it switches, saves
and opens without internet from its saved copy. Refresh pulls its standings again; nothing is pulled by itself.
With the standings come the site's scoring rules for live points (when the series has a points table there), the
playoff cutoff, and the series' logo. The site wins for standings, points and the cutoff. The logos are the producer's
to change: the standings logo is only set when there is none or it is still the site's, and the league logo (top
right of the broadcast) the first time and after that only while it is still the site's.
Also from the site: the Next broadcast box's event, date and time (the series' next race on the site's schedule), and
in the playoffs the bracket, live points' playoff mode and the cutoff for the round being run, when the series'
rounds are the 12 / 8 / 4 the overlay's bracket shows.
"""
import json
import os
import re
import shutil
import threading
import time

import datafiles
import glrsite
import standings

DIR = os.path.join(datafiles.DATA, "profiles")
INDEX = os.path.join(DIR, "index.json")
SETTINGS_KEYS = ("livePoints", "raceName", "leagueLogo", "nextRace")       # settings.json keys that belong to a series
CONFIG_KEYS = ("xtreme", "title", "cutoff", "logo", "logo_name", "logo_size", "excluded")   # standings/config.json keys that do
STANDINGS_FILES = ("standings.json", "bracket.json")
LOCK = threading.Lock()
_state = None          # the overlay's State (server.py), set by init()


def _read(path, default, backup=False):
    data = datafiles.load_json(path, default, backup=backup)
    return default if data is None else data


def _write(path, data):
    global _cache
    datafiles.write_json(path, data, indent=1)
    if path == INDEX:
        _cache = json.loads(json.dumps(data))


_cache = None
# True when a switch failed half-way and putting the previous series back failed too: the live files may then be a mix
# of two series, so they're never saved into a series' folder until a switch has loaded one cleanly again
_mixed = False


def _index():
    global _cache
    if _cache is not None:
        return json.loads(json.dumps(_cache))
    idx = _read(INDEX, None, backup=True)
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
    if _mixed:
        print("Series profiles: not saving '%s': the loaded files may be a mix of two series after a failed switch" % pid)
        return
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
    blank = {"logo_size": 192, "excluded": []}
    standings.update_config(**{k: cfg_saved.get(k, blank.get(k, "")) for k in CONFIG_KEYS if k != "cutoff"},
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


def _switch(pid, back, names):
    """Load series `pid`. If that fails part-way, put series `back` (just saved) back, so the live files are never
    left as a mix of two series. Returns None, or a message saying what went wrong."""
    global _mixed
    try:
        _load(pid)
        _mixed = False
        return None
    except Exception as e:
        err = e
    print("Series profiles: couldn't load '%s': %r" % (pid, err))
    if back:
        try:
            _load(back)
            _mixed = False
            return "Couldn't switch to %s (%s). Still on %s." % (names.get(pid, pid), err, names.get(back, back))
        except Exception as e2:
            print("Series profiles: couldn't put '%s' back either: %r" % (back, e2))
    _mixed = True
    return ("Couldn't switch to %s (%s), and the series that was loaded couldn't be put back. Pick a series again "
            "before the broadcast; nothing is saved over a series until one loads." % (names.get(pid, pid), err))


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
    """For the control panel's Series picker: the series here, and the ones on GLR HUB that aren't linked to one yet."""
    idx = _index()
    site = glrsite.list_snapshot()
    linked = {(p.get("site") or {}).get("slug") for p in idx["list"]}
    return {"active": idx.get("active"), "list": idx["list"],
            "site": [s for s in site["series"] if s["slug"] not in linked], "siteError": site["error"], "siteAt": site["at"]}


def _unique_name(name, idx):
    """A series name that isn't taken here: 'Trucks', else 'Trucks (GLR HUB)', else with a number."""
    taken = {p["name"].lower() for p in idx["list"]}
    name = " ".join(str(name or "").split())[:40] or "Series"
    if name.lower() not in taken:
        return name
    for extra in ["(GLR HUB)"] + ["(GLR HUB %d)" % n for n in range(2, 50)]:
        cand = "%s %s" % (name[:40 - len(extra) - 1], extra)
        if cand.lower() not in taken:
            return cand
    return name


SITE_LOGO_NAME = "GLR HUB series logo"       # the standings logo's name when it came from the site


def _fetch_extras(slug, link):
    """The scoring rules and the logo from the site, read before anything changes. A problem with either is a note for
    the producer, never a reason to stop: the standings still load."""
    ex = {"rules": None, "logoAddr": None, "logo": None, "next": None, "notes": []}
    try:
        ex["next"] = glrsite.fetch_next(slug) or {}
    except glrsite.SiteError as e:
        ex["notes"].append("Next broadcast not read (%s)" % e)
    try:
        ex["rules"] = glrsite.fetch_rules(slug)
    except glrsite.SiteError as e:
        ex["notes"].append("Points rules not read (%s)" % e)
    try:
        ex["logoAddr"] = glrsite.logo_address(slug)
        if ex["logoAddr"] and ex["logoAddr"] != (link or {}).get("logo"):
            ex["logo"] = glrsite.fetch_logo(ex["logoAddr"])
    except glrsite.SiteError as e:
        ex["notes"].append("Logo not read (%s)" % e)
    return ex


def _write_image(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(body)
    os.replace(tmp, path)


def _apply_playoff(entry, po):
    """The playoffs as the site has them, with the standings just pulled: the bracket, live points' playoff mode and
    the cutoff for the round being run. Only for a series whose rounds are the overlay's 12 / 8 / 4; any other
    format leaves the bracket and playoff mode as the producer set them."""
    link = entry["site"]
    link["playoffs"] = ("" if not po["enabled"] else "other" if not po["fits"] else po["name"] or "started" if po["started"] else "regular")
    if not po["enabled"]:
        return
    if po["started"] and po["spots"]:              # e.g. 8 go through from the Round of 12
        n = max(1, min(20, po["spots"]))
        _state.update_settings({"livePoints": {"cutoff": n}})
        standings.set_state(playoff=True, cutoff=n)
        standings.update_config(cutoff=n)
    if not po["fits"]:
        return
    _state.update_settings({"livePoints": {"playoff": bool(po["started"])}})
    if po["started"] and po["rounds"]:
        standings.set_bracket(po["rounds"])


def _apply_extras(entry, ex, table=None):
    """Put the site's scoring rules, cutoff, logo and Next broadcast live for the loaded series `entry`, and with a
    standings table just pulled, the playoffs. Returns notes for the producer."""
    link, notes = entry["site"], list(ex["notes"])
    if ex["next"]:
        _state.update_settings({"nextRace": ex["next"]})
    if ex["next"] is not None:
        link["next"] = bool(ex["next"])
    rules = ex["rules"]
    if rules:
        link["points"] = rules["source"]
        if rules["livePoints"]:
            _state.update_settings({"livePoints": rules["livePoints"]})
            for what in rules["skipped"]:
                notes.append("Live points doesn't count %s" % what)
        if rules["field"]:
            n = max(1, min(60, rules["field"]))
            _state.update_settings({"livePoints": {"cutoff": n}})
            standings.set_state(playoff=True, cutoff=min(20, n))
            standings.update_config(cutoff=min(20, n))
    if ex["logo"]:
        body, ext = ex["logo"]
        try:
            cfg = standings.load_config()
            if not standings.logo_file(cfg) or cfg.get("logo_name") == SITE_LOGO_NAME:     # none, or still the site's
                for f in _logo_files(standings.CONFIG_DIR):
                    os.remove(os.path.join(standings.CONFIG_DIR, f))
                dest = os.path.join(standings.CONFIG_DIR, "logo" + ext)
                _write_image(dest, body)
                standings.update_config(logo=os.path.basename(dest), logo_name=SITE_LOGO_NAME)
                standings.set_logo(dest)
            fname = "glrhub-%s%s" % (link["slug"], ext)
            with _state.lock:
                current = _state.settings.get("leagueLogo") or ""
            if "logo" not in link or current == link.get("logoFile"):                      # the first time, or still the site's
                _write_image(os.path.join(datafiles.LOGO_DIR, fname), body)
                _state.update_settings({"leagueLogo": fname})
                link["logoFile"] = fname
        except OSError as e:
            notes.append("Logo not saved (%s)" % e)
            return notes
    if ex["logoAddr"] is not None:
        link["logo"] = ex["logoAddr"]
    with _state.lock:
        nr_logo = (_state.settings.get("nextRace") or {}).get("logo") or ""
    if link.get("logoFile") and not nr_logo and os.path.exists(os.path.join(datafiles.LOGO_DIR, link["logoFile"])):
        _state.update_settings({"nextRace": {"logo": link["logoFile"]}})      # the Next broadcast box had no logo
    if table is not None:
        _apply_playoff(entry, table["playoff"])      # after the rules: the round's cutoff, not the whole field's
    return notes


def _apply_site(table):
    """Put standings from GLR HUB live (the loaded series must be the linked one)."""
    standings.set_data(table["header"], table["rows"], "glrhub", pulled_at=time.time(), edited_at=None, ids=table["ids"])
    standings.log("Pulled %d drivers from GLR HUB%s%s. The graphic updates by itself." % (
        len(table["rows"]), (" (%s)" % table["cls"]) if table["cls"] else "", ", playoff standings" if table["playoffs"] else ""))


def _site_command(cmd, d):
    """link / siteRefresh / siteClass / siteList. The site is read before anything here changes, and never with LOCK
    held, so a slow or missing site can't leave a half-made series or hold up switching."""
    if cmd == "siteList":
        return glrsite.refresh_list()
    force = bool(d.get("force"))
    with LOCK:
        idx = _index()
        act = idx.get("active")
        cur = next((p for p in idx["list"] if p["id"] == act), None)
        if cmd == "link":
            slug = str(d.get("slug") or "")
            have = next((p for p in idx["list"] if (p.get("site") or {}).get("slug") == slug), None)
            listed = next((s for s in glrsite.list_snapshot()["series"] if s["slug"] == slug), None)
            if not have and not listed:
                return False, "That series isn't in the GLR HUB list any more. Refresh the list and pick again."
            cls = ((have or {}).get("site") or {}).get("cls", "")
        else:
            if not cur or not cur.get("site"):
                return False, "This series isn't linked to GLR HUB."
            have, slug = cur, cur["site"]["slug"]
            cls = str(d.get("cls") or "") if cmd == "siteClass" else cur["site"].get("cls", "")
            if standings.data_snapshot()["edited_at"] and not force:
                return False, "CONFIRM:The standings were edited by hand. Pulling from GLR HUB replaces the edits. Continue?"
    try:
        table = glrsite.fetch_standings(slug, cls)
    except glrsite.SiteError as e:
        if cmd == "link" and have:                  # no internet: the linked series still opens from its saved copy
            ok, msg = command({"cmd": "switch", "id": have["id"]})
            return ok, ("%s. Couldn't refresh from GLR HUB: %s" % (msg or "Loaded the saved copy", e)) if ok else msg
        return False, str(e)
    extras = _fetch_extras(slug, (have or {}).get("site"))
    more = lambda notes: (". " + ". ".join(notes)) if notes else ""
    with LOCK:
        idx = _index()
        ids = {p["id"]: p for p in idx["list"]}
        names = {p["id"]: p["name"] for p in idx["list"]}
        act = idx.get("active")
        have = next((p for p in idx["list"] if (p.get("site") or {}).get("slug") == slug), None)
        link = {"slug": slug, "cls": table["cls"], "classes": table["classes"], "season": table["season"]}
        if cmd != "link":
            if not have or have["id"] != act:
                return False, "Another series was loaded while GLR HUB was answering. Nothing was changed."
            have["site"] = dict(have["site"], **link)
            _apply_site(table)
            notes = _apply_extras(have, extras, table)
            _write(INDEX, idx)
            return True, "Pulled %d drivers from GLR HUB%s" % (len(table["rows"]), more(notes))
        if have:                                    # linked before: switch to it, then bring its standings up to date
            if have["id"] != act or _mixed:
                if act in ids:
                    _save(act)
                problem = _switch(have["id"], act if act in ids and act != have["id"] else None, names)
                if problem:
                    return False, problem
                idx["active"] = have["id"]
            have["site"] = dict(have["site"], **link)
            edited = bool(standings.data_snapshot()["edited_at"])
            notes = _apply_extras(have, extras, None if edited else table)
            if edited:                                      # hand edits stay until Refresh is pressed for this series
                _write(INDEX, idx)
                return True, ("Switched to %s. Its standings were edited by hand, so they weren't replaced: press "
                              "Refresh from GLR HUB to pull%s" % (have["name"], more(notes)))
            _apply_site(table)
            _write(INDEX, idx)
            return True, "Switched to %s: %d drivers from GLR HUB%s" % (have["name"], len(table["rows"]), more(notes))
        listed = next((s for s in glrsite.list_snapshot()["series"] if s["slug"] == slug), None) or {"short": slug, "name": slug}
        name = _unique_name(listed["short"], idx)
        pid = _new_id(name, idx)
        if act in ids:
            _save(act)                              # keep the current one as it is
        link.update(name=listed["name"], id=listed.get("id"), hidden=bool(listed.get("hidden")))
        idx["list"].append({"id": pid, "name": name, "site": link})
        os.makedirs(os.path.join(_pdir(pid), "standings"), exist_ok=True)
        with _state.lock:
            defaults = _state.defaults()
        full = " ".join(str(listed["name"]).split()).upper()[:80]
        # a fresh series: default points, no bracket; the ticker header and the standings title are the series' name
        _write(os.path.join(_pdir(pid), "settings.json"),
               {"settings": {"livePoints": defaults["livePoints"], "raceName": full[:60], "leagueLogo": _state.settings.get("leagueLogo", ""),
                             "nextRace": defaults["nextRace"]},
                "config": {"title": full}, "graphic": {"playoff": False, "cutoff": 16}})
        problem = _switch(pid, act if act in ids else None, dict(names, **{pid: name}))
        if problem:
            idx["list"] = [p for p in idx["list"] if p["id"] != pid]     # not created after all
            shutil.rmtree(_pdir(pid), ignore_errors=True)
            return False, problem
        idx["active"] = pid
        _apply_site(table)
        notes = _apply_extras(idx["list"][-1], extras, table)
        _write(INDEX, idx)
        _save(pid)
        return True, "%s added from GLR HUB: %d drivers%s" % (name, len(table["rows"]), more(notes))


def command(d):
    """switch / new / rename / delete, and for GLR HUB series link / siteRefresh / siteClass / siteList.
    Returns (ok, message)."""
    cmd = str(d.get("cmd") or "")
    if cmd in ("link", "siteRefresh", "siteClass", "siteList"):
        return _site_command(cmd, d)
    with LOCK:
        idx = _index()
        ids = {p["id"]: p for p in idx["list"]}
        names = {p["id"]: p["name"] for p in idx["list"]}
        act = idx.get("active")
        if cmd == "switch":
            pid = str(d.get("id") or "")
            if pid not in ids:
                return False, "That series doesn't exist any more."
            if pid == act and not _mixed:
                return True, ""
            if act in ids:
                _save(act)
            problem = _switch(pid, act if act in ids and act != pid else None, names)
            if problem:
                return False, problem
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
            problem = _switch(pid, act if act in ids else None, dict(names, **{pid: name}))
            if problem:
                idx["list"] = [p for p in idx["list"] if p["id"] != pid]     # not created after all
                shutil.rmtree(_pdir(pid), ignore_errors=True)
                return False, problem
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
