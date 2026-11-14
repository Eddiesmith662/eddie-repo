"""Recorded races replayed through the overlay's real code (see replay.py).

Two kinds of check:
  - facts about the race that a person checked against the broadcast (the flags, overtime, the winner, the pit cycle);
  - the golden file: everything the overlay showed, every second. Any change shows up here; if it's intended, look at
    the differences and save new golden files with  python tests\\replay.py --update
"""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import replay
import server
import incidents
import pitrace


def run(name):
    """Replay once; keep what the checks need."""
    errors_before = server.diag.STATS["errors"]
    rows, lives = [], []
    for r, live in replay.replay(name):
        rows.append(replay.summary(live))
        lives.append({"state": live["sessionState"], "cars": [{"num": c["num"], "gap": c.get("gap"), "finished": c.get("finished"),
                                                                "gapS": c.get("gapS")} for c in live["cars"]]})
    return {"rows": rows, "lives": lives, "errors": server.diag.STATS["errors"] - errors_before,
            "incidents": incidents.snapshot()["list"], "pitrace": pitrace.snapshot()}


def changes(rows, key):
    """[(session time, value)] each time `key` changes."""
    out, prev = [], object()
    for r in rows:
        if r[key] != prev:
            out.append((r["t"], r[key]))
            prev = r[key]
    return out


class GoldenMixin:
    NAME = None

    def test_matches_golden_file(self):
        golden = replay.load_golden(self.NAME)
        self.assertIsNotNone(golden, "no golden file yet: run  python tests\\replay.py --update")
        diff = replay.differences(golden, self.R["rows"])
        self.assertFalse(diff, "The overlay now shows something different from the checked recording:\n  " + "\n  ".join(diff) +
                         "\nIf that's intended, save new golden files:  python tests\\replay.py --update")

    def test_no_errors(self):
        self.assertEqual(self.R["errors"], 0, "errors were logged during the replay: %s" % server.diag.STATS["lastError"])

    def test_gaps_never_negative(self):
        bad = [(r["t"], g) for r in self.R["rows"] for g in r["gap"] if isinstance(g, str) and g.startswith("+-")]
        self.assertFalse(bad[:5])

    def test_lap_never_goes_backwards(self):
        laps = [r["lap"] for r in self.R["rows"]]
        self.assertEqual(laps, sorted(laps))


class TalladegaFinish(GoldenMixin, unittest.TestCase):
    """Talladega, Oct 24 2026, lap 35 to the finish. Scheduled 50 laps; caution on lap 49 sent it to overtime;
    green on lap 52, white on lap 54, checkered at 54 laps; #15 won."""
    NAME = "talladega-2026-10-24-finish"

    @classmethod
    def setUpClass(cls):
        cls.R = run(cls.NAME)

    def flag_at_lap(self, flag):
        return [r["lap"] for r in self.R["rows"] if r["flag"] == flag]

    def test_flags_through_the_race(self):
        seq = [f for _, f in changes(self.R["rows"], "flag")]
        self.assertEqual(seq, ["green", "caution", "green", "caution", "green", "white", "checkered"])

    def test_cautions_on_laps_40_and_49(self):
        starts = [r["lap"] for a, r in zip(self.R["rows"], self.R["rows"][1:]) if r["flag"] == "caution" and a["flag"] != "caution"]
        self.assertEqual(starts, [40, 49])

    def test_overtime_certain_under_the_lap_49_caution(self):
        first_ot = next(r for r in self.R["rows"] if r["ot"])
        self.assertEqual((first_ot["lap"], first_ot["flag"]), (49, "caution"))

    def test_restart_on_lap_52_makes_lap_54_the_final_lap(self):
        restart = next(r for a, r in zip(self.R["rows"], self.R["rows"][1:]) if a["flag"] == "caution" and r["flag"] == "green" and r["lap"] >= 50)
        self.assertEqual((restart["lap"], restart["final"]), (52, 54))

    def test_white_flag_only_on_lap_54(self):
        self.assertEqual(set(self.flag_at_lap("white")), {54})

    def test_checkered_at_54_laps_and_lap_counter_stops_there(self):
        self.assertEqual(set(self.flag_at_lap("checkered")), {54})
        self.assertEqual(max(r["lap"] for r in self.R["rows"]), 54)

    def test_winner_and_locked_finish_gaps(self):
        last = self.R["lives"][-1]["cars"]
        self.assertEqual(last[0]["num"], "15")
        self.assertEqual(last[0]["gap"], "LEADER")
        finished = [c for c in last if c["finished"] and c["gapS"] is not None]
        self.assertGreaterEqual(len(finished), 10)
        self.assertEqual([c["gapS"] for c in finished], sorted(c["gapS"] for c in finished), "finish gaps out of order")
        self.assertEqual(last[1]["num"], "3")

    def test_incident_log_has_both_cautions(self):
        cautions = [e["lap"] for e in self.R["incidents"] if e["type"] == "caution"]
        self.assertEqual(cautions, [40, 49])

    def test_pit_cycle_under_the_lap_40_caution(self):
        ready = [r for r in self.R["rows"] if r["pr"] == "ready"]
        self.assertTrue(ready, "the lap-40 caution pit cycle never became READY")
        self.assertEqual((ready[0]["lap"], ready[0]["flag"]), (42, "caution"))

    def test_pit_cycle_under_the_overtime_caution(self):
        # lap 50: ten lead-lap cars pitted; eight sat in their stalls for about two minutes and left together.
        # Before the fix the cycle gave up on them after 90 s and was thrown away, so it never reached the graphic.
        ready = [r for r in self.R["rows"] if r["pr"] == "ready" and r["lap"] >= 50]
        self.assertTrue(ready, "the overtime caution pit cycle never became READY")
        self.assertEqual(ready[0]["flag"], "caution", "should be ready before the restart")
        final = self.R["pitrace"]
        self.assertEqual(final.get("listLap"), 50)
        rows = final.get("list") or []
        self.assertEqual(len(rows), 10)
        # a car held in its stall has no real stop time: the pit timer gives up at 50 s, and 49.9 must not go on air
        self.assertEqual({r["num"]: r["stop"] for r in rows if r["stop"] is not None}, {"24": 24.2})


