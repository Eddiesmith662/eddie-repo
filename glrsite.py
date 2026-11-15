"""GLR HUB series for the overlay's Series list (Nov 2026).

GLR HUB (the league site, glr/) is the replacement for Xtreme Scoring: it works the standings out from the results the
overlay sends it. This reads the site's public data, with no sign-in:

  /api/series               the series on the site (a series' number is its iRacing league ID)
  /api/standings/<series>   the current season's standings, one group per class when classes race together

and turns a series' standings into the table the standings graphic, the bracket and live points already use (a header
row and driver rows, the same shape as an Xtreme pull or a CSV), plus each driver's iRacing ID, so live points can
match a car to its row by ID when the name in iRacing isn't the one on the site.

Nothing here runs by itself during a broadcast: the list is read at start-up and when asked, and standings only when the
producer picks a series or presses Refresh (profiles.py).
"""
import json
import re
import threading
import time
import urllib.error
import urllib.request

import leagueupload
import net

HEADER = ["Pos", "#", "Driver", "Pts", "To Ldr", "To Nxt", "Wins", "Top 5", "Top 10", "Starts"]
MAX_ROWS = 200           # more than any field: live points needs everyone who races

LOCK = threading.Lock()
LIST = {"series": [], "at": 0.0, "error": "", "loading": False}     # the site's series, as last read


class SiteError(Exception):
    """GLR HUB couldn't be read; the message is for the producer."""


def _get(path, timeout=15):
    req = urllib.request.Request(leagueupload.SITE + path, headers={"User-Agent": "VSPEED-Overlay", "Accept": "application/json"})
    try:
        r = net.urlopen(req, timeout)
        return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            why = json.loads(e.read().decode("utf-8") or "{}").get("error")
        except ValueError:
            why = ""
        raise SiteError(why or "GLR HUB answered with error %d" % e.code)
    except (OSError, ValueError) as e:
        raise SiteError("Couldn't reach GLR HUB (%s)" % (getattr(e, "reason", None) or e))


def _slug(s):
    return re.sub(r"[^a-z0-9-]", "", str(s or "").lower())


def fetch_list():
    """The series on the site now. Past series (old seasons kept for the record) are left out: nothing races in them."""
    d = _get("/api/series")
    out = []
    for s in d.get("series") or []:
        slug = _slug(s.get("slug"))
        if not slug or s.get("past"):
            continue
        out.append({"slug": slug, "id": s.get("id"), "name": str(s.get("name") or s.get("short_name") or slug)[:80],
                    "short": str(s.get("short_name") or s.get("name") or slug)[:40], "hidden": bool(s.get("hidden"))})
    return out


def refresh_list():
    """Read the list again and keep it. Returns (ok, message). Never raises: the old list stays if the site is down."""
    with LOCK:
        if LIST["loading"]:
            return True, "Already reading the GLR HUB series"
        LIST["loading"] = True
    try:
        series = fetch_list()
        with LOCK:
            LIST.update(series=series, at=time.time(), error="")
        return True, "%d series on GLR HUB" % len(series)
    except SiteError as e:
        with LOCK:
            LIST["error"] = str(e)
        return False, str(e)
    except Exception as e:      # whatever the site sends, the overlay carries on
        with LOCK:
            LIST["error"] = "GLR HUB sent something unexpected (%r)" % (e,)
        return False, LIST["error"]
    finally:
        with LOCK:
            LIST["loading"] = False


def refresh_list_in_background():
    threading.Thread(target=refresh_list, name="glr-series", daemon=True).start()


def list_snapshot():
    with LOCK:
        return {"series": [dict(s) for s in LIST["series"]], "at": LIST["at"], "error": LIST["error"]}


def _fmt(x):
    x = float(x or 0)
    return str(int(round(x))) if abs(x - round(x)) < 1e-9 else ("%.3f" % x).rstrip("0").rstrip(".")


def _name_key(name):
    return re.sub(r"[^a-z]", "", str(name or "").lower())       # the same rule as standings.name_key and live points


def to_table(resp, cls=""):
    """One class's standings as the overlay's table. Returns a dict: header, rows, ids ({name key: iRacing ID}),
    classes (the class names, when the series has more than one), cls (the class used), season, playoffs (True when the
    playoffs have started: the drivers still in come first, on their playoff points, then the ones knocked out, then
    everyone else)."""
    groups = [g for g in (resp.get("groups") or []) if isinstance(g, dict)]
    season = (resp.get("season") or {}).get("name") or ""
    classes = [str(g.get("carClass") or "") for g in groups if g.get("carClass")]
    if not groups:
        raise SiteError("%s has no races in its standings yet" % (resp.get("series") or "This series"))
    g = next((x for x in groups if cls and str(x.get("carClass") or "") == cls), groups[0])
    po = g.get("playoffs") or {}
    if po.get("started") and (po.get("current") or {}).get("rows"):
        people = list(po["current"]["rows"]) + list(po.get("eliminated") or []) + list(po.get("others") or [])
        shared = False
    else:
        people = list(g.get("regular") or [])
        shared = True
    people = [p for p in people if isinstance(p, dict) and str(p.get("name") or "").strip()][:MAX_ROWS]
    if not people:
        raise SiteError("%s has no drivers in its standings yet" % (resp.get("series") or "This series"))
    rows, ids = [], {}
    top = float(people[0].get("points") or 0)
    for k, p in enumerate(people):
        pts = float(p.get("points") or 0)
        prev = float(people[k - 1].get("points") or 0) if k else pts
        pos = p.get("pos") if shared and p.get("pos") else k + 1
        rows.append([str(pos), str(p.get("number") or "").strip(), str(p["name"]).strip(), _fmt(pts), _fmt(pts - top), _fmt(pts - prev),
                     _fmt(p.get("wins")), _fmt(p.get("top5")), _fmt(p.get("top10")), _fmt(p.get("starts"))])
        if p.get("custId") and _name_key(p["name"]):
            ids.setdefault(_name_key(p["name"]), str(p["custId"]))
    return {"header": list(HEADER), "rows": rows, "ids": ids, "classes": classes if len(classes) > 1 else [],
            "cls": str(g.get("carClass") or "") if len(classes) > 1 else "", "season": season, "playoffs": not shared}


def fetch_standings(slug, cls=""):
    """A series' standings from the site, as to_table() gives them. Raises SiteError with a message for the producer."""
    slug = _slug(slug)
    if not slug:
        raise SiteError("Pick a series first")
    resp = _get("/api/standings/" + slug)
    if not resp.get("ok", True):
        raise SiteError(resp.get("error") or "GLR HUB couldn't give the standings")
    return to_table(resp, cls)
