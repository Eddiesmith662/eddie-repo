"""The start files a steward or producer double-clicks: race control's desktop shortcut and the first-run setup.
(Checked by running them in a throwaway copy too: a fresh Python download, the shortcut made once, minimized, with
its icon. Running batch files isn't part of these tests.)"""
import os
import struct
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


class Launchers(unittest.TestCase):
    def test_race_control_makes_its_shortcut_once(self):
        start = read("start-race-control.bat")
        self.assertIn('if not exist "data\\steward\\desktop-shortcut.txt" call "%~dp0race-control-shortcut.bat"', start)
        # the shortcut comes after Python is ready and before race control starts (the last line must stay last)
        lines = [l for l in start.splitlines() if l and not l.startswith("rem")]
        self.assertTrue(lines[-1].startswith('"%PY%" %PYARGS% run.py --race-control'))
        made = read("race-control-shortcut.bat")
        self.assertIn("VSPEED Race Control.lnk", made)
        self.assertIn("WindowStyle = 7", made)                               # minimized
        self.assertIn("data\\steward\\desktop-shortcut.txt", made)           # remembered, so it isn't put back
        self.assertIn("static\\assets\\race-control.ico", made)

    def test_the_icon(self):
        with open(os.path.join(ROOT, "static", "assets", "race-control.ico"), "rb") as f:
            data = f.read()
        reserved, kind, count = struct.unpack("<HHH", data[:6])
        self.assertEqual((reserved, kind), (0, 1))
        sizes = set()
        for i in range(count):
            w, h, _, _, _, bits, length, offset = struct.unpack("<BBBBHHII", data[6 + 16 * i:22 + 16 * i])
            self.assertEqual(data[offset:offset + 8], b"\x89PNG\r\n\x1a\n")
            self.assertLessEqual(offset + length, len(data))
            sizes.add(w or 256)
        self.assertTrue({16, 32, 48, 256} <= sizes)

    def test_first_run_reads_plainly(self):
        setup = read("python-setup.bat")
        self.assertIn("Setting up VSPEED: one time only, about a minute", setup)
        self.assertNotIn("throw ", setup)                                    # no red PowerShell error text
        self.assertIn('-C "%PYTMP%" >nul 2>nul', setup)

    def test_batch_files_have_windows_line_endings(self):
        for name in ("start-race-control.bat", "race-control-shortcut.bat", "python-setup.bat"):
            with open(os.path.join(ROOT, name), "rb") as f:
                data = f.read()
            self.assertEqual(data.count(b"\n"), data.count(b"\r\n"), name)


if __name__ == "__main__":
    unittest.main()
