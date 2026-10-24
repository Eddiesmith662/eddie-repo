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
        subprocess.call([sys.executable, "-m", "pip", "install", "pyirsdk"])
    # the server runs as its own process so a just-installed update is what starts
    return subprocess.call([sys.executable, os.path.join(ROOT, "server.py")] + args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
