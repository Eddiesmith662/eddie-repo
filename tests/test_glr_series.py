"""GLR HUB series in the overlay's Series list (Nov 2026): the list from the league site, linking a series, its
standings as the overlay's table, refresh, classes, no internet, and live points matching drivers by iRacing ID.
Stage 2: the site's scoring rules for live points, the playoff cutoff and the series logo.
The site is a stand-in (made-up series and drivers): nothing here goes on the internet."""
import copy
import os
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import glrsite
import livepoints
import profiles
import server
import standings


def driver(cust, name, number, points, pos, wins=0, starts=5, top5=1, top10=3):
    return {"custId": cust, "name": name, "number": number, "points": points, "pos": pos, "behind": 0, "wins": wins,
            "starts": starts, "top5": top5, "top10": top10}


TRUCKS = {"ok": True, "series": "Test Trucks", "season": {"id": 7, "name": "Season 3"}, "rules": {}, "groups": [{
    "carClass": "", "playoffs": None, "regular": [
        driver(900001, "Test Alpha", "10", 200, 1, wins=2), driver(900002, "Test Bravo", "20", 188, 2, wins=1),
        driver(900003, "Test Charlie", "30", 188, 2), driver(900004, "Test Delta", "40", 150.5, 4)]}]}
SPORTS = {"ok": True, "series": "Test Sports Cars", "season": {"id": 9, "name": "Season 1"}, "rules": {}, "groups": [
    {"carClass": "GT3", "playoffs": None, "regular": [driver(900011, "Test Echo", "11", 90, 1), driver(900012, "Test Foxtrot", "12", 70, 2)]},
    {"carClass": "GT4", "playoffs": None, "regular": [driver(900021, "Test Golf", "21", 60, 1)]}]}
SERIES = {"ok": True, "series": [
    {"id": 5001, "name": "Test Truck Series", "short_name": "Test Trucks", "slug": "test-trucks", "hidden": 0, "logo": "/theme/series-5001.png"},
    {"id": 5002, "name": "Test Sports Car Championship", "short_name": "Test Sports Cars", "slug": "test-sports", "hidden": 1, "logo": ""},
    {"id": 1000000001, "name": "Old Test Series", "short_name": "Old", "slug": "old-test", "past": True}]}


# the Trucks score from a table on the site, with playoffs; the Sports Cars take iRacing's points (no table to give)
TRUCK_RULES = {"ok": True, "series": "Test Trucks", "source": "table", "table": [40, 35, 34, 33], "others": 1, "zeroLaps": True,
               "bonus": {"win": 5, "pole": 0, "led": 1, "mostLed": 1, "fastLap": 0}, "drops": 2, "byClass": True, "ties": "share",
               "playoffs": {"enabled": True, "field": 10, "regularRaces": 8, "minStarts": 0, "winIn": True, "seedBonus": [], "winBonus": 0,
                            "rounds": [{"name": "Round of 10", "races": 2, "drivers": 10}]}}
SPORTS_RULES = {"ok": True, "series": "Test Sports Cars", "source": "iracing", "table": [], "others": 0, "zeroLaps": False,
                "bonus": {"win": 0, "pole": 0, "led": 0, "mostLed": 0, "fastLap": 0}, "playoffs": {"enabled": False, "field": 12, "rounds": []}}
PNG = b"\x89PNG\r\n\x1a\n" + b"made-up logo"


