"""Standings, playoff bracket, race analysis and broadcast team.

Ported from Standings Control (standings_control.py) without the desktop window: the same data
handling, Xtreme Scoring pull, CSV, bracket and text logic, now driven from the VSPEED control panel.
Files live in the "standings" folder next to server.py: config.json, standings.json, bracket.json, logo.*
(the same names the old program used, so its files can be copied straight in)."""
import base64
import copy
import csv
import html as htmlmod
import io
import json
import os
import re
import threading
import time
import urllib.request
from datetime import datetime

import datafiles
import net
CONFIG_DIR = datafiles.STANDINGS_DIR
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
DATA_PATH = os.path.join(CONFIG_DIR, "standings.json")
BRACKET_PATH = os.path.join(CONFIG_DIR, "bracket.json")

PULL_ROWS = 30          # drivers kept from the website (the graphic shows the top 20 of these)
MAX_CSV_ROWS = 50
STALE_HOURS = 24        # data older than this is shown in red

STATE = {"visible": False, "replay": 0, "reload": 0, "title": None, "playoff": False, "cutoff": 16,
         "logo": 0, "view": "standings", "logoSize": 192, "dataVer": 0,
         "bracket": {"rounds": [[], [], [], []]},
         "analysis": {"visible": False, "replay": 0, "title": "RACE ANALYSIS", "lines": []},
         "team": {"visible": False, "replay": 0, "title": "BROADCASTING TEAM", "people": []}}
STATE_LOCK = threading.Lock()
LAST_POLL = 0.0
LAST_POLL_A = 0.0       # last time the race analysis page asked for its state
LAST_POLL_T = 0.0       # same for the broadcast team page

TEAM_TITLE = "BROADCASTING TEAM"
TEAM_EXAMPLE = [["Sam Rivera", "Lead Commentary"], ["Jordan Lee", "Co-Commentary"], ["Casey Hart", "Producer"]]
TEAM_SLOTS = 3

ANALYSIS_TITLE = "RACE ANALYSIS"
ANALYSIS_EXAMPLE = ["RACE LENGTH: 100 LAPS", "PITROAD SPEED: 50MPH", "TIRE SETS AVAILABLE: 4",
                    "2 GWC ATTEMPTS", "100% FUEL | PREMIER SETUP"]
ANALYSIS_LINES = 5


def set_state(**kw):
    with STATE_LOCK:
        STATE.update(kw)


def set_analysis(**kw):
    with STATE_LOCK:
        a = dict(STATE["analysis"])
        a.update(kw)
        STATE["analysis"] = a


def bump_analysis_replay():
    with STATE_LOCK:
        a = dict(STATE["analysis"])
        a["replay"] += 1
        STATE["analysis"] = a


def clean_analysis(title, lines):
    """Title in capitals-friendly plain text and exactly 5 line slots (blank allowed)."""
    t = " ".join(str(title or "").split()) or ANALYSIS_TITLE
    ls = [" ".join(str(x or "").split())[:80] for x in list(lines or [])[:ANALYSIS_LINES]]
    ls += [""] * (ANALYSIS_LINES - len(ls))
    return t[:60], ls


def set_team(**kw):
    with STATE_LOCK:
        a = dict(STATE["team"])
        a.update(kw)
        STATE["team"] = a


def bump_team_replay():
    with STATE_LOCK:
        a = dict(STATE["team"])
        a["replay"] += 1
        STATE["team"] = a


def clean_team(title, people):
    """Title plus exactly 3 [name, role] slots (a slot with both blank is left out of the graphic)."""
    t = " ".join(str(title or "").split()) or TEAM_TITLE
    out = []
    for p in list(people or [])[:TEAM_SLOTS]:
        p = list(p) if isinstance(p, (list, tuple)) else []
        p += [""] * (2 - len(p))
        out.append([" ".join(str(p[0] or "").split())[:40], " ".join(str(p[1] or "").split())[:40]])
    out += [["", ""]] * (TEAM_SLOTS - len(out))
    return t[:60], out


def bump(key):
    with STATE_LOCK:
        STATE[key] += 1


