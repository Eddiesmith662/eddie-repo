"""Race control (racecontrol.py, simchat.py, and race control's commands in server.py): the incident queue, the
steward's calls, sending them to iRacing and checking they took, clearing, and the race's saved file. Readings are
made-up races with made-up drivers; everything is saved in the throwaway data folder."""
import json
import os
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import incidents
import racecontrol as rc
import server
import simchat

SUB = 4242001          # a made-up iRacing subsession


def car(i, inc=0, black=False, dq=False, pos=None):
    return {"idx": i, "num": str(10 + i), "name": "Test Driver %s" % "ABCDEFGH"[i], "custId": str(900 + i), "inc": inc,
            "blackFlag": black, "dq": dq, "mph": 150, "onTrack": True, "progress": 10.0 + i * 0.1, "surf": 3,
            "pit": False, "pitState": None, "pos": pos or i + 1}


class Race:
    """A made-up race fed through the incident log and race control, a reading at a time."""

    def __init__(self, sub=SUB):
        self.t, self.sub, self.lap, self.flag = 100.0, sub, 10, "green"
        self.cars = [car(0), car(1), car(2)]

    def live(self, replay=False):
        self.t += 0.25
        return {"connected": True, "subId": self.sub, "track": "Test Oval", "sessNum": 2, "sessionName": "RACE",
                "isRace": True, "sessionState": 4, "flag": self.flag, "lap": self.lap, "sessTime": self.t,
                "isReplay": replay, "cars": [dict(c) for c in self.cars], "trackM": 2400}

    def step(self, n=1, replay=False):
        for _ in range(n):
            lv = self.live(replay)
            incidents.update(lv)
            rc.update(lv)
        return lv

    def set(self, i, black=None, **kw):
        if black is not None:
            kw["blackFlag"] = black
        self.cars[i].update(kw)


def fresh():
    """Race control and the incident log as if the program had just started."""
    incidents.clear()
    incidents._store = incidents._new_store()
    rc._st.clear()
    rc._st.update({"key": None, "path": None, "data": None, "ver": 0, "map": {}, "incVer": -1, "replay": False,
                   "reviewFrom": None, "lastInc": {}, "lastT": None, "lastLap": None, "catch": {}, "catchT": None})
    rc.start(lambda *a: None)


def wipe_file(sub=SUB):
    for n in os.listdir(rc.DIR) if os.path.isdir(rc.DIR) else []:
        if n.startswith(str(sub)):
            os.remove(os.path.join(rc.DIR, n))


class Base(unittest.TestCase):
    def setUp(self):
        wipe_file()
        fresh()
        self.race = Race()
        self.race.step(3)

    def call(self, kind, i=1, reason="Avoidable contact T3", value=None, incident=None, steward="Steward X"):
        d = {"cmd": "call", "kind": kind, "idx": i, "reason": reason, "value": value, "incident": incident}
        return rc.command(d, self.race.live(), steward)

    def sent(self, cid):
        ok, err, text = rc.send_prepare(cid, "Steward X", self.race.live())
        self.assertTrue(ok, err)
        rc.send_done(cid, True)
        return text

    def get(self, cid):
        return next(c for c in rc.snapshot()["calls"] if c["id"] == cid)


class Queue(Base):
    def test_contact_points_from_iracing_go_in_the_queue_to_review(self):
        self.race.set(1, inc=4)
        self.race.step()
        q = rc.snapshot()["queue"]
        self.assertEqual([(x["type"], x["num"], x["pts"], x["status"]) for x in q], [("contact", "11", 4, "new")])

    def test_iracings_own_black_flag_is_logged_not_queued_for_a_decision(self):
        self.race.set(2, black=True)
        self.race.step()
        q = rc.snapshot()["queue"]
        self.assertEqual([(x["type"], x["status"], x["auto"]) for x in q], [("penalty", "logged", True)])

    def test_points_gained_during_a_replay_come_in_after_review(self):
        # the incident log pauses during a replay: race control adds the points iRacing's results gained meanwhile
        self.race.step(2, replay=True)
        self.assertTrue(rc.snapshot()["inReplay"])
        self.race.set(0, inc=2)
        self.race.set(2, inc=4)
        self.race.lap = 13
        self.race.step(3, replay=True)
        self.race.step(3)
        q = rc.snapshot()["queue"]
        self.assertFalse(rc.snapshot()["inReplay"])
        self.assertEqual(sorted((x["num"], x["pts"], x["afterReview"], x["status"]) for x in q),
                         [("10", 2, True, "new"), ("12", 4, True, "new")])
        self.assertTrue(all(x["window"][0] < x["window"][1] for x in q))   # replay goes to where the review started

    def test_reviewing_status_and_back(self):
        self.race.set(1, inc=4)
        self.race.step()
        qid = rc.snapshot()["queue"][0]["id"]
        self.assertTrue(rc.command({"cmd": "status", "id": qid, "status": "reviewing"}, self.race.live(), "S")[0])
        self.assertEqual(rc.find(qid)["status"], "reviewing")
        self.assertFalse(rc.command({"cmd": "status", "id": qid, "status": "decided"}, self.race.live(), "S")[0])


