"""GLR HUB series in the overlay's Series list (Nov 2026): the list from the league site, linking a series, its
standings as the overlay's table, refresh, classes, no internet, and live points matching drivers by iRacing ID.
Stage 2: the site's scoring rules for live points, the playoff cutoff and the series logo.
Stage 3: the Next broadcast box from the site's schedule, and in the playoffs the bracket and live points' playoff mode.
The site is a stand-in (made-up series and drivers): nothing here goes on the internet."""
import copy
import datetime
import os
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import glrsite
import livepoints
import profiles
import server
import stage
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
# far in the future, so the tests don't depend on today's date: 01:00 UTC on Jan 11 is 8:00 PM Eastern on Jan 10
SCHEDULE = {"ok": True, "races": [
    {"series": "Test Sports Cars", "slug": "test-sports", "startsAt": "2099-01-09T01:00:00.000Z", "track": "Test Road Course", "notes": ""},
    {"series": "Test Trucks", "slug": "test-trucks", "startsAt": "2099-01-11T01:00:00.000Z", "track": "Test  Speedway", "notes": "Playoffs"},
    {"series": "Test Trucks", "slug": "test-trucks", "startsAt": "2099-01-18T01:00:00.000Z", "track": "Test Oval", "notes": ""}]}


def playoff_trucks(sizes=(12, 8, 4), second_round=False, champion=False):
    """The Trucks in their playoffs: 12 made-up drivers in the field (seeded in the order they made it), the rest not."""
    resp = copy.deepcopy(TRUCKS)
    field = [driver(910000 + k, "Test Playoff %s" % "ABCDEFGHIJKL"[k - 1], str(k), 300 - k, k) for k in range(1, 13)]
    for s in field:
        s["inField"] = True
    out = [dict(driver(920000 + k, "Test Other %d" % k, str(50 + k), 100 - k, 12 + k), inField=False) for k in range(1, 4)]
    names = ["Round of 12", "Round of 8", "Championship 4"]
    resp["rules"] = {"playoffs": {"enabled": True, "field": sizes[0], "rounds": [{"name": names[k], "races": 2, "drivers": n} for k, n in enumerate(sizes)]}}

    def rows(people, base, **marks):
        got = [dict(driver(s["custId"], s["name"], s["number"], base - 3 * k, k + 1), won=False, missed=False, through=True, status="")
               for k, s in enumerate(people)]
        for cust, mark in marks.items():
            next(r for r in got if r["custId"] == int(cust))[mark] = True
        return got
    # round 1 is listed in points order, not seed order: seed 5 leads it after winning a race in it, seed 9 missed one
    r1 = rows([field[4]] + field[:4] + field[5:], 1050, **{"910005": "won", "910009": "missed"})
    # season wins, as the site sends them with every row: seeds 1 and 2 won in the regular season, seed 5 only in this
    # round, and a driver who missed the playoffs won a race too
    for r in r1:
        r["wins"] = {910001: 5, 910002: 1, 910005: 1}.get(r["custId"], 0)
    out[0]["wins"] = 1
    rounds = [dict(name=names[0], races=2, drivers=sizes[0], finale=False, complete=second_round, spots=sizes[1], ran=1, rows=r1)]
    if second_round:
        r2 = rows(field[:8], 2040)
        rounds.append(dict(name=names[1], races=2, drivers=sizes[1], finale=False, complete=champion, spots=sizes[2], ran=1, rows=r2))
    if champion:
        r3 = rows(field[:4], 3000)
        r3[2]["status"] = "Champion"
        rounds.append(dict(name=names[2], races=1, drivers=sizes[2], finale=True, complete=True, ran=1, rows=r3))
    resp["groups"][0].update(regular=field + out, playoffs={"started": True, "rounds": rounds, "current": rounds[-1],
                                                            "eliminated": [], "others": out})
    return resp


TRUCKS["rules"] = {"playoffs": {k: TRUCK_RULES["playoffs"][k] for k in ("enabled", "field", "rounds")}}


