"""Only one copy of the overlay at a time on a PC.

Richmond, Nov 6 2026: a producer updated at the start of the night, then started the overlay again from start.bat
while the first window was still open. Windows let both copies listen on the same port, so for the whole race every
button press went to one copy or the other at random: graphics shown by the copy the broadcast wasn't reading, two
sets of standings and pit counts drifting apart, and both copies saving (and uploading) the results.

Now a second copy sees the first one answering and stops with a message instead, before it offers an update (so an
update never replaces files under a running copy). The server also takes its port exclusively on Windows
(server.QuietServer), so nothing else can share it either.
"""
import socket

MESSAGE = """
============================================================
 VSPEED is already running on this PC (port %d): the
 overlay or race control, in another window.
 Use the window that's already open; to restart it, close
 that window first, then start this again.
============================================================"""


def running(port):
    """Is something already answering on this port on this PC?"""
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except OSError:
        return False


def port_from(args, default=8765):
    """The --port the program was started with (start.bat passes none: 8765)."""
    for i, a in enumerate(args):
        if a == "--port" and i + 1 < len(args):
            try:
                return int(args[i + 1])
            except ValueError:
                pass
        if a.startswith("--port="):
            try:
                return int(a.split("=", 1)[1])
            except ValueError:
                pass
    return default
