"""The Layout tab's size boxes, on the real control panel in a browser (Playwright; skipped where it isn't installed).

Nov 15, 2026: each graphic's size was a slider that was hard to use: every movement rebuilt the whole size list, which
threw away the slider being dragged. Now each graphic has a box to type its size into, in percent of its default.
"""
import copy
import threading
import time
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import server


@unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "Playwright isn't installed here")
class LayoutSizeBox(unittest.TestCase):
    BOX = '#lyList input[data-size="tower"]'

    @classmethod
    def setUpClass(cls):
        cls.was = copy.deepcopy(server.STATE.settings.get("layout"))
        cls.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)   # port 0: a free one, never 8765/8766
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.page = cls.browser.new_page(viewport={"width": 1600, "height": 1000})
        cls.page.goto("http://127.0.0.1:%d/control" % cls.port)
        cls.page.click('#nav button[data-tab="layout"]')
        cls.page.wait_for_selector(cls.BOX, timeout=10000)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        with server.STATE.lock:
            server.STATE.settings["layout"] = cls.was

    def saved(self):
        return (server.STATE.settings.get("layout") or {}).get("tower", {}).get("s")

    def wait_saved(self, want):
        end = time.time() + 5
        while time.time() < end and self.saved() != want:
            time.sleep(0.05)
        self.assertEqual(self.saved(), want)

    def test_the_size_is_a_box_to_type_a_percent_into(self):
        self.assertEqual(self.page.locator("#lyList input[type=range]").count(), 0, "no sliders")
        self.assertEqual(self.page.get_attribute(self.BOX, "type"), "number")
        self.assertIn("%", self.page.inner_text('#lyList .lyrow[data-id="tower"]'))

    def test_typing_a_size_resizes_the_graphic_and_the_box_keeps_what_was_typed(self):
        self.page.click(self.BOX)
        self.page.fill(self.BOX, "")
        self.page.type(self.BOX, "125", delay=120)          # one key at a time, as a producer types
        self.wait_saved(1.25)
        time.sleep(0.6)                                      # the list is redrawn as the overlay reports back
        self.assertEqual(self.page.input_value(self.BOX), "125")
        self.assertTrue(self.page.evaluate("s => document.activeElement === document.querySelector(s)", self.BOX),
                        "still typing in the same box: the list wasn't rebuilt under it")

    def test_a_size_out_of_range_is_brought_back_into_it(self):
        self.page.fill(self.BOX, "500")
        self.page.press(self.BOX, "Enter")
        self.wait_saved(1.8)
        self.assertEqual(self.page.input_value(self.BOX), "180")
        self.page.fill(self.BOX, "5")
        self.page.press(self.BOX, "Enter")
        self.wait_saved(0.4)
        self.assertEqual(self.page.input_value(self.BOX), "40")

    def test_a_half_typed_size_changes_nothing(self):
        self.page.fill(self.BOX, "110")
        self.wait_saved(1.1)
        self.page.fill(self.BOX, "1")                        # on the way to typing 120: not a size yet
        time.sleep(0.4)
        self.assertEqual(self.saved(), 1.1)
        self.page.fill(self.BOX, "")
        self.page.press(self.BOX, "Enter")                   # left empty: back to what it was
        self.assertEqual(self.page.input_value(self.BOX), "110")

    def test_reset_puts_the_box_back_to_100(self):
        self.page.fill(self.BOX, "150")
        self.wait_saved(1.5)
        self.page.click('#lyList button[data-reset="tower"]')
        self.page.wait_for_function("s => document.querySelector(s) && document.querySelector(s).value === '100'", arg=self.BOX, timeout=5000)


if __name__ == "__main__":
    unittest.main()
