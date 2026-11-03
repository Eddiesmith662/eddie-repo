"""Live points: the championship as it would stand if the race ended now.

Each driver's points from the Standings tab (Xtreme Scoring pull or CSV, loaded before the race) plus what
they'd score for their current running position, plus bonuses: leading a lap, leading the most laps, and pole.

Playoff cutline, same rules as the standings graphic's playoff view: drivers with a win are locked in at the
top (here that's anyone with a win in the standings' Wins column, plus whoever is leading the race), the
remaining spots up to the cutoff go to the best of the rest on points, and the line sits under the last
driver who's in.

Playoff mode (cfg "playoff", switched on with the bracket on the Standings tab): only the drivers in the current
playoff round (the latest bracket round with drivers in it) are listed, regular-season wins don't count, and a driver
is locked in by a win in this round (ticked in the bracket) or by leading the race. The cutline sets itself: 8 go
through from the Round of 12, 4 from the Round of 8. The Championship 4 has no points: highest finisher of the four
takes it, so it lists them in running order with the leader as CHAMP. Points still come from the standings (Xtreme
Scoring shows the reset playoff points) plus tonight's points and bonuses.

Drivers are matched to the standings by name (ignoring case, spaces, punctuation and the digits iRacing adds
to some names), then by car number. iRacing drivers not in the standings start from 0. Drivers in the
standings who aren't in this race keep their points and stay in the list.
"""
import re

# VSPEED's points table: P1 46, P2 42, P3 41, then one point less per place to P43 = 1, 0 after that
DEFAULT_TABLE = [46] + [44 - p for p in range(2, 44)] + [0] * 17      # 60 places
# from / to = the places shown on the graphic (e.g. 3 and 16 = 3rd to 16th), at most MAX_ROWS of them
DEFAULTS = {"cutoff": 12, "from": 1, "to": 15, "table": DEFAULT_TABLE, "bonusLed": 1, "bonusMost": 1, "bonusPole": 1, "playoff": False}
ROUNDS = ["ROUND OF 12", "ROUND OF 8", "CHAMPIONSHIP 4"]
ADVANCE = [8, 4]             # drivers who go through from the Round of 12 and the Round of 8
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


def _find(people, name, num):
    k = _key(name)
    p = next((p for p in people if k and _key(p["name"]) == k), None)
    if p is None and num:
        p = next((p for p in people if p["num"] == str(num).strip()), None)
    return p


def race_key(live):
    """Which race this is, so 'Add tonight's race' knows it's already in the standings."""
    return "%s|%s|%s" % (live.get("subId") or "", live.get("track") or "", live.get("sessNum"))


def _score(live, cfg, header, srows, excluded, counted=False):
    """Match each car in the race to a standings row and work out tonight's points. Returns (people, racing):
    every standings row in its own order, then the cars that aren't in the standings, each with base (standings
    points), race (points for the running position), bonus, pts (the total), car (the car in this race, or None)
    and excl (left out by hand). counted: tonight's race is already in the standings (added after the checkered
    flag), so it isn't added again: everyone stays on their standings points."""
    di, ni, pi, wi, posi = (_col(header, "driver"), _col(header, "#", "no", "num", "car"), _col(header, "pts", "points"),
                           _col(header, "wins", "w"), _col(header, "pos"))
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
                       "basePos": int(_num(g(posi))) or (k + 1), "car": None, "excl": _key(g(di)) in excluded})
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
            p = {"name": c.get("name", ""), "num": str(c.get("num") or ""), "base": 0.0, "wins": 0, "basePos": None, "car": None,
                 "excl": _key(c.get("name")) in excluded}
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
        if counted:
            race = bonus = 0.0
        p["race"], p["bonus"] = race, bonus
        p["pts"] = p["base"] + race + bonus
        p["leading"] = c is not None and racing and (c.get("pos") or 0) == 1
        p["lock"] = p["wins"] > 0 or p["leading"]

    return people, racing