class Site:
    """The stand-in for GLR HUB: answers glrsite._get from made-up data, or is 'down'."""

    def __init__(self):
        self.down = False
        self.standings = {"test-trucks": copy.deepcopy(TRUCKS), "test-sports": copy.deepcopy(SPORTS)}
        self.rules = {"test-trucks": copy.deepcopy(TRUCK_RULES), "test-sports": copy.deepcopy(SPORTS_RULES)}
        self.series = copy.deepcopy(SERIES)
        self.logo_bytes = PNG
        self.asked, self.logos = [], []

    def get(self, path, timeout=15):
        self.asked.append(path)
        if self.down:
            raise glrsite.SiteError("Couldn't reach GLR HUB (no internet)")
        if path == "/api/series":
            return copy.deepcopy(self.series)
        if path.endswith("/points") and path.split("/")[3] in self.rules:
            return copy.deepcopy(self.rules[path.split("/")[3]])
        one = next((x for x in self.series["series"] if path == "/api/series/" + x["slug"]), None)
        if one:
            return {"ok": True, "series": copy.deepcopy(one)}
        if path.startswith("/api/standings/") and path.rsplit("/", 1)[1] in self.standings:
            return copy.deepcopy(self.standings[path.rsplit("/", 1)[1]])
        raise glrsite.SiteError("No such series")

    def logo(self, address):
        self.logos.append(address)
        if self.down:
            raise glrsite.SiteError("Couldn't download the logo (no internet)")
        return self.logo_bytes, ".png"


class Table(unittest.TestCase):
    def test_the_standings_become_the_overlays_table(self):
        t = glrsite.to_table(TRUCKS)
        self.assertEqual(t["header"][:7], ["Pos", "#", "Driver", "Pts", "To Ldr", "To Nxt", "Wins"])
        self.assertEqual(t["rows"][0][:7], ["1", "10", "Test Alpha", "200", "0", "0", "2"])
        self.assertEqual(t["rows"][1][:7], ["2", "20", "Test Bravo", "188", "-12", "-12", "1"])
        self.assertEqual(t["rows"][2][:6], ["2", "30", "Test Charlie", "188", "-12", "0"])       # level on points: the same place
        self.assertEqual(t["rows"][3][:6], ["4", "40", "Test Delta", "150.5", "-49.5", "-37.5"])
        self.assertEqual(t["ids"], {"testalpha": "900001", "testbravo": "900002", "testcharlie": "900003", "testdelta": "900004"})
        self.assertEqual((t["classes"], t["cls"], t["season"], t["playoffs"]), ([], "", "Season 3", False))

    def test_a_series_with_classes_gives_one_class_at_a_time(self):
        t = glrsite.to_table(SPORTS)
        self.assertEqual((t["classes"], t["cls"]), (["GT3", "GT4"], "GT3"))
        self.assertEqual([r[2] for r in t["rows"]], ["Test Echo", "Test Foxtrot"])
        self.assertEqual([r[2] for r in glrsite.to_table(SPORTS, "GT4")["rows"]], ["Test Golf"])

    def test_in_the_playoffs_the_drivers_still_in_come_first(self):
        resp = copy.deepcopy(TRUCKS)
        g = resp["groups"][0]
        g["playoffs"] = {"started": True, "current": {"rows": [driver(900003, "Test Charlie", "30", 3020, 1), driver(900001, "Test Alpha", "10", 3010, 2)]},
                         "eliminated": [driver(900002, "Test Bravo", "20", 2040, 3)], "others": [driver(900004, "Test Delta", "40", 150.5, 1)]}
        t = glrsite.to_table(resp)
        self.assertTrue(t["playoffs"])
        self.assertEqual([(r[0], r[2], r[3]) for r in t["rows"]],
                         [("1", "Test Charlie", "3020"), ("2", "Test Alpha", "3010"), ("3", "Test Bravo", "2040"), ("4", "Test Delta", "150.5")])

    def test_a_series_with_no_races_says_so(self):
        with self.assertRaises(glrsite.SiteError):
            glrsite.to_table({"ok": True, "series": "Test Trucks", "season": None, "groups": []})


