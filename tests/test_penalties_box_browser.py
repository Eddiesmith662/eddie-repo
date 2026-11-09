"""The Penalties box above the live timing, in a browser (Playwright; skipped where it isn't installed).

Nov 8, 2026: race control's calls with no black flag stayed in the box all race, one tall row each, and pushed the live
timing off the screen. The box now scrolls past about three rows and collapses to one line; a new black flag opens it.
"""
import threading
import time
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import rcfeed
import replay
import server


def rc_call(i):
    return {"uid": "p:c%d" % i, "kind": "warning", "amount": 0, "reason": "Test reason %d" % i, "carNumber": str(10 + i),
            "driverName": "Racer %d" % (10 + i), "lap": 30 + i, "madeAt": "2026-11-08T20:%02d:00Z" % (10 + i), "status": "active"}


@unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "Playwright isn't installed here")
class PenaltiesBox(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live = None
        for r, lv in replay.replay("talladega-2026-10-24-caution"):
            live = lv
            if lv.get("flag") == "green" and (lv.get("lap") or 0) >= 20:
                break
        cls.was = server.STATE.live, rcfeed.listed
        server.STATE.set_live(live)
        cls.calls = [rc_call(i) for i in range(8)]
        rcfeed.listed = lambda: list(reversed(cls.calls))
        with server.STATE.lock:
            server.PEN.update(seq=0, list=[], prev={}, init=True, hide=0, rcShown={})
        cls.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)   # port 0: a free one, never 8765/8766
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.page = cls.browser.new_page(viewport={"width": 1280, "height": 800})

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.STATE.set_live(cls.was[0])
        rcfeed.listed = cls.was[1]
        with server.STATE.lock:
            server.PEN.update(seq=0, list=[], prev={}, init=False, hide=0, rcShown={})

    def setUp(self):
        self.page.goto("http://127.0.0.1:%d/timing" % self.port)
        self.page.evaluate("localStorage.removeItem('vsPensCollapsed')")
        self.page.reload()
        self.page.wait_for_function("!document.getElementById('pens').hidden && document.querySelectorAll('#pens .pen').length >= 8", timeout=8000)

    def box(self):
        return self.page.evaluate("""() => { const b = document.getElementById('pens').getBoundingClientRect(),
            c = document.getElementById('cars').getBoundingClientRect();
            return {h: b.height, carsTop: c.top, text: document.querySelector('#pens .ph span').textContent}; }""")

    def flag(self, n):
        with server.STATE.lock:
            server.PEN["seq"] += 1
            server.PEN["list"].append({"id": server.PEN["seq"], "idx": n, "num": str(n), "name": "Racer %d" % n, "pos": 5,
                                       "reason": "", "active": True, "t": time.time(), "show": 0})
            server.STATE.bump()

    def test_eight_calls_leave_the_live_timing_in_view(self):
        b = self.box()
        self.assertLess(b["h"], 240)                     # about three rows and the header, then it scrolls
        self.assertLess(b["carsTop"], 400)               # the live timing starts in the top half of the window

    def test_collapse_is_one_line_and_remembered(self):
        self.page.click("#pens [data-pcol]")
        b = self.box()
        self.assertLess(b["h"], 50)
        self.assertIn("8 race control calls", b["text"])
        self.page.reload()
        self.page.wait_for_function("!document.getElementById('pens').hidden", timeout=8000)
        self.assertEqual(self.page.evaluate("document.querySelectorAll('#pens .pen').length"), 0)

    def test_a_new_black_flag_opens_it_again(self):
        self.page.click("#pens [data-pcol]")
        self.assertEqual(self.page.evaluate("document.querySelectorAll('#pens .pen').length"), 0)
        self.flag(42)
        self.page.wait_for_function("document.querySelector('#pens .pen[data-pid]')", timeout=8000)
        self.assertIn("#42", self.page.evaluate("document.querySelector('#pens .pen[data-pid]').textContent"))


if __name__ == "__main__":
    unittest.main()
