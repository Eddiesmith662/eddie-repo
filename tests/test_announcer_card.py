"""The announcer page's driver card: the season in words, what a playoff driver needs, every driver's card for
tap-to-open, and the page itself in a browser (Playwright; skipped where it isn't installed).

Nov 15, 2026 (F.O.E. Grand National, Round of 12): announcers wanted each driver's season in a few lines and what they
need to go through, in place of the column of numbers, and to open any driver's card by tapping them. The lines are
put together from the league site's numbers by fixed rules. Every driver here is made up.
"""
import support  # noqa: F401  (first: the throwaway data folder)

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import announcer
from test_announcer_driver import FakeSite, LEAGUE, STATS, DRIVER


def row(**kw):
    return dict({"starts": 0, "wins": 0, "top5": 0, "top10": 0, "poles": 0, "lapsLed": 0, "dnf": 0}, **kw)


class SeasonInWords(unittest.TestCase):
    def test_a_driver_with_several_wins(self):
        text = announcer.blurb(row(starts=7, wins=5, top5=6, top10=6, lapsLed=318, best=1), [1, 2, 1, 27, 1, 1, 1], led_rank=1)
        self.assertEqual(text, "Five wins in 7 starts, including the last three. Has led 318 laps, the most in the series. "
                               "Top 10 in 6 of 7 starts.")

    def test_one_win_and_the_regular_season_title(self):
        text = announcer.blurb(row(starts=10, wins=1, top5=7, top10=9, lapsLed=47, best=1), [4, 2, 3, 4, 1, 3, 2, 7, 18, 7],
                               regular_champion=True)
        self.assertEqual(text, "Regular season champion. One win in 10 starts, with seven top fives. "
                               "Top 10 in 9 of 10 starts. Last three finishes: 7th, 18th and 7th.")

    def test_the_only_top_five_was_a_win(self):
        text = announcer.blurb(row(starts=10, wins=1, top5=1, top10=6, lapsLed=5, best=1), [7, 8, 6, 7, 11, 18, 1, 12, 22, 9])
        self.assertTrue(text.startswith("One win in 10 starts, and no other top five."), text)

    def test_no_wins_but_second_three_times(self):
        text = announcer.blurb(row(starts=8, top5=4, top10=6, lapsLed=37, best=2, poles=1), [25, 6, 2, 7, 2, 4, 14, 2])
        self.assertEqual(text, "No wins in 8 starts. Best finish is 2nd, three times, with four top fives. One pole. "
                               "Last three finishes: 4th, 14th and 2nd.")

    def test_top_tens_but_no_top_five(self):
        text = announcer.blurb(row(starts=8, top10=5, best=8), [8, 16, 16, 10, 23, 9, 8, 10])
        self.assertEqual(text, "Five top 10s in 8 starts, but no top five. Best finish is 8th. Hasn't led a lap. "
                               "Last three finishes: 9th, 8th and 10th.")

    def test_no_top_tens(self):
        text = announcer.blurb(row(starts=10, lapsLed=4, dnf=2, best=11), [13, 12, 11, 11, 12, 13, 19, 16, 11, 14])
        self.assertEqual(text, "No top 10s in 10 starts. Best finish is 11th. Two DNFs. Last three finishes: 16th, 11th and 14th.")

    def test_won_last_time_out_and_one_start(self):
        self.assertTrue(announcer.blurb(row(starts=4, wins=1, top5=2, top10=3, lapsLed=9, best=1), [9, 12, 4, 1]).endswith("Won last time out."))
        self.assertEqual(announcer.blurb(row(starts=1, top10=1, lapsLed=2, best=6), [6]),
                         "One top 10 in 1 start, but no top five. Best finish is 6th.")

    def test_nothing_for_a_driver_who_has_not_started(self):
        self.assertEqual(announcer.blurb(row()), "")
        self.assertEqual(announcer.blurb(None), "")


def playoff(rows, **cur):
    """The site's standings in a playoff round (shaped like /api/standings/<series>)."""
    cur = dict({"name": "Round of 12", "races": 2, "ran": 0, "complete": False, "winAdvances": True, "missMustWin": True,
                "finale": False, "rows": rows}, **cur)
    return {"groups": [{"regular": [{"custId": 100, "pos": 1, "points": 300, "finishes": [3, 1, 2]}],
                        "playoffs": {"started": True, "current": cur, "eliminated": []}}]}