class Site:
    """The stand-in for GLR HUB: answers glrsite._get from made-up data, or is 'down'."""

    def __init__(self):
        self.down = False
        self.standings = {"test-trucks": copy.deepcopy(TRUCKS), "test-sports": copy.deepcopy(SPORTS)}
        self.rules = {"test-trucks": copy.deepcopy(TRUCK_RULES), "test-sports": copy.deepcopy(SPORTS_RULES)}
        self.series = copy.deepcopy(SERIES)
        self.schedule = copy.deepcopy(SCHEDULE)
        self.logo_bytes = PNG
        self.asked, self.logos = [], []

    def get(self, path, timeout=15):
        self.asked.append(path)
        if self.down:
            raise glrsite.SiteError("Couldn't reach GLR HUB (no internet)")
        if path == "/api/series":
            return copy.deepcopy(self.series)
        if path == "/api/schedule" and self.schedule:
            return copy.deepcopy(self.schedule)
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
        self.assertEqual(server.STATE.settings["stage"], {"stage": "pre", "field": 10, "line": 0, "lineLabel": ""})
        self.assertEqual(self.lp()["cutoff"], 10)
        self.assertEqual((standings.STATE["cutoff"], standings.STATE["playoff"], standings.STATE["visible"]), (10, True, False))
        self.assertFalse(self.lp().get("playoff"), "the regular season: not a playoff round")

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


class NextRace(unittest.TestCase):
    """The Next broadcast box's text from the site's schedule, in Eastern time."""
    RACES = [{"slug": "test-trucks", "startsAt": "2026-11-16T01:00:00.000Z", "track": "Test Speedway"},
             {"slug": "test-sports", "startsAt": "2026-11-17T01:00:00.000Z", "track": "Test Road Course"},
             {"slug": "test-trucks", "startsAt": "2026-11-23T01:00:00.000Z", "track": "Test Oval"},
             {"slug": "test-trucks", "startsAt": "2027-07-04T23:30:00.000Z", "track": "Test Summer Track"}]

    def at(self, *when):
        return glrsite.next_race(self.RACES, "test-trucks", datetime.datetime(*when))

    def test_the_series_next_race_in_eastern_time(self):
        # 01:00 UTC on Monday is 8:00 PM Eastern on Sunday
        self.assertEqual(self.at(2026, 11, 10, 12), {"event": "TEST SPEEDWAY", "date": "NOV 15TH", "time": "8:00 PM ET"})

    def test_tonights_race_is_skipped_for_the_one_after(self):
        self.assertEqual(self.at(2026, 11, 15, 20)["event"], "TEST OVAL")          # five hours before the green
        self.assertEqual(self.at(2026, 11, 16, 3)["date"], "NOV 22ND")              # two hours into the race

    def test_summer_time(self):
        self.assertEqual(self.at(2027, 6, 1, 0), {"event": "TEST SUMMER TRACK", "date": "JUL 4TH", "time": "7:30 PM ET"})

    def test_nothing_scheduled(self):
        self.assertIsNone(self.at(2028, 1, 1, 0))
        self.assertIsNone(glrsite.next_race(self.RACES, "test-other", datetime.datetime(2026, 11, 1)))


class PlayoffTable(unittest.TestCase):
    def test_the_bracket_is_seeded_in_the_order_the_field_was_made(self):
        po = glrsite.to_table(playoff_trucks())["playoff"]
        self.assertEqual((po["enabled"], po["fits"], po["started"], po["name"], po["spots"]), (True, True, True, "Round of 12", 8))
        r12 = po["rounds"][0]
        self.assertEqual([e["seed"] for e in r12], list(range(1, 13)))
        self.assertEqual((r12[0]["name"], r12[0]["num"]), ("Test Playoff A", "1"))
        self.assertEqual([e["seed"] for e in r12 if e["won"]], [5])
        self.assertEqual([e["seed"] for e in r12 if e["missed"]], [9])
        self.assertEqual(po["rounds"][1:], [[], [], []])

    def test_in_the_playoffs_the_wins_are_still_the_seasons(self):
        # who is locked in during the playoffs comes from the stage and the bracket's marks (test_season_stage.py),
        # not from this column, so it can say what it says all year: the season's wins
        t = glrsite.to_table(playoff_trucks())
        wins = {r[2]: r[6] for r in t["rows"]}
        self.assertEqual((wins["Test Playoff A"], wins["Test Playoff B"], wins["Test Playoff E"], wins["Test Other 1"]), ("5", "1", "1", "1"))
        self.assertEqual((t["playoff"]["round"], t["playoff"]["field"]), (0, 12))

    def test_in_the_regular_season_the_wins_are_the_seasons(self):
        self.assertEqual([r[6] for r in glrsite.to_table(TRUCKS)["rows"]], ["2", "1", "0", "0"])

    def test_later_rounds_and_the_champion(self):
        po = glrsite.to_table(playoff_trucks(second_round=True))["playoff"]
        self.assertEqual((po["name"], po["spots"], len(po["rounds"][1])), ("Round of 8", 4, 8))
        po = glrsite.to_table(playoff_trucks(second_round=True, champion=True))["playoff"]
        self.assertEqual((po["name"], po["spots"]), ("Championship 4", None))
        self.assertEqual([len(r) for r in po["rounds"]], [12, 8, 4, 1])
        self.assertEqual(po["rounds"][3][0]["name"], "Test Playoff C")

    def test_another_playoff_format_gives_no_bracket(self):
        po = glrsite.to_table(playoff_trucks(sizes=(10, 6, 4)))["playoff"]
        self.assertEqual((po["enabled"], po["fits"], po["started"], po["spots"], po["rounds"]), (True, False, True, 6, None))

    def test_the_regular_season(self):
        resp = copy.deepcopy(TRUCKS)
        resp["rules"] = {"playoffs": {"enabled": True, "field": 12, "rounds": [{"name": "Round of 12", "drivers": 12}, {"name": "Round of 8", "drivers": 8}]}}
        po = glrsite.to_table(resp)["playoff"]
        self.assertEqual((po["enabled"], po["fits"], po["started"], po["rounds"]), (True, True, False, None))
        self.assertFalse(glrsite.to_table(SPORTS)["playoff"]["enabled"])


