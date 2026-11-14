"""Braking for a slow corner is not a spin (Charlotte Roval, Sports Car, Nov 12, 2026).

A steward's diagnostics from that race: the incident log's own detection logged 42 spins ("slowed from 138 to 30 mph")
and 38 car contacts ("Sudden stop next to ...") that iRacing gave no points for, 70 of the 80 at the hairpin 42% of the
way round the lap, where every car brakes from about 140 mph to about 35. On an oval a car only loses that much speed
in a crash, which is what the detection was built on (Talladega, Oct 2026).

The recording is 15 minutes of that race (laps under green, car numbers only). The black box keeps one reading a
second, so the cars' speeds are worked out here straight from how far each car moved between readings, and fed to the
incident log directly. In those 15 minutes iRacing gave #52 two points for a real spin in the last chicane, and #28
came almost to a stop (1 mph) in the hairpin behind another car (#911 was down to 14 mph there a few seconds before).
"""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import incidents
import replay

NAME = "charlotte-roval-2026-11-12-hairpin"
TRACK_M = 2.28 * 1609.344
HAIRPIN = (0.39, 0.45)             # lap position of the slow corner
SLOW_THERE = 16                    # mph: half of what the slower cars do in the hairpin (about 32)
REAL_SPIN = ("52", 2940, 2975)     # iRacing: +2x for #52 at session time 2958 (the chicane before the start line)


def readings():
    """The recording as the readings the incident log gets, with each car's speed from its lap position."""
    prev = {}
    for r in replay.load(NAME):
        cars = []
        for c in r["cars"]:
            idx, num, lap, pct, pit, surf, pos = c[0], c[1], c[2], c[3], bool(c[4]), c[5], c[6]
            if pct is None or pct < 0:
                prev.pop(idx, None)
                continue
            prog, mph, p = lap + pct, None, prev.get(idx)
            if p and 0 < r["sessTime"] - p[1] <= 2.0 and -0.01 <= prog - p[0] < 0.25:
                mph = max(0.0, prog - p[0]) * TRACK_M / (r["sessTime"] - p[1]) * 2.23694
            prev[idx] = (prog, r["sessTime"])
            cars.append({"idx": idx, "num": num, "name": "Test Driver %s" % num, "pos": pos, "progress": prog, "onTrack": True,
                         "pit": pit, "surf": surf, "mph": mph, "inc": None})
        yield {"connected": True, "isReplay": bool(r.get("replay")), "isRace": True, "sessNum": r["sess"], "sessionName": "RACE",
               "sessTime": r["sessTime"], "sessionState": r["state"], "flag": "green", "lap": 1, "trackM": TRACK_M, "cars": cars}


class Hairpin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        incidents.clear()
        incidents._store = incidents._new_store()
        where = {}
        for live in readings():
            incidents.update(live)
            now = {c["idx"]: (c["progress"] % 1.0, c["mph"]) for c in live["cars"]}
            for e in incidents.snapshot()["list"]:
                where.setdefault(e["id"], now.get(e.get("idx")) or (None, None))
        cls.crashes = [dict(e, lapPos=where[e["id"]][0], mph=where[e["id"]][1]) for e in incidents.snapshot()["list"]
                       if e["type"] in ("spin", "contact", "wall", "multi")]
        incidents.clear()
        incidents._store = incidents._new_store()

    def test_braking_for_the_hairpin_is_not_a_spin_or_a_contact(self):
        there = [(e["t"], e["num"], e["type"], e["detail"]) for e in self.crashes
                 if e["lapPos"] is not None and HAIRPIN[0] <= e["lapPos"] <= HAIRPIN[1] and e["mph"] > SLOW_THERE]
        self.assertEqual(there, [], "%d cars braking for the hairpin were logged as incidents" % len(there))

    def test_a_car_almost_stopped_in_the_hairpin_is_still_logged(self):
        found = [e for e in self.crashes if e["num"] == "28" and 2465 <= e["t"] <= 2480]
        self.assertTrue(found, [(e["t"], e["num"], e["type"]) for e in self.crashes])

    def test_few_crashes_in_fifteen_clean_minutes(self):
        # before: 32 (25 of them at the hairpin)
        self.assertLessEqual(len(self.crashes), 6, [(e["t"], e["num"], e["type"], e["detail"]) for e in self.crashes])

    def test_the_real_spin_is_still_logged(self):
        num, t0, t1 = REAL_SPIN
        found = [e for e in self.crashes if e["num"] == num and t0 <= e["t"] <= t1]
        self.assertTrue(found, "the spin iRacing gave #52 two points for is missing: %s"
                        % [(e["t"], e["num"], e["type"]) for e in self.crashes])


if __name__ == "__main__":
    unittest.main()