class Calls(Base):
    def test_a_call_needs_a_steward_a_car_and_a_reason(self):
        self.assertIn("name", self.call("warning", steward="")[1])
        self.assertIn("reason", self.call("warning", reason="")[1])
        self.assertIn("car", rc.command({"cmd": "call", "kind": "warning", "reason": "x"}, self.race.live(), "S")[1].lower())
        self.assertTrue(rc.command({"cmd": "call", "kind": "noaction", "idx": 1}, self.race.live(), "S")[0])

    def test_shortest_stop_and_go_is_25_seconds(self):
        ok, err, _ = self.call("stopgo", value=20)
        self.assertFalse(ok)
        self.assertIn("25", err)
        self.assertTrue(self.call("stopgo", value=25)[0])

    def test_a_call_decides_its_incident_and_withdrawing_reopens_it(self):
        self.race.set(1, inc=4)
        self.race.step()
        qid = rc.snapshot()["queue"][0]["id"]
        cid = self.call("time", value=5, incident=qid)[2]["call"]["id"]
        self.assertEqual(rc.find(qid)["status"], "decided")
        ok, _, extra = rc.command({"cmd": "withdraw", "id": cid, "reason": "wrong car"}, self.race.live(), "Steward X")
        self.assertTrue(ok)
        self.assertEqual((self.get(cid)["status"], rc.find(qid)["status"], extra["clear"]), ("withdrawn", "reviewing", None))

    def test_no_action_marks_the_incident_no_action(self):
        self.race.set(1, inc=4)
        self.race.step()
        qid = rc.snapshot()["queue"][0]["id"]
        rc.command({"cmd": "call", "kind": "noaction", "incident": qid}, self.race.live(), "S")
        self.assertEqual(rc.find(qid)["status"], "noaction")


class SimCommands(Base):
    """What's typed into iRacing for each call (tested on a live session at Bristol, Nov 2026)."""

    def text(self, kind, value=None, reason="Avoidable contact T3"):
        return self.call(kind, value=value, reason=reason)[2]["call"]["sim"]

    def test_commands_for_each_kind_of_call(self):
        self.assertEqual(self.text("warning")["cmd"], "/#11 Race control warning: Avoidable contact T3")
        self.assertEqual(self.text("drivethrough")["cmd"], "!black #11 D Avoidable contact T3")
        self.assertEqual(self.text("eol")["cmd"], "!eol #11 Avoidable contact T3")
        self.assertEqual(self.text("dq")["cmd"], "!dq #11 Avoidable contact T3")

    def test_stop_and_go_sends_25_seconds_less(self):
        # iRacing held 55 s for "!black #87 30" and 35 s for "!black #87 10"; sending 5 gave the 30 s asked for
        self.assertEqual(self.text("stopgo", 30)["cmd"], "!black #11 5 Avoidable contact T3")
        self.assertEqual(self.text("stopgo", 25)["cmd"], "!black #11 0 Avoidable contact T3")

    def test_results_only_calls_send_nothing(self):
        for kind, value in (("time", 5), ("positions", 2), ("points", 10)):
            self.assertIsNone(self.text(kind, value))

    def test_the_reason_is_one_clean_line(self):
        self.assertEqual(self.text("drivethrough", reason="Blocking\n  twice\t on the restart")["cmd"],
                         "!black #11 D Blocking twice on the restart")
        self.assertLessEqual(len(self.text("drivethrough", reason="x" * 300)["cmd"]), simchat.MAX_LEN)


