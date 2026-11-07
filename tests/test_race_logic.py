"""The race logic in server.py, one function at a time, with the real-race cases its comments describe."""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import server
from server import race_flags, pit_timer, tow_fix, compute_gaps, fmt_lap, fmt_clock, track_meters, flag_from_bits

CAUTION = server.FLAG_CAUTION


class RaceFlags(unittest.TestCase):
    KEYS = {"flag", "overtime", "finalLap", "otAttempts", "otLimit"}

    def test_every_key_is_there_outside_races(self):
        # v1.5.12-1.5.13: practice and qualifying failed every reading with KeyError('otAttempts')
        for is_race, total in ((False, 0), (False, 10), (True, 0)):
            self.assertEqual(set(race_flags({}, is_race, 4, 0, 3.5, total)), self.KEYS)

    def test_racing_with_no_flag_bits_is_green(self):
        self.assertEqual(race_flags({}, True, 4, 0, 10.2, 50)["flag"], "green")

    def test_pace_laps_before_the_start(self):
        # iRacing sets one-to-green and green-held during the pace laps (SessionState 3): shown as PACE LAP, not green
        bits = server.FLAG_ONE_TO_GREEN | server.FLAG_GREEN_HELD
        self.assertEqual(race_flags({}, True, 3, bits, 0.5, 50)["flag"], "pace")

    def test_white_flag_from_the_leaders_lap(self):
        # while spectating iRacing never sent the white bit (Talladega, Oct 24)
        self.assertEqual(race_flags({}, True, 4, 0, 49.9, 50)["flag"], "green")
        self.assertEqual(race_flags({}, True, 4, 0, 50.1, 50)["flag"], "white")

    def test_checkered_after_the_finish(self):
        self.assertEqual(race_flags({}, True, 5, 0, 50.3, 50)["flag"], "checkered")

    def test_caution_with_one_lap_to_go_means_overtime(self):
        # Nashville, Oct 26: 82 laps; under yellow that late the restart can't come before the last lap
        self.assertTrue(race_flags({}, True, 4, CAUTION, 81.4, 82)["overtime"])
        self.assertFalse(race_flags({}, True, 4, CAUTION, 79.4, 82)["overtime"])

    def test_restart_in_overtime_sets_the_final_lap(self):
        store = {}
        race_flags(store, True, 4, 0, 48.0, 50)                   # watched from before the scheduled finish
        race_flags(store, True, 4, CAUTION, 49.5, 50)             # caution
        out = race_flags(store, True, 4, 0, 52.3, 50)             # green 30% into lap 52: the green lap is 53
        self.assertEqual((out["finalLap"], out["overtime"], out["otAttempts"]), (54, True, 1))

    def test_flag_bits(self):
        self.assertEqual(flag_from_bits(server.FLAG_CHECKERED | CAUTION), "checkered")
        self.assertEqual(flag_from_bits(server.FLAG_RED), "red")
        self.assertEqual(flag_from_bits(server.FLAG_CAUTION_WAVING), "caution")
        self.assertEqual(flag_from_bits(0), "")


class PitTimer(unittest.TestCase):
    def test_a_normal_stop(self):
        st = {}
        self.assertEqual(pit_timer(st, 1, 0.0, True, False, laps=10), ("road", None))
        pit_timer(st, 1, 10.0, True, True, laps=10)
        self.assertEqual(pit_timer(st, 1, 15.0, True, True, laps=10), ("stall", 5.0))
        self.assertEqual(pit_timer(st, 1, 18.0, True, False, laps=10), ("done", 8.0))
        self.assertEqual(st[1]["stops"], 1)
        self.assertEqual(pit_timer(st, 1, 30.0, False, False, laps=10), (None, None))   # gone after PIT_SHOW_AFTER
        self.assertEqual(st[1]["lastStop"], 8.0)

    def test_rolling_over_the_box_is_not_a_stop(self):
        st = {}
        pit_timer(st, 1, 10.0, True, True)
        pit_timer(st, 1, 11.0, True, False)
        self.assertEqual(st[1].get("stops", 0), 0)
        self.assertIsNone(st[1]["lastStop"])

    def test_a_parked_car_is_hidden(self):
        # Nashville, Oct 26: #69 sat in the stall for 25 minutes and live timing showed 1506.7s
        st = {}
        pit_timer(st, 1, 0.0, True, True)
        self.assertEqual(pit_timer(st, 1, 60.0, True, True), (None, None))
        self.assertEqual(pit_timer(st, 1, 1500.0, True, True), (None, None))
        pit_timer(st, 1, 1501.0, False, False)
        self.assertIsNone(st[1]["lastStop"])                     # too long to be a stop

    def test_not_counted_during_a_replay(self):
        st = {}
        pit_timer(st, 1, 10.0, True, True, count=False)
        pit_timer(st, 1, 15.0, True, True, count=False)
        self.assertEqual(st[1].get("stops", 0), 0)