# ----------------------------------------------------------------------------
# Standings data: pulled from Xtreme Scoring, loaded from CSV, or edited by hand
# ----------------------------------------------------------------------------
DATA = {"header": [], "rows": [], "pulled_at": 0.0, "source": "", "edited_at": None}
DATA_LOCK = threading.Lock()

_TR = re.compile(r"<tr\b[^>]*>[\s\S]*?</tr>", re.I)
_CELL = re.compile(r"<t[dh]\b[^>]*>([\s\S]*?)</t[dh]>", re.I)
_TAG = re.compile(r"<[^>]*>")


def _clean(s):
    s = htmlmod.unescape(_TAG.sub("", s)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def parse_standings(page, limit=PULL_ROWS):
    """Find the first standings table in the widget page. Returns (header, rows)."""
    table = []
    for tr in _TR.finditer(page):
        cells = [_clean(m.group(1)) for m in _CELL.finditer(tr.group(0))]
        if cells:
            table.append(cells)
    start = next((i for i, r in enumerate(table) if r[0].lower() == "pos"), -1)
    if start < 0:
        raise ValueError("Could not find the standings table (a header row starting with 'Pos'). "
                         "Check the widget link, or the website layout may have changed.")
    header = table[start]
    rows = []
    for r in table[start + 1:]:
        # a different row shape, a repeated header, or a lone class title ends this class's table
        if len(r) != len(header) or r[0].lower() == "pos" or not any(r[1:]):
            break
        rows.append(r)
        if len(rows) >= limit:
            break
    if not rows:
        raise ValueError("Found the standings header but no driver rows under it.")
    return header, rows


def parse_csv_text(text, limit=MAX_CSV_ROWS):
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if len(rows) < 2:
        raise ValueError("The file needs a header row and at least one driver row.")
    header = [c.strip() for c in rows[0]]
    if "driver" not in [h.lower() for h in header]:
        raise ValueError("The first row must be a header with a 'Driver' column "
                         "(and ideally Pos, #, Pts, To Ldr, Wins).")
    n = len(header)
    data = [([c.strip() for c in r] + [""] * n)[:n] for r in rows[1:1 + limit]]
    return header, data


# Columns the graphic reads (matched by name, any capitalisation) and what happens without them.
COLUMN_NOTES = [
    ("Pos", "position numbers will be blank"),
    ("#", "car numbers will be blank (the bracket uses them too)"),
    ("Pts", "points will be blank and the cutoff math won't work"),
    ("To Ldr", "the gap column will be blank"),
    ("Wins", "no one will show as LOCKED IN"),
]


def missing_column_note(header):
    low = [h.lower() for h in header]
    gone = ["'%s' (%s)" % (n, why) for n, why in COLUMN_NOTES if n.lower() not in low]
    return ("Note: the file has no " + "; no ".join(gone) + ".") if gone else ""


EXAMPLE_DRIVERS = [
    ("85", "Alex Rivers", 300, 2), ("38", "Sam Carter", 292, 1), ("08", "Jordan Blake", 281, 0), ("21", "Casey Morgan", 270, 1),
    ("14", "Riley Quinn", 262, 0), ("00", "Taylor Reed", 255, 0), ("7", "Morgan Ellis", 249, 0), ("53", "Drew Parker", 240, 1),
    ("904", "Jamie Foster", 233, 0), ("16", "Chris Dalton", 226, 0), ("27", "Pat Sullivan", 219, 0), ("43", "Robin Hayes", 211, 0),
    ("69", "Devin Brooks", 204, 0), ("22", "Cameron Wells", 198, 0), ("75", "Logan Pierce", 190, 0), ("71", "Avery Grant", 183, 1),
    ("124", "Skyler Moore", 175, 0), ("64", "Blake Turner", 168, 0), ("771", "Reese Walker", 160, 0), ("020", "Kelly Dixon", 152, 0),
]


def example_csv():
    """A ready-to-load sample file: the format Load CSV expects, with made-up drivers."""
    header = ["Pos", "#", "Driver", "Pts", "To Ldr", "To Nxt", "Wins"]
    rows = []
    for i, (car, name, pts, wins) in enumerate(EXAMPLE_DRIVERS):
        lead, prev = EXAMPLE_DRIVERS[0][2], EXAMPLE_DRIVERS[max(i - 1, 0)][2]
        rows.append([str(i + 1), car, name, str(pts), "0" if i == 0 else str(pts - lead),
                     "0" if i == 0 else str(pts - prev), str(wins)])
    return header, rows


def rows_to_csv(header, rows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def _fmt_num(x):
    if abs(x) < 1e-9:
        return "0"
    return ("%.3f" % x).rstrip("0").rstrip(".")


def recalc(header, rows):
    """Re-sort by points (ties keep their current order), renumber Pos, and recompute the
    To Ldr / To Nxt gaps the way the website shows them. Returns a new list of rows."""
    low = [h.lower() for h in header]
    if "pts" not in low:
        raise ValueError("There is no Pts column to sort by.")
    ip = low.index("pts")
    try:
        pts = [float(r[ip].replace(",", "")) for r in rows]
    except ValueError:
        raise ValueError("Every Pts value must be a number to re-sort.")
    order = sorted(range(len(rows)), key=lambda i: -pts[i])
    new = [list(rows[i]) for i in order]
    p = [pts[i] for i in order]
    idx = {n: low.index(n) if n in low else -1 for n in ("pos", "to ldr", "to nxt")}
    for k, r in enumerate(new):
        if idx["pos"] >= 0:
            r[idx["pos"]] = str(k + 1)
        if idx["to ldr"] >= 0:
            r[idx["to ldr"]] = _fmt_num(p[k] - p[0])
        if idx["to nxt"] >= 0:
            r[idx["to nxt"]] = _fmt_num(p[k] - p[k - 1]) if k else "0"
    return new


def data_snapshot():
    with DATA_LOCK:
        return copy.deepcopy(DATA)


def save_data():
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        tmp = DATA_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data_snapshot(), f)
        os.replace(tmp, DATA_PATH)
    except OSError:
        pass


def set_data(header, rows, source, pulled_at=None, edited_at=None, save=True):
    with DATA_LOCK:
        DATA["header"] = list(header)
        DATA["rows"] = [list(r) for r in rows]
        DATA["source"] = source
        DATA["pulled_at"] = time.time() if pulled_at is None else pulled_at
        DATA["edited_at"] = edited_at
    bump("dataVer")
    if save:
        save_data()


# ---- Playoff bracket: filled by hand, never by the standings pull ----
BRACKET_CAPS = [12, 8, 4, 1]
BRACKET_NAMES = ["Round of 12", "Round of 8", "Championship 4", "Champion"]


def _clean_rounds(rounds):
    out = []
    for k, cap in enumerate(BRACKET_CAPS):
        lst, seen = [], set()
        for e in (rounds[k] if isinstance(rounds, list) and k < len(rounds) else []):
            try:
                ent = {"seed": int(e["seed"]), "num": str(e.get("num", "")), "name": str(e.get("name", ""))}
            except (KeyError, TypeError, ValueError, AttributeError):
                continue
            if ent["seed"] in seen or len(lst) >= cap:
                continue
            seen.add(ent["seed"])
            lst.append(ent)
        out.append(lst)
    return out


def bracket_snapshot():
    with STATE_LOCK:
        return copy.deepcopy(STATE["bracket"]["rounds"])


def save_bracket():
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        tmp = BRACKET_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"rounds": bracket_snapshot()}, f)
        os.replace(tmp, BRACKET_PATH)
    except OSError:
        pass


