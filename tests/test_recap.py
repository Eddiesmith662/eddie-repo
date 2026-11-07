"""Race recap (recap.py): cautions and lead changes so far, for the bar under the VSPEED logo."""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import recap
import replay


def reading(flag="green", leader=1, laps=10, state=4, race=True, replaying=False, sub=1, ir=None):
    cars = [{"idx": leader, "lapsCompleted": laps, "progress": laps + 0.1}] + \
           [{"idx": i, "lapsCompleted": laps, "progress": laps + 0.05 - i * 0.001} for i in (7, 8) if i != leader]
    return {"connected": True, "isRace": race, "sessionState": state, "isReplay": replaying, "flag": flag, "subId": sub,
            "sessNum": 2, "sessionName": "RACE", "cars": cars, "irRecap": ir or {}}


class Counting(unittest.TestCase):
    def setUp(self):
        recap._st = recap._new(None)

    def feed(self, *readings):
        out = None
        for r in readings:
            out = recap.update(r)
        return out

    def test_a_caution_is_counted_once(self):
        out = self.feed(reading(), reading(flag="caution"), reading(flag="caution"), reading(flag="red"),
                        reading(flag="caution"), reading(), reading(flag="caution"))
        self.assertEqual(out["cautions"], 2)              # red during a caution is the same caution

    def test_started_under_caution_isnt_counted(self):
        self.assertEqual(self.feed(reading(flag="caution"), reading(flag="caution"))["cautions"], 0)

    def test_lead_change_only_at_the_line(self):
        out = self.feed(reading(leader=1, laps=10),
                        reading(leader=7, laps=10),        # passes mid-lap: not yet
                        reading(leader=1, laps=10),        # and back: no lead change
                        reading(leader=1, laps=11),        # 1 leads at the line
                        reading(leader=7, laps=12))        # 7 leads at the line: one
        self.assertEqual(out["leadChanges"], 1)

    def test_nothing_counted_from_a_replay_the_pace_laps_or_other_sessions(self):
        out = self.feed(reading(leader=1, laps=10), reading(flag="caution", replaying=True), reading(leader=7, laps=11, replaying=True),
                        reading(flag="caution", state=3), reading(flag="caution", race=False))
        self.assertEqual(out, {"cautions": 0, "leadChanges": 0})

    def test_iracings_count_when_it_is_higher(self):
        out = self.feed(reading(), reading(flag="caution", ir={"cautions": 4, "leadChanges": 9}))
        self.assertEqual(out, {"cautions": 4, "leadChanges": 9})
        out = self.feed(reading(), reading(flag="caution", ir={"cautions": 0, "leadChanges": None}))
        self.assertEqual(out["cautions"], 2)               # the overlay's own count when iRacing's is lower or missing

    def test_a_new_session_starts_over(self):
        self.feed(reading(), reading(flag="caution"))
        self.assertEqual(self.feed(reading(sub=2))["cautions"], 0)


class OnTheRecordings(unittest.TestCase):
    """Talladega, Oct 24 2026: the overlay's own count from what it saw (iRacing's isn't in these old recordings)."""

    def last(self, name):
        out = None
        for _, live in replay.replay(name):
            out = live.get("recap")
        return out

    def test_finish(self):
        # from lap 35: cautions on laps 40 and 49; #4 led at the line from lap 37, #15 from lap 45
        self.assertEqual(self.last("talladega-2026-10-24-finish"), {"cautions": 2, "leadChanges": 2})

    def test_caution(self):
        # laps 13 to 21: the caution on lap 17; #3 led at the line from lap 16
        self.assertEqual(self.last("talladega-2026-10-24-caution"), {"cautions": 1, "leadChanges": 1})


if __name__ == "__main__":
    unittest.main()
