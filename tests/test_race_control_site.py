"""Race control <-> the league site (rcsite.py, phase 5c): signing in, the race file, sending and trying again, races
the site turns down, reading the other stewards' calls back, and official results going with the sign-in. The site is
a stand-in here (no network); the real site's side is tested in glr/test/racecontrol.test.mjs."""
import json
import os
import unittest
import zipfile

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import diag
import leagueupload
import racecontrol as rc
import rcsite
import server
from test_race_control import Race, fresh, wipe_file, SUB

LEAGUE = 9310
TOKEN = "vsrc_" + "ab" * 32


class LeagueRace(Race):
    def live(self, replay=False):
        lv = super().live(replay)
        lv["leagueId"] = LEAGUE
        return lv


class Site:
    """A stand-in for the league site: answers rcsite's requests and remembers them."""

    def __init__(self):
        self.calls, self.down, self.answer, self.polls = [], False, {}, ["waiting", "ok"]
        self.decisions = []

    def __call__(self, method, path, body=None, token=None, timeout=15):
        self.calls.append((method, path, body, token))
        if self.down:
            raise OSError("no internet")
        if (method, path) in self.answer:
            return self.answer[(method, path)]
        if path == "/api/rc/link":
            return 200, {"ok": True, "code": "ABCD-EFGH", "url": "https://site/glr/rc/link?code=ABCD-EFGH", "poll": "p1", "expiresIn": 600}
        if path == "/api/rc/link/poll":
            st = self.polls.pop(0) if self.polls else "ok"
            return 200, ({"ok": True, "state": "ok", "token": TOKEN, "user": {"id": "42", "name": "Steward Discord"}}
                         if st == "ok" else {"ok": True, "state": st})
        if path == "/api/rc/check":
            return 200, {"ok": True, "user": {"id": "42", "name": "Steward Discord"}, "series": "all"}
        if path == "/api/rc/signout":
            return 200, {"ok": True}
        if path.startswith("/api/rc/races/"):
            return 200, {"ok": True, "decisions": self.decisions}
        return 404, {"ok": False, "error": "Unknown"}

    def puts(self):
        return [b for m, p, b, t in self.calls if m == "PUT"]


def reset_site():
    for f in (rcsite.SIGNIN_FILE, rcsite.OUTBOX_FILE):
        for x in (f, f + ".bak"):
            if os.path.exists(x):
                os.remove(x)
    rcsite._st.update(pc="", token="", user=None, link=None, pending=[], refused={}, fails=0, nextTry=0.0, lastRead=0.0)
    rcsite.STATUS.update(state="out", msg="", last="")


class Base(unittest.TestCase):
    def setUp(self):
        wipe_file()
        fresh()
        reset_site()
        self.site = Site()
        self.real = rcsite._request
        rcsite._request = self.site
        rcsite.start(lambda *a: None, loop=False)
        self.race = LeagueRace()
        self.race.step(3)

    def tearDown(self):
        rcsite._request = self.real
        leagueupload.TOKEN_SOURCE = None
        wipe_file()
        reset_site()

    def sign_in(self):
        ok, err, extra = rcsite.sign_in()
        self.assertTrue(ok, err)
        for _ in range(3):
            rcsite._st["link"] and rcsite._st["link"].update(next=0.0)
            rcsite._poll_link()
        self.assertEqual(rcsite.token(), TOKEN)

    def call(self, kind="drivethrough", i=1, **kw):
        d = dict({"cmd": "call", "kind": kind, "idx": i, "reason": "Avoidable contact T3"}, **kw)
        ok, err, extra = rc.command(d, self.race.live(), "Steward Discord")
        self.assertTrue(ok, err)
        return extra["call"]