def set_bracket(rounds, save=True):
    set_state(bracket={"rounds": _clean_rounds(rounds)})
    if save:
        save_bracket()


def load_bracket():
    try:
        with open(BRACKET_PATH, "r", encoding="utf-8") as f:
            set_bracket(json.load(f)["rounds"], save=False)
    except (OSError, ValueError, KeyError, TypeError):
        pass


def bracket_from_standings(header, rows, n=12):
    """The first n drivers in the standings, as seeds 1..n (needs a Driver column)."""
    low = [h.lower() for h in header]
    if "driver" not in low:
        return None
    di = low.index("driver")
    ni = low.index("#") if "#" in low else -1
    return [{"seed": i + 1, "num": (r[ni] if ni >= 0 else ""), "name": r[di]} for i, r in enumerate(rows[:n])]


def bracket_advance(rounds, r, idx):
    """Move the driver at rounds[r][idx] into the next round. Returns (rounds, problem or None)."""
    rounds = copy.deepcopy(rounds)
    if r < 0 or r > 2 or idx < 0 or idx >= len(rounds[r]):
        return rounds, "Pick a driver first." if r <= 2 else "The champion has nowhere to advance to."
    ent = rounds[r][idx]
    nxt = rounds[r + 1]
    if any(e["seed"] == ent["seed"] for e in nxt):
        return rounds, "%s is already in the %s." % (ent["name"], BRACKET_NAMES[r + 1])
    if r + 1 == 3:
        rounds[3] = [ent]                      # one champion: advancing someone else replaces them
    elif len(nxt) >= BRACKET_CAPS[r + 1]:
        return rounds, "The %s is full (%d drivers). Remove one first." % (BRACKET_NAMES[r + 1], BRACKET_CAPS[r + 1])
    else:
        nxt.append(ent)
    return rounds, None


