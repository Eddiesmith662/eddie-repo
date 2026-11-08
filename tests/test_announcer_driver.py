"""The announcer page's driver on camera: their season in the series, championship place and points, and their own
info (bio, team, sponsor, hometown), from the league site's public pages. The site's answers here are shaped like the
real ones (from a local test copy of the site); every driver is made up."""
import support  # noqa: F401  (first: the throwaway data folder)

import io
import unittest
import urllib.error

import announcer

LEAGUE = 4242
SERIES = {"ok": True, "series": [{"id": LEAGUE, "short_name": "Test Cup", "slug": "test-cup"}]}
STATS = {"ok": True, "series": "Test Cup", "season": {"id": 500, "name": "Test Cup Season 1"}, "races": 6, "drivers": [
    {"custId": 100, "name": "Racer A", "starts": 6, "wins": 1, "top5": 3, "top10": 5, "poles": 2, "avgStart": 4.5,
     "avgFinish": 7.1666, "lapsLed": 45, "dnf": 1},
    {"custId": 101, "name": "Racer B", "starts": 6, "wins": 2, "top5": 4, "top10": 6, "poles": 0, "avgStart": 3.0,
     "avgFinish": 4.0, "lapsLed": 120, "dnf": 0}]}
STANDINGS = {"ok": True, "season": {"id": 500, "name": "Test Cup Season 1"}, "groups": [{"carClass": "", "regular": [
    {"custId": 101, "points": 210, "pos": 1, "behind": 0},
    {"custId": 100, "points": 188, "pos": 2, "behind": 22}]}]}
DRIVER = {"ok": True, "driver": {"cust_id": 100, "name": "Racer A", "profile": {
    "bio": "Started in go-karts.\nThird season in the cup.", "team": "Made-Up Motorsports", "sponsor": "Test Tires",
    "hometown": "Sampleville", "updated_at": "2026-11-01"}}}


class FakeSite:
    def __init__(self, answers=None, down=False):
        self.answers = dict({"/api/series": SERIES, "/api/series/test-cup/stats": STATS,
                             "/api/standings/test-cup": STANDINGS, "/api/drivers/100": DRIVER}, **(answers or {}))
        self.down, self.asked = down, []

    def __call__(self, path):
        self.asked.append(path)
        if self.down:
            raise OSError("no internet")
        if path not in self.answers:
            raise urllib.error.HTTPError(path, 404, "No such driver", {}, io.BytesIO(b"{}"))
        return self.answers[path]


def live(league=LEAGUE, cust="100"):
    return {"connected": True, "isRace": True, "leagueId": league, "camCarIdx": 0,
            "cars": [{"idx": 0, "pos": 2, "num": "1", "name": "Racer A", "custId": cust},
                     {"idx": 1, "pos": 1, "num": "2", "name": "Racer B", "custId": "101"}]}


def cam_of(site, lv=None):
    return announcer.build(lv or live(), {}, lambda: [], site)["cam"]


