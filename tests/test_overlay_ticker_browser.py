"""The ticker on the real overlay page, in a browser (Playwright; skipped where it isn't installed).

Nov 8, 2026, Phoenix: the producer's OBS/vMix browser (Chrome 127) left the ticker folded away when it came up at the
start. The page's check put the rows back ("rows put back on screen (fixed itself)"), but the lap and flag line above
them stayed hidden for the whole race: the check only looked at the rows. The glitch itself only happens in that older
browser, so here the line is held folded with a style rule, as the diagnostics showed it: clipped to nothing, with no
animation running.
"""
import os
import threading
import time
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import replay
import server


@unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "Playwright isn't installed here")
class TickerComesBack(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live = None
        for r, lv in replay.replay("talladega-2026-10-24-caution"):
            live = lv
            if lv.get("flag") == "green" and (lv.get("lap") or 0) >= 20:
                break                                          # racing under green, with a lap count to show
        cls.was = server.STATE.live, server.STATE.settings.get("show")
        server.STATE.set_live(live)
        cls.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)   # port 0: a free one, never 8765/8766
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.page = cls.browser.new_page(viewport={"width": 1920, "height": 1080})
        cls.page.goto("http://127.0.0.1:%d/overlay?preview" % cls.port)    # ?preview: not the broadcast copy

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.STATE.set_live(cls.was[0])
        server.STATE.settings["show"] = cls.was[1]

    def ticker(self, on):
        server.STATE.update_settings({"show": {"tower": on}})

    def bring_up_stuck(self, stuck):
        """Take the ticker down, hold `stuck` folded the way OBS left it, and bring it back up."""
        self.ticker(False)
        self.page.wait_for_function("document.getElementById('tower').classList.contains('off')", timeout=5000)
        self.page.evaluate("""css => { let s = document.getElementById('stuck');
            if (!s) { s = document.createElement('style'); s.id = 'stuck'; document.head.appendChild(s); }
            s.textContent = css ? css + ' { clip-path: inset(0px 0px 100%) !important; }' : ''; }""", stuck)
        self.ticker(True)
        self.page.wait_for_function("!document.getElementById('tower').classList.contains('off')", timeout=5000)
        time.sleep(4)                                          # the check runs about 2.5 s after it comes up

    def clipped(self, sel):
        return self.page.evaluate("s => getComputedStyle(document.querySelector(s)).clipPath", sel)

    def test_the_lap_line_comes_back_with_the_rows(self):
        # tonight's case: the rows and the lap line both left folded
        self.bring_up_stuck("#tower .sub, #tRows")
        self.assertNotIn("100%", self.clipped("#tRows"))
        self.assertNotIn("100%", self.clipped("#tower .sub"))
        self.assertTrue(self.page.evaluate("document.getElementById('tSub').textContent.trim().length > 0"))

    def test_the_lap_line_comes_back_on_its_own(self):
        self.bring_up_stuck("#tower .sub")
        self.assertNotIn("100%", self.clipped("#tower .sub"))

    def test_the_title_bar_comes_back(self):
        self.bring_up_stuck("#tower .head")
        self.assertNotIn("100%", self.clipped("#tower .head"))

    def test_the_fix_is_dropped_when_the_ticker_goes_down(self):
        # the fix's inline styles would stop the line folding away next time
        self.bring_up_stuck("#tower .sub")
        self.assertIn("important", self.page.evaluate("document.querySelector('#tower .sub').getAttribute('style') || ''"))
        self.ticker(False)
        self.page.wait_for_function("document.getElementById('tower').classList.contains('off')", timeout=5000)
        self.assertNotIn("clip-path", self.page.evaluate("document.querySelector('#tower .sub').getAttribute('style') || ''"))

    def test_the_page_says_what_it_put_back(self):
        logged = []
        real = server.diag.client_error
        server.diag.client_error = lambda d: logged.append(str((d or {}).get("msg", "")))
        try:
            self.bring_up_stuck("#tower .sub")
        finally:
            server.diag.client_error = real
        self.assertTrue(any("Ticker up with its lap line hidden" in m for m in logged), logged)

    def test_a_ticker_that_came_up_fine_is_left_alone(self):
        self.bring_up_stuck("")
        self.assertEqual(self.page.evaluate("document.querySelector('#tower .sub').getAttribute('style') || ''"), "")


if __name__ == "__main__":
    unittest.main()
