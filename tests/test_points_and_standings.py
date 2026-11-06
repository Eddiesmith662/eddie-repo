"""Live points, Add tonight's race, and the standings table and bracket. Made-up drivers only."""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import livepoints
import standings

HEADER = ["Pos", "#", "Driver", "Pts", "Wins"]
ROWS = [["1", "10", "Test Alpha", "100", "1"],
        ["2", "20", "Test Bravo", "95", "0"],
        ["3", "30", "Test Charlie", "90", "0"],
        ["4", "40", "Test Delta", "80", "0"]]


def car(num, name, pos, led=0, start=None):
    return {"num": num, "name": name, "pos": pos, "lapsLed": led, "startPos": start}


def live(cars, state=4):
    return {"connected": True, "isRace": True, "sessionState": state, "lap": 30, "subId": 1, "track": "Test Speedway",
            "sessNum": 2, "cars": cars}


STANDINGS = {"header": HEADER, "rows": ROWS}
CFG = {"cutoff": 2}


class LivePoints(unittest.TestCase):
    def row(self, out, name):
        return next(r for r in out["rows"] if r["name"] == name)

    def test_points_bonuses_and_order(self):
        cars = [car("30", "Test Charlie", 1, led=12, start=1), car("20", "Test Bravo", 2, led=3), car("10", "Test Alpha", 3)]
        out = livepoints.compute(live(cars), CFG, STANDINGS)
        self.assertTrue(out["ok"])
        # Charlie: 90 + 46 for P1 + led a lap + most laps led + pole = 139
        self.assertEqual(self.row(out, "Test Charlie")["pts"], "139")
        self.assertEqual(self.row(out, "Test Bravo")["pts"], str(95 + 42 + 1))
        self.assertEqual(self.row(out, "Test Delta")["pts"], "80")          # not racing: keeps their points

    def test_win_locks_in_and_cut_line(self):
        cars = [car("40", "Test Delta", 1), car("20", "Test Bravo", 2), car("30", "Test Charlie", 3), car("10", "Test Alpha", 4)]
        out = livepoints.compute(live(cars), CFG, STANDINGS)
        status = {r["name"]: r["status"] for r in out["rows"]}
        self.assertEqual(status["Test Alpha"], "lock")         # a win in the standings
        self.assertEqual(status["Test Delta"], "lock")         # leading tonight
        self.assertEqual(out["lineAfter"], 1)                  # cutoff 2: both spots taken by the locks

    def test_names_match_without_case_spaces_or_digits(self):
        cars = [car("99", "test ALPHA2", 1)]
        out = livepoints.compute(live(cars), CFG, STANDINGS)
        self.assertEqual(out["unmatched"], [])

    def test_driver_not_in_the_standings_starts_from_zero(self):
        cars = [car("77", "Test Newcomer", 5)]
        out = livepoints.compute(live(cars), CFG, STANDINGS)
        self.assertEqual(out["unmatched"], ["#77 Test Newcomer"])

    def test_excluded_driver_left_out(self):
        out = livepoints.compute(live([car("10", "Test Alpha", 1)]), CFG, STANDINGS, excluded={"testalpha"})
        self.assertNotIn("Test Alpha", [r["name"] for r in out["rows"]])

    def test_tonights_race_already_added_is_not_counted_twice(self):
        cars = [car("30", "Test Charlie", 1)]
        snap = dict(STANDINGS, race_added=livepoints.race_key(live(cars)))
        out = livepoints.compute(live(cars), CFG, snap)
        self.assertEqual(self.row(out, "Test Charlie")["pts"], "90")

    def test_championship_4_goes_by_finishing_order(self):
        bracket = [[], [], [{"seed": 1, "num": "10", "name": "Test Alpha"}, {"seed": 2, "num": "20", "name": "Test Bravo"}], []]
        cars = [car("20", "Test Bravo", 3), car("10", "Test Alpha", 5)]
        out = livepoints.compute(live(cars), dict(CFG, playoff=True), STANDINGS, bracket)
        self.assertEqual([r["name"] for r in out["rows"]], ["Test Bravo", "Test Alpha"])
        self.assertEqual(out["rows"][0]["cut"], "CHAMP")

    def test_no_standings_says_so(self):
        out = livepoints.compute(live([]), CFG, {"header": [], "rows": []})
        self.assertFalse(out["ok"])
        self.assertIn("No standings", out["why"])


