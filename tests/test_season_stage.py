"""The season stage (stage.py, Nov 2026): one setting per series that the standings graphic, live points and the
bracket work from, in place of five that could disagree.

Grand National, Round of 12, Nov 14, 2026: the standings graphic showed the six regular-season winners as LOCKED IN
(it locked in anyone with a win in the Wins column) while live points, in playoff mode, rightly showed none.
Made-up drivers only."""
import copy
import threading
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import livepoints
import profiles
import server
import stage
import standings

HEADER = ["Pos", "#", "Driver", "Pts", "Wins"]
# six drivers; the first two won in the regular season
ROWS = [["1", "10", "Test Alpha", "1050", "5"], ["2", "20", "Test Bravo", "1040", "1"], ["3", "30", "Test Charlie", "1030", "0"],
        ["4", "40", "Test Delta", "1020", "0"], ["5", "50", "Test Echo", "1010", "0"], ["6", "60", "Test Foxtrot", "1000", "0"]]
NAMES = [r[2] for r in ROWS]


def bracket(won=(), second=()):
    """Everyone in the Round of 12; `won` = names with the trophy mark there; `second` = names moved on to the Round of 8."""
    ent = lambda k, name: {"seed": k + 1, "num": ROWS[k][1], "name": name, "won": name in won, "missed": False}
    return [[ent(k, n) for k, n in enumerate(NAMES)], [ent(k, n) for k, n in enumerate(NAMES) if n in second], [], []]


def race(order=NAMES, state=4):
    """A race with the six running in `order`."""
    num = {r[2]: r[1] for r in ROWS}
    return {"connected": True, "isRace": True, "sessionState": state, "lap": 30, "subId": 1, "track": "Test Speedway", "sessNum": 2,
            "cars": [{"num": num[n], "name": n, "pos": k + 1, "lapsLed": 0, "startPos": None, "lapsCompleted": 20} for k, n in enumerate(order)]}


class Rules(unittest.TestCase):
    def test_each_stage(self):
        r = lambda **v: stage.rules(v)
        self.assertEqual(r(stage="regular"), {"playoff": False, "round": None, "cutoff": 0, "lock": "none", "lineLabel": "CUTOFF LINE"})
        self.assertEqual(r(stage="regular", line=10, lineLabel="Top ten award")["lineLabel"], "TOP TEN AWARD")
        self.assertEqual(r(stage="regular", line=10)["cutoff"], 10)
        self.assertEqual(r(stage="pre", field=16), {"playoff": False, "round": None, "cutoff": 16, "lock": "season", "lineLabel": "PLAYOFF CUTOFF LINE"})
        self.assertEqual((r(stage="r12")["round"], r(stage="r12")["cutoff"], r(stage="r12")["lock"]), (0, 8, "round"))
        self.assertEqual((r(stage="r8")["round"], r(stage="r8")["cutoff"], r(stage="r8")["lock"]), (1, 4, "round"))
        self.assertEqual((r(stage="c4")["round"], r(stage="c4")["cutoff"], r(stage="c4")["lock"]), (2, 4, "none"))

    def test_anything_odd_is_playoffs_ahead_top_twelve(self):
        self.assertEqual(stage.clean(None), {"stage": "pre", "field": 12, "line": 0, "lineLabel": ""})
        self.assertEqual(stage.clean({"stage": "finals", "field": "lots", "line": -4})["stage"], "pre")
        self.assertEqual(stage.clean({"stage": "regular", "line": 999})["line"], 60)

    def test_one_line_for_the_control_panel(self):
        self.assertEqual(stage.describe({"stage": "r12"}), "Round of 12 · 8 advance · a win in the round locks a driver in")
        self.assertIn("no cutoff line", stage.describe({"stage": "regular"}))


class SavedBeforeStages(unittest.TestCase):
    """A series saved before stages keeps what it showed: its stage is worked out from the settings it had."""

    def test_live_points_in_playoff_mode_is_the_latest_round_with_drivers(self):
        self.assertEqual(stage.infer({"playoff": True}, {}, bracket())["stage"], "r12")
        self.assertEqual(stage.infer({"playoff": True}, {}, bracket(second=NAMES[:4]))["stage"], "r8")
        self.assertEqual(stage.infer({"playoff": True}, {}, [[], [], [], []])["stage"], "r12")

    def test_season_mode_keeps_its_line_and_wins_still_lock_in(self):
        v = stage.infer({"playoff": False, "cutoff": 14}, {"playoff": False, "cutoff": 16}, bracket())
        self.assertEqual((v["stage"], v["field"]), ("pre", 14))
        self.assertEqual(stage.rules(v)["lock"], "season")

    def test_a_standings_cutoff_that_was_switched_on_is_the_one_kept(self):
        self.assertEqual(stage.infer({"cutoff": 12}, {"playoff": True, "cutoff": 16}, None)["field"], 16)


