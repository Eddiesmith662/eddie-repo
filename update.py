"""VSPEED Overlay updater.

On start, run.py asks GitHub whether a newer published release exists. If so it shows the
release notes and asks before installing. Installing:
  1. downloads the release,
  2. backs up the current program files into data/backup/<old version>,
  3. replaces the program files (never anything in the data folder),
  4. installs any new Python packages listed in requirements.txt.

`python update.py --rollback` (restore-previous.bat) puts the last backed-up version back.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

import datafiles
import net

REPO = "Eddiesmith662/eddie-repo"
API_LATEST = os.environ.get("VSPEED_UPDATE_API") or "https://api.github.com/repos/%s/releases/latest" % REPO
ROOT = datafiles.ROOT
DATA = datafiles.DATA
BACKUP_DIR = os.path.join(DATA, "backup")
INSTALLED = os.path.join(DATA, "installed-files.json")   # program files of the current version
KEEP_BACKUPS = 3
PROMPT_SECONDS = 30
# never replaced or removed by an update
PROTECTED = ("data/", ".git/", "__pycache__/")


def local_version():
    try:
        with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "0.0.0"


def vtuple(v):
    out = []
    for part in str(v or "").strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        out.append(int(digits) if digits else 0)
    return tuple((out + [0, 0, 0])[:3])


def _get(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "VSPEED-Overlay-Updater",
                                               "Accept": "application/vnd.github+json"})
    return net.urlopen(req, timeout)


def check_latest(timeout=5):
    """Newest published release, or None if there's nothing newer (or GitHub can't be reached)."""
    try:
        with _get(API_LATEST, timeout) as r:
            rel = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code != 404:                       # 404 = no published release yet
            print("Update check: GitHub answered %s" % e.code)
        return None
    except Exception as e:
        print("Update check skipped (no connection to GitHub: %s)" % getattr(e, "reason", e))
        return None
    tag = rel.get("tag_name") or ""
    if rel.get("draft") or rel.get("prerelease") or vtuple(tag) <= vtuple(local_version()):
        return None
    return {"version": tag.lstrip("vV"), "tag": tag, "notes": (rel.get("body") or "").strip(),
            "zip": rel.get("zipball_url"), "name": rel.get("name") or tag}


def _installed_list():
    """Program files recorded by the last update ([] for a copy that was installed by hand)."""
    try:
        with open(INSTALLED, encoding="utf-8") as f:
            files = json.load(f)
        return files if isinstance(files, list) else []
    except (OSError, ValueError):
        return []


def _program_files():
    """Program files of the current install (relative paths with forward slashes)."""
    files = _installed_list()
    if files:
        return files
    found = []
    for base, dirs, names in os.walk(ROOT):
        rel = os.path.relpath(base, ROOT).replace(os.sep, "/")
        rel = "" if rel == "." else rel + "/"
        if any((rel + "x").startswith(p) for p in PROTECTED):
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if not any((rel + d + "/").startswith(p) for p in PROTECTED)]
        found += [rel + n for n in names if not n.endswith(".pyc")]
    return found


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _backup(files, version):
    dest = os.path.join(BACKUP_DIR, "v" + version)
    if os.path.exists(dest):
        shutil.rmtree(dest, ignore_errors=True)
    for rel in files:
        src = os.path.join(ROOT, rel)
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
            shutil.copy2(src, os.path.join(dest, rel))
    with open(os.path.join(dest, "files.json"), "w", encoding="utf-8") as f:
        json.dump(files, f)
    # keep only the newest few backups
    olds = sorted((d for d in os.listdir(BACKUP_DIR) if os.path.isdir(os.path.join(BACKUP_DIR, d))),
                  key=lambda d: os.path.getmtime(os.path.join(BACKUP_DIR, d)), reverse=True)
    for d in olds[KEEP_BACKUPS:]:
        shutil.rmtree(os.path.join(BACKUP_DIR, d), ignore_errors=True)
    return dest


def _write_files(new_files, old_files):
    """Write the new program files and remove ones the new version no longer has.
    Only files a previous update recorded are ever removed, so stray files someone keeps
    in the folder are left alone."""
    changed = 0
    for rel, data in new_files.items():
        if rel.lower().endswith(".bat"):          # Windows batch files need CRLF line endings
            data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        path = os.path.join(ROOT, rel)
        try:
            with open(path, "rb") as f:
                if f.read() == data:
                    continue
        except OSError:
            pass
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".new"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        changed += 1
    for rel in old_files:
        if rel not in new_files and not rel.startswith(PROTECTED):
            try:
                os.remove(os.path.join(ROOT, rel))
            except OSError:
                pass
    with open(INSTALLED, "w", encoding="utf-8") as f:
        json.dump(sorted(new_files), f)
    return changed


def _requirements(before):
    req = os.path.join(ROOT, "requirements.txt")
    try:
        with open(req, "rb") as f:
            now = _sha(f.read())
    except OSError:
        return
    if now == before:
        return
    print("Installing Python packages for this version...")
    subprocess.call([sys.executable, "-m", "pip", "install", "-r", req])


def install(info):
    print("Downloading %s..." % info["tag"])
    with _get(info["zip"], 60) as r:
        blob = r.read()
    z = zipfile.ZipFile(io.BytesIO(blob))
    new_files = {}
    for entry in z.infolist():
        if entry.is_dir():
            continue
        parts = entry.filename.split("/", 1)          # GitHub puts everything in one top folder
        if len(parts) < 2 or not parts[1]:
            continue
        rel = parts[1]
        if rel.startswith(PROTECTED) or ".." in rel.split("/"):
            continue
        new_files[rel] = z.read(entry)
    if "server.py" not in new_files or "VERSION" not in new_files:
        raise RuntimeError("the download doesn't look like the overlay program")
    got = new_files["VERSION"].decode("utf-8", "replace").strip()
    if vtuple(got) != vtuple(info["version"]):
        raise RuntimeError("release %s contains version %s" % (info["tag"], got))
    old_files = _program_files()
    old_version = local_version()
    try:
        with open(os.path.join(ROOT, "requirements.txt"), "rb") as f:
            req_before = _sha(f.read())
    except OSError:
        req_before = ""
    where = _backup(old_files, old_version)
    print("Backed up v%s to %s" % (old_version, os.path.relpath(where, ROOT)))
    try:
        n = _write_files(new_files, _installed_list())
    except Exception:
        print("Something went wrong while copying files; putting v%s back..." % old_version)
        rollback(quiet=True)
        raise
    _requirements(req_before)
    print("Updated to v%s (%d file%s changed)." % (got, n, "" if n == 1 else "s"))


def rollback(quiet=False):
    try:
        backups = sorted((d for d in os.listdir(BACKUP_DIR) if os.path.isdir(os.path.join(BACKUP_DIR, d))),
                         key=lambda d: os.path.getmtime(os.path.join(BACKUP_DIR, d)), reverse=True)
    except OSError:
        backups = []
    if not backups:
        print("There's no earlier version to go back to.")
        return False
    src = os.path.join(BACKUP_DIR, backups[0])
    try:
        with open(os.path.join(src, "files.json"), encoding="utf-8") as f:
            files = json.load(f)
    except (OSError, ValueError):
        files = []
    data = {}
    for rel in files:
        p = os.path.join(src, rel)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                data[rel] = f.read()
    if "server.py" not in data:
        print("The backup in %s is incomplete; nothing was changed." % src)
        return False
    _write_files(data, _installed_list())
    shutil.rmtree(src, ignore_errors=True)
    if not quiet:
        print("Went back to %s. (It will offer the newer version again the next time it starts;" % backups[0])
        print("press N to stay on this one.)")
    return True


def _ask(prompt, seconds):
    """Y/N with a countdown; no answer = No, so an unattended start never waits forever."""
    if not sys.stdin or not sys.stdin.isatty():
        return False
    if os.name == "nt":
        import msvcrt
        sys.stdout.write("%s [Y/N] (starts without updating in %ds) " % (prompt, seconds))
        sys.stdout.flush()
        end = time.time() + seconds
        while time.time() < end:
            if msvcrt.kbhit():
                ch = msvcrt.getwch().lower()
                if ch in ("y", "n", "\r"):
                    print(ch if ch != "\r" else "")
                    return ch == "y"
            time.sleep(0.05)
        print("\nNo answer, starting the current version.")
        return False
    try:
        return input("%s [Y/N] " % prompt).strip().lower().startswith("y")
    except EOFError:
        return False


def offer_update():
    """Called by run.py before the server starts."""
    info = check_latest()
    if not info:
        return
    print()
    print("=" * 60)
    print(" Update available: v%s   (you have v%s)" % (info["version"], local_version()))
    print("=" * 60)
    if info["notes"]:
        for line in info["notes"].splitlines()[:25]:
            print("  " + line)
        print()
    if not _ask("Install it now?", PROMPT_SECONDS):
        print("Skipped. It will ask again next time.")
        return
    try:
        install(info)
    except Exception as e:
        print("The update didn't install (%s). Starting the current version." % e)


if __name__ == "__main__":
    if "--rollback" in sys.argv:
        rollback()
    elif "--check" in sys.argv:
        i = check_latest()
        print("Newest: %s" % (i["tag"] if i else "you're up to date (v%s)" % local_version()))
    else:
        offer_update()
