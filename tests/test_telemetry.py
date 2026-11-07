"""Telemetry widget data: each car's gear and RPM from iRacing (and in the black box), the demo's pretend ones."""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import replay
import server

NAME = "talladega-2026-10-24-finish"


def one_reading(extra=None):
    """The first reading of a recorded race through the real IRacingSource.tick(), with extra iRacing values added.
    Returns (live, what went into the black box)."""
    readings = replay.load(NAME)[:1]
    src = object.__new__(server.IRacingSource)
    src.irsdk, src.ir = None, replay.FakeIR(replay.RECORDINGS[NAME], readings)
    src.connected, src.last_info_update, src.drivers, src.info, src.pit_store = True, -1, {}, {}, {}
    src.ir.set(readings[0])
    src.ir.vals.update(extra or {})
    seen = []
    real = server.diag.blackbox
    server.diag.blackbox = seen.append
    try:
        live = src.tick()
    finally:
        server.diag.blackbox = real
    return live, seen[0]


class FromIRacing(unittest.TestCase):
    def test_gear_and_rpm_for_every_car(self):
        n = 30
        gear = [4] * n
        rpm = [7480.6] * n
        gear[2], rpm[2] = -1, 950.2     # one car in reverse
        gear[3], rpm[3] = 0, 1100.0     # one in neutral
        live, bb = one_reading({"CarIdxGear": gear, "CarIdxRPM": rpm})
        by = {c["idx"]: c for c in live["cars"]}
        self.assertEqual((by[0]["gear"], by[0]["rpm"]), (4, 7481))
        self.assertEqual((by[2]["gear"], by[3]["gear"]), (-1, 0))
        rec = {c[0]: c for c in bb["cars"]}
        self.assertEqual(rec[0][12:14], [4, 7481])            # recorded in the black box too

    def test_missing_from_iracing(self):
        live, bb = one_reading()                               # the old recording has no gear or RPM
        self.assertTrue(all(c["gear"] is None and c["rpm"] is None for c in live["cars"]))
        self.assertTrue(all(c[12] is None and c[13] is None for c in bb["cars"]))

    def test_replay_harness_passes_recorded_gear_through(self):
        r = replay.load(NAME)[0]
        r = dict(r, cars=[list(c) + [3, 6400] for c in r["cars"]])   # a black box from Nov 2026 on
        ir = replay.FakeIR(replay.RECORDINGS[NAME], [r])
        ir.set(r)
        i = r["cars"][0][0]
        self.assertEqual((ir["CarIdxGear"][i], ir["CarIdxRPM"][i]), (3, 6400))


class Demo(unittest.TestCase):
    def test_pretend_gear_and_rpm_follow_speed(self):
        cars = [{"mph": m} for m in (None, 0, 20, 45, 70, 120, 185)]
        server.demo_drivetrain(cars)
        self.assertEqual([c["gear"] for c in cars], [None, 0, 1, 2, 3, 4, 4])
        self.assertIsNone(cars[0]["rpm"])
        self.assertEqual(cars[1]["rpm"], 1100)
        self.assertTrue(all(2200 <= c["rpm"] <= server.DEMO_REV for c in cars[2:]))
        self.assertLess(cars[5]["rpm"], cars[6]["rpm"])      # faster in the same gear = more revs


if __name__ == "__main__":
    unittest.main()
