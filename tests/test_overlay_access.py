"""Producers sign in to use the overlay (Nov 2026, plan doc Decisions): access.py and the gate in server.py, against a
stand-in for the league site's GET /api/overlay/check (glr/OVERLAY-SIGNIN.md). Made-up people only."""
import json
import os
import shutil
import threading
import time
import unittest
import urllib.error
import urllib.request

import support  # noqa: F401  (first: throwaway data folder)
import access
import leagueupload as lu
import server

TOKEN = "vsov_" + "3" * 64
KEY = "vsglr_" + "4" * 48
PAT = {"id": "81", "name": "Producer Pat"}
GOOD = (200, {"ok": True, "name": "overlay (Producer Pat)", "user": PAT, "perms": ["overlay", "upload"]})
BLOCKED = "Your overlay access was turned off by a GLR HUB admin. Ask an admin to turn it back on."


class Site:
    """Answers check (and results) like the league site; `check` is what it says, or an exception to raise."""
    def __init__(self):
        self.check, self.results, self.calls = GOOD, (200, {"ok": True, "series": "Test"}), []

    def __call__(self, path, key, body=None, timeout=15):
        self.calls.append((path, key))
        if path == "/api/overlay/check":
            if isinstance(self.check, Exception):
                raise self.check
            return self.check
        if path == "/api/overlay/results":
            return self.results
        if path == "/api/overlay/signout":
            return 200, {"ok": True}
        return 404, {}


def signed_in_here(token=TOKEN, access_rec=None):
    """This PC signed in before (the key file), as after pressing Allow."""
    lu._stored["key"] = None
    c = lu._creds()
    c.update(token=token, user=dict(PAT), access=lu._access_from(access_rec))
    lu._save_creds()
    lu.configure({"key": lu.stored_key()})