class TalladegaCaution(GoldenMixin, unittest.TestCase):
    """The same race, laps 13 to 21: caution on lap 17, the field pits under it, green again on lap 20."""
    NAME = "talladega-2026-10-24-caution"

    @classmethod
    def setUpClass(cls):
        cls.R = run(cls.NAME)

    def test_caution_lap_17_green_lap_20(self):
        ch = [(r["lap"], r["flag"]) for r in self.R["rows"]]
        self.assertEqual(next(l for l, f in ch if f == "caution"), 17)
        self.assertEqual(next(l for l, f in reversed(ch) if f == "caution"), 20)
        self.assertEqual(self.R["rows"][-1]["flag"], "green")

    def test_pit_cycle_ready_with_spots_gained_and_lost(self):
        pr = self.R["pitrace"]
        self.assertEqual(pr.get("status"), "ready")
        rows = pr.get("list") or []
        self.assertGreaterEqual(len(rows), 10)
        self.assertEqual(rows[0]["num"], "8")                       # first off pit road
        self.assertEqual(sum(r["gained"] for r in rows), 0, "spots gained and lost should balance out")
        self.assertTrue(all(r["stop"] is None or 1.5 < r["stop"] < 50 for r in rows))

    def test_pit_stops_counted(self):
        # under this caution every car stopped, and about half came back for a second stop on the next lap
        stops = self.R["rows"][-1]["stops"]
        self.assertEqual(len(stops), 25)
        self.assertEqual(sorted(set(stops.values())), [1, 2])
        self.assertTrue(all(stops.get(r["num"]) for r in self.R["pitrace"].get("list") or []))

class CharlotteRovalHairpin(GoldenMixin, unittest.TestCase):
    """Charlotte Roval, Sports Car, Nov 12 2026: 15 minutes of a timed race under green, 16 cars. The first road course
    recording: the hairpin 42% of the way round is taken at about 35 mph after a 140 mph straight."""
    NAME = "charlotte-roval-2026-11-12-hairpin"

    @classmethod
    def setUpClass(cls):
        cls.R = run(cls.NAME)

    def test_green_all_the_way(self):
        self.assertEqual({r["flag"] for r in self.R["rows"]}, {"green"})

    def test_braking_for_the_hairpin_is_not_logged(self):
        # at one reading a second the smoothed speeds are gentler than on race night; test_road_course_incidents.py has
        # the same recording with the cars' real speeds
        crashes = [(e["t"], e["num"], e["type"], e["detail"]) for e in self.R["incidents"] if e["type"] in ("spin", "contact", "wall", "multi")]
        self.assertLessEqual(len(crashes), 3, crashes)



if __name__ == "__main__":
    unittest.main()