class Linked(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real_get, cls.real_logo = glrsite._get, glrsite.fetch_logo
        server.STATE.settings["raceName"] = "TEST SERIES"
        if not standings.data_snapshot()["rows"]:
            standings.set_data(["Pos", "Driver", "Pts"], [["1", "Test A", "10"]], "csv")
        profiles.init(server.STATE)
        cls.home = profiles.summary()["active"]

    @classmethod
    def tearDownClass(cls):
        glrsite._get, glrsite.fetch_logo = cls.real_get, cls.real_logo

    def setUp(self):
        self.site = Site()
        glrsite._get, glrsite.fetch_logo = self.site.get, self.site.logo
        ok, msg = glrsite.refresh_list()
        self.assertTrue(ok, msg)

    def tearDown(self):
        glrsite._get = self.site.get
        self.site.down = False
        profiles.command({"cmd": "switch", "id": self.home})
        for p in profiles.summary()["list"]:
            if p.get("site"):
                profiles.command({"cmd": "delete", "id": p["id"]})
        with glrsite.LOCK:
            glrsite.LIST.update(series=[], at=0.0, error="")

    def linked(self, slug="test-trucks"):
        return next((p for p in profiles.summary()["list"] if (p.get("site") or {}).get("slug") == slug), None)

    def test_the_list_has_the_sites_series_but_not_past_ones(self):
        s = profiles.summary()
        self.assertEqual([(x["slug"], x["short"], x["hidden"], x["logo"]) for x in s["site"]],
                         [("test-trucks", "Test Trucks", False, "/theme/series-5001.png"), ("test-sports", "Test Sports Cars", True, "")])
        self.assertEqual(s["siteError"], "")

    def test_the_list_survives_the_site_being_down(self):
        self.site.down = True
        ok, msg = profiles.command({"cmd": "siteList"})
        self.assertFalse(ok)
        s = profiles.summary()
        self.assertEqual(len(s["site"]), 2, "the last list read stays")
        self.assertIn("reach GLR HUB", s["siteError"])

    def test_picking_a_site_series_makes_a_linked_series_with_its_standings(self):
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        p = self.linked()
        self.assertEqual((p["name"], p["site"]["name"], p["site"]["season"]), ("Test Trucks", "Test Truck Series", "Season 3"))
        self.assertEqual(profiles.summary()["active"], p["id"])
        self.assertEqual([x["slug"] for x in profiles.summary()["site"]], ["test-sports"], "a linked series isn't offered again")
        snap = standings.data_snapshot()
        self.assertEqual((snap["source"], len(snap["rows"]), snap["rows"][0][2]), ("glrhub", 4, "Test Alpha"))
        self.assertEqual(snap["ids"]["testdelta"], "900004")
        self.assertEqual(server.STATE.settings["raceName"], "TEST TRUCK SERIES")           # the ticker header
        self.assertEqual(standings.STATE["title"], "TEST TRUCK SERIES")                    # the standings graphic's title
        self.assertFalse(standings.STATE["visible"], "nothing goes on air by itself")

    def test_the_series_before_keeps_its_own_standings(self):
        before = standings.data_snapshot()
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        ok, msg = profiles.command({"cmd": "switch", "id": self.home})
        self.assertTrue(ok, msg)
        after = standings.data_snapshot()
        self.assertEqual((after["rows"], after["source"], after["ids"]), (before["rows"], before["source"], before["ids"]))

    def test_picking_it_again_brings_its_standings_up_to_date(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        profiles.command({"cmd": "switch", "id": self.home})
        self.site.standings["test-trucks"]["groups"][0]["regular"][0]["points"] = 246
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        self.assertEqual(standings.data_snapshot()["rows"][0][3], "246")
        self.assertEqual(len([p for p in profiles.summary()["list"] if p.get("site")]), 1, "no second copy of the series")

    def test_with_no_internet_a_linked_series_opens_from_its_saved_copy(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        profiles.command({"cmd": "switch", "id": self.home})
        self.site.down = True
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        self.assertIn("Couldn't refresh from GLR HUB", msg)
        snap = standings.data_snapshot()
        self.assertEqual((snap["source"], snap["rows"][0][2], snap["ids"]["testalpha"]), ("glrhub", "Test Alpha", "900001"))

    def test_with_no_internet_a_new_series_is_not_made(self):
        self.site.down = True
        before = profiles.summary()
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertFalse(ok)
        after = profiles.summary()
        self.assertEqual((after["active"], after["list"]), (before["active"], before["list"]))

    def test_refresh_asks_before_replacing_hand_edits(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        snap = standings.data_snapshot()
        rows = [list(r) for r in snap["rows"]]
        rows[0][3] = "999"
        ok, msg = standings.command("edit", {"rows": rows})
        self.assertTrue(ok, msg)
        self.assertEqual(standings.data_snapshot()["ids"]["testalpha"], "900001", "a hand edit keeps the drivers' IDs")
        ok, msg = profiles.command({"cmd": "siteRefresh"})
        self.assertFalse(ok)
        self.assertTrue(msg.startswith("CONFIRM:"), msg)
        self.assertEqual(standings.data_snapshot()["rows"][0][3], "999")
        ok, msg = profiles.command({"cmd": "siteRefresh", "force": True})
        self.assertTrue(ok, msg)
        self.assertEqual(standings.data_snapshot()["rows"][0][3], "200")

    def test_refresh_only_works_on_a_linked_series(self):
        ok, msg = profiles.command({"cmd": "siteRefresh"})
        self.assertFalse(ok)
        self.assertIn("isn't linked", msg)

    def test_a_series_with_classes_switches_class(self):
        ok, msg = profiles.command({"cmd": "link", "slug": "test-sports"})
        self.assertTrue(ok, msg)
        self.assertEqual((self.linked("test-sports")["site"]["classes"], self.linked("test-sports")["site"]["cls"]), (["GT3", "GT4"], "GT3"))
        ok, msg = profiles.command({"cmd": "siteClass", "cls": "GT4"})
        self.assertTrue(ok, msg)
        self.assertEqual(self.linked("test-sports")["site"]["cls"], "GT4")
        self.assertEqual([r[2] for r in standings.data_snapshot()["rows"]], ["Test Golf"])

    def test_a_csv_load_drops_the_site_ids(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        standings.set_data(["Pos", "Driver", "Pts"], [["1", "Test Alpha", "10"]], "csv")
        self.assertEqual(standings.data_snapshot()["ids"], {})

    def test_a_name_already_used_here_gets_a_marked_one(self):
        ok, msg = profiles.command({"cmd": "new", "name": "Test Trucks", "blank": True})
        self.assertTrue(ok, msg)
        mine = profiles.summary()["active"]
        try:
            ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
            self.assertTrue(ok, msg)
            self.assertEqual(self.linked()["name"], "Test Trucks (GLR HUB)")
        finally:
            profiles.command({"cmd": "switch", "id": self.home})
            profiles.command({"cmd": "delete", "id": mine})


class RulesAndLogo(Linked):
    """Stage 2: with the standings come the site's scoring rules, the playoff cutoff and the series logo."""

    def lp(self):
        return server.STATE.settings["livePoints"]

    def league_logo(self):
        return server.STATE.settings.get("leagueLogo")

    def test_the_sites_points_table_becomes_the_live_points_rules(self):
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        lp = self.lp()
        self.assertEqual(lp["table"][:6], [40, 35, 34, 33, 1, 1])              # past the table: the site's "others"
        self.assertEqual(len(lp["table"]), 60)
        self.assertEqual((lp["bonusWin"], lp["bonusLed"], lp["bonusMost"], lp["bonusPole"], lp["zeroLaps"], lp["others"]), (5, 1, 1, 0, True, 1))
        self.assertEqual(self.linked()["site"]["points"], "table")

    def test_the_playoff_field_sets_the_cutoff_and_nothing_goes_on_air(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertEqual(self.lp()["cutoff"], 10)
        self.assertEqual((standings.STATE["cutoff"], standings.STATE["playoff"], standings.STATE["visible"]), (10, True, False))
        self.assertFalse(self.lp().get("playoff"), "live points' playoff mode reads the bracket: left off")

    def test_a_series_on_iracing_points_keeps_the_overlays_own_table(self):
        ok, msg = profiles.command({"cmd": "link", "slug": "test-sports"})
        self.assertTrue(ok, msg)
        self.assertEqual(self.lp()["table"][:3], livepoints.DEFAULT_TABLE[:3])
        self.assertEqual(self.linked("test-sports")["site"]["points"], "iracing")
        self.assertFalse(standings.STATE["playoff"])

    def test_a_refresh_replaces_points_changed_here(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        server.STATE.update_settings({"livePoints": {"bonusWin": 99}})
        self.site.rules["test-trucks"]["bonus"]["win"] = 6
        ok, msg = profiles.command({"cmd": "siteRefresh"})
        self.assertTrue(ok, msg)
        self.assertEqual(self.lp()["bonusWin"], 6)

    def test_the_series_logo_becomes_the_standings_logo_and_the_league_logo(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertEqual(self.site.logos, ["/theme/series-5001.png"])
        cfg = standings.load_config()
        self.assertEqual(cfg["logo_name"], profiles.SITE_LOGO_NAME)
        with open(standings.logo_file(cfg), "rb") as f:
            self.assertEqual(f.read(), PNG)
        self.assertEqual(self.league_logo(), "glrhub-test-trucks.png")
        with open(os.path.join(datafiles.LOGO_DIR, "glrhub-test-trucks.png"), "rb") as f:
            self.assertEqual(f.read(), PNG)

    def test_the_logo_is_downloaded_again_only_when_the_site_changes_it(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        profiles.command({"cmd": "siteRefresh"})
        self.assertEqual(len(self.site.logos), 1)
        self.site.series["series"][0]["logo"] = "/logo/5001?v=2026-11-15"
        self.site.logo_bytes = PNG + b" 2"
        profiles.command({"cmd": "siteRefresh"})
        self.assertEqual(self.site.logos[-1], "/logo/5001?v=2026-11-15")
        with open(standings.logo_file(standings.load_config()), "rb") as f:
            self.assertEqual(f.read(), PNG + b" 2")

    def test_logos_the_producer_picked_are_left_alone(self):
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        server.STATE.update_settings({"leagueLogo": "my-league.png"})
        standings.update_config(logo_name="my-own.png")
        self.site.series["series"][0]["logo"] = "/logo/5001?v=2026-11-15"
        self.site.logo_bytes = PNG + b" 2"
        ok, msg = profiles.command({"cmd": "siteRefresh"})
        self.assertTrue(ok, msg)
        self.assertEqual(self.league_logo(), "my-league.png")
        self.assertEqual(standings.load_config()["logo_name"], "my-own.png")
        with open(standings.logo_file(standings.load_config()), "rb") as f:
            self.assertEqual(f.read(), PNG, "the producer's standings logo file isn't overwritten")

    def test_the_series_before_keeps_its_own_logo_and_points(self):
        before = (self.league_logo(), copy.deepcopy(self.lp()))
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        profiles.command({"cmd": "switch", "id": self.home})
        self.assertEqual((self.league_logo(), self.lp()), before)

    def test_a_problem_with_the_rules_or_logo_still_loads_the_standings(self):
        del self.site.rules["test-trucks"]
        self.site.series["series"][0]["logo"] = "https://elsewhere.example/logo.png"      # not an address on the site: ignored
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        self.assertIn("Points rules not read", msg)
        self.assertEqual(self.site.logos, [])
        self.assertEqual(standings.data_snapshot()["rows"][0][2], "Test Alpha")

    def test_a_fastest_lap_bonus_is_named_as_not_counted(self):
        self.site.rules["test-trucks"]["bonus"]["fastLap"] = 2
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        self.assertIn("fastest-lap bonus", msg)


class SiteScoring(unittest.TestCase):
    """Live points with GLR HUB's other rules: a win bonus, points past the end of the table, 0 laps scores nothing."""
    HEADER, ROWS = ["Pos", "#", "Driver", "Pts", "Wins"], [["1", "10", "Test Alpha", "100", "0"], ["2", "20", "Test Bravo", "90", "0"],
                                                            ["3", "30", "Test Charlie", "80", "0"]]

    def pts(self, cfg, cars):
        live = {"connected": True, "isRace": True, "sessionState": 4, "lap": 30, "subId": 1, "track": "Test Speedway", "sessNum": 2,
                "cars": [{"num": n, "name": name, "pos": pos, "lapsLed": 0, "startPos": None, "lapsCompleted": laps} for n, name, pos, laps in cars]}
        out = livepoints.compute(live, dict({"cutoff": 2, "bonusLed": 0, "bonusMost": 0, "bonusPole": 0}, **cfg), {"header": self.HEADER, "rows": self.ROWS})
        self.assertTrue(out["ok"], out.get("why"))
        return {r["name"]: r["pts"] for r in out["rows"]}

    CARS = [("10", "Test Alpha", 1, 20), ("20", "Test Bravo", 2, 20), ("30", "Test Charlie", 3, 0)]

    def test_win_bonus_and_points_past_the_table(self):
        got = self.pts({"table": [40, 35], "bonusWin": 5, "others": 2}, self.CARS)
        self.assertEqual(got, {"Test Alpha": "145", "Test Bravo": "125", "Test Charlie": "82"})

    def test_a_car_with_no_laps_scores_nothing_for_its_place(self):
        got = self.pts({"table": [40, 35, 34], "zeroLaps": True}, self.CARS)
        self.assertEqual(got["Test Charlie"], "80")
        self.assertEqual(self.pts({"table": [40, 35, 34]}, self.CARS)["Test Charlie"], "114")       # the rule off: as before

    def test_on_lap_one_nobody_has_a_lap_yet_so_everyone_scores(self):
        cars = [(n, name, pos, 0) for n, name, pos, _ in self.CARS]
        self.assertEqual(self.pts({"table": [40, 35, 34], "zeroLaps": True}, cars)["Test Charlie"], "114")

    def test_the_default_settings_score_as_before(self):
        self.assertEqual((livepoints.DEFAULTS["bonusWin"], livepoints.DEFAULTS["others"], livepoints.DEFAULTS["zeroLaps"]), (0, 0, False))


class MatchById(unittest.TestCase):
    """Live points: a driver whose iRacing name isn't the one on the site still lands on their own standings row."""
    T = glrsite.to_table(TRUCKS)

    def live(self, cars):
        return {"connected": True, "isRace": True, "sessionState": 4, "lap": 30, "subId": 1, "track": "Test Speedway", "sessNum": 2,
                "cars": [{"num": n, "name": name, "pos": pos, "lapsLed": 0, "startPos": None, "custId": cust} for n, name, pos, cust in cars]}

    def rows(self, ids, cars):
        out = livepoints.compute(self.live(cars), {"cutoff": 2}, {"header": self.T["header"], "rows": self.T["rows"], "ids": ids})
        self.assertTrue(out["ok"], out.get("why"))
        return out

    def test_matched_by_id_when_the_name_and_number_are_different(self):
        cars = [("77", "T Delta Jr", 1, "900004"), ("10", "Test Alpha", 2, "900001")]
        out = self.rows(self.T["ids"], cars)
        self.assertEqual(out["unmatched"], [])
        delta = next(r for r in out["rows"] if r["name"] == "Test Delta")
        self.assertEqual(delta["pts"], "196.5")                 # 150.5 + 46 for the win

    def test_without_ids_the_same_car_is_not_in_the_standings(self):
        out = self.rows({}, [("77", "T Delta Jr", 1, "900004"), ("10", "Test Alpha", 2, "900001")])
        self.assertEqual(out["unmatched"], ["#77 T Delta Jr"])

    def test_someone_elses_id_does_not_steal_a_row(self):
        # a car with no ID on the site still matches by name, as before
        out = self.rows(self.T["ids"], [("20", "Test Bravo", 1, ""), ("30", "Test Charlie", 2, "123")])
        self.assertEqual(out["unmatched"], [])


if __name__ == "__main__":
    unittest.main()