class Access(unittest.TestCase):
    def setUp(self):
        self.real = (lu._request, lu._log, access.ON_CHANGE)
        self.site = Site()
        lu._request, lu._log = self.site, lambda m: None
        access.ON_CHANGE = None
        access.ENABLED["on"] = True
        access.STATUS.update(state="checking", msg="", user="", daysLeft=None)
        lu._stored["key"] = None
        if os.path.exists(lu.KEY_FILE):
            os.remove(lu.KEY_FILE)
        shutil.rmtree(lu.DIR, ignore_errors=True)
        lu.configure({"key": ""})
        lu.UPLOAD["allowed"] = True

    def tearDown(self):
        lu._request, lu._log, access.ON_CHANGE = self.real
        access.ENABLED["on"] = False
        lu._stored["key"] = None
        if os.path.exists(lu.KEY_FILE):
            os.remove(lu.KEY_FILE)
        shutil.rmtree(lu.DIR, ignore_errors=True)
        lu.configure({"key": ""})
        lu.UPLOAD["allowed"] = True

    def state(self):
        return access.status()["state"]

    # ------------------------------------------------------------------ the start-up check
    def test_nobody_signed_in_shows_the_sign_in(self):
        access.check()
        self.assertEqual(self.state(), "signin")
        self.assertFalse(access.allowed())
        self.assertEqual(self.site.calls, [])                          # nothing to ask the site with

    def test_a_key_alone_does_not_open_the_overlay(self):
        lu.save_key(KEY)
        lu.configure({"key": KEY})
        access.check()
        self.assertEqual(self.state(), "signin")
        self.assertEqual(lu._key(), KEY)                               # but it still sends results

    def test_a_producer_is_let_in_and_the_answer_is_kept(self):
        signed_in_here()
        access.check()
        st = access.status()
        self.assertEqual((st["state"], st["user"], st["allowed"]), ("ok", "Producer Pat", True))
        self.assertEqual(self.site.calls, [("/api/overlay/check", TOKEN)])
        lu._stored["key"] = None                                       # read back from the file
        rec = lu.access_record()
        self.assertEqual(rec["perms"], ["overlay", "upload"])
        self.assertLess(time.time() - rec["at"], 5)
        self.assertEqual(lu._key(), TOKEN)
        self.assertNotIn(TOKEN, json.dumps(access.status()))

    def test_no_overlay_permission(self):
        signed_in_here()
        self.site.check = (200, {"ok": True, "user": PAT, "perms": ["upload"]})
        access.check()
        self.assertEqual(self.state(), "denied")
        self.assertFalse(access.allowed())
        self.assertIsNone(lu.access_record())

    def test_unknown_permission_names_are_ignored(self):
        signed_in_here()
        self.site.check = (200, {"ok": True, "user": PAT, "perms": ["overlay", "upload", "schedule"]})
        access.check()
        self.assertEqual(self.state(), "ok")

    def test_overlay_but_not_upload(self):
        signed_in_here()
        self.site.check = (200, {"ok": True, "user": PAT, "perms": ["overlay"]})
        access.check()
        self.assertEqual(self.state(), "ok")
        self.assertEqual(lu._key(), "")                                # the token doesn't send results
        lu._send_all()
        self.assertEqual((lu.STATUS["state"], lu.STATUS["msg"]), ("error", lu.NO_UPLOAD))
        lu.save_key(KEY)                                               # a key saved before still does
        lu.configure({"key": KEY})
        self.assertEqual(lu._key(), KEY)

    def test_signed_out_on_the_site(self):
        signed_in_here()
        self.site.check = (401, {"ok": False, "error": "unknown token"})
        access.check()
        self.assertEqual(self.state(), "signin")
        self.assertIn("signed out", access.status()["msg"])
        self.assertIsNone(lu.signed_in())                              # forgotten here too

    def test_blocked_shows_the_site_text_as_it_is(self):
        signed_in_here(access_rec={"user": PAT, "perms": ["overlay", "upload"], "at": time.time() - 3600})
        self.site.check = (403, {"ok": False, "blocked": True, "error": BLOCKED})
        access.check()
        self.assertEqual((self.state(), access.status()["msg"]), ("blocked", BLOCKED))
        self.assertFalse(access.allowed())
        self.assertIsNone(lu.access_record())                          # no working offline on an old answer

    def test_producer_role_taken_away(self):
        signed_in_here()
        self.site.check = (403, {"ok": False, "error": "The overlay needs the Producer role."})
        access.check()
        self.assertEqual((self.state(), access.status()["msg"]), ("denied", "The overlay needs the Producer role."))
        self.assertIsNotNone(lu.signed_in())                           # signed in still: "Sign in with another account"

    # ------------------------------------------------------------------ offline: 5 days on the last good answer
    def offline_at(self, days_ago, error=OSError("no internet")):
        signed_in_here(access_rec={"user": PAT, "perms": ["overlay", "upload"], "at": time.time() - days_ago * 86400})
        self.site.check = error
        access.check()
        return access.status()

    def test_offline_on_the_last_good_answer(self):
        st = self.offline_at(1)
        self.assertEqual((st["state"], st["allowed"], st["daysLeft"]), ("offline", True, 4))
        self.assertIn("within 4 days", st["msg"])
        self.assertEqual(lu._key(), TOKEN)                             # results wait in the queue, as before

    def test_offline_last_day(self):
        st = self.offline_at(4.9)
        self.assertEqual((st["state"], st["daysLeft"]), ("offline", 1))
        self.assertIn("within 1 day.", st["msg"])

    def test_offline_for_more_than_5_days(self):
        st = self.offline_at(5.1)
        self.assertEqual(st["state"], "offline-wait")
        self.assertFalse(st["allowed"])
        self.assertIn("over 5 days", st["msg"])

    def test_site_problem_counts_as_offline(self):
        signed_in_here(access_rec={"user": PAT, "perms": ["overlay"], "at": time.time() - 86400})
        self.site.check = (503, {})
        access.check()
        self.assertEqual(self.state(), "offline")
        self.assertIn("(503)", access.status()["msg"])

    def test_offline_and_never_checked(self):
        signed_in_here()                                               # signed in for results before, never checked
        self.site.check = OSError("no internet")
        access.check()
        self.assertEqual(self.state(), "offline-wait")
        self.assertFalse(access.allowed())

    def test_an_answer_from_the_future_does_not_count(self):
        st = self.offline_at(-3)                                       # the PC's clock was wrong when it was kept
        self.assertEqual(st["state"], "offline-wait")

    def test_a_damaged_answer_does_not_count(self):
        signed_in_here()
        with open(lu.KEY_FILE, encoding="utf-8") as f:
            d = json.load(f)
        d["access"] = {"perms": ["overlay"], "at": "yesterday"}
        with open(lu.KEY_FILE, "w", encoding="utf-8") as f:           # test data folder only
            json.dump(d, f)
        lu._stored["key"] = None
        self.site.check = OSError("no internet")
        access.check()
        self.assertEqual(self.state(), "offline-wait")

    # ------------------------------------------------------------------ never during a race
    def test_the_site_saying_no_mid_race_does_not_close_the_overlay(self):
        signed_in_here()
        access.check()
        self.assertTrue(access.allowed())
        os.makedirs(lu.DIR, exist_ok=True)
        lu.datafiles.write_json(os.path.join(lu.DIR, "9-2.json"), {"subsessionId": 9, "results": []})
        self.site.results = (403, {"ok": False, "blocked": True, "error": BLOCKED})
        lu._send_all()
        self.assertEqual(lu.STATUS["msg"], BLOCKED)
        self.assertTrue(access.allowed())                              # still open until it's closed
        self.site.results = (401, {"ok": False})
        lu._send_all()
        self.assertTrue(access.allowed())
        self.assertEqual(lu.pending(), ["9-2.json"])                   # nothing lost

    def test_race_control_and_tests_are_never_gated(self):
        access.ENABLED["on"] = False
        access.STATUS["state"] = "signin"
        self.assertTrue(access.allowed())

    def test_a_check_that_crashes_does_not_leave_it_stuck(self):
        signed_in_here()
        self.site.check = ValueError("odd answer")
        lu._request = lambda *a, **k: (_ for _ in ()).throw(ValueError("odd answer"))
        access.check()
        self.assertEqual(self.state(), "offline-wait")


