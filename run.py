"""Starts the overlay: checks for an update first, makes sure the iRacing package is
installed, then runs the server. start.bat and start-demo.bat call this.

Pass --no-update to skip the update check."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)


def main():
    args = sys.argv[1:]
    try:   # updates and startup problems go into the log file too
        import diag, update as _u
        diag.setup(_u.local_version(), "launcher")
    except Exception:
        pass
    if "--no-update" in args:
        args.remove("--no-update")
    else:
        try:
            import update
            update.offer_update()
        except Exception as e:      # an update problem must never stop the overlay from starting
            print("Update check failed (%s); starting anyway." % e)
    try:
        import irsdk  # noqa: F401
    except ImportError:
        if "--demo" in args:      # the fake race doesn't need it
            return subprocess.call([sys.executable, os.path.join(ROOT, "server.py")] + args)
        print("Installing pyirsdk (the iRacing connection)...")
        try:
            import update
            update.pip_install(["pyirsdk"], "pyirsdk (the iRacing connection)")
        except Exception as e:
            print("Could not run pip: %s" % e)
        # pip says it worked, but check the overlay can really load it (a fresh process sees the new install)
        if subprocess.call([sys.executable, "-c", "import irsdk"], stderr=subprocess.DEVNULL) != 0:
            v = "%d.%d" % sys.version_info[:2]
            print()
            print("!! The iRacing connection (pyirsdk) couldn't be installed for Python %s." % v)
            print("!! A brand-new Python sometimes arrives before every package has caught up.")
            print("!! Fix: install Python 3.13 from python.org (tick \"Add Python to PATH\"), then run start.bat again.")
            print("!! Starting the demo race in the meantime.")
            print()
    # the server runs as its own process so a just-installed update is what starts
    return subprocess.call([sys.executable, os.path.join(ROOT, "server.py")] + args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
