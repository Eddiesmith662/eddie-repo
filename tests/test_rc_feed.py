"""Race control's calls on the broadcast (rcfeed.py): the penalty box says what race control gave. The league site is
a stand-in here; the real site's side is tested in glr/test/racecontrol.test.mjs."""
import time
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import leagueupload
import rcfeed
import server

SUB, LEAGUE = 4242001, 9310


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def call(uid, kind, num, amount=0, reason="Test reason", made=None, status="active", lap=12):
    return {"uid": uid, "source": "race control", "kind": kind, "amount": amount, "reason": reason, "custId": 900 + int(num),
            "carNumber": str(num), "driverName": "Racer %s" % num, "lap": lap, "madeAt": iso(made or time.time()),
            "status": status, "sim": None}


class Feed(unittest.TestCase):
    def setUp(self):
        self.answer = {"ok": True, "calls": []}
        self.asked = []
        self.real = (leagueupload._request, leagueupload._key)
        leagueupload._request = lambda path, key, body=None, timeout=15: (self.asked.append(path) or (200, self.answer))
        leagueupload._key = lambda: "vsglr_" + "a" * 48
        rcfeed._st.update(sub=None, want=None, calls=[], ver=0, err="")
        with server.STATE.lock:
            server.PEN.update(seq=0, list=[], prev={}, init=False, hide=0, rcShown={})
            server.STATE.live = {"cars": [{"idx": 3, "num": "7", "name": "Racer Seven", "pos": 4}], "classes": []}

    def tearDown(self):
        leagueupload._request, leagueupload._key = self.real
        rcfeed._st.update(sub=None, want=None, calls=[], ver=0, err="")

    def race(self, calls, league=LEAGUE, source="iracing"):
        self.answer = {"ok": True, "calls": calls}
        rcfeed.update({"subId": SUB, "leagueId": league, "source": source})
        return rcfeed._read()

    def test_labels_for_the_box(self):
        self.assertEqual([rcfeed.label({"kind": k, "amount": a}) for k, a in
                          [("stopgo", 30), ("drivethrough", 0), ("eol", 0), ("time", 5), ("points", 10), ("positions", 1), ("dq", 0), ("warning", 0)]],
                         ["STOP & GO 30 SEC", "DRIVE-THROUGH", "END OF LINE", "+5 SEC", "-10 PTS", "BACK 1 PLACE", "DISQUALIFIED", "WARNING"])

    def test_reads_the_race_being_shown_only_in_league_races(self):
        self.assertTrue(self.race([call("p:c1", "stopgo", 7, 30)]))
        self.assertEqual(self.asked, ["/api/overlay/calls/%d" % SUB])
        self.race([], league=None)            # not a league race: nothing read, nothing kept
        self.assertEqual(rcfeed.calls(), [])
        self.asked.clear()
        self.race([], source="demo")
        self.assertEqual(self.asked, [])

    def test_a_black_flag_gets_race_controls_penalty_and_reason(self):
        now = time.time()
        self.race([call("p:c1", "stopgo", 7, 30, "Jumped the restart", made=now - 20), call("p:c2", "drivethrough", 8, made=now - 20)])
        with server.STATE.lock:
            server.PEN["list"] = [{"id": 1, "idx": 3, "num": "7", "name": "Racer Seven", "pos": 4, "reason": "", "active": True, "t": now, "show": 0}]
            v = server.penalty_view()
        self.assertEqual((v["list"][0]["rcLabel"], v["list"][0]["rcReason"]), ("STOP & GO 30 SEC", "Jumped the restart"))

    def test_an_old_or_withdrawn_call_doesnt_match(self):
        now = time.time()
        self.race([call("p:c1", "stopgo", 7, 30, made=now - 900), call("p:c2", "drivethrough", 7, made=now - 10, status="withdrawn")])
        self.assertIsNone(rcfeed.for_black_flag("7", now))

    def test_calls_with_no_black_flag_are_listed_and_show_queues_them(self):
        now = time.time()
        self.race([call("p:c1", "time", 7, 5, "Pass under caution", made=now - 5), call("p:c2", "noaction", 8), call("p:c3", "stopgo", 9, 30)])
        with server.STATE.lock:
            rc = server.penalty_view()["rc"]
        self.assertEqual([(c["uid"], c["label"]) for c in rc], [("p:c1", "+5 SEC")])   # no "no action", no in-race penalties
        self.assertTrue(server.penalty_command({"cmd": "showrc", "uid": "p:c1"})["ok"])
        ev = server.PEN["list"][-1]
        self.assertEqual((ev["num"], ev["name"], ev["pos"], ev["rcLabel"], ev["rcReason"], ev["rcUid"], ev["fromRc"]),
                         ("7", "Racer Seven", 4, "+5 SEC", "Pass under caution", "p:c1", True))
        self.assertTrue(ev["show"])                      # on air only because Show was pressed
        self.assertFalse(server.penalty_command({"cmd": "showrc", "uid": "p:gone"})["ok"])

    def test_the_site_unreachable_keeps_the_box_working(self):
        def down(*a, **k):
            raise OSError("no internet")
        leagueupload._request = down
        rcfeed.update({"subId": SUB, "leagueId": LEAGUE, "source": "iracing"})
        self.assertFalse(rcfeed._read())
        self.assertIn("Couldn't reach", rcfeed.status()["err"])
        with server.STATE.lock:
            server.PEN["list"] = [{"id": 1, "idx": 3, "num": "7", "name": "Racer Seven", "pos": 4, "reason": "", "active": True, "t": time.time(), "show": 0}]
            self.assertNotIn("rcLabel", server.penalty_view()["list"][0])


if __name__ == "__main__":
    unittest.main()
