"""The season stage: where a series is in its season, said once (Nov 2026).

Before, that was spread over five settings that each graphic read for itself: the standings graphic's cutoff switch
and number, live points' line and its season / playoff mode, and which rounds of the bracket had drivers in them.
They could disagree. Grand National, Round of 12, Nov 14, 2026: the standings graphic showed the six regular-season
winners as LOCKED IN while live points, in playoff mode, rightly showed none.

Now each series has one stage (settings "stage", saved with the series), and the standings graphic, live points and
the bracket all work from it:

  stage     who is in the fight   line after           what locks a driver in
  regular   everyone              none (or a plain     nothing
                                  line the producer
                                  sets, with a label)
  pre       everyone              the playoff field    a win this season
  r12       the Round of 12       8                    a win in this round (the bracket's trophy mark)
  r8        the Round of 8        4                    a win in this round
  c4        the Championship 4    4 (the four)         nothing: the best finisher of the four takes it

apply() pushes the stage into the settings the graphics already read (live points' cutoff, mode and round; the
standings graphic's cutoff, what locks a driver in and the line's label), so there is one place to change and nothing
to keep in step by hand. A series linked to GLR HUB gets its stage from the site at each refresh (profiles.py).
"""
import standings

STAGES = [("regular", "Regular season, no playoffs"), ("pre", "Regular season, playoffs ahead"),
          ("r12", "Round of 12"), ("r8", "Round of 8"), ("c4", "Championship 4")]
KEYS = [k for k, _ in STAGES]
ROUND = {"r12": 0, "r8": 1, "c4": 2}       # the bracket round a playoff stage is
ROUND_KEYS = ["r12", "r8", "c4"]
ADVANCE = {"r12": 8, "r8": 4, "c4": 4}     # the line: how many go through (the Championship 4: the four themselves)
PLAYOFF_LABEL = "PLAYOFF CUTOFF LINE"


def _int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return default


def clean(v):
    """A stage as saved: {stage, field (the playoff field, for 'pre'), line and lineLabel (the plain line, for
    'regular'; 0 = no line)}. Anything missing or odd becomes 'regular season, playoffs ahead, top 12'."""
    v = v if isinstance(v, dict) else {}
    return {"stage": v.get("stage") if v.get("stage") in KEYS else "pre", "field": _int(v.get("field"), 1, 60, 12),
            "line": _int(v.get("line"), 0, 60, 0), "lineLabel": " ".join(str(v.get("lineLabel") or "").split())[:40]}


def rules(v):
    """What a stage means for the graphics: playoff (live points lists only the round's drivers), round (the bracket
    round, or None), cutoff (the line goes after this place; 0 = no line), lock ('season': a win this season,
    'round': a win in the round, 'none'), lineLabel (the words on the standings graphic's line)."""
    v = clean(v)
    s = v["stage"]
    if s == "regular":
        return {"playoff": False, "round": None, "cutoff": v["line"], "lock": "none", "lineLabel": (v["lineLabel"] or "CUTOFF LINE").upper()}
    if s == "pre":
        return {"playoff": False, "round": None, "cutoff": v["field"], "lock": "season", "lineLabel": PLAYOFF_LABEL}
    return {"playoff": True, "round": ROUND[s], "cutoff": ADVANCE[s], "lock": "none" if s == "c4" else "round",
            "lineLabel": "CHAMPIONSHIP 4" if s == "c4" else PLAYOFF_LABEL}


def describe(v):
    """One line for the control panel, e.g. 'Round of 12 · 8 advance'."""
    v = clean(v)
    s = v["stage"]
    if s == "regular":
        return "Regular season" + (" · line after %d%s" % (v["line"], (" (%s)" % v["lineLabel"]) if v["lineLabel"] else "") if v["line"] else " · no cutoff line")
    if s == "pre":
        return "Regular season · top %d make the playoffs · a win locks a driver in" % v["field"]
    if s == "c4":
        return "Championship 4 · the best finisher of the four takes it"
    return "%s · %d advance · a win in the round locks a driver in" % (dict(STAGES)[s], ADVANCE[s])


def infer(live_points, graphic, bracket):
    """The stage of a series saved before there were stages, from the settings it had, so nothing changes on air
    when the overlay is updated: live points in playoff mode = the latest bracket round with drivers in it; otherwise
    'playoffs ahead' with the cutoff it was using (the standings graphic's when its cutoff was switched on, else live
    points' line)."""
    lp = live_points if isinstance(live_points, dict) else {}
    g = graphic if isinstance(graphic, dict) else {}
    if lp.get("playoff"):
        rounds = list(bracket or []) + [[]] * 3
        return clean({"stage": ROUND_KEYS[max((k for k in range(3) if rounds[k]), default=0)]})
    return clean({"stage": "pre", "field": g.get("cutoff") if g.get("playoff") and g.get("cutoff") else lp.get("cutoff") or 12})


def apply(state):
    """Push the series' stage (state.settings["stage"]) into what the graphics read. Call after anything changes it."""
    with state.lock:
        v = clean(state.settings.get("stage"))
    r = rules(v)
    lp = {"playoff": r["playoff"], "round": r["round"], "lock": r["lock"], "noLine": r["cutoff"] == 0}
    if r["cutoff"]:
        lp["cutoff"] = r["cutoff"]
    state.update_settings({"stage": v, "livePoints": lp})
    graphic = {"lock": r["lock"], "lockRound": r["round"], "lineLabel": r["lineLabel"], "hasLine": r["cutoff"] > 0}
    if r["cutoff"]:
        graphic["cutoff"] = min(20, r["cutoff"])            # the standings graphic shows the top 20
        standings.update_config(cutoff=graphic["cutoff"])
    else:
        graphic["playoff"] = False                          # no line to show: the cutoff picture goes off
    standings.set_state(**graphic)
    return v


def ensure(state, saved=True):
    """A series loaded with no stage of its own (saved before stages): work it out from its settings. Then apply."""
    if not saved:
        with state.lock:
            lp = dict(state.settings.get("livePoints") or {})
        with standings.STATE_LOCK:
            g = {"playoff": standings.STATE.get("playoff"), "cutoff": standings.STATE.get("cutoff")}
        with state.lock:
            state.settings["stage"] = infer(lp, g, standings.bracket_snapshot())
    return apply(state)