class Sending(Base):
    def test_drive_through_in_the_sim_then_served(self):
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.assertEqual(self.sent(cid), "!black #11 D Avoidable contact T3")
        self.assertEqual(self.get(cid)["sim"]["state"], "waiting")
        self.race.set(1, black=True)
        self.race.step()
        self.assertEqual(self.get(cid)["sim"]["state"], "inSim")
        self.race.step(5)
        self.race.set(1, black=False)
        self.race.lap = 12
        self.race.step()
        sim = self.get(cid)["sim"]
        self.assertEqual((sim["state"], sim["servedLap"]), ("served", 12))

    def test_no_flag_within_10_live_seconds_means_it_didnt_show(self):
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.sent(cid)
        rc._st["lastWall"] = 0           # count the next readings as a full second each
        for _ in range(12):
            rc._st["lastWall"] -= 1.0
            self.race.step()
        self.assertEqual(self.get(cid)["sim"]["state"], "notTaken")
        self.assertTrue(rc.send_prepare(cid, "S", self.race.live())[0])     # Send again is allowed

    def test_replay_time_doesnt_count_toward_the_wait(self):
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.sent(cid)
        self.race.step(80, replay=True)
        self.race.set(1, black=True)
        self.race.step()
        self.assertEqual(self.get(cid)["sim"]["state"], "inSim")

    def test_a_car_that_already_had_a_black_flag_says_sent_not_failed(self):
        # Bristol test, Nov 5 2026: #87 still had a black flag, and the new one was wrongly shown as not taken
        self.race.set(1, black=True)
        self.race.step()
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.sent(cid)
        sim = self.get(cid)["sim"]
        self.assertEqual(sim["state"], "sent")
        self.assertIn("already had a black flag", sim["note"])

    def test_sent_once_only_and_end_of_line_only_under_caution(self):
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.sent(cid)
        self.assertIn("already sent", rc.send_prepare(cid, "S", self.race.live())[1])
        eol = self.call("eol")[2]["call"]["id"]
        self.assertIn("caution", rc.send_prepare(eol, "S", self.race.live())[1])
        self.race.flag = "caution"
        self.assertTrue(rc.send_prepare(eol, "S", self.race.live())[0])

    def test_a_failed_send_can_be_sent_again(self):
        cid = self.call("drivethrough")[2]["call"]["id"]
        rc.send_prepare(cid, "S", self.race.live())
        rc.send_done(cid, False, "Couldn't find the iRacing window")
        sim = self.get(cid)["sim"]
        self.assertEqual((sim["state"], sim["error"]), ("failed", "Couldn't find the iRacing window"))
        self.assertTrue(rc.send_prepare(cid, "S", self.race.live())[0])

    def test_dq_shows_in_the_sim_from_the_dq_flag(self):
        cid = self.call("dq")[2]["call"]["id"]
        self.sent(cid)
        self.race.set(1, dq=True)
        self.race.step()
        self.assertEqual(self.get(cid)["sim"]["state"], "inSim")


class Clearing(Base):
    def test_withdrawing_a_sent_call_can_clear_it(self):
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.sent(cid)
        ok, _, extra = rc.command({"cmd": "withdraw", "id": cid, "reason": "wrong car", "clear": True}, self.race.live(), "S")
        self.assertEqual(extra["clear"], "!clear #11")
        rc.clear_done(cid, True)
        self.assertEqual(self.get(cid)["sim"]["state"], "cleared")

    def test_clear_one_car_stops_its_calls_showing_served(self):
        a = self.call("drivethrough", i=1)[2]["call"]["id"]
        b = self.call("drivethrough", i=2)[2]["call"]["id"]
        self.sent(a)
        self.sent(b)
        ok, _, text, c = rc.clear_prepare(1, "S", self.race.live())
        self.assertEqual(text, "!clear #11")
        rc.clear_log("S", c, text, True, live=self.race.live())
        self.assertEqual((self.get(a)["sim"]["state"], self.get(b)["sim"]["state"]), ("cleared", "waiting"))
        self.assertTrue(rc.send_prepare(a, "S", self.race.live())[0])      # can be sent again

    def test_clear_all_is_logged_with_who_sent_it(self):
        a = self.call("drivethrough", i=1)[2]["call"]["id"]
        self.sent(a)
        ok, _, text, c = rc.clear_prepare(None, "Steward X", self.race.live())
        rc.clear_log("Steward X", c, text, True, live=self.race.live())
        x = rc.snapshot()["clears"]
        self.assertEqual([(y["cmd"], y["by"], y["ok"]) for y in x], [("!clearall", "Steward X", True)])
        self.assertEqual(self.get(a)["sim"]["state"], "cleared")

    def test_a_dq_is_never_marked_cleared(self):
        cid = self.call("dq")[2]["call"]["id"]
        self.sent(cid)
        rc.clear_log("S", None, "!clearall", True)
        self.assertEqual(self.get(cid)["sim"]["state"], "waiting")