class Gate(unittest.TestCase):
    """The pages and commands while nobody may use the overlay, through the real HTTP handler on a free port."""
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)   # port 0: a free one, never 8765/8766
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.real = (lu._request, lu._log, access.ON_CHANGE, server.STATE)
        self.site = Site()
        lu._request, lu._log = self.site, lambda m: None
        server.STATE = server.State()
        access.ON_CHANGE = None
        access.ENABLED["on"] = True
        lu._stored["key"] = None
        if os.path.exists(lu.KEY_FILE):
            os.remove(lu.KEY_FILE)
        lu.configure({"key": ""})
        access.check()                                                 # nobody signed in

    def tearDown(self):
        lu._request, lu._log, access.ON_CHANGE, server.STATE = self.real
        access.ENABLED["on"] = False
        lu._stored["key"] = None
        if os.path.exists(lu.KEY_FILE):
            os.remove(lu.KEY_FILE)
        lu.configure({"key": ""})
        lu.UPLOAD["allowed"] = True

    def get(self, path):
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (self.port, path), timeout=5) as r:
            return r.status, r.read().decode("utf-8")

    def post(self, path, body):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_broadcast_pages_are_blank_until_signed_in(self):
        for page in ("/overlay", "/standings", "/analysis", "/team"):
            code, body = self.get(page)
            self.assertEqual(code, 200)
            self.assertIn("location.reload", body)                     # looks again by itself
            self.assertNotIn("<div", body)
        code, body = self.get("/control")
        self.assertIn('id="gate"', body)                               # the control panel shows its sign-in screen
        signed_in_here()
        access.check()
        code, body = self.get("/overlay")
        self.assertNotIn("location.reload()},5000", body)
        self.assertIn("<div", body)

    def test_commands_wait_for_the_sign_in(self):
        code, j = self.post("/api/gfx", {"cmd": "towerShow"})
        self.assertEqual((code, j["ok"]), (403, False))
        code, j = self.post("/api/settings", {"raceName": "SNEAKY"})
        self.assertEqual(code, 403)
        self.assertNotEqual(server.STATE.settings.get("raceName"), "SNEAKY")
        code, j = self.post("/api/leagueupload", {"cmd": "check"})   # the sign-in screen's own buttons work
        self.assertEqual(code, 200)
        signed_in_here()
        access.check()
        code, j = self.post("/api/settings", {"raceName": "TEST SERIES"})
        self.assertEqual((code, j["ok"]), (200, True))

    def test_try_again_does_nothing_once_the_overlay_is_open(self):
        signed_in_here()
        access.check()
        self.site.check = (403, {"ok": False, "blocked": True, "error": BLOCKED})
        code, j = self.post("/api/leagueupload", {"cmd": "check"})
        time.sleep(0.3)
        self.assertTrue(access.allowed())                              # still open: the site is asked at start-up only

    def test_the_pages_learn_the_state_but_never_the_token(self):
        signed_in_here()
        access.check()
        snap = json.loads(server.STATE.snapshot())
        self.assertEqual(snap["access"]["state"], "ok")
        self.assertTrue(snap["access"]["allowed"])
        self.assertNotIn(TOKEN, json.dumps(snap))

    def test_sign_out_closes_the_overlay(self):
        signed_in_here()
        access.check()
        self.assertTrue(access.allowed())
        code, j = self.post("/api/leagueupload", {"cmd": "signout"})
        self.assertTrue(j["ok"])
        self.assertEqual(access.status()["state"], "signin")
        self.assertFalse(access.allowed())

    def test_pressing_allow_opens_the_overlay(self):
        lu.ON_SIGNED_IN, real = server.league_upload_signed_in, lu.ON_SIGNED_IN
        try:
            signed_in_here()                                           # what the sign-in thread saves
            server.league_upload_signed_in(dict(PAT))
            end = time.time() + 3
            while time.time() < end and not access.allowed():
                time.sleep(0.02)
            self.assertTrue(access.allowed())
        finally:
            lu.ON_SIGNED_IN = real


if __name__ == "__main__":
    unittest.main()
