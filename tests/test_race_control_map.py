"""Race control's Map tab (static/rcmap.js, static/trackmaps.json): which map, where each car and incident goes.

iRacing's maps are never copied into the repo, so the placing maths is tested on a made-up oval drawn the same way
(a filled ribbon between two edges, a start/finish line and an arrow). That part runs in a browser and is skipped
where Playwright isn't installed (the producer's PC); the rest runs everywhere."""
import json
import os
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import datafiles
import racecontrol as rc
import server
from test_race_control import Race, fresh, wipe_file

STATIC = os.path.join(datafiles.ROOT, "static")


class TrackList(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(STATIC, "trackmaps.json"), encoding="utf-8") as f:
            self.maps = json.load(f)

    def test_every_track_points_at_its_own_map_on_iracings_server(self):
        self.assertEqual(self.maps["base"], "https://members-assets.iracing.com/public/track-maps/")
        self.assertGreater(len(self.maps["tracks"]), 100)
        for tid, t in self.maps["tracks"].items():
            self.assertTrue(tid.isdigit(), tid)
            # the folder's number is iRacing's track id (Bristol 101, Talladega 116, Daytona 191)
            self.assertEqual(t["folder"].split("/")[1].split("-")[0], tid, t)
            self.assertTrue(t["name"])
            self.assertIn(t.get("runs", "anticlockwise"), ("clockwise", "anticlockwise"), t)
        # the maps whose start/finish is a single arrow, at the ovals GLR races (Nov 8, 2026)
        for tid in ("214", "400", "418", "419"):
            self.assertEqual(self.maps["tracks"][tid]["runs"], "anticlockwise")

    def test_glr_venues_are_there(self):
        names = " ".join(t["name"] for t in self.maps["tracks"].values())
        for venue in ("Talladega", "Bristol", "Charlotte Motor Speedway - Oval", "Daytona International Speedway - Oval",
                      "Watkins Glen", "Darlington", "Michigan", "Kansas"):
            self.assertIn(venue, names)


class TrackIdAndIncidentPlaces(unittest.TestCase):
    def test_the_track_id_comes_from_iracings_own_data(self):
        import replay

        class TalladegaIR(replay.FakeIR):
            def __init__(self, meta, readings):
                super().__init__(meta, readings)
                self.static["WeekendInfo"].update(TrackID=116)
        real = replay.FakeIR
        replay.FakeIR = TalladegaIR
        try:
            for i, (_, live) in enumerate(replay.replay("talladega-2026-10-24-caution")):
                if i == 5:
                    break
        finally:
            replay.FakeIR = real
        self.assertEqual(live["trackId"], 116)

    def test_the_demo_shows_talladegas_map(self):
        self.assertEqual(server.DemoSource().tick()["trackId"], 116)

    def test_each_incident_knows_where_on_the_lap_it_happened(self):
        wipe_file()
        fresh()
        race = Race()
        race.step(3)
        race.set(1, inc=4, progress=12.735)
        race.step()
        q = rc.snapshot()["queue"][0]
        self.assertAlmostEqual(q["lapPos"], 0.735, places=3)
        wipe_file()


OVAL = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
<path fill="#fff" fill-rule="evenodd" d="M160,540 A800,400 0 1,0 1760,540 A800,400 0 1,0 160,540 Z
 M240,540 A720,320 0 1,0 1680,540 A720,320 0 1,0 240,540 Z"/></svg>"""
# start/finish across the bottom straight at x=960; the arrow beside it points %s
SF = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
<rect x="955" y="855" width="10" height="110" fill="red"/>
<polygon points="%s" fill="red"/></svg>"""
RIGHT, LEFT = "990,990 1030,1000 990,1010", "930,990 890,1000 930,1010"
# pit road drawn the way iRacing's older maps do it: a dashed lane inside the bottom straight (y=850, x 700 to 1220), each
# dash its own small shape, an arrow at pit entry, and the blue merge lane (further right, also y=850) in a Mergeline group
PIT = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
<g id="Mergeline">%s</g><g id="Pitroad">%s<polygon points="640,830 690,850 640,870" fill="#d82520"/></g></svg>""" % (
    "".join('<rect x="%d" y="848" width="30" height="5" fill="#0089ba"/>' % x for x in range(1300, 1520, 50)),
    "".join('<rect x="%d" y="848" width="30" height="5" fill="#d82520"/>' % x for x in range(700, 1220, 50)))
# a second pit lane inside the top straight (y=230), like Bristol's dual pit roads
PIT2 = PIT.replace("</g></svg>", "%s</g></svg>" % "".join(
    '<rect x="%d" y="228" width="30" height="5" fill="#d82520"/>' % x for x in range(700, 1220, 50)))