class SigningIn(Base):
    def test_code_then_allow_then_token_saved_on_this_pc_only(self):
        ok, _, extra = rcsite.sign_in()
        self.assertEqual(extra["code"], "ABCD-EFGH")
        self.assertEqual(rcsite.status()["state"], "linking")
        rcsite._poll_link()                                       # still waiting for Allow
        self.assertEqual(rcsite.token(), "")
        rcsite._st["link"]["next"] = 0.0
        rcsite._poll_link()
        self.assertEqual((rcsite.token(), rcsite.user()["name"]), (TOKEN, "Steward Discord"))
        saved = datafiles.load_json(rcsite.SIGNIN_FILE)
        self.assertEqual((saved["token"], len(saved["pc"])), (TOKEN, 8))
        self.assertNotIn(TOKEN, json.dumps(server.STATE.settings))      # never in settings.json

    def test_the_pc_id_stays_the_same_after_a_restart(self):
        pc = rcsite._st["pc"]
        rcsite._load()
        self.assertEqual(rcsite._st["pc"], pc)

    def test_an_expired_code_says_so(self):
        self.site.polls = ["expired"]
        rcsite.sign_in()
        rcsite._poll_link()
        self.assertEqual((rcsite.token(), rcsite.status()["state"]), ("", "out"))
        self.assertIn("ran out", rcsite.status()["msg"])

    def test_sign_out_tells_the_site_and_forgets_the_token(self):
        self.sign_in()
        rcsite.sign_out()
        self.assertEqual(rcsite.token(), "")
        self.assertIn(("POST", "/api/rc/signout", None, TOKEN), self.site.calls)
        self.assertEqual(datafiles.load_json(rcsite.SIGNIN_FILE)["token"], "")

    def test_the_token_is_never_in_the_diagnostics_zip(self):
        self.sign_in()
        self.call()
        rcsite._send_pending()
        path = diag.save_zip(server.STATE.settings)
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                self.assertNotIn(TOKEN.encode(), z.read(n), n)


class RaceFile(Base):
    def test_what_goes_to_the_site(self):
        self.race.set(1, inc=4)
        self.race.step()
        qid = rc.snapshot()["queue"][0]["id"]
        c = self.call("stopgo", value=30, incident=qid)
        f, ver = rc.race_file(str(SUB), "pc1")
        self.assertEqual((f["type"], f["version"], f["subsessionId"], f["leagueId"], f["sessionNum"], f["sessionName"], f["pc"]),
                         ("vspeed_race_control", 1, SUB, LEAGUE, 2, "RACE", "pc1"))
        x = f["calls"][0]
        self.assertEqual((x["uid"], x["kind"], x["amount"], x["custId"], x["carNumber"], x["lap"], x["status"]),
                         ("pc1:" + c["id"], "stopgo", 30, 901, "11", 10, "active"))
        self.assertEqual(x["incident"], {"type": "contact", "points": 4})
        self.assertEqual(x["sim"], {"command": "!black #11 5 Avoidable contact T3", "state": "ready", "servedLap": None})

    def test_withdrawn_calls_carry_when_and_why(self):
        c = self.call("warning")
        rc.command({"cmd": "withdraw", "id": c["id"], "reason": "wrong car"}, self.race.live(), "S")
        x = rc.race_file(str(SUB), "pc1")[0]["calls"][0]
        self.assertEqual((x["status"], x["withdrawnReason"]), ("withdrawn", "wrong car"))
        self.assertTrue(x["withdrawnAt"])

    def test_a_call_with_no_driver_stays_on_this_pc(self):
        # a no action on a whole-field caution has no driver, and the site keys every call on one
        rc.command({"cmd": "call", "kind": "noaction", "idx": 1}, self.race.live(), "S")
        rc._st["data"]["calls"][0]["car"]["custId"] = ""
        self.assertEqual(rc.race_file(str(SUB), "pc1")[0]["calls"], [])

    def test_the_demo_race_never_goes(self):
        fresh()
        Race(sub=None).step(2)               # the demo: no iRacing session or league
        self.sign_in()
        self.call()
        rcsite._send_pending()
        self.assertEqual(self.site.puts(), [])
        self.assertEqual(rcsite.status()["waiting"], 0)