class PlayoffsAndNext(Linked):
    """Stage 3: the Next broadcast box and the playoffs come with the standings."""

    def lp(self):
        return server.STATE.settings["livePoints"]

    def test_the_next_broadcast_box_gets_the_series_next_race(self):
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        nr = server.STATE.settings["nextRace"]
        self.assertEqual((nr["event"], nr["date"], nr["time"], nr["title"]), ("TEST SPEEDWAY", "JAN 10TH", "8:00 PM ET", "NEXT BROADCAST"))
        self.assertEqual(nr["logo"], "glrhub-test-trucks.png")
        self.assertTrue(self.linked()["site"]["next"])

    def test_with_nothing_scheduled_the_box_is_left_alone(self):
        self.site.schedule["races"] = [r for r in self.site.schedule["races"] if r["slug"] != "test-trucks"]
        before = copy.deepcopy(server.STATE.defaults()["nextRace"])
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        nr = server.STATE.settings["nextRace"]
        self.assertEqual((nr["event"], nr["date"], nr["time"]), (before["event"], before["date"], before["time"]))
        self.assertFalse(self.linked()["site"]["next"])

    def test_in_the_playoffs_the_bracket_playoff_mode_and_round_cutoff_are_set(self):
        self.site.standings["test-trucks"] = playoff_trucks()
        ok, msg = profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertTrue(ok, msg)
        rounds = standings.bracket_snapshot()
        self.assertEqual([len(r) for r in rounds], [12, 0, 0, 0])
        self.assertEqual([e["seed"] for e in rounds[0] if e["won"]], [5])
        self.assertEqual(server.STATE.settings["stage"]["stage"], "r12")
        self.assertTrue(self.lp()["playoff"])
        self.assertEqual((self.lp()["cutoff"], standings.STATE["cutoff"], standings.STATE["playoff"]), (8, 8, True))    # 8 go through, not the field's 10
        self.assertEqual(standings.lock_names(), [{"k": "testplayoffe", "n": "5"}], "locked in on the graphic: only the round's winner")
        self.assertEqual(self.linked()["site"]["playoffs"], "Round of 12")
        self.assertEqual(standings.STATE["view"], "standings", "the graphic's view is the producer's")
        self.assertFalse(standings.STATE["visible"])

    def test_live_points_in_playoff_mode_reads_the_sites_bracket(self):
        self.site.standings["test-trucks"] = playoff_trucks()
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        live = {"connected": True, "isRace": True, "sessionState": 4, "lap": 30, "subId": 1, "track": "Test Speedway", "sessNum": 2,
                "cars": [{"num": str(k), "name": "Test Playoff %s" % "ABCDEFGHIJKL"[k - 1], "pos": k, "lapsLed": 0, "startPos": None,
                          "lapsCompleted": 20, "custId": str(910000 + k)} for k in range(1, 13)]}
        out = livepoints.compute(live, self.lp(), standings.data_snapshot(), standings.bracket_snapshot(), standings.excluded_keys())
        self.assertTrue(out["ok"], out.get("why"))
        self.assertEqual((out["title"], len(out["rows"]) <= 15, out["unmatched"]), ("ROUND OF 12", True, []))

    def test_the_regular_season_is_playoffs_ahead_and_keeps_the_bracket(self):
        mine = [[{"seed": 1, "num": "1", "name": "Test Hand Made"}], [], [], []]
        self.site.standings["test-trucks"]["rules"] = {"playoffs": {"enabled": True, "field": 12, "rounds": [{"name": "Round of 12", "drivers": 12}]}}
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        standings.set_bracket(mine)
        server.STATE.update_settings({"stage": {"stage": "r8"}})          # changed by hand: lasts until the next refresh
        stage.apply(server.STATE)
        ok, msg = profiles.command({"cmd": "siteRefresh"})
        self.assertTrue(ok, msg)
        self.assertEqual((server.STATE.settings["stage"]["stage"], server.STATE.settings["stage"]["field"]), ("pre", 12))
        self.assertFalse(self.lp()["playoff"])
        self.assertEqual(standings.bracket_snapshot()[0][0]["name"], "Test Hand Made")
        self.assertEqual(self.linked()["site"]["playoffs"], "regular")

    def test_another_playoff_format_gets_a_plain_line_and_nobody_locked_in(self):
        self.site.standings["test-trucks"] = playoff_trucks(sizes=(10, 6, 4))
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        self.assertEqual(standings.bracket_snapshot(), [[], [], [], []])
        self.assertEqual(server.STATE.settings["stage"], {"stage": "regular", "field": 12, "line": 6, "lineLabel": "PLAYOFF CUTOFF LINE"})
        self.assertFalse(self.lp().get("playoff"))
        self.assertEqual((self.lp()["cutoff"], self.lp()["lock"], standings.STATE["lock"]), (6, "none", "none"), "the line after the 6 who go through")
        self.assertEqual(self.linked()["site"]["playoffs"], "other")

    def test_a_series_without_playoffs_is_a_regular_season_with_no_line(self):
        ok, msg = profiles.command({"cmd": "link", "slug": "test-sports"})
        self.assertTrue(ok, msg)
        self.assertEqual(server.STATE.settings["stage"]["stage"], "regular")
        self.assertEqual((self.lp()["playoff"], self.lp()["lock"], self.lp()["noLine"], standings.STATE["playoff"]), (False, "none", True, False))
        # a plain line the producer adds is kept through a refresh, and so is a hand-made bracket
        standings.set_bracket([[{"seed": 1, "num": "1", "name": "Test Hand Made"}], [], [], []])
        server.STATE.update_settings({"stage": {"stage": "regular", "line": 10, "lineLabel": "Top ten award"}})
        stage.apply(server.STATE)
        profiles.command({"cmd": "siteRefresh"})
        self.assertEqual((server.STATE.settings["stage"]["line"], server.STATE.settings["stage"]["lineLabel"]), (10, "Top ten award"))
        self.assertEqual(standings.bracket_snapshot()[0][0]["name"], "Test Hand Made")

    def test_the_series_before_keeps_its_own_bracket_and_next_broadcast(self):
        before = (standings.bracket_snapshot(), copy.deepcopy(server.STATE.settings["nextRace"]))
        self.site.standings["test-trucks"] = playoff_trucks()
        profiles.command({"cmd": "link", "slug": "test-trucks"})
        profiles.command({"cmd": "switch", "id": self.home})
        self.assertEqual((standings.bracket_snapshot(), server.STATE.settings["nextRace"]), before)


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

    def test_a_name_match_does_not_take_a_row_that_is_another_drivers_by_id(self):
        # two drivers whose names match once digits are dropped ("Test Twin2", "Test Twin"): each lands on their own row
        header, rows = self.T["header"], [["1", "8", "Test Twin2", "50", "0", "0", "0", "0", "0", "1"], ["2", "9", "Test Twin", "40", "-10", "-10", "0", "0", "0", "1"]]
        live = self.live([("9", "Test Twin", 1, "900032"), ("8", "Test Twin2", 2, "900031")])
        out = livepoints.compute(live, {"cutoff": 2, "bonusLed": 0, "bonusMost": 0, "bonusPole": 0}, {"header": header, "rows": rows, "ids": {"testtwin": "900031"}})
        self.assertEqual(out["unmatched"], [])
        self.assertEqual({r["num"]: r["pts"] for r in out["rows"]}, {"8": "92", "9": "86"})

    def test_someone_elses_id_does_not_steal_a_row(self):
        # a car with no ID on the site still matches by name, as before
        out = self.rows(self.T["ids"], [("20", "Test Bravo", 1, ""), ("30", "Test Charlie", 2, "123")])
        self.assertEqual(out["unmatched"], [])


if __name__ == "__main__":
    unittest.main()