class LivePointsByStage(unittest.TestCase):
    DATA = {"header": HEADER, "rows": ROWS}

    def run_stage(self, v, brk=None, order=NAMES):
        r = stage.rules(v)
        cfg = {"playoff": r["playoff"], "round": r["round"], "lock": r["lock"], "noLine": r["cutoff"] == 0, "cutoff": r["cutoff"] or 12,
               "bonusLed": 0, "bonusMost": 0, "bonusPole": 0}
        return livepoints.compute(race(order), cfg, self.DATA, brk or bracket())

    def status(self, out):
        return {r["name"]: r["status"] for r in out["rows"]}

    def test_no_playoffs_no_line_and_nobody_locked_in(self):
        out = self.run_stage({"stage": "regular"})
        self.assertTrue(out["ok"], out.get("why"))
        self.assertEqual(out["lineAfter"], -1)
        self.assertEqual(set(self.status(out).values()), {"out"}, "no green rows, no IN labels")
        self.assertEqual({r["cut"] for r in out["rows"]}, {""})
        self.assertEqual(out["rows"][0]["name"], "Test Alpha", "still the championship order")

    def test_no_playoffs_with_a_plain_line(self):
        out = self.run_stage({"stage": "regular", "line": 3})
        self.assertEqual(out["lineAfter"], 2)
        self.assertEqual(list(self.status(out).values()), ["in", "in", "in", "out", "out", "out"], "a line, but a win locks nobody in")

    def test_playoffs_ahead_a_season_win_and_the_leader_are_locked_in(self):
        out = self.run_stage({"stage": "pre", "field": 3}, order=["Test Foxtrot"] + NAMES[:5])
        st = self.status(out)
        self.assertEqual((st["Test Alpha"], st["Test Bravo"], st["Test Foxtrot"]), ("lock", "lock", "lock"))
        self.assertEqual(st["Test Charlie"], "out", "three spots, three locked in")

    def test_in_a_round_regular_season_wins_do_not_lock_anyone_in(self):
        out = self.run_stage({"stage": "r12"}, order=["Test Charlie"] + [n for n in NAMES if n != "Test Charlie"])
        st = self.status(out)
        self.assertEqual(out["title"], "ROUND OF 12")
        self.assertEqual([n for n, s in st.items() if s == "lock"], ["Test Charlie"], "only the race leader; not the two regular-season winners")

    def test_in_a_round_the_trophy_mark_locks_a_driver_in(self):
        out = self.run_stage({"stage": "r12"}, bracket(won=["Test Echo"]))
        self.assertEqual(self.status(out)["Test Echo"], "lock")

    def test_the_round_is_the_stages_not_the_latest_one_with_drivers(self):
        # four drivers were moved on to the Round of 8 early: the stage still says Round of 12
        out = self.run_stage({"stage": "r12"}, bracket(second=NAMES[:4]))
        self.assertEqual((out["title"], len(out["rows"])), ("ROUND OF 12", 6))
        out = self.run_stage({"stage": "r8"}, bracket(second=NAMES[:4]))
        self.assertEqual((out["title"], len(out["rows"])), ("ROUND OF 8", 4))

    def test_a_round_with_nobody_in_it_says_what_to_do(self):
        out = self.run_stage({"stage": "r8"}, bracket())
        self.assertFalse(out["ok"])
        self.assertIn("Round Of 8", out["why"])
        out = self.run_stage({"stage": "r12"}, [[], [], [], []])
        self.assertIn("bracket is empty", out["why"])

    def test_before_stages_playoff_mode_still_finds_its_round(self):
        out = livepoints.compute(race(), {"playoff": True, "cutoff": 12}, self.DATA, bracket(second=NAMES[:4]))
        self.assertEqual(out["title"], "ROUND OF 8")


