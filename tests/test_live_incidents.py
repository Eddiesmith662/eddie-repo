"""Live incident points for a session admin (Nov 9, 2026). iRacing fills in the driver list's incident counts live for an
admin, while the results' Incidents stay 0 until the checkered; the incident log and race control now use the live ones.
League race, Nov 9: results 0 the whole time, the driver list 48 -> 73 points over 5 minutes, five cars at once in a
wreck. Made-up drivers only."""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import incidents
from server import live_inc


def car(idx, inc):
    return {"idx": idx, "num": str(10 + idx), "name": "Racer %d" % idx, "pos": idx, "inc": inc, "surf": 3, "lap": 30,
            "pit": False, "mph": 180.0}


def reading(t, incs, live=True, state=4):
    return {"connected": True, "isRace": True, "sessNum": 2, "sessionName": "RACE", "sessTime": t, "sessionState": state,
            "flag": "green", "lap": 30, "incLive": live, "cars": [car(i, n) for i, n in enumerate(incs, 1)]}


class LiveCount(unittest.TestCase):
    def test_the_driver_lists_count_when_its_higher(self):
        self.assertEqual(live_inc(0, 8), 8)              # an admin: results 0 until the checkered, the driver list live
        self.assertEqual(live_inc(9, 8), 9)              # the results caught up
        self.assertEqual(live_inc(0, 0), 0)              # not an admin: the driver list says 0
        self.assertEqual(live_inc(None, None), None)
        self.assertEqual(live_inc(None, 4), 4)


class BigWreck(unittest.TestCase):
    def setUp(self):
        incidents.clear()
        incidents._store = incidents._new_store()

    def tearDown(self):
        incidents.clear()
        incidents._store = incidents._new_store()

    def logged(self):
        return [(e["num"], e.get("pts")) for e in incidents.STATE["list"] if e.get("idx") is not None]

    def test_five_cars_at_once_with_live_counts_is_a_wreck(self):
        incidents.update(reading(100.0, [4, 4, 4, 0, 4]))
        incidents.update(reading(102.0, [8, 8, 5, 4, 8]))   # 19:23:45 on Nov 9: five cars in the same second
        self.assertEqual(sorted(self.logged()), [("11", 4), ("12", 4), ("13", 1), ("14", 4), ("15", 4)])

    def test_without_live_counts_it_is_still_the_final_counts_arriving(self):
        # Oct 25: the results published 17 drivers' points in the same second after the finish
        incidents.update(reading(100.0, [0, 0, 0, 0, 0], live=False))
        incidents.update(reading(102.0, [4, 4, 1, 2, 4], live=False))
        self.assertEqual(self.logged(), [])

    def test_one_car_is_logged_either_way(self):
        incidents.update(reading(100.0, [0, 0], live=False))
        incidents.update(reading(102.0, [2, 0], live=False))
        self.assertEqual(self.logged(), [("11", 2)])


if __name__ == "__main__":
    unittest.main()
