"""Saving and loading the data files: nothing the producer set up may be lost to a crash, a damaged file, a OneDrive
lock, a site that turns a race down, or a series switch that fails part-way. Everything here uses the throwaway data folder."""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest

import support
import datafiles
import server
import standings
import leagueupload as lu
import raceresults as rr
import profiles


def tmpdir():
    d = tempfile.mkdtemp(dir=support.DATA)
    return d


class SaveAndLoad(unittest.TestCase):
    def setUp(self):
        self.d = tmpdir()
        self.p = os.path.join(self.d, "x.json")

    def test_round_trip_leaves_no_temp_files(self):
        datafiles.write_json(self.p, {"a": 1})
        self.assertEqual(datafiles.load_json(self.p), {"a": 1})
        self.assertFalse([f for f in os.listdir(self.d) if f.endswith(".tmp")])

    def test_damaged_file_kept_aside_and_last_good_copy_used(self):
        datafiles.write_json(self.p, {"a": 1})
        datafiles.load_json(self.p, backup=True)                 # makes x.json.bak
        with open(self.p, "w") as f:
            f.write("{half writ")
        self.assertEqual(datafiles.load_json(self.p, {}), {"a": 1})
        self.assertTrue(any(n.startswith("x.json.broken-") for n in os.listdir(self.d)))

    def test_missing_file_gives_the_default(self):
        self.assertEqual(datafiles.load_json(self.p, {"d": 1}), {"d": 1})

    def test_locked_file_is_tried_again(self):
        real, calls = os.replace, {"n": 0}

        def flaky(a, b):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise PermissionError(13, "locked by OneDrive")
            return real(a, b)
        os.replace = flaky
        try:
            datafiles.write_json(self.p, {"b": 2})
        finally:
            os.replace = real
        self.assertEqual((datafiles.load_json(self.p), calls["n"]), ({"b": 2}, 3))

    def test_many_saves_at_once(self):
        errs = []

        def save(i):
            try:
                datafiles.write_json(self.p, {"i": i})
            except Exception as e:
                errs.append(e)
        ts = [threading.Thread(target=save, args=(i,)) for i in range(30)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errs, [])
        self.assertIsInstance(datafiles.load_json(self.p), dict)


class SettingsFile(unittest.TestCase):
    def test_damaged_settings_come_back_from_the_backup(self):
        good = {"raceName": "TEST SERIES", "leagueUpload": {"on": True, "key": "vsglr_" + "a" * 48}}
        with open(server.SETTINGS_FILE + ".bak", "w", encoding="utf-8") as f:
            json.dump(good, f)
        with open(server.SETTINGS_FILE, "w", encoding="utf-8") as f:
            f.write('{"raceName": "TEST SER')
        st = server.State()
        self.assertEqual(st.settings["raceName"], "TEST SERIES")
        self.assertTrue(st.settings["leagueUpload"]["key"].startswith("vsglr_"))
        self.assertTrue(any(n.startswith("settings.json.broken-") for n in os.listdir(support.DATA)))

    def test_file_on_disk_ends_up_with_the_newest_settings(self):
        st = server.State()
        ts = [threading.Thread(target=st.update_settings, args=({"towerRows": i},)) for i in range(40)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        with open(server.SETTINGS_FILE, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["towerRows"], st.settings["towerRows"])


class StandingsConfig(unittest.TestCase):
    def test_unreadable_config_doesnt_wipe_the_rest(self):
        saved = dict(standings._CFG_CACHE)
        try:
            standings._CFG_CACHE.clear()
            standings._CFG_CACHE.update({"xtreme": "https://example.test/w", "excluded": ["Test Driver"], "title": "CUP"})
            if os.path.exists(standings.CONFIG_PATH):
                os.remove(standings.CONFIG_PATH)
            standings.update_config(cutoff=10)
            cfg = standings.load_config()
            self.assertEqual((cfg.get("xtreme"), cfg.get("excluded"), cfg.get("cutoff")), ("https://example.test/w", ["Test Driver"], 10))
        finally:
            standings._CFG_CACHE.clear()
            standings._CFG_CACHE.update(saved)


LIVE = {"track": "Test Speedway", "cars": [{"idx": 1, "num": "7", "name": "Test A", "custId": "1", "gap": "LEADER"}], "classes": []}
SESS = {"ResultsPositions": [{"CarIdx": 1, "Position": 1, "LapsComplete": 10, "Time": 0, "Incidents": 0}]}


class LeagueUpload(unittest.TestCase):
    def setUp(self):
        self.real_request, self.real_log = lu._request, lu._log
        lu._log = lambda m: None
        lu.configure({"on": True, "key": "k"})
        shutil.rmtree(lu.DIR, ignore_errors=True)

    def tearDown(self):
        lu._request, lu._log = self.real_request, self.real_log
        lu.configure({"on": False, "key": ""})

    def answer(self, code, j):
        lu._request = lambda path, key, body=None, timeout=15: (code, j)

    def path(self, sub):
        return os.path.join(lu.DIR, "%s-2.json" % sub)

    def test_refused_race_is_set_aside_not_deleted(self):
        lu.queue(LIVE, SESS, {"subId": 111, "leagueId": 9}, 2, False)
        self.answer(404, {"ok": False, "error": "iRacing league 9 isn't on the site yet."})
        lu._send_all()
        self.assertFalse(os.path.exists(self.path(111)))
        self.assertTrue(os.path.exists(os.path.join(lu.REFUSED_DIR, "111-2.json")))

    def test_site_problems_keep_the_race_queued(self):
        lu.queue(LIVE, SESS, {"subId": 222, "leagueId": 9}, 2, False)
        for code in (500, 503, 429, 408):
            self.answer(code, {})
            lu._send_all()
            self.assertTrue(os.path.exists(self.path(222)), code)

    def test_official_copy_queued_during_a_send_is_kept(self):
        lu.queue(LIVE, SESS, {"subId": 333, "leagueId": 9}, 2, False)

        def mid_send(path, key, body=None, timeout=15):
            lu.queue(LIVE, dict(SESS, ResultsOfficial=1), {"subId": 333, "leagueId": 9}, 2, True)
            return 200, {"ok": True, "series": "Test"}
        lu._request = mid_send
        lu._send_all()
        left = datafiles.load_json(self.path(333))
        self.assertTrue(left and left["official"])
        self.answer(200, {"ok": True})
        lu._send_all()
        self.assertFalse(os.path.exists(self.path(333)))

    def test_damaged_queue_file_set_aside(self):
        os.makedirs(lu.DIR, exist_ok=True)
        with open(self.path(444), "w") as f:
            f.write("{damaged")
        lu._send_all()
        self.assertTrue(os.path.exists(os.path.join(lu.REFUSED_DIR, "444-2.json")))

    def test_not_a_league_race_is_not_queued(self):
        lu.queue(LIVE, SESS, {"subId": 555, "leagueId": 0}, 2, False)
        self.assertFalse(os.path.exists(self.path(555)))


class RaceResults(unittest.TestCase):
    def test_a_failed_save_is_tried_again_and_the_upload_still_queued(self):
        logs, queued, real, fails = [], [], datafiles.write_text, {"n": 1}

        def failing(path, text, newline=None):
            if path.endswith(".csv") and fails["n"] > 0:
                fails["n"] -= 1
                raise PermissionError(13, "locked by OneDrive")
            return real(path, text, newline)
        info = {"subId": 9001}
        call = lambda s=SESS: rr.update(LIVE, s, info, 2, log=logs.append, on_saved=queued.append)
        datafiles.write_text = failing
        try:
            call()
            st = rr._done["9001-2"]
            st["checkered"] -= 61                                  # a minute after the checkered
            call()
            self.assertEqual(queued, [False])
            self.assertTrue(st["done"] is None and st["retryAt"] > time.time())
            st["retryAt"] = 0
            call()
            self.assertEqual((st["csv"], queued), ("first", [False]))
        finally:
            datafiles.write_text = real
        with open(st["path"], "rb") as f:
            raw = f.read()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))           # Excel opens the names correctly
        self.assertNotIn(b"\r\r\n", raw)
        call(dict(SESS, ResultsOfficial=1))
        self.assertEqual((st["done"], queued), ("official", [False, True]))

    def test_gives_up_after_the_last_try(self):
        info, logs = {"subId": 9002}, []
        real = datafiles.write_text

        def always(path, text, newline=None):
            raise PermissionError(13, "locked")
        datafiles.write_text = always
        try:
            rr.update(LIVE, SESS, info, 2, log=logs.append)
            st = rr._done["9002-2"]
            st["checkered"] -= 61
            for _ in range(rr.MAX_TRIES):
                st["retryAt"] = 0
                rr.update(LIVE, SESS, info, 2, log=logs.append)
        finally:
            datafiles.write_text = real
        self.assertEqual(st["done"], "official")
        self.assertIn("Gave up", logs[-1])


