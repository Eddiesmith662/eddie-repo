"""The league site overlay key: kept in its own file, not in settings.json, and never shown to the pages."""
import json
import os
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import leagueupload as lu
import server

KEY = "vsglr_" + "ab" * 24


def read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class KeyFile(unittest.TestCase):
    def setUp(self):
        lu._stored["key"] = None
        for p in (lu.KEY_FILE, datafiles.SETTINGS_FILE + ".bak"):
            if os.path.exists(p):
                os.remove(p)
        self.st = server.State()

    def tearDown(self):
        lu.save_key("")
        lu.configure({"on": False, "key": ""})

    def test_save_read_and_remove(self):
        self.assertEqual(lu.stored_key(), "")
        lu.save_key(KEY)
        lu._stored["key"] = None                      # read it back from the file, not from memory
        self.assertEqual(lu.stored_key(), KEY)
        lu.save_key("")
        self.assertFalse(os.path.exists(lu.KEY_FILE))
        self.assertEqual(lu.stored_key(), "")

    def test_a_key_in_settings_json_moves_to_its_own_file(self):
        # an install from before Nov 2026: the key in settings.json and in its .bak
        self.st.update_settings({"leagueUpload": {"on": True, "key": KEY}})
        datafiles.write_json(datafiles.SETTINGS_FILE + ".bak", {"leagueUpload": {"on": True, "key": KEY}})
        logs = []
        self.assertTrue(lu.move_key_out_of_settings(self.st, logs.append))
        self.assertEqual(read(lu.KEY_FILE)["key"], KEY)
        self.assertNotIn("key", read(datafiles.SETTINGS_FILE)["leagueUpload"])
        self.assertNotIn("key", read(datafiles.SETTINGS_FILE + ".bak")["leagueUpload"])
        self.assertTrue(read(datafiles.SETTINGS_FILE)["leagueUpload"]["on"])      # still switched on
        self.assertNotIn(KEY, open(datafiles.SETTINGS_FILE, encoding="utf-8").read())
        self.assertFalse(lu.move_key_out_of_settings(self.st, logs.append))      # only once

    def test_pages_never_see_the_key(self):
        self.st.update_settings({"leagueUpload": {"on": True}})
        self.assertEqual(self.st.public_settings()["leagueUpload"]["key"], "")
        lu.save_key(KEY)
        shown = self.st.public_settings()
        self.assertEqual(shown["leagueUpload"], {"on": True, "key": "saved"})
        self.assertNotIn(KEY, json.dumps(shown))

    def test_pasting_a_key_saves_it_in_its_own_file(self):
        real_check, real_state = lu.check, server.STATE
        lu.check = lambda key: (True, "Key works (Test)")
        server.STATE = self.st
        try:
            ok, msg = server.league_upload_command({"cmd": "key", "key": KEY})
            self.assertTrue(ok, msg)
            self.assertEqual(read(lu.KEY_FILE)["key"], KEY)
            self.assertNotIn(KEY, open(datafiles.SETTINGS_FILE, encoding="utf-8").read())
            self.assertTrue(self.st.settings["leagueUpload"]["on"])
            self.assertEqual(lu._key(), KEY)                                   # and the upload uses it
            ok, _ = server.league_upload_command({"cmd": "off"})
            self.assertEqual(lu._key(), "")
            ok, _ = server.league_upload_command({"cmd": "on"})
            self.assertTrue(ok)
            self.assertEqual(lu._key(), KEY)
            ok, _ = server.league_upload_command({"cmd": "key", "key": ""})   # removed
            self.assertFalse(os.path.exists(lu.KEY_FILE))
            self.assertFalse(self.st.settings["leagueUpload"]["on"])
        finally:
            lu.check, server.STATE = real_check, real_state

    def test_start_reads_the_key_file(self):
        lu.save_key(KEY)
        real_thread = lu.threading.Thread
        lu.threading.Thread = lambda **kw: type("T", (), {"start": lambda self: None})()   # no background sender here
        try:
            lu.start({"on": True}, log=lambda m: None)
        finally:
            lu.threading.Thread = real_thread
        self.assertEqual(lu._key(), KEY)


if __name__ == "__main__":
    unittest.main()
