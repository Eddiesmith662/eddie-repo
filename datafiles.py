"""Where each install keeps its own files.

Everything that belongs to the person using the overlay (settings, standings, sponsor
images, league logos, update backups) lives in the `data` folder. Updates only ever
replace program files, so nothing in `data` is touched by an update.

Older installs kept these files next to the program; they are moved into `data`
automatically the first time this version runs.
"""
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
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


migrate()