class AddTonightsRace(unittest.TestCase):
    def test_only_after_the_checkered(self):
        with self.assertRaises(ValueError):
            livepoints.race_result(live([car("10", "Test Alpha", 1)], state=4), CFG, STANDINGS)

    def test_winner_gets_a_win_and_newcomers_are_added(self):
        cars = [car("20", "Test Bravo", 1), car("77", "Test Newcomer", 2)]
        rows, sm = livepoints.race_result(live(cars, state=5), CFG, STANDINGS)
        self.assertEqual(sm["winner"], "#20 Test Bravo")
        self.assertEqual(sm["new"], ["#77 Test Newcomer"])
        bravo = next(r for r in rows if r[2] == "Test Bravo")
        self.assertEqual((bravo[3], bravo[4]), (str(95 + 46), "1"))   # no bonuses: led no laps, didn't start on pole
        self.assertEqual(rows[0][2], "Test Bravo")               # re-sorted by points


class StandingsTable(unittest.TestCase):
    def test_parse_widget_page(self):
        page = ("<table><tr><th>Pos</th><th>Driver</th><th>Pts</th></tr><tr><td>1</td><td>Test&nbsp;Alpha</td><td>100</td></tr>"
                "<tr><td>2</td><td><a href='#'>Test Bravo</a></td><td>95</td></tr></table>")
        header, rows = standings.parse_standings(page)
        self.assertEqual(header, ["Pos", "Driver", "Pts"])
        self.assertEqual(rows, [["1", "Test Alpha", "100"], ["2", "Test Bravo", "95"]])

    def test_parse_widget_page_without_table(self):
        with self.assertRaises(ValueError):
            standings.parse_standings("<p>maintenance</p>")

    def test_csv_needs_a_driver_column(self):
        with self.assertRaises(ValueError):
            standings.parse_csv_text("Pos,Pts\n1,100\n")
        header, rows = standings.parse_csv_text("﻿Pos,Driver,Pts\n1,Test Alpha,100\n".lstrip("﻿"))
        self.assertEqual(rows, [["1", "Test Alpha", "100"]])

    def test_recalc_sorts_and_works_out_gaps(self):
        header = ["Pos", "Driver", "Pts", "To Ldr", "To Nxt"]
        rows = [["1", "A", "90", "", ""], ["2", "B", "100", "", ""], ["3", "C", "95.5", "", ""]]
        out = standings.recalc(header, rows)
        self.assertEqual([r[1] for r in out], ["B", "C", "A"])
        self.assertEqual([r[3] for r in out], ["0", "-4.5", "-10"])
        self.assertEqual([r[4] for r in out], ["0", "-4.5", "-5.5"])

    def test_excluded_drivers_leave_the_table_and_ties_share_a_place(self):
        saved = dict(standings._CFG_CACHE)
        try:
            standings._CFG_CACHE["excluded"] = ["Test Alpha"]
            rows = [["1", "10", "Test Alpha", "100", "1"], ["2", "20", "Test Bravo", "95", "0"], ["3", "30", "Test Charlie", "95", "0"]]
            out = standings.eligible_data({"header": HEADER, "rows": rows})
            self.assertEqual([(r[0], r[2]) for r in out["rows"]], [("1", "Test Bravo"), ("1", "Test Charlie")])
        finally:
            standings._CFG_CACHE.clear()
            standings._CFG_CACHE.update(saved)


class Bracket(unittest.TestCase):
    def seeds(self, n):
        return [{"seed": i, "num": str(i), "name": "Test %d" % i} for i in range(1, n + 1)]

    def test_advance_until_the_round_is_full(self):
        rounds = [self.seeds(12), [], [], []]
        for i in range(8):
            rounds, problem = standings.bracket_advance(rounds, 0, i)
            self.assertIsNone(problem)
        rounds, problem = standings.bracket_advance(rounds, 0, 8)
        self.assertIn("full", problem)

    def test_a_win_doesnt_carry_into_the_next_round(self):
        r0 = self.seeds(12)
        r0[0]["won"] = True
        rounds, _ = standings.bracket_advance([r0, [], [], []], 0, 0)
        self.assertFalse(rounds[1][0]["won"])

    def test_remove_takes_them_out_of_later_rounds(self):
        rounds = [self.seeds(12), [], [], []]
        rounds, _ = standings.bracket_advance(rounds, 0, 0)
        rounds, _ = standings.bracket_advance(rounds, 1, 0)
        rounds, _ = standings.bracket_remove(rounds, 1, 0)
        self.assertEqual((rounds[1], rounds[2]), ([], []))
        self.assertEqual(len(rounds[0]), 12)

    def test_clean_rounds_drops_bad_entries_and_duplicates(self):
        out = standings._clean_rounds([[{"seed": 1, "name": "A"}, {"seed": 1, "name": "A again"}, {"name": "no seed"}], [], [], []])
        self.assertEqual([e["name"] for e in out[0]], ["A"])


if __name__ == "__main__":
    unittest.main()