class SeriesSwitch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.STATE.settings["raceName"] = "TEST SERIES"
        standings.set_data(["Pos", "Driver", "Pts"], [["1", "Test A", "10"]], "csv")
        profiles.init(server.STATE)
        if not any(p["name"] == "Second Series" for p in profiles.summary()["list"]):
            ok, msg = profiles.command({"cmd": "new", "name": "Second Series", "blank": True})
            assert ok, msg
        ids = {p["name"]: p["id"] for p in profiles.summary()["list"]}
        cls.second = ids["Second Series"]
        cls.first = next(i for n, i in ids.items() if n != "Second Series")

    def setUp(self):
        self.real = profiles._load
        profiles._load = self.real
        ok, msg = profiles.command({"cmd": "switch", "id": self.first})
        self.assertTrue(ok, msg)

    def tearDown(self):
        profiles._load = self.real
        profiles._mixed = False

    def test_failed_switch_puts_the_series_back(self):
        def broken(pid):
            if pid == self.second:
                standings.set_data(["Pos", "Driver", "Pts"], [["1", "HALF LOADED", "0"]], "csv")
                raise OSError("disk error part-way through")
            return self.real(pid)
        profiles._load = broken
        ok, msg = profiles.command({"cmd": "switch", "id": self.second})
        self.assertFalse(ok)
        self.assertEqual(profiles.summary()["active"], self.first)
        self.assertEqual(standings.data_snapshot()["rows"], [["1", "Test A", "10"]])

    def test_mixed_files_never_saved_over_a_series(self):
        def broken(pid):
            standings.set_data(["Pos", "Driver", "Pts"], [["1", "MIXED", "0"]], "csv")
            raise OSError("disk gone")
        profiles._load = broken
        ok, _ = profiles.command({"cmd": "switch", "id": self.second})
        self.assertFalse(ok)
        self.assertTrue(profiles._mixed)
        path = os.path.join(profiles._pdir(self.first), "standings", "standings.json")
        before = datafiles.load_json(path)
        profiles.command({"cmd": "save"})
        self.assertEqual(datafiles.load_json(path), before)
        profiles._load = self.real
        ok, msg = profiles.command({"cmd": "switch", "id": self.first})
        self.assertTrue(ok, msg)
        self.assertFalse(profiles._mixed)
        self.assertEqual(standings.data_snapshot()["rows"], [["1", "Test A", "10"]])


if __name__ == "__main__":
    unittest.main()