class Applied(unittest.TestCase):
    """The stage pushed into what the graphics read, and saved with the series."""

    @classmethod
    def setUpClass(cls):
        server.STATE.settings["raceName"] = "TEST SERIES"
        if not standings.data_snapshot()["rows"]:
            standings.set_data(["Pos", "Driver", "Pts"], [["1", "Test A", "10"]], "csv")
        profiles.init(server.STATE)
        cls.home = profiles.summary()["active"]

    def setUp(self):
        self.was = (copy.deepcopy(server.STATE.settings.get("stage")), copy.deepcopy(server.STATE.settings.get("livePoints")),
                    standings.bracket_snapshot(), {k: standings.STATE.get(k) for k in ("playoff", "cutoff", "lock", "lockRound", "lineLabel", "hasLine")})

    def tearDown(self):
        profiles.command({"cmd": "switch", "id": self.home})
        for p in profiles.summary()["list"]:
            if p["name"].startswith("Stage Test"):
                profiles.command({"cmd": "delete", "id": p["id"]})
        with server.STATE.lock:
            server.STATE.settings["stage"], server.STATE.settings["livePoints"] = self.was[0], self.was[1]
        standings.set_bracket(self.was[2], save=False)
        standings.set_state(**self.was[3])

    def set_stage(self, **v):
        server.STATE.update_settings({"stage": stage.clean(v)})        # the whole stage, as the control panel sends it
        return stage.apply(server.STATE)

    def lp(self):
        return server.STATE.settings["livePoints"]

    def test_a_round_sets_live_points_and_the_standings_graphic_together(self):
        self.set_stage(stage="r12")
        self.assertEqual((self.lp()["playoff"], self.lp()["round"], self.lp()["cutoff"], self.lp()["lock"], self.lp()["noLine"]), (True, 0, 8, "round", False))
        self.assertEqual((standings.STATE["cutoff"], standings.STATE["lock"], standings.STATE["lockRound"], standings.STATE["hasLine"]), (8, "round", 0, True))
        self.set_stage(stage="r8")
        self.assertEqual((self.lp()["round"], self.lp()["cutoff"], standings.STATE["cutoff"], standings.STATE["lockRound"]), (1, 4, 4, 1))

    def test_playoffs_ahead_uses_the_field_for_both(self):
        self.set_stage(stage="pre", field=16)
        self.assertEqual((self.lp()["playoff"], self.lp()["cutoff"], self.lp()["lock"], standings.STATE["cutoff"], standings.STATE["lock"]),
                         (False, 16, "season", 16, "season"))

    def test_the_standings_graphic_shows_the_top_twenty_so_its_line_stops_there(self):
        self.set_stage(stage="pre", field=30)
        self.assertEqual((self.lp()["cutoff"], standings.STATE["cutoff"]), (30, 20))

    def test_no_playoffs_switches_the_cutoff_picture_off_and_it_cannot_be_switched_on(self):
        standings.set_state(playoff=True)
        self.set_stage(stage="regular")
        self.assertEqual((standings.STATE["playoff"], standings.STATE["hasLine"], standings.STATE["lock"], self.lp()["noLine"]), (False, False, "none", True))
        ok, msg = standings.command("playoff", {})
        self.assertFalse(ok)
        self.assertIn("Season stage", msg)
        self.assertFalse(standings.STATE["playoff"])

    def test_a_plain_line_can_be_shown_with_its_own_words(self):
        self.set_stage(stage="regular", line=10, lineLabel="Top ten award")
        self.assertEqual((standings.STATE["cutoff"], standings.STATE["lineLabel"], standings.STATE["lock"]), (10, "TOP TEN AWARD", "none"))
        ok, msg = standings.command("playoff", {})
        self.assertTrue(ok, msg)
        self.assertTrue(standings.STATE["playoff"])

    def test_the_graphic_is_told_who_won_in_the_round_and_nobody_else(self):
        standings.set_bracket(bracket(won=["Test Echo"]), save=False)
        self.set_stage(stage="r12")
        self.assertEqual(standings.lock_names(), [{"k": "testecho", "n": "50"}])
        self.assertEqual(standings.summary()["state"]["lockNames"], [{"k": "testecho", "n": "50"}])
        self.set_stage(stage="r8")
        self.assertEqual(standings.lock_names(), [], "a win only counts in its own round")
        self.set_stage(stage="pre")
        self.assertEqual(standings.lock_names(), [], "playoffs ahead: the graphic goes by the Wins column")

    def test_the_stage_is_saved_with_the_series(self):
        self.set_stage(stage="r8")
        ok, msg = profiles.command({"cmd": "new", "name": "Stage Test Two", "blank": True})
        self.assertTrue(ok, msg)
        self.assertEqual(server.STATE.settings["stage"]["stage"], "pre", "a new empty series: playoffs ahead, top 12")
        self.set_stage(stage="regular", line=5)
        profiles.command({"cmd": "switch", "id": self.home})
        self.assertEqual((server.STATE.settings["stage"]["stage"], self.lp()["round"], standings.STATE["cutoff"]), ("r8", 1, 4))
        other = next(p["id"] for p in profiles.summary()["list"] if p["name"] == "Stage Test Two")
        profiles.command({"cmd": "switch", "id": other})
        self.assertEqual((server.STATE.settings["stage"]["stage"], server.STATE.settings["stage"]["line"], self.lp()["noLine"]), ("regular", 5, False))

    def test_a_series_saved_before_stages_keeps_what_it_showed(self):
        ok, msg = profiles.command({"cmd": "new", "name": "Stage Test Old", "blank": True})
        self.assertTrue(ok, msg)
        old = profiles.summary()["active"]
        # as an older overlay left it: playoff mode with four drivers in the Round of 8, and no stage
        standings.set_bracket(bracket(second=NAMES[:4]))
        server.STATE.update_settings({"livePoints": {"playoff": True, "cutoff": 12}})
        profiles.command({"cmd": "switch", "id": self.home})
        path = profiles.os.path.join(profiles._pdir(old), "settings.json")
        saved = profiles._read(path, {})
        del saved["settings"]["stage"]
        for k in ("round", "lock", "noLine"):
            saved["settings"]["livePoints"].pop(k, None)
        profiles._write(path, saved)
        profiles.command({"cmd": "switch", "id": old})
        self.assertEqual(server.STATE.settings["stage"]["stage"], "r8")
        self.assertEqual((self.lp()["playoff"], self.lp()["round"], self.lp()["cutoff"]), (True, 1, 4))


@unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "Playwright isn't installed here")
class StandingsGraphic(unittest.TestCase):
    """The standings graphic in a browser: who it marks LOCKED IN in each stage."""

    @classmethod
    def setUpClass(cls):
        cls.was = (standings.data_snapshot(), standings.bracket_snapshot(), copy.deepcopy(server.STATE.settings.get("stage")),
                   copy.deepcopy(server.STATE.settings.get("livePoints")),
                   {k: standings.STATE.get(k) for k in ("playoff", "cutoff", "lock", "lockRound", "lineLabel", "hasLine", "visible", "view")})
        standings.set_data(HEADER, ROWS, "csv", save=False)
        cls.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)   # port 0: a free one, never 8765/8766
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.page = cls.browser.new_page(viewport={"width": 1920, "height": 1080})

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        d = cls.was[0]
        standings.set_data(d["header"], d["rows"], d["source"], d["pulled_at"], d["edited_at"], save=False, race_added=d["race_added"], ids=d["ids"])
        standings.set_bracket(cls.was[1], save=False)
        with server.STATE.lock:
            server.STATE.settings["stage"], server.STATE.settings["livePoints"] = cls.was[2], cls.was[3]
        standings.set_state(**cls.was[4])

    def show(self, brk, **v):
        """Set the stage and bracket, switch the cutoff picture on, and read the graphic: {driver: text in the gap column}."""
        standings.set_bracket(brk, save=False)
        server.STATE.update_settings({"stage": stage.clean(v)})        # the whole stage, as the control panel sends it
        r = stage.rules(stage.apply(server.STATE))
        standings.set_state(playoff=r["cutoff"] > 0, visible=True, view="standings")
        self.page.goto("http://127.0.0.1:%d/standings" % self.port)
        self.page.wait_for_function("document.querySelectorAll('.row').length >= 6", timeout=8000)
        want = "true" if r["cutoff"] > 0 else "false"
        self.page.wait_for_function("document.getElementById('panel').classList.contains('playoff') === %s" % want, timeout=8000)
        self.page.wait_for_timeout(300)
        return self.page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.row')].map(r =>
            [r.querySelector('.name').textContent, r.querySelector('.gap').textContent]))""")

    def locked(self, gaps):
        return sorted(n for n, t in gaps.items() if t == "LOCKED IN")

    def test_playoffs_ahead_season_winners_are_locked_in(self):
        self.assertEqual(self.locked(self.show(bracket(), stage="pre", field=4)), ["Test Alpha", "Test Bravo"])

    def test_in_a_round_regular_season_winners_are_not_locked_in(self):
        # the Grand National on Nov 14, 2026: six regular-season winners showed as LOCKED IN in the Round of 12
        self.assertEqual(self.locked(self.show(bracket(), stage="r12")), [])

    def test_in_a_round_a_win_in_the_round_locks_a_driver_in(self):
        gaps = self.show(bracket(won=["Test Echo"]), stage="r12")
        self.assertEqual(self.locked(gaps), ["Test Echo"])
        first = self.page.evaluate("document.querySelector('#rowsL .row .name').textContent")
        self.assertEqual(first, "Test Echo", "the locked-in driver goes to the top")

    def test_a_plain_line_locks_nobody_in_and_carries_its_own_words(self):
        gaps = self.show(bracket(won=["Test Echo"]), stage="regular", line=3, lineLabel="Top three award")
        self.assertEqual(self.locked(gaps), [])
        label = self.page.evaluate("document.querySelector('.row.cutoff-after .cutlabel').textContent")
        self.assertEqual(label, "TOP THREE AWARD")
        after = self.page.evaluate("document.querySelector('.row.cutoff-after .name').textContent")
        self.assertEqual(after, "Test Charlie")

    def test_no_playoffs_the_plain_standings(self):
        gaps = self.show(bracket(), stage="regular")
        self.assertEqual(self.locked(gaps), [])
        self.assertFalse(self.page.evaluate("document.getElementById('panel').classList.contains('playoff')"))


if __name__ == "__main__":
    unittest.main()