def compute(live, cfg, standings_data, bracket=None, excluded=None):
    """Returns what the live points graphic and the control panel show (see the module notes).
    excluded: name keys (letters only, lower case) of drivers left out by hand on the Standings tab, e.g. not eligible
    for the playoffs. They're matched to their car as usual (so they don't come back as 'not in the standings'), then
    left out: they're not listed and never take a spot above the line."""
    excluded = set(excluded or ())
    cfg = dict(DEFAULTS, **(cfg or {}))
    playoff = bool(cfg.get("playoff"))
    out = {"ok": False, "why": "", "rows": [], "cutoff": int(cfg.get("cutoff") or 12), "lap": live.get("lap"),
           "mode": "playoff" if playoff else "season", "title": "LIVE POINTS"}
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

    cars = live.get("cars") or []
    counted = bool(standings_data.get("race_added")) and standings_data.get("race_added") == race_key(live)
    people, racing = _score(live, cfg, header, srows, excluded, counted)
    out["counted"] = counted

    # excluded drivers: matched above, now left out
    people = [p for p in people if not p.get("excl")]
    # positions in the standings without them (drivers level on points share one), for the moved-up / down arrows
    if excluded:
        ranked = sorted((p for p in people if p["basePos"]), key=lambda p: p["basePos"])
        for k, p in enumerate(ranked):
            p["basePos"] = ranked[k - 1]["basePos"] if k and p["base"] == ranked[k - 1]["base"] else k + 1

    # cars in this race that aren't in the standings (a first race in the series, or a name and number that don't match)
    out["unmatched"] = ["#%s %s" % (p["num"], p["name"]) for p in people if p["car"] is not None and not p["basePos"]]
    cut = max(1, int(cfg.get("cutoff") or 12))
    if playoff:
        rounds = (bracket or [[], [], [], []]) + [[]] * 4
        r = max((k for k in range(3) if rounds[k]), default=None)
        if r is None:
            out["why"] = "Playoff mode: the bracket is empty (Standings tab: Load top 12)"
            return out
        field = []
        for e in rounds[r]:            # the drivers in this round, with their standings points
            p = _find(people, e.get("name"), e.get("num"))
            if p is None:
                p = {"name": e.get("name", ""), "num": str(e.get("num") or ""), "base": 0.0, "wins": 0, "basePos": None,
                     "car": None, "race": 0.0, "bonus": 0.0, "pts": 0.0, "leading": False}
            if p in field:
                continue
            p["wins"] = 0                                          # regular-season wins don't count any more
            p["lock"] = bool(e.get("won")) or p["leading"]         # won a race in this round, or leading this one
            field.append(p)
        people = field
        out["title"] = ROUNDS[r]
        out["round"] = r
        if r == 2:
            # Championship 4: no points, the highest finisher of the four takes it
            people.sort(key=lambda p: ((p["car"] or {}).get("pos") or 999, p["basePos"] or 999))
            rows = []
            for k, p in enumerate(people):
                c = p["car"]
                rows.append({"pos": k + 1, "num": p["num"] or (c or {}).get("num", ""), "name": p["name"],
                             "pts": ("P%d" % c["pos"]) if c is not None and c.get("pos") else "",
                             "race": "", "cut": "CHAMP" if k == 0 and c is not None and racing else "",
                             "status": "champ" if k == 0 and c is not None and racing else "out",
                             "racing": c is not None, "runPos": (c or {}).get("pos"), "move": None})
            out.update(ok=True, rows=rows, lineAfter=0 if rows else -1, cutoff=1, locked=0,
                       matched=sum(1 for p in people if p["car"] is not None), cars=len(people), champ4=True)
            return out
        cut = ADVANCE[r]

    # points order (ties: more wins, then the better place in the standings before the race, then running order)
    people.sort(key=lambda p: (-p["pts"], -p["wins"], p["basePos"] or 999, (p["car"] or {}).get("pos") or 999))
    for k, p in enumerate(people):
        p["ptsPos"] = k + 1
    # playoff order: everyone locked in first (keeping points order), then the rest
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
               matched=sum(1 for p in people if p["car"] is not None and p["basePos"]),
               cars=sum(1 for p in people if p["car"] is not None) if playoff else len(cars))
    return out


def race_result(live, cfg, standings_data):
    """The standings with tonight's race added, for 'Add tonight's race to the standings' (Standings tab), once the
    checkered flag is out. Each driver's Pts become their live points total (standings points + points for where they
    finished + bonuses, the same as live points), the winner gets a win, drivers new to the series are added, and the
    table is re-sorted the way live points orders it (Pos, To Ldr, To Nxt and Chg are worked out by the caller's
    recalc; Chg here = places gained tonight). Excluded drivers keep their row and get their points too (they stay
    hidden as before). Raises ValueError with the reason when it can't.
    Returns (rows, summary): summary = {"winner": "#N Name", "new": [names], "moves": [(name, old, new)], "drivers": n}."""
    cfg = dict(DEFAULTS, **(cfg or {}))
    if not live.get("connected"):
        raise ValueError("iRacing isn't connected.")
    if not live.get("isRace"):
        raise ValueError("This works in a race session, once the checkered flag is out.")
    if (live.get("sessionState") or 0) < 5:
        raise ValueError("The race isn't over yet: add it once the checkered flag is out.")
    header, srows = list(standings_data.get("header") or []), [list(r) for r in standings_data.get("rows") or []]
    di, ni, pi, wi, posi, ci = (_col(header, "driver"), _col(header, "#", "no", "num", "car"), _col(header, "pts", "points"),
                               _col(header, "wins", "w"), _col(header, "pos"), _col(header, "chg", "change"))
    if not srows or di < 0 or pi < 0:
        raise ValueError("Pull or load the standings first (they need Driver and Pts columns).")
    people, _ = _score(live, cfg, header, srows, set())
    width = len(header)
    out, summary = [], {"winner": "", "new": [], "moves": [], "drivers": 0}
    for k, p in enumerate(people):
        new = k >= len(srows)
        r = (["" for _ in range(width)] if new else (srows[k] + [""] * width)[:width])
        c = p["car"]
        won = c is not None and (c.get("pos") or 0) == 1
        if new:
            r[di] = p["name"]
            if ni >= 0:
                r[ni] = p["num"]
            summary["new"].append("#%s %s" % (p["num"], p["name"]))
        r[pi] = _fmt(p["pts"])
        if wi >= 0:
            r[wi] = str(p["wins"] + (1 if won else 0))
        if won:
            summary["winner"] = "#%s %s" % (p["num"] or c.get("num", ""), p["name"])
        if c is not None:
            summary["drivers"] += 1
        out.append((p, r, p["wins"] + (1 if won else 0)))
    # the order live points uses: points, then wins, then the place before the race, then where they finished
    out.sort(key=lambda x: (-x[0]["pts"], -x[2], x[0]["basePos"] or 999, (x[0]["car"] or {}).get("pos") or 999))
    rows = []
    for k, (p, r, _) in enumerate(out):
        if ci >= 0:
            r[ci] = str(p["basePos"] - (k + 1)) if p["basePos"] else ""
        if p["basePos"] and p["basePos"] != k + 1:
            summary["moves"].append((p["name"], p["basePos"], k + 1))
        rows.append(r)
    return rows, summary