class SavedFile(Base):
    def path(self):
        return os.path.join(rc.DIR, "%d.json" % SUB)

    def test_every_change_is_saved_and_picked_up_after_a_restart(self):
        self.race.set(1, inc=4)
        self.race.step()
        cid = self.call("drivethrough")[2]["call"]["id"]
        self.sent(cid)
        fresh()
        Race().step()
        s = rc.snapshot()
        self.assertEqual((len(s["queue"]), [c["id"] for c in s["calls"]]), (1, [cid]))
        nxt = self.call("warning")[2]["call"]["id"]
        self.assertNotEqual(nxt, cid)            # numbering carries on

    def test_saves_go_through_the_shared_safe_save(self):
        self.call("warning")
        self.assertEqual(datafiles.load_json(self.path())["calls"][0]["kind"], "warning")
        self.assertFalse([n for n in os.listdir(rc.DIR) if n.endswith(".tmp")])

    def test_a_damaged_file_is_kept_aside_and_the_last_good_copy_used(self):
        self.call("warning")
        fresh()
        Race().step()                            # picking the race up makes the .bak
        with open(self.path(), "w") as f:
            f.write('{"queue": [')               # half-written
        fresh()
        Race().step()
        self.assertEqual([c["kind"] for c in rc.snapshot()["calls"]], ["warning"])
        self.assertTrue(any(".broken-" in n for n in os.listdir(rc.DIR)))

    def test_a_file_that_isnt_race_control_data_is_never_written_over(self):
        datafiles.write_json(self.path(), ["not", "race", "control"])
        fresh()
        Race().step()
        self.call("warning")
        self.assertEqual(datafiles.load_json(self.path()), ["not", "race", "control"])
        self.assertNotEqual(os.path.basename(rc._st["path"]), "%d.json" % SUB)

    def tearDown(self):
        wipe_file()


class ServerCommands(unittest.TestCase):
    """race_control_command in server.py with the demo race standing in for iRacing."""

    def setUp(self):
        wipe_file()
        fresh()
        self.was = (server.RC["on"], server.SOURCE)
        server.RC["on"] = True
        server.SOURCE = server.DemoSource()
        self.race = Race()
        self.race.cars = [dict(car(i), num=c["num"]) for i, c in enumerate(server.SOURCE.cars[:3])]
        lv = self.race.step()
        with server.STATE.lock:
            server.STATE.live = lv

    def tearDown(self):
        server.RC["on"], server.SOURCE = self.was
        wipe_file()

    def test_make_the_call_sends_it_in_the_same_press(self):
        server.race_control_command({"cmd": "steward", "name": "Steward X"})
        r = server.race_control_command({"cmd": "call", "kind": "drivethrough", "idx": 1, "reason": "Contact", "send": True})
        self.assertTrue(r["ok"] and r["sendOk"])
        num = self.race.cars[1]["num"]
        self.assertEqual(r["sent"], "!black #%s D Contact" % num)
        self.assertGreater(server.SOURCE.cars[1].get("blackUntil", 0), 0)      # the demo car got the black flag

    def test_clear_and_clear_all_reach_the_sim(self):
        server.race_control_command({"cmd": "steward", "name": "Steward X"})
        server.SOURCE.cars[1]["blackUntil"] = 9e12
        server.SOURCE.cars[2]["blackUntil"] = 9e12
        self.assertEqual(server.race_control_command({"cmd": "clear", "idx": 1})["sent"], "!clear #%s" % self.race.cars[1]["num"])
        self.assertEqual(server.SOURCE.cars[1]["blackUntil"], 0)
        self.assertEqual(server.race_control_command({"cmd": "clearall"})["sent"], "!clearall")
        self.assertEqual(server.SOURCE.cars[2]["blackUntil"], 0)

    def test_off_when_not_in_race_control_mode(self):
        server.RC["on"] = False
        self.assertFalse(server.race_control_command({"cmd": "clearall"})["ok"])


