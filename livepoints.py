"""Live points: the championship as it would stand if the race ended now.

Each driver's points from the Standings tab (Xtreme Scoring pull or CSV, loaded before the race) plus what
they'd score for their current running position, plus bonuses: leading a lap, leading the most laps, and pole.

Playoff cutline, same rules as the standings graphic's playoff view: drivers with a win are locked in at the
top (here that's anyone with a win in the standings' Wins column, plus whoever is leading the race), the
remaining spots up to the cutoff go to the best of the rest on points, and the line sits under the last
driver who's in.

Drivers are matched to the standings by name (ignoring case, spaces, punctuation and the digits iRacing adds
to some names), then by car number. iRacing drivers not in the standings start from 0. Drivers in the
standings who aren't in this race keep their points and stay in the list.
"""
import re

# VSPEED's points table: P1 46, P2 42, P3 41, then one point less per place to P43 = 1, 0 after that
DEFAULT_TABLE = [46] + [44 - p for p in range(2, 44)] + [0] * 17      # 60 places
# from / to = the places shown on the graphic (e.g. 3 and 16 = 3rd to 16th), at most MAX_ROWS of them
DEFAULTS = {"cutoff": 12, "from": 1, "to": 15, "table": DEFAULT_TABLE, "bonusLed": 1, "bonusMost": 1, "bonusPole": 1}
MAX_ROWS = 15


def _key(name):
    """Name for matching: letters only, lower case ("Jake Bustos2" and "jake bustos" match)."""
    return re.sub(r"[^a-z]", "", str(name or "").lower())


def _num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _col(header, *names):
    low = [str(h).strip().lower() for h in header]
    for n in names:
        if n in low:
            return low.index(n)
    return -1


def _fmt(x):
    return str(int(x)) if abs(x - round(x)) < 1e-9 else ("%.1f" % x)


def compute(live, cfg, standings_data):
    """Returns what the live points graphic and the control panel show (see the module notes)."""
    cfg = dict(DEFAULTS, **(cfg or {}))
    out = {"ok": False, "why": "", "rows": [], "cutoff": int(cfg.get("cutoff") or 12), "lap": live.get("lap")}
    if not live.get("connected"):
        out["why"] = "Waiting for iRacing"
        return out
    if not live.get("isRace"):
        out["why"] = "Live points work in race sessions"
        return out
    header, srows = standings_data.get("header") or [], standings_data.get("rows") or []
    di, ni, pi, wi, posi = (_col(header, "driver"), _col(header, "#", "no", "num", "car"), _col(header, "pts", "points"),
                           _col(header, "wins", "w"), _col(header, "pos"))
    if not srows or di < 0:
        out["why"] = "No standings loaded: pull or load them on the Standings tab before the race"
        return out

    table = [_num(x) for x in (cfg.get("table") or DEFAULT_TABLE)]
    b_led, b_most, b_pole = _num(cfg.get("bonusLed")), _num(cfg.get("bonusMost")), _num(cfg.get("bonusPole"))
    racing = (live.get("sessionState") or 0) >= 4
    cars = live.get("cars") or []
    most = max((c.get("lapsLed") or 0) for c in cars) if cars else 0

    # the standings, in their own order
    people = []
    for k, r in enumerate(srows):
        g = lambda i: r[i] if 0 <= i < len(r) else ""
        people.append({"name": g(di), "num": str(g(ni)).strip(), "base": _num(g(pi)), "wins": int(_num(g(wi))),
                       "basePos": int(_num(g(posi))) or (k + 1), "car": None})
    by_name = {}
    for p in people:
        by_name.setdefault(_key(p["name"]), p)
    by_num = {}
    for p in people:
        if p["num"]:
            by_num.setdefault(p["num"], p)

    # match each car in the race to a standings row
    for c in cars:
        p = by_name.get(_key(c.get("name")))
        if p is None or p["car"] is not None:
            p = by_num.get(str(c.get("num") or ""))
            if p is not None and p["car"] is not None:
                p = None
        if p is None:                      # not in the standings: starts from 0
            p = {"name": c.get("name", ""), "num": str(c.get("num") or ""), "base": 0.0, "wins": 0, "basePos": None, "car": None}
            people.append(p)
        p["car"] = c

    for p in people:
        c = p["car"]
        race = bonus = 0.0
        if c is not None:
            pos = c.get("pos") or 0
            if racing and pos > 0:
                race = table[pos - 1] if pos <= len(table) else 0.0
            led = c.get("lapsLed") or 0
            if led >= 1:
                bonus += b_led
                if led == most:
                    bonus += b_most
            if c.get("startPos") == 1:
                bonus += b_pole
        p["race"], p["bonus"] = race, bonus
        p["pts"] = p["base"] + race + bonus
        p["lock"] = p["wins"] > 0 or (c is not None and racing and (c.get("pos") or 0) == 1)

    # points order (ties: more wins, then the better place in the standings before the race, then running order)
    people.sort(key=lambda p: (-p["pts"], -p["wins"], p["basePos"] or 999, (p["car"] or {}).get("pos") or 999))
    for k, p in enumerate(people):
        p["ptsPos"] = k + 1
    # playoff order: everyone locked in first (keeping points order), then the rest
    cut = max(1, int(cfg.get("cutoff") or 12))
    locked = [p for p in people if p["lock"]]
    rest = [p for p in people if not p["lock"]]
    spots = max(0, cut - len(locked))
    for k, p in enumerate(rest):
        p["status"] = "in" if k < spots else "out"
    for p in locked:
        p["status"] = "lock"
    order = locked + rest
    last_in = next((p for p in reversed(rest[:spots])), None)
    first_out = rest[spots] if spots < len(rest) else None
    line_after = len(locked) + spots - 1 if (locked or spots) else -1
    rows = []
    for k, p in enumerate(order):
        if p["status"] == "lock":
            to_cut = "IN"
        else:
            ref = first_out if p["status"] == "in" else last_in
            d = p["pts"] - ref["pts"] if ref else None
            to_cut = "" if d is None else ("+" + _fmt(d) if d > 0 else _fmt(d))
        c = p["car"]
        rows.append({"pos": k + 1, "num": p["num"] or (c or {}).get("num", ""), "name": p["name"],
                     "pts": _fmt(p["pts"]), "race": _fmt(p["race"] + p["bonus"]), "cut": to_cut, "status": p["status"],
                     "racing": c is not None, "runPos": (c or {}).get("pos"),
                     "move": (p["basePos"] - (k + 1)) if p["basePos"] else None})
    out.update(ok=True, rows=rows, lineAfter=line_after, cutoff=cut, locked=len(locked),
               matched=sum(1 for p in people if p["car"] is not None and p["basePos"]), cars=len(cars))
    return out