def bracket_remove(rounds, r, idx):
    """Take the driver at rounds[r][idx] back out of that round and every later round."""
    rounds = copy.deepcopy(rounds)
    if r < 1 or r > 3 or idx < 0 or idx >= len(rounds[r]):
        return rounds, "Pick a driver in the Round of 8 or later." if r == 0 else "Pick a driver first."
    seed = rounds[r][idx]["seed"]
    for k in range(r, 4):
        rounds[k] = [e for e in rounds[k] if e["seed"] != seed]
    return rounds, None


def bracket_edit(rounds, seed, num, name):
    """Change a driver's car number and/or name everywhere they appear in the bracket."""
    rounds = copy.deepcopy(rounds)
    name = " ".join(str(name).split())
    if not name:
        return rounds, "The name cannot be empty."
    hit = False
    for lst in rounds:
        for e in lst:
            if e["seed"] == seed:
                e["num"], e["name"] = str(num).strip(), name
                hit = True
    return rounds, (None if hit else "That driver is no longer in the bracket.")


def load_data():
    """Bring back the saved copy from the last run. Returns True if there was one."""
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        header = [str(x) for x in d["header"]]
        rows = [[str(x) for x in r] for r in d["rows"]]
        pulled = float(d.get("pulled_at") or 0)
        edited = float(d["edited_at"]) if d.get("edited_at") else None
        source = str(d.get("source") or "")
    except (OSError, ValueError, KeyError, TypeError):
        return False
    if not header or not rows:
        return False
    set_data(header, rows, source, pulled, edited, save=False)
    return True