class Sending(Base):
    def test_a_new_call_sends_the_whole_race(self):
        self.sign_in()
        a = self.call("warning", i=1)
        b = self.call("drivethrough", i=2)
        rcsite._send_pending()
        put = self.site.puts()[-1]
        self.assertEqual([x["uid"].split(":")[1] for x in put["calls"]], [a["id"], b["id"]])
        self.assertEqual(self.site.calls[-1][1], "/api/rc/races/%d" % SUB)
        self.assertEqual((rcsite.status()["state"], rcsite.status()["waiting"]), ("ok", 0))

    def test_calls_made_before_signing_in_go_once_signed_in(self):
        self.call()
        rcsite._send_pending()
        self.assertEqual(self.site.puts(), [])
        self.sign_in()
        rcsite._send_pending()
        self.assertEqual(len(self.site.puts()[-1]["calls"]), 1)

    def test_served_in_the_sim_is_sent_too(self):
        self.sign_in()
        c = self.call()
        rcsite._send_pending()
        ok, _, _ = rc.send_prepare(c["id"], "S", self.race.live())
        rc.send_done(c["id"], True)
        self.race.set(1, black=True)
        self.race.step()
        rcsite._send_pending()
        self.assertEqual(self.site.puts()[-1]["calls"][0]["sim"]["state"], "inSim")

    def test_site_down_keeps_the_race_waiting_even_after_a_restart(self):
        self.sign_in()
        self.call()
        self.site.down = True
        rcsite._send_pending()
        self.assertEqual(rcsite.status()["state"], "waiting")
        self.assertIn(str(SUB), datafiles.load_json(rcsite.OUTBOX_FILE)["pending"])
        rcsite._load()                                            # the program restarts
        self.site.down = False
        rcsite._st["nextTry"] = 0.0
        rcsite._send_pending()
        self.assertEqual((len(self.site.puts()), rcsite.status()["waiting"]), (2, 0))   # the failed try, then the one that went

    def test_a_race_the_site_turns_down_is_kept_with_the_reason(self):
        self.sign_in()
        self.site.answer[("PUT", "/api/rc/races/%d" % SUB)] = (403, {"ok": False, "error": "You're not a steward for ARCA."})
        self.call()
        rcsite._send_pending()
        st = rcsite.status()
        self.assertEqual((st["state"], st["refused"]), ("refused", {str(SUB): "You're not a steward for ARCA."}))
        self.assertEqual(len(rc.snapshot()["calls"]), 1)                  # nothing lost here
        del self.site.answer[("PUT", "/api/rc/races/%d" % SUB)]
        self.call("warning", i=2)                                         # a change tries it again
        rcsite._send_pending()
        self.assertEqual(len(self.site.puts()[-1]["calls"]), 2)

    def test_busy_site_is_tried_again(self):
        self.sign_in()
        self.site.answer[("PUT", "/api/rc/races/%d" % SUB)] = (503, {})
        self.call()
        rcsite._send_pending()
        self.assertEqual((rcsite.status()["state"], rcsite.status()["waiting"]), ("waiting", 1))

    def test_a_sign_in_turned_off_on_the_site_asks_to_sign_in_again(self):
        self.sign_in()
        self.site.answer[("PUT", "/api/rc/races/%d" % SUB)] = (401, {"ok": False, "error": "Race control isn't signed in to the site."})
        self.call()
        rcsite._send_pending()
        self.assertEqual(rcsite.token(), "")
        self.assertIn("Sign in again", rcsite.status()["msg"].replace("sign in again", "Sign in again"))
        self.assertEqual(rcsite.status()["waiting"], 1)                   # still waiting for the next sign-in


class ReadingBack(Base):
    def test_other_stewards_calls_are_shown(self):
        self.sign_in()
        self.site.decisions = [{"uid": "otherpc:c1", "source": "race control", "kind": "drivethrough", "amount": 0, "custId": 902,
                                "carNumber": "12", "driverName": "Test Driver C", "madeBy": "Second Steward", "status": "active",
                                "madeAt": "2026-11-06T02:00:00Z", "reason": "Contact"}]
        rcsite._read_back()
        self.assertEqual([(x["madeBy"], x["kind"]) for x in rc.snapshot()["siteCalls"]], [("Second Steward", "drivethrough")])

    def test_a_call_withdrawn_on_the_site_is_withdrawn_here(self):
        self.sign_in()
        c = self.call("points", value=10)
        pc = rcsite._st["pc"]
        self.site.decisions = [{"uid": "%s:%s" % (pc, c["id"]), "source": "race control", "kind": "points", "amount": 10, "custId": 901,
                                "status": "withdrawn", "withdrawnOnSite": True, "withdrawnBy": "Head Steward",
                                "withdrawnReason": "Reviewed after the race", "withdrawnAt": "2026-11-06T03:00:00Z"}]
        rcsite._read_back()
        mine = rc.snapshot()["calls"][0]
        self.assertEqual((mine["status"], mine["withdrawn"]["by"], mine["withdrawn"]["reason"]),
                         ("withdrawn", "Head Steward (on the site)", "Reviewed after the race"))
        self.assertEqual(rc.snapshot()["siteCalls"], [])                  # our own calls aren't listed twice


