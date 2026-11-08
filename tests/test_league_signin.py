"""Sign in with Discord (glr/OVERLAY-SIGNIN.md): the overlay's side, against a stand-in for the league site.
(Checked end to end against a local copy of the real site code too; that needs Node, so it isn't part of these tests.)"""
import json
import os
import shutil
import threading
import time
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import leagueupload as lu
import server

TOKEN = "vsov_" + "1" * 64
KEY = "vsglr_" + "2" * 48


class Site:
    """Answers like the league site: link, poll (waiting until allowed), check, results, signout; can refuse."""
    def __init__(self):
        self.allowed, self.answer, self.calls, self.signed_out = False, {}, [], False

    def __call__(self, path, key, body=None, timeout=15):
        self.calls.append((path, key))
        if path in self.answer:
            return self.answer[path]
        if path == "/api/overlay/link":
            return 200, {"ok": True, "code": "ABCD-EFGH", "url": "https://glrhub.app/overlay/link?code=ABCD-EFGH", "poll": "p", "expiresIn": 600}
        if path == "/api/overlay/link/poll":
            if not self.allowed:
                return 200, {"ok": True, "state": "waiting"}
            self.allowed = False
            return 200, {"ok": True, "state": "ok", "token": TOKEN, "user": {"id": "80", "name": "Producer Pat"}}
        if path == "/api/overlay/signout":
            self.signed_out = True
            return 200, {"ok": True}
        if path == "/api/overlay/check":
            return 200, {"ok": True, "name": "overlay (Producer Pat)", "user": {"id": "80", "name": "Producer Pat"}}
        if path == "/api/overlay/results":
            return 200, {"ok": True, "series": "Test"}
        return 404, {}


def wait(cond, secs=3):
    end = time.time() + secs
    while time.time() < end and not cond():
        time.sleep(0.02)
    return cond()