class DriverOnCamera(unittest.TestCase):
    def setUp(self):
        self.logs = []

    def site(self, fake):
        return announcer.SiteInfo(fetch=fake, log=self.logs.append)

    def test_season_championship_and_bio(self):
        fake = FakeSite()
        site = self.site(fake)
        self.assertNotIn("x", cam_of(site))          # first update: not looked up yet, and the feed doesn't wait
        site.refresh()
        x = cam_of(site)["x"]
        self.assertEqual(x["season"], "Test Cup Season 1")
        self.assertEqual(x["s"], {"st": 6, "w": 1, "t5": 3, "t10": 5, "po": 2, "as": 4.5, "af": 7.2, "led": 45, "dnf": 1})
        self.assertEqual(x["ch"], {"pos": 2, "pts": 188, "behind": 22})
        self.assertEqual((x["team"], x["sp"], x["home"]), ("Made-Up Motorsports", "Test Tires", "Sampleville"))
        self.assertTrue(x["bio"].startswith("Started in go-karts."))
        # kept: the next updates don't ask the site again
        n = len(fake.asked)
        site.refresh()
        cam_of(site)
        self.assertEqual(len(fake.asked), n)

    def test_only_the_driver_on_camera(self):
        site = self.site(FakeSite())
        site.refresh()
        data = announcer.build(live(), {}, lambda: [], site)
        self.assertTrue(all("x" not in c for c in data["cars"]))

    def test_not_a_league_race(self):
        fake = FakeSite()
        site = self.site(fake)
        cam = cam_of(site, live(league=None))
        site.refresh()
        self.assertNotIn("x", cam_of(site, live(league=None)))
        self.assertEqual(fake.asked, [])
        self.assertEqual(cam["d"], "Racer A")

    def test_a_league_that_is_not_on_the_site(self):
        fake = FakeSite()
        site = self.site(fake)
        cam_of(site, live(league=999))
        site.refresh()
        site.refresh()
        self.assertNotIn("x", cam_of(site, live(league=999)))
        self.assertEqual(fake.asked, ["/api/series"])     # asked once, not every update

    def test_a_driver_the_site_does_not_know(self):
        site = self.site(FakeSite())
        cam_of(site, live(cust="555"))
        site.refresh()
        self.assertIsNone(site.get(LEAGUE, 555))
        cam_of(site)                                       # back to a known driver
        site.refresh()
        self.assertIn("s", cam_of(site)["x"])

    def test_no_bio_written(self):
        site = self.site(FakeSite({"/api/drivers/100": {"ok": True, "driver": {"cust_id": 100, "profile": None}}}))
        cam_of(site)
        site.refresh()
        x = cam_of(site)["x"]
        self.assertIn("s", x)
        self.assertFalse({"bio", "team", "sp", "home"} & set(x))

    def test_site_down_never_stops_the_feed(self):
        fake = FakeSite(down=True)
        site = self.site(fake)
        cam_of(site)
        site.refresh()
        site.refresh(now=site.failed["the series list"] + 5)       # not asked again straight away
        self.assertEqual(fake.asked, ["/api/series"])
        self.assertNotIn("x", cam_of(site))
        self.assertEqual(len(self.logs), 1)
        fake.down = False
        site.refresh(now=site.failed["the series list"] + announcer.RETRY + 1)
        self.assertIn("ch", cam_of(site)["x"])

    def test_a_bad_answer_is_only_logged(self):
        site = self.site(FakeSite({"/api/series/test-cup/stats": "not json"}))
        cam_of(site)
        site.refresh()
        x = cam_of(site)["x"]
        self.assertNotIn("s", x)                     # the season couldn't be read; the bio still shows
        self.assertIn("bio", x)
        self.assertTrue(any("season" in m for m in self.logs))


class Championship(unittest.TestCase):
    def test_playoffs_current_round(self):
        st = {"groups": [{"regular": [{"custId": 100, "pos": 5, "points": 400}], "playoffs": {"started": True, "current": {
            "name": "Round of 8", "rows": [{"custId": 101, "pos": 1, "points": 2030}, {"custId": 100, "pos": 2, "points": 2021}]}}}]}
        self.assertEqual(announcer.championship(st, 100), {"pos": 2, "pts": 2021, "round": "Round of 8", "behind": 9})

    def test_out_of_the_playoffs(self):
        st = {"groups": [{"playoffs": {"started": True, "current": {"name": "Round of 8", "rows": []},
                                       "eliminated": [{"custId": 100, "outIn": "Round of 12"}]}}]}
        self.assertEqual(announcer.championship(st, 100), {"out": "Round of 12"})

    def test_per_class(self):
        st = {"groups": [{"carClass": "GTP", "regular": [{"custId": 101, "pos": 1, "points": 90, "behind": 0}]},
                         {"carClass": "GT3", "regular": [{"custId": 100, "pos": 1, "points": 80, "behind": 0}]}]}
        self.assertEqual(announcer.championship(st, 100), {"pos": 1, "pts": 80, "behind": 0})


class Page(unittest.TestCase):
    def test_page_shows_it_safely(self):
        with open(support.ROOT + "/relay/src/announcer.html", encoding="utf-8") as f:
            page = f.read()
        self.assertIn('id="drv"', page)
        self.assertIn("drvBox(cam)", page)
        self.assertIn("esc(x.bio)", page)            # drivers write the bio: never put on the page as HTML


if __name__ == "__main__":
    unittest.main()