class RealReadings(unittest.TestCase):
    """The league and session come from iRacing's own data, through the real reading code (IRacingSource.tick), not
    filled in by hand. Nov 6 2026: the live data never carried the league id, so race control's file for the site was
    never made, and on a real race night no calls would have gone; the tests above had added it by hand."""

    def run_race(self, league):
        import replay
        name = "talladega-2026-10-24-caution"

        class LeagueIR(replay.FakeIR):
            def __init__(self, meta, readings):
                super().__init__(meta, readings)
                self.static["WeekendInfo"].update(LeagueID=league, SubSessionID=77001)
        wipe_file(77001)
        fresh()
        was, real_ir = server.RC["on"], replay.FakeIR
        server.RC["on"], replay.FakeIR = True, LeagueIR      # race control reads each reading, as on a steward's PC
        try:
            for i, (_, live) in enumerate(replay.replay(name)):
                if i == 20:
                    break
        finally:
            server.RC["on"], replay.FakeIR = was, real_ir
        car = next(c for c in live["cars"] if c.get("custId"))
        ok, err, _ = rc.command({"cmd": "call", "kind": "warning", "idx": car["idx"], "reason": "Blocking"}, live, "Steward")
        self.assertTrue(ok, err)
        return live, rc.race_file("77001", "pc1")[0]

    def tearDown(self):
        wipe_file(77001)

    def test_a_league_race_makes_a_file_for_the_site(self):
        live, f = self.run_race(4242)
        self.assertEqual((live["leagueId"], live["subId"]), (4242, 77001))
        self.assertIsNotNone(f, "race control made no file for the site from real readings")
        self.assertEqual((f["leagueId"], f["subsessionId"], len(f["calls"])), (4242, 77001, 1))
        self.assertTrue(f["calls"][0]["custId"])              # the driver's iRacing id, from DriverInfo

    def test_a_session_that_isnt_a_league_race_stays_on_this_pc(self):
        live, f = self.run_race(0)                             # iRacing sends LeagueID 0 outside league sessions
        self.assertIsNone(f)


class OfficialResults(Base):
    def test_results_go_with_the_sign_in_when_there_is_no_overlay_key(self):
        leagueupload.configure({"on": False, "key": ""})
        leagueupload.TOKEN_SOURCE = rcsite.token
        self.assertEqual(leagueupload._key(), "")
        self.sign_in()
        self.assertEqual(leagueupload._key(), TOKEN)
        leagueupload.configure({"on": True, "key": "overlay-key"})
        self.assertEqual(leagueupload._key(), "overlay-key")              # the overlay key comes first
        leagueupload.configure({"on": False, "key": ""})


class ServerCommands(Base):
    def setUp(self):
        super().setUp()
        self.was = server.RC["on"]
        server.RC["on"] = True
        with server.STATE.lock:
            server.STATE.live = self.race.live()

    def tearDown(self):
        server.RC["on"] = self.was
        super().tearDown()

    def test_signed_in_calls_carry_the_discord_name(self):
        r = server.race_control_command({"cmd": "signin"})
        self.assertEqual(r["code"], "ABCD-EFGH")
        for _ in range(2):
            rcsite._st["link"]["next"] = 0.0
            rcsite._poll_link()
        self.assertFalse(server.race_control_command({"cmd": "steward", "name": "Someone Else"})["ok"])
        r = server.race_control_command({"cmd": "call", "kind": "warning", "idx": 1, "reason": "Blocking"})
        self.assertEqual(r["call"]["steward"], "Steward Discord")
        self.assertTrue(server.race_control_command({"cmd": "sitecheck"})["ok"])


if __name__ == "__main__":
    unittest.main()