class WhatADriverNeeds(unittest.TestCase):
    ROWS = [{"custId": 100, "points": 1015, "toCut": 15}, {"custId": 101, "points": 1000, "toCut": 0},
            {"custId": 102, "points": 1000, "toCut": 0}, {"custId": 103, "points": 1000, "toCut": 0},
            {"custId": 104, "points": 991, "toCut": -9}, {"custId": 105, "points": 999, "toCut": -1}]

    def test_over_on_and_below_the_cut_line(self):
        st = playoff(self.ROWS)
        self.assertEqual(announcer.tonight(st, 100), ("15 points over the cut line. Two races left in the round. A win goes straight through.", 15))
        self.assertEqual(announcer.tonight(st, 101), ("On the cut line, level with two others. Two races left in the round. A win goes straight through.", 0))
        self.assertEqual(announcer.tonight(st, 104), ("9 points below the cut line. Two races left in the round. A win goes straight through.", -9))
        self.assertEqual(announcer.tonight(st, 105)[0][:28], "1 point below the cut line. ")

    def test_last_race_of_the_round_and_no_win_rule(self):
        line, cut = announcer.tonight(playoff(self.ROWS, ran=1, winAdvances=False), 100)
        self.assertEqual(line, "15 points over the cut line. Last race of the round.")

    def test_through_on_a_win_or_must_win(self):
        rows = [{"custId": 100, "points": 1046, "toCut": 20, "won": True}, {"custId": 101, "points": 1000, "toCut": -30, "missed": True}]
        st = playoff(rows, ran=1)
        self.assertEqual(announcer.tonight(st, 100), ("Already through to the next round on a win.", None))
        self.assertEqual(announcer.tonight(st, 101), ("Missed a race in this round: must win to go through.", None))

    def test_championship_race(self):
        rows = [{"custId": c, "points": 3000} for c in (100, 101, 102, 103)]
        line, cut = announcer.tonight(playoff(rows, name="Championship", races=1, finale=True), 102)
        self.assertEqual(line, "Championship race: the best finisher of the four title drivers is champion.")
        self.assertIsNone(cut)

    def test_nothing_outside_the_round(self):
        st = playoff(self.ROWS)
        self.assertEqual(announcer.tonight(st, 999), ("", None))                         # not in the playoffs
        self.assertEqual(announcer.tonight(playoff(self.ROWS, ran=2, complete=True), 100), ("", None))   # the round is over
        self.assertEqual(announcer.tonight({"groups": [{"regular": [{"custId": 100}]}]}, 100), ("", None))   # no playoffs


STANDINGS = playoff([{"custId": 101, "pos": 1, "points": 1008, "toCut": 8, "finishes": [1, 1, 2, 3, 1, 4]},
                     {"custId": 100, "pos": 2, "points": 1000, "toCut": 0, "finishes": [3, 1, 2, 9, 12, 6]}])
DRIVER_B = {"ok": True, "driver": {"cust_id": 101, "name": "Racer B", "profile": {"team": "Sample Racing", "hometown": "Testburg"}}}
CARS = [{"idx": 0, "pos": 2, "num": "1", "name": "Racer A", "custId": "100"},
        {"idx": 1, "pos": 1, "num": "2", "name": "Racer B", "custId": "101"},
        {"idx": 2, "pos": 3, "num": "02", "name": "Racer C", "custId": "555"},      # not in the series on the site
        {"idx": 3, "pos": 4, "num": "0", "name": "Pace Car", "custId": ""}]


