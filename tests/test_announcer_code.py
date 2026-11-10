"""The announcer feed's producer code comes from the league site with this PC's sign-in, one show per producer (Nov 2026:
no more pasting a code made on the relay's /admin page). The site and the relay are stand-ins; the site's side is
tested in glr/. Made-up producers only."""
import threading
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import announcer
import leagueupload

RELAY = "https://relay.test"
SIG = "A" * 32


def code(show):
    return "%s/k/%s.%s" % (RELAY, show, SIG)


class FakeState:
    def __init__(self, an):
        self.lock = threading.RLock()
        self.settings = {"announcer": dict(announcer.DEFAULTS, **an), "raceName": "Test Cup"}
        self.live = {}

    def notify(self):
        pass

    def update_settings(self, patch):
        with self.lock:
            self.settings["announcer"].update(patch["announcer"])


class ProducerCode(unittest.TestCase):
    def setUp(self):
        self.real = (leagueupload._request, leagueupload.signed_in, leagueupload.token, announcer.build)
        self.who = {"id": "u1", "name": "Producer One"}
        self.answer = (200, {"ok": True, "code": code("producer-one"), "show": "producer-one"})
        self.asked = []
        leagueupload.signed_in = lambda: self.who
        leagueupload.token = lambda: "vsov_test"

        def request(path, key, body=None, timeout=15):
            self.asked.append((path, key, body))
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer
        leagueupload._request = request
        announcer.build = lambda *a, **k: {"x": 1}
        self.logged = []

    def tearDown(self):
        leagueupload._request, leagueupload.signed_in, leagueupload.token, announcer.build = self.real

    def sender(self, **an):
        st = FakeState(dict({"on": True, "token": "view1"}, **an))
        s = announcer.Sender(st, lambda: {}, self.logged.append)
        self.pushed = []
        s._post = lambda base, key, body: (self.pushed.append((base, key)) or (200, {"ok": True, "viewers": 2}))
        return s, st

    def test_switched_on_it_gets_the_code_from_the_site_and_sends(self):
        s, st = self.sender()
        s.once()
        self.assertEqual(self.asked, [("/api/overlay/announcer", "vsov_test", {"show": ""})])
        self.assertEqual(st.settings["announcer"]["code"], code("producer-one"))
        self.assertEqual(self.pushed, [(RELAY, "producer-one." + SIG)])
        self.assertEqual(announcer.STATUS["link"], RELAY + "/a/producer-one/view1")
        s.once()
        self.assertEqual(len(self.asked), 1)             # asked once, not every update

    def test_a_pasted_code_asks_the_site_to_keep_its_show(self):
        s, st = self.sender(code=code("glr-arca"))
        self.answer = (200, {"ok": True, "code": code("glr-arca"), "show": "glr-arca"})
        s.once()
        self.assertEqual(self.asked[0][2], {"show": "glr-arca"})   # the links announcers already have keep working
        self.assertEqual(st.settings["announcer"]["code"], code("glr-arca"))

    def test_off_asks_nothing(self):
        s, st = self.sender(on=False)
        s.once()
        self.assertEqual((self.asked, self.pushed, announcer.STATUS["state"]), ([], [], "off"))

    def test_not_signed_in_says_so(self):
        self.who = None
        s, st = self.sender()
        s.once()
        self.assertEqual(self.asked, [])
        self.assertEqual(announcer.STATUS["state"], "setup")
        self.assertIn("Sign in to GLR HUB", announcer.STATUS["error"])

    def test_the_site_down_uses_the_saved_code(self):
        self.answer = OSError("no internet")
        s, st = self.sender(code=code("producer-one"))
        s.once()
        self.assertEqual(self.pushed, [(RELAY, "producer-one." + SIG)])
        self.assertEqual(len([m for m in self.logged if "Couldn't reach GLR HUB" in m]), 1)

    def test_the_site_down_with_no_saved_code_says_why(self):
        self.answer = OSError("no internet")
        s, st = self.sender()
        s.once()
        self.assertEqual(self.pushed, [])
        self.assertIn("Couldn't reach GLR HUB", announcer.STATUS["error"])

    def test_not_a_producer_says_what_the_site_said(self):
        self.answer = (403, {"ok": False, "error": "Only producers can use the announcer page"})
        s, st = self.sender()
        s.once()
        self.assertEqual(announcer.STATUS["error"], "Only producers can use the announcer page")

    def test_another_producer_signing_in_gets_their_own_show(self):
        s, st = self.sender()
        s.once()
        self.who = {"id": "u2", "name": "Producer Two"}
        self.answer = (200, {"ok": True, "code": code("producer-two"), "show": "producer-two"})
        s.last_text = None
        s.once()
        self.assertEqual(self.pushed[-1], (RELAY, "producer-two." + SIG))


class CodeStaysOnThisPC(unittest.TestCase):
    """The producer code is a key to the relay: like the sign-in token, never in the control panel, logs or zips."""
    def test_not_sent_to_the_control_panel(self):
        import server
        was = server.STATE.settings.get("announcer")
        server.STATE.settings["announcer"] = dict(announcer.DEFAULTS, on=True, code=code("producer-one"), token="view1")
        try:
            text = server.STATE.snapshot()
            self.assertNotIn(SIG, text)
            self.assertEqual(server.STATE.public_settings()["announcer"]["code"], "saved")
        finally:
            server.STATE.settings["announcer"] = was

    def test_not_in_the_diagnostics_zip(self):
        import json
        import zipfile
        import diag
        path = diag.save_zip({"announcer": {"on": True, "code": code("producer-one"), "token": "view1"}})
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            body = b"".join(z.read(n) for n in names)
            saved = json.loads(z.read("settings.json"))
        self.assertNotIn(SIG.encode(), body)
        self.assertEqual(saved["announcer"]["code"], "(set for show producer-one, not included)")

    def test_the_log_names_the_show_only(self):
        logged = []
        st = FakeState({"on": True, "token": "view1"})
        real = (leagueupload._request, leagueupload.signed_in, leagueupload.token, announcer.build)
        leagueupload.signed_in = lambda: {"id": "u1", "name": "Producer One"}
        leagueupload.token = lambda: "vsov_test"
        leagueupload._request = lambda *a, **k: (200, {"ok": True, "code": code("producer-one"), "show": "producer-one"})
        announcer.build = lambda *a, **k: {"x": 1}
        try:
            s = announcer.Sender(st, lambda: {}, logged.append)
            s._post = lambda base, key, body: (200, {"ok": True, "viewers": 0})
            s.once()
        finally:
            leagueupload._request, leagueupload.signed_in, leagueupload.token, announcer.build = real
        self.assertTrue(any("producer-one" in m for m in logged))
        self.assertFalse(any(SIG in m for m in logged))


if __name__ == "__main__":
    unittest.main()
