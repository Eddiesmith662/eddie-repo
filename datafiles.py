"""Where each install keeps its own files.

Everything that belongs to the person using the overlay (settings, standings, sponsor
images, league logos, update backups) lives in the `data` folder. Updates only ever
replace program files, so nothing in `data` is touched by an update.

Older installs kept these files next to the program; they are moved into `data`
automatically the first time this version runs.
"""
import json
import os
import shutil
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
# VSPEED_DATA points the program at another data folder (the tests use a throwaway one, never the real data)
DATA = os.environ.get("VSPEED_DATA") or os.path.join(ROOT, "data")
SETTINGS_FILE = os.path.join(DATA, "settings.json")
STANDINGS_DIR = os.path.join(DATA, "standings")
SPONSOR_DIR = os.path.join(DATA, "sponsors")
LOGO_DIR = os.path.join(DATA, "logos")          # league / series logos for the top right

# images that ship with the program (everything else in static/assets was added by the user)
BUILTIN_ASSETS = {"vspeed_logo.png", "vspeed_badge.png", "preview_bg.jpg", "podium_1.png", "podium_2.png", "podium_3.png"}
# the logo move below is for installs from before the data folder existed; it runs once per install, so images
# that later versions ship in static/assets are never moved (v1.5.16 moved the podium artwork into data/logos)
ASSETS_MOVED_MARK = os.path.join(DATA, ".logos-moved")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


# ---------------------------------------------------------------- saving and loading the data files safely
# The overlay usually lives on a OneDrive-synced Desktop, and OneDrive briefly locks files while it uploads them.
# Every save goes to a temporary file first and then replaces the real one, so a crash or power cut mid-save
# never leaves a half-written file, and a locked file is tried again for a couple of seconds.
_TRIES = 12


def _retry(fn):
    for i in range(_TRIES):
        try:
            return fn()
        except PermissionError:
            if i == _TRIES - 1:
                raise
            time.sleep(0.05 * (i + 1))      # about 3.9 s in all


def write_text(path, text, newline=None):
    """Save text to `path` all at once: the old copy stays until the new one is complete.
    newline="" writes line endings exactly as given (CSV files, whose writer adds its own)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = "%s.%d.tmp" % (path, threading.get_ident())     # one per thread, so two saves at once never collide
    try:
        with open(tmp, "w", encoding="utf-8", newline=newline) as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        _retry(lambda: os.replace(tmp, path))
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def write_json(path, data, indent=None):
    write_text(path, json.dumps(data, indent=indent))


def _read_json(path):
    def read():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return _retry(read)


def load_json(path, default=None, backup=False):
    """Read a JSON file. A file that can't be read is never silently replaced by an empty one:
      - a damaged file is kept as <name>.broken-<date-time> and the last good copy (<name>.bak) is used instead;
      - backup=True: after a good read, that copy becomes the new <name>.bak (used for the files read at start).
    Returns `default` only when there is no file at all, or neither it nor its backup can be read."""
    bak = path + ".bak"
    try:
        data = _read_json(path)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        if isinstance(e, ValueError):        # damaged (half-written, emptied): keep it for a look later
            aside = "%s.broken-%s" % (path, time.strftime("%Y%m%d-%H%M%S"))
            try:
                _retry(lambda: os.replace(path, aside))
                print("%s was damaged (%s): kept as %s" % (os.path.basename(path), e, os.path.basename(aside)))
            except OSError:
                pass
        else:
            print("Could not read %s: %s" % (os.path.basename(path), e))
        try:
            data = _read_json(bak)
            print("Using the last good copy of %s (%s)" % (os.path.basename(path), os.path.basename(bak)))
            return data
        except (OSError, ValueError):
            return default
    if backup:
        try:
            _retry(lambda: shutil.copyfile(path, bak))
        except OSError:
            pass
    return data


def _move(src, dst, what):
    if not os.path.exists(src) or os.path.exists(dst):
        return
    try:
        shutil.move(src, dst)
        print("Moved %s into the data folder" % what)
    except OSError as e:
        print("Could not move %s into the data folder: %s" % (what, e))


def migrate():
    os.makedirs(DATA, exist_ok=True)
    _move(os.path.join(ROOT, "settings.json"), SETTINGS_FILE, "settings.json")
    _move(os.path.join(ROOT, "standings"), STANDINGS_DIR, "the standings folder")
    _move(os.path.join(ROOT, "sponsors"), SPONSOR_DIR, "the sponsors folder")
    os.makedirs(LOGO_DIR, exist_ok=True)
    assets = os.path.join(ROOT, "static", "assets")
    _undo_podium_move(assets)
    if os.path.exists(ASSETS_MOVED_MARK):
        return
    try:
        names = os.listdir(assets)
    except OSError:
        names = []
    for name in names:
        if name in BUILTIN_ASSETS or os.path.splitext(name)[1].lower() not in IMAGE_EXT:
            continue
        _move(os.path.join(assets, name), os.path.join(LOGO_DIR, name), "logo " + name)
    try:
        with open(ASSETS_MOVED_MARK, "w") as f:
            f.write("League logos from static/assets were moved into data/logos. This only happens once.\n")
    except OSError:
        pass


def _undo_podium_move(assets):
    """v1.5.16 moved its own podium artwork into data/logos: put it back (the update restores it too) and
    take it out of the league logo list."""
    for n in ("podium_1.png", "podium_2.png", "podium_3.png"):
        moved, home = os.path.join(LOGO_DIR, n), os.path.join(assets, n)
        if not os.path.exists(moved):
            continue
        try:
            if not os.path.exists(home):
                shutil.move(moved, home)
            else:
                os.remove(moved)
            print("Put the podium artwork %s back where it belongs" % n)
        except OSError as e:
            print("Could not move %s back: %s" % (n, e))


if not os.environ.get("VSPEED_DATA"):     # another data folder (tests): never move this install's own files
    migrate()