class EveryDriversCard(unittest.TestCase):
    def site(self, **answers):
        fake = FakeSite(dict({"/api/standings/test-cup": STANDINGS, "/api/drivers/101": DRIVER_B}, **answers))
        return fake, announcer.SiteInfo(fetch=fake, log=lambda *a: None)

    def test_the_card_has_the_season_in_words_and_the_playoff_line(self):
        fake, site = self.site()
        site.get(LEAGUE, 100)
        site.refresh()
        x = site.get(LEAGUE, 100)
        self.assertEqual(x["bl"], "Regular season champion. One win in 6 starts, with three top fives. Has led 45 laps, the second most "
                                  "in the series. Two poles. Last three finishes: 9th, 12th and 6th.")
        self.assertEqual(x["to"], "On the cut line. Two races left in the round. A win goes straight through.")
        self.assertEqual(x["cut"], 0)
        self.assertEqual(x["s"]["w"], 1)                       # the numbers are still there

    def test_a_card_for_every_driver_the_site_knows_by_car_number(self):
        fake, site = self.site()
        self.assertEqual(site.cards(LEAGUE, CARS), {})         # nothing looked up yet, and it never waits
        site.get(LEAGUE, 100)
        while site.refresh():
            pass
        cards = site.cards(LEAGUE, CARS)
        self.assertEqual(sorted(cards), ["1", "2"])
        self.assertEqual(cards["2"]["cut"], 8)
        self.assertIn("Two wins in 6 starts", cards["2"]["bl"])
        self.assertEqual(cards["2"]["team"], "Sample Racing")  # the other drivers' own info is looked up too
        self.assertEqual(cards["1"]["home"], "Sampleville")
        self.assertIn("/api/drivers/555", fake.asked)          # asked once; the site doesn't know them
        n = len(fake.asked)
        site.refresh()
        self.assertEqual(len(fake.asked), n)                   # kept: not asked again

    def test_the_rest_of_the_field_is_looked_up_a_few_at_a_time(self):
        fake, site = self.site()
        cars = [{"num": str(k), "custId": str(1000 + k)} for k in range(10)]
        site.cards(LEAGUE, cars)
        site.get(LEAGUE, 100)
        self.assertTrue(site.refresh())                        # more to come
        asked = [p for p in fake.asked if p.startswith("/api/drivers/1")]
        self.assertEqual(len([p for p in asked if p != "/api/drivers/100"]), announcer.FIELD_AT_ONCE)

    def test_not_a_league_race(self):
        fake, site = self.site()
        self.assertEqual(site.cards(0, CARS), {})
        self.assertEqual(site.cards(None, None), {})


class FakeState:
    def __init__(self, live):
        self.lock = threading.Lock()
        self.live = live
        self.settings = {"announcer": {"on": True, "code": "https://relay.example/k/test-show.0123456789abcdefghij",
                                       "token": "viewcode12345678"}, "raceName": "Test Cup"}

    def notify(self):
        pass

    def update_settings(self, patch):
        pass


class CardsGoToTheRelay(unittest.TestCase):
    """The cards ride beside an update only when they change, not twice a second."""

    def setUp(self):
        live = {"connected": True, "isRace": True, "leagueId": LEAGUE, "camCarIdx": 0, "cars": CARS}
        self.sender = announcer.Sender(FakeState(live), lambda: [], log=lambda *a: None)
        fake = FakeSite({"/api/standings/test-cup": STANDINGS, "/api/drivers/101": DRIVER_B})
        self.sender.site = announcer.SiteInfo(fetch=fake, log=lambda *a: None)
        self.sender.ask_code = lambda cfg: ""
        self.sent = []
        self.sender._post = lambda base, key, body: (self.sent.append(json.loads(body)), (200, {"ok": True, "viewers": 1}))[1]
        self.was = dict(announcer.STATUS)

    def tearDown(self):
        with announcer._lock:
            announcer.STATUS.clear()
            announcer.STATUS.update(self.was)

    def test_sent_once_then_only_the_updates(self):
        self.sender.once()
        self.assertNotIn("cards", self.sent[-1])               # the site hasn't answered yet
        while self.sender.site.refresh():
            pass
        self.sender.once()
        self.assertEqual(sorted(self.sent[-1]["cards"]), ["1", "2"])
        self.assertEqual(self.sent[-1]["data"]["cam"]["x"]["bl"], self.sent[-1]["cards"]["1"]["bl"])
        n = len(self.sent)
        self.sender.once()                                     # nothing changed: nothing sent at all
        self.assertEqual(len(self.sent), n)
        self.sender.state.live = dict(self.sender.state.live, lap=2)
        self.sender.once()
        self.assertNotIn("cards", self.sent[-1])               # an update, without the cards

    def test_sent_again_now_and_then_in_case_the_relay_lost_them(self):
        while True:
            self.sender.once()
            if not self.sender.site.refresh():
                break
        self.sender.once()
        self.assertIn("cards", self.sent[-1])
        self.sender.cards_sent -= announcer.CARDS_EVERY + 1
        self.sender.once()
        self.assertIn("cards", self.sent[-1])