def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; StandingsControl/2.0)", "Accept": "text/html,*/*"})
    with net.urlopen(req, timeout) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="replace")


def pull_xtreme(url):
    """Download and parse the widget page. Only replaces the saved standings if that worked."""
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("The widget link must start with https://")
    header, rows = parse_standings(fetch_text(url))
    set_data(header, rows, "xtreme", pulled_at=time.time(), edited_at=None)
    return len(rows)


def fmt_time(ts):
    dt = datetime.fromtimestamp(ts)
    return "%s, %d:%02d %s" % (dt.strftime("%a %b %d"), dt.hour % 12 or 12, dt.minute,
                               "AM" if dt.hour < 12 else "PM")


def describe_age(sec):
    if sec < 60:
        return "just now"
    if sec < 3600:
        return "%d min ago" % (sec // 60)
    if sec < 48 * 3600:
        h = int(sec // 3600)
        return "%d hour%s ago" % (h, "" if h == 1 else "s")
    return "%d days ago" % (sec // 86400)


# ----------------------------------------------------------------------------
# Logo and local web server
# ----------------------------------------------------------------------------
LOGO_PATH = ""
LOGO_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}


def logo_file(cfg):
    """Full path of the saved logo, or "" if there isn't one. The logo is remembered by file name
    so the whole folder can be moved."""
    name = cfg.get("logo") or ""
    if not name:
        return ""
    for cand in (os.path.join(CONFIG_DIR, os.path.basename(name)), name if os.path.isabs(name) else ""):
        if cand and os.path.exists(cand):
            return cand
    return ""


def set_logo(path):
    """Point the graphic at a logo file (or clear it with an empty path)."""
    global LOGO_PATH
    LOGO_PATH = path or ""
    with STATE_LOCK:
        STATE["logo"] = int(time.time() * 1000) if LOGO_PATH else 0

def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except OSError:
        pass


# ----------------------------------------------------------------------------
# Controller: what the desktop window used to do, as commands from the web panel
# ----------------------------------------------------------------------------
PULL_ERR = ""
PULLING = False
LOG = []            # recent messages, newest last (shown in the control panel)
_CFG_LOCK = threading.Lock()


def log(text):
    LOG.append("[%s] %s" % (time.strftime("%H:%M:%S"), text))
    del LOG[:-40]


_CFG_CACHE = {}


def update_config(**kw):
    with _CFG_LOCK:
        cfg = load_config()
        cfg.update(kw)
        save_config(cfg)
        _CFG_CACHE.clear()
        _CFG_CACHE.update(cfg)


def init():
    """Load everything saved from the last run (same startup as the old program)."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    cfg = load_config()
    _CFG_CACHE.update(cfg)
    if cfg.get("title"):
        set_state(title=cfg["title"])
    try:
        set_state(cutoff=max(1, min(20, int(cfg.get("cutoff", 16)))))
    except (TypeError, ValueError):
        pass
    saved_logo = logo_file(cfg)
    if saved_logo:
        set_logo(saved_logo)
    try:
        set_state(logoSize=max(40, min(220, int(cfg.get("logo_size", 192)))))
    except (TypeError, ValueError):
        pass
    load_data()
    load_bracket()
    lines = cfg.get("analysis_lines")
    t, l = clean_analysis(cfg.get("analysis_title"), lines if isinstance(lines, list) else ANALYSIS_EXAMPLE)
    set_analysis(title=t, lines=l)
    people = cfg.get("team_people")
    t, p = clean_team(cfg.get("team_title"), people if isinstance(people, list) else TEAM_EXAMPLE)
    set_team(title=t, people=p)
    log("Standings files: %s" % CONFIG_DIR)


def autopull(on_done=None):
    """Pull once on startup, unless there is no link or the standings were edited by hand."""
    url = (load_config().get("xtreme") or "").strip()
    if not url:
        log("Paste your Xtreme Scoring widget link, then press Pull standings now.")
    elif data_snapshot()["edited_at"]:
        log("Keeping your hand-edited standings. Press Pull standings now to replace them.")
    else:
        def run():
            do_pull(url, auto=True)
            if on_done:
                on_done()
        threading.Thread(target=run, daemon=True).start()


def do_pull(url, auto=False):
    global PULL_ERR, PULLING
    PULLING = True
    log("Pulling standings from Xtreme Scoring%s..." % (" (on launch)" if auto else ""))
    try:
        n = pull_xtreme(url)
        PULL_ERR = ""
        log("Pulled %d drivers. The graphic updates by itself." % n)
        return True, "Pulled %d drivers" % n
    except Exception as e:  # network errors, bad pages, etc.
        PULL_ERR = str(e)
        log("Pull failed: %s" % e)
        return False, "Pull failed: %s" % e
    finally:
        PULLING = False


def age_text():
    snap = data_snapshot()
    if not snap["rows"]:
        return "No standings loaded yet", True, ""
    age = time.time() - snap["pulled_at"]
    stale = age >= STALE_HOURS * 3600
    verb = "Pulled" if snap["source"] == "xtreme" else "Loaded from a file"
    note = ("Hand-edited %s. Pulling again replaces the edits." % fmt_time(snap["edited_at"])) if snap["edited_at"] else ""
    return "%s %s · %s%s" % (verb, fmt_time(snap["pulled_at"]), describe_age(age), " — OLD, pull again" if stale else ""), stale, note


def summary():
    """Everything the control panel and the main overlay need, in one JSON-friendly dict."""
    with STATE_LOCK:
        st = copy.deepcopy(STATE)
    snap = data_snapshot()
    cfg = _CFG_CACHE
    age, stale, note = age_text()
    return {
        "state": st,
        "header": snap["header"], "rows": snap["rows"][:PULL_ROWS], "source": snap["source"],
        "edited": bool(snap["edited_at"]), "age": age, "stale": stale, "note": note,
        "pullErr": PULL_ERR, "pulling": PULLING, "xtreme": cfg.get("xtreme", ""),
        "logoName": cfg.get("logo_name", "") if LOGO_PATH else "",
        "log": LOG[-12:],
    }


def _int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def command(cmd, d):
    """Run one control panel command. Returns (ok, message). A message starting with 'CONFIRM:'
    means the panel should ask the user and send the command again with force=true."""
    force = bool(d.get("force"))
    # ---- standings graphic ----
    if cmd == "show":
        set_state(visible=True); log("Standings: show"); return True, ""
    if cmd == "hide":
        set_state(visible=False); log("Standings: hide"); return True, ""
    if cmd == "replay":
        with STATE_LOCK:
            STATE["replay"] += 1
            STATE["visible"] = True
        log("Standings: replay animation"); return True, ""
    if cmd == "reload":
        bump("reload"); return True, "Graphic reloading its data"
    if cmd == "view":
        v = "bracket" if d.get("view") == "bracket" else "standings"
        set_state(view=v); log("View: %s" % v); return True, ""
    if cmd == "title":
        text = " ".join(str(d.get("text") or "").split())[:80]
        set_state(title=text or None); update_config(title=text)
        return True, "Title updated"
    if cmd == "playoff":
        n = _int(d.get("cutoff", STATE["cutoff"]), 1, 20, 16)
        with STATE_LOCK:
            STATE["cutoff"] = n
            STATE["playoff"] = bool(d["on"]) if "on" in d else not STATE["playoff"]
            on = STATE["playoff"]
        update_config(cutoff=n)
        log("Playoff cutoff %s (top %d)" % ("ON" if on else "OFF", n)); return True, ""
    if cmd == "cutoff":
        n = _int(d.get("cutoff"), 1, 20, 16)
        set_state(cutoff=n); update_config(cutoff=n); return True, ""
    if cmd == "logoSize":
        n = _int(d.get("size"), 40, 220, 192)
        set_state(logoSize=n); update_config(logo_size=n); return True, ""
    if cmd == "logoUpload":
        name = os.path.basename(str(d.get("name") or "logo.png"))
        ext = os.path.splitext(name)[1].lower()
        if ext not in LOGO_TYPES:
            return False, "Logo must be a PNG, JPG, GIF, WEBP or SVG file."
        try:
            raw = base64.b64decode(str(d.get("data") or "").split(",")[-1])
            for old in os.listdir(CONFIG_DIR):
                if old.startswith("logo.") and os.path.splitext(old)[1].lower() in LOGO_TYPES:
                    os.remove(os.path.join(CONFIG_DIR, old))
            dest = os.path.join(CONFIG_DIR, "logo" + ext)
            with open(dest, "wb") as f:
                f.write(raw)
        except (OSError, ValueError) as e:
            return False, "Could not save the logo: %s" % e
        update_config(logo=os.path.basename(dest), logo_name=name)
        set_logo(dest); log("Logo set: %s" % name); return True, "Logo set"
    if cmd == "logoRemove":
        old = logo_file(load_config())
        update_config(logo="", logo_name="")
        set_logo("")
        if old:
            try:
                os.remove(old)
            except OSError:
                pass
        log("Logo removed"); return True, "Logo removed"
    # ---- standings data ----
    if cmd == "xtreme":
        update_config(xtreme=str(d.get("url") or "").strip()); return True, "Link saved"
    if cmd == "pull":
        url = str(d.get("url") or load_config().get("xtreme") or "").strip()
        if not url:
            return False, "Paste your Xtreme Scoring widget link first."
        update_config(xtreme=url)
        if data_snapshot()["edited_at"] and not force:
            return False, "CONFIRM:The standings were edited by hand. Pulling replaces the edits. Continue?"
        return do_pull(url)
    if cmd == "csvLoad":
        if data_snapshot()["edited_at"] and not force:
            return False, "CONFIRM:The standings were edited by hand. Loading this file replaces them. Continue?"
        try:
            header, rows = parse_csv_text(str(d.get("text") or "").lstrip("﻿"))
        except (ValueError, csv.Error) as e:
            return False, str(e)
        set_data(header, rows, "csv", pulled_at=time.time(), edited_at=None)
        global PULL_ERR
        PULL_ERR = ""
        msg = "Loaded %d drivers from %s" % (len(rows), d.get("name") or "the file")
        note = missing_column_note(header)
        log(msg + (". " + note if note else ""))
        return True, msg
    if cmd == "edit":
        snap = data_snapshot()
        with STATE_LOCK:
            ver = STATE["dataVer"]
        if d.get("ver") is not None and int(d["ver"]) != ver and not force:
            return False, "CONFIRM:The standings changed after you started editing (for example, a pull finished). Save your version anyway?"
        rows = [[str(c).strip() for c in r] for r in (d.get("rows") or [])]
        n = len(snap["header"])
        rows = [(r + [""] * n)[:n] for r in rows]
        msg = "Saved"
        if d.get("recalc"):
            try:
                rows = recalc(snap["header"], rows)
            except ValueError as e:
                msg = "Saved as typed (not re-sorted: %s)" % e
        set_data(snap["header"], rows, snap["source"], pulled_at=snap["pulled_at"], edited_at=time.time())
        log("Standings edited by hand."); return True, msg
    # ---- bracket ----
    if cmd == "bracketLoad":
        snap = data_snapshot()
        entries = bracket_from_standings(snap["header"], snap["rows"]) if snap["rows"] else None
        if not entries:
            return False, "Pull or load the standings first, then load the bracket."
        if any(bracket_snapshot()) and not force:
            return False, "CONFIRM:The bracket already has drivers. Loading the top 12 replaces it and clears any advancing. Continue?"
        set_bracket([entries, [], [], []])
        log("Bracket loaded with the top %d drivers." % len(entries)); return True, "Bracket loaded"
    if cmd == "bracketClear":
        if any(bracket_snapshot()) and not force:
            return False, "CONFIRM:This removes every driver from the bracket. Continue?"
        set_bracket([[], [], [], []]); log("Bracket cleared."); return True, "Bracket cleared"
    if cmd in ("bracketAdvance", "bracketRemove"):
        r, idx = _int(d.get("r"), -1, 9, -1), _int(d.get("idx"), -1, 99, -1)
        before = bracket_snapshot()
        fn = bracket_advance if cmd == "bracketAdvance" else bracket_remove
        rounds, problem = fn(before, r, idx)
        if problem:
            return False, problem
        name = before[r][idx]["name"]
        set_bracket(rounds)
        if cmd == "bracketAdvance":
            log("%s advanced to the %s." % (name, BRACKET_NAMES[r + 1]))
        else:
            log("%s removed from the %s%s." % (name, BRACKET_NAMES[r], " and later rounds" if r < 3 else ""))
        return True, ""
    if cmd == "bracketEdit":
        rounds, problem = bracket_edit(bracket_snapshot(), _int(d.get("seed"), 0, 999, 0), d.get("num", ""), d.get("name", ""))
        if problem:
            return False, problem
        set_bracket(rounds); return True, "Driver updated in every round"
    # ---- race analysis (race info) ----
    if cmd in ("analysisText", "analysisShow", "analysisReplay"):
        if "title" in d or "lines" in d:
            t, l = clean_analysis(d.get("title", STATE["analysis"]["title"]), d.get("lines", STATE["analysis"]["lines"]))
            set_analysis(title=t, lines=l); update_config(analysis_title=t, analysis_lines=l)
        if cmd != "analysisText":
            set_analysis(visible=True)
        if cmd == "analysisReplay":
            bump_analysis_replay()
        return True, ""
    if cmd == "analysisHide":
        set_analysis(visible=False); return True, ""
    # ---- broadcast team ----
    if cmd in ("teamText", "teamShow", "teamReplay"):
        if "title" in d or "people" in d:
            t, p = clean_team(d.get("title", STATE["team"]["title"]), d.get("people", STATE["team"]["people"]))
            set_team(title=t, people=p); update_config(team_title=t, team_people=p)
        if cmd != "teamText":
            set_team(visible=True)
        if cmd == "teamReplay":
            bump_team_replay()
        return True, ""
    if cmd == "teamHide":
        set_team(visible=False); return True, ""
    if cmd == "hideAll":
        set_state(visible=False); set_analysis(visible=False); set_team(visible=False); return True, ""
    return False, "Unknown command: %s" % cmd


def state_json():
    with STATE_LOCK:
        return json.dumps(STATE)