class TowFix(unittest.TestCase):
    def test_a_towed_car_keeps_where_it_stopped(self):
        # Talladega, Oct 25: #3 crashed at 23.53 laps and reappeared in his stall at 23.95, ahead of the leader
        st = {}
        self.assertEqual(tow_fix(st, 3, 23.50, 3, log=False), 23.50)
        self.assertEqual(tow_fix(st, 3, 23.53, 3, log=False), 23.53)
        self.assertIsNone(tow_fix(st, 3, None, -1, log=False))       # being towed
        self.assertEqual(tow_fix(st, 3, 23.95, 1, log=False), 23.53)  # in the stall
        self.assertEqual(tow_fix(st, 3, 24.10, 3, log=False), 24.10)  # drove off: real position again

    def test_a_car_driving_into_its_stall_is_not_held(self):
        st = {}
        tow_fix(st, 5, 10.90, 3, log=False)
        self.assertEqual(tow_fix(st, 5, 10.92, 1, log=False), 10.92)


class Gaps(unittest.TestCase):
    def cars(self, *progress):
        return [{"progress": p, "best": 50.0, "last": 51.0, "est": 50.0} for p in progress]

    def test_race_gaps(self):
        cars = self.cars(10.5, 10.4, 9.3)
        compute_gaps(cars, True, True)
        self.assertEqual([c["gap"] for c in cars], ["LEADER", "+5.0", "-1 LAP"])
        self.assertEqual(cars[1]["interval"], "+5.0")
        self.assertEqual(cars[2]["lapsDown"], 1)

    def test_never_negative(self):
        # after the checkered a car can be a few metres ahead of the one listed above it (Oct 25: "+-0.1")
        cars = self.cars(10.5, 10.6)
        compute_gaps(cars, True, True)
        self.assertEqual(cars[1]["gap"], "+0.0")

    def test_qualifying_gaps_from_best_laps(self):
        cars = [{"best": 50.0}, {"best": 50.25}, {"best": 0}]
        compute_gaps(cars, False, True)
        self.assertEqual([c["gap"] for c in cars], ["50.000", "+0.250", "NO TIME"])


class StartingPositions(unittest.TestCase):
    """add_extras: where each car started, overall and within its class (driver info shows the class one in a
    multi-class race, next to the class place)."""
    def cars(self):
        # grid: 1 GTP, 2 GT3, 3 GTP, 4 GT3, 5 GT3; running order now: 4, 1, 2, 5, 3
        cls = {1: "GTP", 2: "GT3", 3: "GTP", 4: "GT3", 5: "GT3"}
        now = [4, 1, 2, 5, 3]
        per = {}
        out = []
        for pos, idx in enumerate(now, 1):
            per[cls[idx]] = per.get(cls[idx], 0) + 1
            out.append({"idx": idx, "cls": cls[idx], "pos": pos, "classPos": per[cls[idx]], "progress": None})
        return out

    def test_overall_and_class_start(self):
        cars = self.cars()
        server.add_extras(cars, True, [1, 2, 3, 4, 5], {}, {}, 0.0, 0.0)
        by = {c["idx"]: c for c in cars}
        self.assertEqual([by[i]["startPos"] for i in (1, 2, 3, 4, 5)], [1, 2, 3, 4, 5])
        self.assertEqual([by[i]["classStartPos"] for i in (1, 2, 3, 4, 5)], [1, 1, 2, 2, 3])
        self.assertEqual(by[4]["classGained"], 1)                  # started 2nd in GT3, 1st in GT3 now

    def test_not_in_practice_or_qualifying(self):
        cars = self.cars()
        server.add_extras(cars, False, [1, 2, 3, 4, 5], {}, {}, 0.0, 0.0)
        self.assertTrue(all(c["startPos"] is None and c["classStartPos"] is None for c in cars))

    def test_car_not_on_the_grid(self):
        cars = self.cars()
        server.add_extras(cars, True, [1, 2, 3, 4], {}, {}, 0.0, 0.0)   # car 5 joined late
        c5 = next(c for c in cars if c["idx"] == 5)
        self.assertEqual((c5["startPos"], c5["classStartPos"]), (None, None))


class Formatting(unittest.TestCase):
    def test_fmt_lap(self):
        self.assertEqual(fmt_lap(83.456), "1:23.456")
        self.assertEqual(fmt_lap(29.5), "29.500")
        self.assertEqual(fmt_lap(0), "")
        self.assertEqual(fmt_lap(-1), "")

    def test_fmt_clock(self):
        self.assertEqual(fmt_clock(3725), "1:02:05")
        self.assertEqual(fmt_clock(65), "1:05")
        self.assertEqual(fmt_clock(None), "")

    def test_track_meters(self):
        self.assertAlmostEqual(track_meters("2.66 mi"), 4280.85, places=1)
        self.assertAlmostEqual(track_meters("4.02 km"), 4020.0)
        self.assertEqual(track_meters(""), 0.0)


if __name__ == "__main__":
    unittest.main()