# ------------------------------------------------------------------ the page itself, in a browser
CARD_A = {"season": "Test Cup Season 1", "s": {"st": 6, "w": 1, "t5": 3, "t10": 5, "po": 2, "as": 4.5, "af": 7.2, "led": 45, "dnf": 1},
          "ch": {"pos": 2, "pts": 1000, "round": "Round of 12", "behind": 8}, "cut": 0,
          "bl": "One win in 6 starts, with three top fives.", "to": "On the cut line. Two races left in the round.",
          "team": "Made-Up Motorsports", "bio": "Started in <b>go-karts</b>."}
CARD_B = {"season": "Test Cup Season 1", "s": {"st": 6, "w": 2, "t5": 4, "t10": 6, "po": 0, "as": 3.0, "af": 4.0, "led": 120, "dnf": 0},
          "ch": {"pos": 1, "pts": 1008, "round": "Round of 12", "behind": 0}, "cut": 8,
          "bl": "Two wins in 6 starts.", "to": "8 points over the cut line.", "home": "Testburg"}


def feed(state=1, cam_x=None, lp=False):
    cam = {"p": 2, "n": "1", "d": "Racer A"}
    if cam_x:
        cam["x"] = cam_x
    return {"v": 1, "series": "Test Cup", "track": "Test Speedway",
            "sess": {"name": "RACE", "race": True, "state": state, "lap": 10, "total": 50, "flag": "green", "live": True},
            "cam": cam, "air": [], "inc": [], "notes": {"text": "", "t": 0},
            "cars": [{"p": 1, "n": "2", "d": "Racer B", "g": "LEADER", "iv": ""},
                     {"p": 2, "n": "1", "d": "Racer A", "g": "0.4", "iv": "0.4", "cam": True},
                     {"p": 3, "n": "02", "d": "Racer C", "g": "1.9", "iv": "1.5"}],
            "lp": {"title": "Live points", "line": 0, "rows": [
                {"p": 1, "n": "2", "d": "Racer B", "pts": "1054", "cut": "+12", "status": "in", "racing": True},
                {"p": 2, "n": "1", "d": "Racer A", "pts": "1042", "cut": "-12", "status": "out", "racing": True}]} if lp else None}