class OwnPortAndFolder(unittest.TestCase):
    """Race control runs beside the overlay on one PC (Nov 6 2026): its own port (8766) and its own data folder
    (data\\steward), so the two never share buttons or save over each other's settings and results."""

    def test_race_control_has_its_own_port(self):
        import instance
        self.assertEqual(instance.port_from([]), 8765)
        self.assertEqual(instance.port_from(["--race-control"]), 8766)
        self.assertEqual(instance.port_from(["--race-control", "--demo"]), 8766)
        self.assertEqual(instance.port_from(["--race-control", "--port", "9000"]), 9000)

    def run_datafiles(self, *args):
        """datafiles in a copy of the program, started the way the launchers start it."""
        import shutil
        import subprocess
        import sys
        import tempfile
        root = tempfile.mkdtemp(prefix="vspeed-rc-")
        shutil.copy(os.path.join(datafiles.ROOT, "datafiles.py"), root)
        os.makedirs(os.path.join(root, "static", "assets"))
        with open(os.path.join(root, "static", "assets", "league-logo.png"), "wb") as f:
            f.write(b"png")
        with open(os.path.join(root, "show.py"), "w") as f:
            f.write("import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n"
                    "import datafiles\nprint(datafiles.DATA)\n")
        env = {k: v for k, v in os.environ.items() if k != "VSPEED_DATA"}
        out = subprocess.run([sys.executable, "-I", os.path.join(root, "show.py")] + list(args), cwd=root, env=env,
                             capture_output=True, text=True, timeout=30)
        self.addCleanup(shutil.rmtree, root, True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return root, out.stdout.strip().splitlines()[-1]

    def test_race_control_keeps_its_files_in_data_steward(self):
        root, data = self.run_datafiles("--race-control")
        self.assertEqual(os.path.normcase(data), os.path.normcase(os.path.join(root, "data", "steward")))
        # the install's own files stay where the overlay keeps them: race control never moves them into its folder
        self.assertTrue(os.path.exists(os.path.join(root, "static", "assets", "league-logo.png")))

    def test_the_overlay_still_uses_data(self):
        root, data = self.run_datafiles()
        self.assertEqual(os.path.normcase(data), os.path.normcase(os.path.join(root, "data")))

    def test_updates_never_touch_race_controls_folder(self):
        import update
        self.assertTrue("data/steward/race-control/123.json".startswith(update.PROTECTED))

    def test_old_race_files_are_copied_across_once(self):
        import tempfile
        old, new = tempfile.mkdtemp(), os.path.join(tempfile.mkdtemp(), "race-control")
        for n in ("4242001.json", "signin.json"):
            datafiles.write_json(os.path.join(old, n), {"n": n})
        self.assertEqual(rc.copy_old_files(old, new), 2)
        self.assertEqual(datafiles.load_json(os.path.join(new, "signin.json")), {"n": "signin.json"})
        self.assertTrue(os.path.exists(os.path.join(old, "4242001.json")))    # the old folder is left as it was
        datafiles.write_json(os.path.join(old, "later.json"), {})
        self.assertEqual(rc.copy_old_files(old, new), 0)                      # only the first time


class OpensItsPage(unittest.TestCase):
    """Race control opens the Race Control page in the browser when it starts (Nov 7 2026)."""

    def test_opens_the_race_control_page_on_its_port(self):
        asked = []
        self.assertTrue(server.open_race_control_page(8766, opener=lambda url, new: asked.append((url, new)) or True))
        self.assertEqual(asked, [("http://localhost:8766/racecontrol", 2)])

    def test_no_browser_never_stops_race_control(self):
        def broken(url, new):
            raise OSError("no browser on this PC")
        self.assertFalse(server.open_race_control_page(8766, opener=broken))


class WhereTheRaceIsSaved(unittest.TestCase):
    """The line under Calls (Nov 7, 2026: it said data/race-control/..., without the steward folder)."""

    def test_inside_the_program_folder_it_says_the_whole_way_from_there(self):
        path = os.path.join(datafiles.ROOT, "data", "steward", "race-control", "12345.json")
        self.assertEqual(rc._where(path), os.path.join("data", "steward", "race-control", "12345.json"))

    def test_a_data_folder_elsewhere_is_shown_in_full(self):
        path = os.path.join(os.path.dirname(datafiles.ROOT), "somewhere-else", "race-control", "12345.json")
        self.assertEqual(rc._where(path), path)
        self.assertEqual(rc._where(None), "")


class Diagnostics(unittest.TestCase):
    """Save diagnostics on the Race Control page: race control's race files go in the zip, the sign-in token doesn't."""

    def test_the_race_files_go_in_and_the_sign_in_stays_out(self):
        import zipfile
        import diag
        wipe_file()
        fresh()
        race = Race()
        race.step(3)
        race.set(1, inc=4)
        race.step()
        signin = os.path.join(rc.DIR, "signin.json")
        datafiles.write_json(signin, {"pc": "ab12cd34", "token": "secret-token", "user": {"id": "1", "name": "Steward"}})
        try:
            zp = diag.save_zip({})
            self.assertGreaterEqual(rc.add_to_diagnostics(zp), 1)
            with zipfile.ZipFile(zp) as z:
                names = z.namelist()
                self.assertIn("race-control/%s.json" % SUB, names)
                self.assertNotIn("race-control/signin.json", names)
                self.assertFalse(any(b"secret-token" in z.read(n) for n in names))
                race_file = json.loads(z.read("race-control/%s.json" % SUB))
                self.assertTrue(race_file["queue"])
        finally:
            os.remove(signin)
            wipe_file()


if __name__ == "__main__":
    unittest.main()