class SignIn(unittest.TestCase):
    def setUp(self):
        self.real = (lu._request, lu.POLL_EVERY, lu.ON_SIGNED_IN, lu._log, server.STATE)
        self.site = Site()
        lu._request, lu.POLL_EVERY, lu._log = self.site, 0.02, lambda m: None
        server.STATE = server.State()
        server.STATE.update_settings({"leagueUpload": {"on": False}})   # the settings file is shared between tests
        lu.ON_SIGNED_IN = server.league_upload_signed_in
        lu._stored["key"] = None
        if os.path.exists(lu.KEY_FILE):
            os.remove(lu.KEY_FILE)
        shutil.rmtree(lu.DIR, ignore_errors=True)       # an empty upload queue (other tests leave races in it)
        lu.configure({"on": False, "key": ""})

    def tearDown(self):
        shutil.rmtree(lu.DIR, ignore_errors=True)
        lu.cancel_sign_in()
        lu._request, lu.POLL_EVERY, lu.ON_SIGNED_IN, lu._log, server.STATE = self.real
        lu._stored["key"] = None
        if os.path.exists(lu.KEY_FILE):
            os.remove(lu.KEY_FILE)
        lu.configure({"on": False, "key": ""})

    def sign_in(self):
        r = server.league_upload_command({"cmd": "signin"})
        self.assertEqual((r["ok"], r["code"]), (True, "ABCD-EFGH"))
        self.site.allowed = True
        # signed in (on the background sign-in thread, which saves the key file and then ends); results go with it
        # straight away, there's no switch
        self.assertTrue(wait(lambda: lu.signed_in() is not None and lu._key() == TOKEN and not any(
            t.name == "league-signin" and t.is_alive() for t in threading.enumerate())))
        return r

    def test_sign_in_sends_results_and_keeps_the_token_private(self):
        self.assertEqual(self.site.calls[0][1] if self.site.calls else "", "")
        self.sign_in()
        self.assertEqual(self.site.calls[0], ("/api/overlay/link", ""))          # asking for a code sends no key
        self.assertEqual(lu.signed_in()["name"], "Producer Pat")
        self.assertEqual(lu._key(), TOKEN)
        with open(lu.KEY_FILE, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["token"], TOKEN)
        shown = json.dumps(server.STATE.public_settings()) + json.dumps(lu.status())
        self.assertNotIn(TOKEN, shown)
        self.assertIn("Producer Pat", json.dumps(lu.status()))
        with open(datafiles.SETTINGS_FILE, encoding="utf-8") as f:
            self.assertNotIn(TOKEN, f.read())

    def test_the_sign_in_is_used_ahead_of_a_key(self):
        lu.save_key(KEY)
        lu.configure({"on": True, "key": KEY})
        self.assertEqual(lu._key(), KEY)
        self.sign_in()
        self.assertEqual(lu._key(), TOKEN)

    def test_401_signs_out_here_and_the_key_takes_over(self):
        lu.save_key(KEY)
        self.sign_in()
        os.makedirs(lu.DIR, exist_ok=True)
        datafiles.write_json(os.path.join(lu.DIR, "1-2.json"), {"subsessionId": 1, "results": []})
        self.site.answer["/api/overlay/results"] = (401, {"ok": False, "error": "unknown"})
        lu._send_all()
        self.assertIsNone(lu.signed_in())
        self.assertEqual(lu.pending(), ["1-2.json"])                            # nothing lost
        self.assertIn("overlay key", lu.STATUS["msg"])
        self.assertEqual(lu._key(), KEY)
        del self.site.answer["/api/overlay/results"]
        lu._send_all()
        self.assertEqual(lu.pending(), [])

    def test_401_without_a_key_asks_to_sign_in_again(self):
        self.sign_in()
        os.makedirs(lu.DIR, exist_ok=True)
        datafiles.write_json(os.path.join(lu.DIR, "3-2.json"), {"subsessionId": 3, "results": []})
        self.site.answer["/api/overlay/results"] = (401, {"ok": False})
        lu._send_all()
        self.assertIn("sign in with Discord again", lu.STATUS["msg"])
        self.assertEqual(lu.pending(), ["3-2.json"])
        os.remove(os.path.join(lu.DIR, "3-2.json"))

    def test_403_keeps_the_sign_in_and_says_why(self):
        self.sign_in()
        os.makedirs(lu.DIR, exist_ok=True)
        datafiles.write_json(os.path.join(lu.DIR, "2-2.json"), {"subsessionId": 2, "results": []})
        self.site.answer["/api/overlay/results"] = (403, {"ok": False, "error": "The overlay needs the Producer role."})
        lu._send_all()
        self.assertEqual(lu.STATUS["msg"], "The overlay needs the Producer role.")
        self.assertIsNotNone(lu.signed_in())
        self.assertEqual(lu.pending(), ["2-2.json"])
        os.remove(os.path.join(lu.DIR, "2-2.json"))

    def test_a_code_that_runs_out(self):
        self.site.answer["/api/overlay/link/poll"] = (200, {"ok": True, "state": "expired"})
        server.league_upload_command({"cmd": "signin"})
        self.assertTrue(wait(lambda: lu.status()["signin"] is None))
        self.assertIsNone(lu.signed_in())
        self.assertIn("press Sign in with Discord again", lu.STATUS["msg"])

    def test_sign_out(self):
        self.sign_in()
        r = server.league_upload_command({"cmd": "signout"})
        self.assertTrue(r["ok"] and self.site.signed_out)
        self.assertIsNone(lu.signed_in())
        self.assertFalse(os.path.exists(lu.KEY_FILE))                            # nothing left in it
        self.assertEqual(lu._key(), "")                                           # no key either: nothing to send with

    def test_sign_out_with_the_site_unreachable(self):
        self.sign_in()

        def offline(path, key, body=None, timeout=15):
            raise OSError("no internet")
        lu._request = offline
        r = server.league_upload_command({"cmd": "signout"})
        self.assertTrue(r["ok"])
        self.assertIn("Keys page", r["msg"])                                       # turn it off on the site too
        self.assertIsNone(lu.signed_in())

    def test_the_site_address(self):
        self.assertTrue(lu.SITE in ("https://glrhub.app", os.environ.get("VSPEED_SITE", "").rstrip("/")))


if __name__ == "__main__":
    unittest.main()