class FakeRelay(BaseHTTPRequestHandler):
    """The page and its event stream, as the relay serves them: whatever is in `events` when a page connects, then
    whatever is added, until the test ends."""
    events = []
    stop = False

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            sent = 0
            try:
                while not FakeRelay.stop:
                    for text in FakeRelay.events[sent:]:
                        self.wfile.write(text.encode("utf-8"))
                        self.wfile.flush()
                        sent += 1
                    time.sleep(0.05)
            except OSError:
                pass
            return
        with open(support.ROOT + "/relay/src/announcer.html", "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def update(data):
    return 'data: {"age":0,"data":%s}\n\n' % json.dumps(data, separators=(",", ":"))


def cards(c):
    return "event: cards\ndata: %s\n\n" % json.dumps(c, separators=(",", ":"))


@unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "Playwright isn't installed here")
class PageInABrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FakeRelay.stop = False
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeRelay)      # port 0: a free one, never 8765/8766
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        FakeRelay.stop = True
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def open(self, *events):
        FakeRelay.events = list(events)
        page = self.browser.new_page(viewport={"width": 1400, "height": 1000})
        self.addCleanup(page.close)
        page.goto("http://127.0.0.1:%d/a/test-show/viewcode12345678" % self.port)
        page.wait_for_function("document.getElementById('cars').children.length === 3", timeout=10000)
        return page

    def test_the_driver_on_camera_has_the_card(self):
        page = self.open(update(feed()), cards({"1": CARD_A, "2": CARD_B}))
        page.wait_for_selector("#drv .strip")
        text = page.inner_text("#drv")
        self.assertIn("P2 in Round of 12", text)
        self.assertIn("On the line", text)
        self.assertIn("One win in 6 starts, with three top fives.", text)
        self.assertIn("Tonight: On the cut line. Two races left in the round.", text)
        self.assertIn("Made-Up Motorsports", text)
        self.assertIn("Started in <b>go-karts</b>.", text)             # the bio is text, never HTML
        self.assertEqual(page.locator("#drv .strip > div").count(), 9)
        self.assertEqual(page.locator("#drv .stats").count(), 0, "the column of numbers is gone")

    def test_an_overlay_from_before_the_cards_still_shows_the_numbers(self):
        old = {k: CARD_A[k] for k in ("season", "s", "ch", "team", "bio")}
        page = self.open(update(feed(cam_x=old)))
        page.wait_for_selector("#drv .strip")
        text = page.inner_text("#drv")
        self.assertIn("P2 in Round of 12", text)
        self.assertIn("Made-Up Motorsports", text)
        self.assertNotIn("Tonight", text)
        self.assertTrue(page.locator("#pickHint").is_hidden())         # no cards: nothing to tap
        page.click('#cars tr[data-n="2"]')
        self.assertTrue(page.locator("#pick").is_hidden())

    def test_tapping_a_driver_opens_their_card_and_again_closes_it(self):
        page = self.open(update(feed()), cards({"1": CARD_A, "2": CARD_B}))
        page.wait_for_selector("#pickHint:not([hidden])")
        self.assertTrue(page.locator("#pick").is_hidden())
        page.click('#cars tr[data-n="2"]')
        page.wait_for_selector("#pick:not([hidden])")
        self.assertIn("#2 Racer B", page.inner_text("#pickWho"))
        text = page.inner_text("#pickDrv")
        self.assertIn("Two wins in 6 starts.", text)
        self.assertIn("+8", text)
        self.assertIn("Testburg", text)
        self.assertIn("One win in 6 starts", page.inner_text("#drv"))  # the on-camera card is still its own driver's
        page.click('#cars tr[data-n="02"]')                             # a driver without a card: nothing changes
        self.assertIn("#2 Racer B", page.inner_text("#pickWho"))
        page.click('#cars tr[data-n="2"]')
        page.wait_for_selector("#pick", state="hidden")
        page.click('#cars tr[data-n="1"]')
        page.wait_for_selector("#pick:not([hidden])")
        page.click("#pickClose")
        page.wait_for_selector("#pick", state="hidden")

    def test_a_tap_still_counts_while_the_table_is_redrawn_under_it(self):
        page = self.open(update(feed()), cards({"1": CARD_A, "2": CARD_B}))
        page.wait_for_selector("#pickHint:not([hidden])")
        box = page.locator('#cars tr[data-n="2"]').bounding_box()
        page.mouse.move(box["x"] + 60, box["y"] + box["height"] / 2)
        page.mouse.down()
        FakeRelay.events.append(update(dict(feed(), track="Test Speedway 2")))      # an update lands mid-tap
        page.wait_for_function("document.getElementById('track').textContent.indexOf('Speedway 2') >= 0")
        page.mouse.up()
        page.wait_for_selector("#pick:not([hidden])")

    def test_during_the_race_the_card_follows_live_points(self):
        page = self.open(update(feed(state=4, lp=True)), cards({"1": CARD_A, "2": CARD_B}))
        page.wait_for_selector("#drv .need")
        text = page.inner_text("#drv")
        self.assertIn("P2 in live points · 1042 pts", text)
        self.assertIn("Right now: Running 2nd. 12 points below the cut line as they run.", text)
        self.assertNotIn("Tonight", text)
        page.click('#lp tr[data-n="2"]')                                # live points rows open cards too
        page.wait_for_selector("#pick:not([hidden])")
        self.assertIn("Right now: Running 1st. 12 points over the cut line as they run.", page.inner_text("#pickDrv"))
        FakeRelay.events.append(update(feed(state=5, lp=True)))
        page.wait_for_function("document.getElementById('drv').innerText.indexOf('At the finish') >= 0")
        self.assertIn("At the finish: Finished 2nd. 12 points below the cut line.", page.inner_text("#drv"))


if __name__ == "__main__":
    unittest.main()