# the same pit lane drawn as one shape, all the dashes in a single path (Nashville, Atlanta 2022, Spielberg)
PIT_ONE_SHAPE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
<g id="Pitroad"><path fill="#d82520" d="%s"/><polygon points="640,830 690,850 640,870" fill="#d82520"/></g></svg>""" % " ".join(
    "M%d,848 h30 v5 h-30 Z" % x for x in range(700, 1220, 50))
# start/finish drawn as a single arrow beside the track, with no line (Phoenix 2021, Kansas, Nashville)
SF_ONE_ARROW = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
<polygon points="900,1000 1000,1000 1000,990 1030,1005 1000,1020 1000,1010 900,1010" fill="red"/></svg>"""


@unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "Playwright isn't installed here")
class Placing(unittest.TestCase):
    """The maths in a real browser, on the made-up oval: centre (960,540), track between 800x400 and 720x320."""

    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch()
        except Exception:
            cls.browser = cls.pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        cls.page = cls.browser.new_page()
        cls.page.set_content("<html><body></body></html>")
        cls.page.add_script_tag(path=os.path.join(STATIC, "rcmap.js"))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def place(self, arrow, positions):
        return self.page.evaluate("""([active, sf, positions]) => {
            const g = RCMap.geometry({active, 'start-finish': sf});
            return {sure: g.sure, pts: positions.map(p => RCMap.at(g, p))};
        }""", [OVAL, SF % arrow, positions])

    def test_start_finish_is_lap_position_zero_on_the_centre_line(self):
        r = self.place(RIGHT, [0, 0.9999])
        p = r["pts"][0]
        self.assertAlmostEqual(p["x"], 960, delta=12)
        self.assertAlmostEqual(p["y"], 540 + 360, delta=8)     # half way between the edges (400 and 320)

    def test_cars_go_the_way_the_arrow_points(self):
        r = self.place(RIGHT, [0.25, 0.5, 0.75])
        self.assertTrue(r["sure"])
        quarter, half, three = r["pts"]
        self.assertGreater(quarter["x"], 1600)                  # right, then over the top, then the left end
        self.assertLess(half["y"], 240)
        self.assertLess(three["x"], 320)
        r = self.place(LEFT, [0.25])
        self.assertLess(r["pts"][0]["x"], 320)                  # the other way round

    def test_the_camera_buttons_list_iracings_cameras_and_light_the_current_one(self):
        # a steward asked (Nov 14, 2026) for the overlay's camera list on the Race Control page
        page = self.browser.new_page()
        try:
            with open(os.path.join(STATIC, "racecontrol.html"), encoding="utf-8") as f:
                page.set_content(f.read())
            page.add_script_tag(path=os.path.join(STATIC, "rcmap.js"))
            got = page.evaluate("""() => {
                const sent = []; window.fetch = (u, o) => { sent.push([u, o && o.body]); return Promise.resolve(new Response('{"ok":true}')); };
                L = {connected: true, camGroup: 10, camGroups: [{num: 9, name: 'TV1'}, {num: 10, name: 'TV2'}, {num: 3, name: 'Cockpit'}]};
                renderLive();
                const names = [...document.querySelectorAll('#cams button')].map(b => b.textContent);
                const lit = [...document.querySelectorAll('#cams button.on')].map(b => b.textContent);
                document.querySelector('#cams [data-g="3"]').click();
                return {names, lit, sent: sent.filter(s => s[0] === '/api/camera').map(s => s[1])};
            }""")
            self.assertEqual(got["names"], ["TV1", "TV2", "Cockpit"])
            self.assertEqual(got["lit"], ["TV2"])
            self.assertEqual([json.loads(b) for b in got["sent"]], [{"group": 3}])
        finally:
            page.close()

    def test_a_call_is_two_short_lines_and_a_click_shows_the_rest(self):
        # Nov 14, 2026: with Calls a third of the page wide, a call with a long reason was 137 px tall (173 at
        # 1366x768) and the panel showed one or two. Now each is two lines; a click gives the full reason and command.
        page = self.browser.new_page(viewport={"width": 1366, "height": 768})
        try:
            with open(os.path.join(STATIC, "racecontrol.html"), encoding="utf-8") as f:
                page.set_content(f.read())
            got = page.evaluate("""() => {
                const reason = 'Avoidable contact in turn 3, sent the other car into the wall and did not give the place back';
                RC.calls = [{id: 'c1', at: '2026-11-14T15:00:00Z', steward: 'Steward X', kind: 'drivethrough', value: null, reason,
                    car: {idx: 3, num: '51', name: 'Driver One'}, lap: 4, status: 'active',
                    sim: {cmd: '!black #51 D ' + reason, state: 'inSim', inSimLap: 4, by: 'Steward X'}},
                  {id: 'c2', at: '2026-11-14T15:01:00Z', steward: 'Steward X', kind: 'warning', value: null, reason: 'Track limits',
                    car: {idx: 5, num: '10', name: 'Driver Two'}, lap: 5, status: 'active',
                    sim: {cmd: '/#10 Race control warning: Track limits', state: 'ready'}}];
                renderCalls();
                const rows = [...document.querySelectorAll('#calls .call')];
                const closed = rows.map(r => Math.round(r.getBoundingClientRect().height));
                const text = rows[1].innerText;
                rows[1].querySelector('.why').click();
                const open = document.querySelector('#calls .call.open');
                return {closed, text, openHeight: Math.round(open.getBoundingClientRect().height),
                        cmdShown: getComputedStyle(open.querySelector('.more')).display !== 'none',
                        buttons: [...document.querySelectorAll('#calls button')].map(b => b.textContent)};
            }""")
            self.assertTrue(all(h <= 60 for h in got["closed"]), got["closed"])
            for part in ("#51 Driver One", "IN THE SIM", "since lap 4", "Steward X"):
                self.assertIn(part.lower(), got["text"].lower())
            self.assertGreater(got["openHeight"], 60)
            self.assertTrue(got["cmdShown"])
            self.assertEqual(sorted(set(got["buttons"])), ["Send to iRacing", "Withdraw"])
        finally:
            page.close()

    def test_unconfirmed_incidents_are_off_to_review_and_the_map_until_ticked(self):
        page = self.browser.new_page()
        try:
            with open(os.path.join(STATIC, "racecontrol.html"), encoding="utf-8") as f:
                page.set_content(f.read())
            got = page.evaluate("""() => {
                const inc = (id, type, extra) => Object.assign({id, type, status: 'new', sess: 0, t: 100, lap: 3, lapPos: 0.4,
                    num: '5', name: 'Driver', detail: '', cars: []}, extra);
                RC.types = [['spin', 'Spin / Crash'], ['contact', 'Car Contact']];
                RC.queue = [inc('i1', 'spin', {unconfirmed: true}), inc('i2', 'contact', {pts: 4})];
                const seen = () => [...document.querySelectorAll('#queue .inc')].map(e => e.dataset.id);
                const onMap = []; window.RCMap = {update: (live, rc) => { onMap.length = 0; rc.queue.forEach(q => onMap.push(q.id)); }};
                const out = {};
                view = 'review'; showUnc = false; renderQueue(); renderMap();
                out.review = seen(); out.count = document.getElementById('qCount').textContent; out.map = [...onMap];
                view = 'all'; renderQueue();
                out.all = seen(); out.tag = !!document.querySelector('#queue [data-id="i1"] .tag');
                renderTypes(); const box = document.querySelector('#types [data-unc]'); box.checked = true;
                box.dispatchEvent(new Event('change', {bubbles: true}));
                view = 'review'; renderQueue();
                out.ticked = seen(); out.mapTicked = [...onMap];
                return out;
            }""")
            self.assertEqual((got["review"], got["count"], got["map"]), (["i2"], "1", ["i2"]))
            self.assertEqual(sorted(got["all"]), ["i1", "i2"])
            self.assertTrue(got["tag"])
            self.assertEqual((sorted(got["ticked"]), sorted(got["mapTicked"])), (["i1", "i2"], ["i1", "i2"]))
        finally:
            page.close()

    def test_the_page_leaves_the_browsers_own_functions_alone(self):
        # Nov 7, 2026: the page's open-an-incident function was called open(), which replaced window.open, so Pop out
        # map (and the Sign in window) did nothing.
        page = self.browser.new_page()
        try:
            with open(os.path.join(STATIC, "racecontrol.html"), encoding="utf-8") as f:
                page.set_content(f.read())
            replaced = page.evaluate("""() => ['open', 'close', 'print', 'stop', 'find', 'alert', 'confirm', 'fetch',
                'focus', 'blur', 'scroll', 'name', 'status', 'length', 'origin', 'top', 'parent']
                .filter(n => typeof window[n] === 'function' ? !/\\[native code\\]/.test(String(window[n]))
                                                              : false)""")
            self.assertEqual(replaced, [])
        finally:
            page.close()

    def pit(self, positions, pitroad=PIT, sf=None, runs=None):
        return self.page.evaluate("""([active, sf, pit, positions, runs]) => {
            const g = RCMap.geometry({active, 'start-finish': sf, pitroad: pit}, runs);
            return positions.map(p => ({track: RCMap.at(g, p), pit: RCMap.onPitRoad(g, p)}));
        }""", [OVAL, sf or SF % RIGHT, pitroad, positions, runs])

    def test_a_car_on_pit_road_is_drawn_on_the_pit_lane_beside_where_it_is(self):
        stall, = self.pit([0.0])                                 # at the start/finish line, in its pit box
        self.assertAlmostEqual(stall["pit"]["y"], 850, delta=4)  # on the pit lane...
        self.assertAlmostEqual(stall["pit"]["x"], stall["track"]["x"], delta=30)   # ...across from where it is on the lap

    def test_a_car_driving_down_pit_road_stays_on_the_pit_lane(self):
        # Phoenix, Nov 8, 2026 (practice): where the nearest bit of pit lane was a gap between two dashes, the car was
        # drawn on the track instead, so a car driving down pit road flicked between the two. The made-up lane runs
        # from about -0.07 to +0.074 of a lap; step down it a thousandth of a lap at a time.
        steps = [k / 1000 for k in range(-65, 71)]
        cars = self.pit(steps)
        for lap, c in zip(steps, cars):
            self.assertAlmostEqual(c["pit"]["y"], 850, delta=4, msg="lap position %.3f is off the pit lane" % lap)
        for a, b in zip(cars, cars[1:]):
            self.assertLess(abs(b["pit"]["x"] - a["pit"]["x"]), 15)    # no jumps

    def test_just_past_the_end_of_the_drawn_lane_it_waits_at_the_end(self):
        # Phoenix again: iRacing's drawing of the pit lane stops short of the last stalls past the start/finish line
        # (a car parked at 0.0323 there was drawn on the track). The made-up lane ends at x=1230, about 0.074.
        end, = self.pit([0.09])
        self.assertAlmostEqual(end["pit"]["y"], 850, delta=4)
        self.assertAlmostEqual(end["pit"]["x"], 1230, delta=8)

    def test_past_the_end_of_the_pit_lane_it_stays_on_the_track(self):
        # by x=1400 (0.12) the pit lane is well behind (the dashes there are the merge lane, which isn't pit road),
        # and the far end of the oval (0.25) is nowhere near it
        for p in self.pit([0.12, 0.25]):
            self.assertEqual(p["pit"], p["track"])

    def test_with_two_pit_lanes_each_car_goes_to_its_own(self):
        bottom, top = self.pit([0.0, 0.5], pitroad=PIT2)        # like Bristol's front and back pit roads
        self.assertAlmostEqual(bottom["pit"]["y"], 850, delta=4)
        self.assertAlmostEqual(top["pit"]["y"], 230, delta=4)

    def test_a_pit_lane_drawn_as_one_shape_is_used(self):
        # Nashville, Atlanta 2022, Spielberg: all the dashes in one shape, which isn't the (small, compact) entry arrow
        stall, = self.pit([0.0], pitroad=PIT_ONE_SHAPE)
        self.assertAlmostEqual(stall["pit"]["y"], 850, delta=4)

    def test_a_single_arrow_start_finish_takes_its_direction_from_the_track_list(self):
        # Phoenix 2021, Kansas, Nashville and others draw start/finish as one arrow beside the track, which doesn't show
        # which way the cars run; the track list says ("runs"). Without it, the map isn't sure (and says so).
        def quarter(runs):
            return self.page.evaluate("""([active, sf, runs]) => {
                const g = RCMap.geometry({active, 'start-finish': sf}, runs);
                return {sure: g.sure, at: RCMap.at(g, 0.25)};
            }""", [OVAL, SF_ONE_ARROW, runs])
        self.assertFalse(quarter(None)["sure"])
        anti, clock = quarter("anticlockwise"), quarter("clockwise")
        self.assertTrue(anti["sure"] and clock["sure"])
        self.assertGreater(anti["at"]["x"], 1600)   # along the bottom to the right, then up: anticlockwise as drawn
        self.assertLess(clock["at"]["x"], 320)

    def test_an_incident_is_marked_on_the_map_for_a_minute(self):
        # a steward asked (Nov 8, 2026): marks that stayed until the incident was decided piled up
        ids = self.page.evaluate("""() => RCMap.marked({sessTime: 1000}, {queue: [
            {id: 'new', status: 'new', t: 950, lapPos: 0.1},          // 50 s ago, not reviewed: marked
            {id: 'old', status: 'new', t: 930, lapPos: 0.2},          // 70 s ago, not reviewed: gone
            {id: 'done', status: 'decided', t: 990, lapPos: 0.3},     // decided, but only 10 s ago: marked
            {id: 'log', status: 'logged', t: 995, lapPos: 0.4},       // iRacing's own penalties: never marked
            {id: 'dis', status: 'dismissed', t: 995, lapPos: 0.45},  // dismissed: off the map too
            {id: 'nopos', status: 'new', t: 995, lapPos: null}]}).map(q => q.id)""")
        self.assertEqual(ids, ["new", "done"])

    def test_a_lap_and_a_bit_lands_where_the_bit_does(self):
        a, b = self.place(RIGHT, [0.3, 12.3])["pts"]
        self.assertAlmostEqual(a["x"], b["x"], delta=0.5)
        self.assertAlmostEqual(a["y"], b["y"], delta=0.5)


if __name__ == "__main__":
    unittest.main()
