"""Imported first by every test: points the program at a throwaway data folder, so the tests never read or change the
real data folder (settings, standings, series, results), then makes the program's modules importable."""
import atexit
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

if "datafiles" in sys.modules and not os.environ.get("VSPEED_DATA"):
    raise RuntimeError("the program was imported before tests/support.py: it would use the real data folder")

if not os.environ.get("VSPEED_DATA"):
    DATA = tempfile.mkdtemp(prefix="vspeed-tests-")
    os.environ["VSPEED_DATA"] = DATA
    atexit.register(shutil.rmtree, DATA, True)
DATA = os.environ["VSPEED_DATA"]

if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import datafiles  # noqa: E402

assert os.path.abspath(datafiles.DATA) == os.path.abspath(DATA), "tests must never use the real data folder"
