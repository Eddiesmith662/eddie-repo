"""Typing into iRacing's chat, for race control's admin commands (!black, !clear, !eol, !dq, private messages).

iRacing's SDK opens a new chat window (the same as pressing T), and the letters and Enter are posted straight to the
iRacing window, so iRacing doesn't have to be in front: the steward keeps the Race Control page on screen. Tested on
a live session (Nov 2026): "!black #87 D" and "!clear #87" both took effect this way.

Windows only, using Windows' own functions (no extra package).
"""
import sys
import threading
import time

LOCK = threading.Lock()          # one command at a time, so two can't be typed into the same chat window
TITLE = "iRacing.com Simulator"
MAX_LEN = 200                    # keep commands well inside iRacing's chat line

if sys.platform == "win32":
    import ctypes
    import ctypes.wintypes as wt
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
else:
    _user32 = None

WM_KEYDOWN, WM_KEYUP, WM_CHAR, VK_RETURN = 0x0100, 0x0101, 0x0102, 0x0D


def clean(text):
    """One line of plain text: no line breaks or control characters, not too long."""
    s = "".join(ch if ch >= " " else " " for ch in str(text or ""))
    return " ".join(s.split())[:MAX_LEN]


def _window():
    if not _user32:
        return None
    found = []

    def cb(h, _):
        n = _user32.GetWindowTextLengthW(h)
        if n and _user32.IsWindowVisible(h):
            buf = ctypes.create_unicode_buffer(n + 1)
            _user32.GetWindowTextW(h, buf, n + 1)
            if TITLE in buf.value:
                found.append(h)
                return False
        return True
    _user32.EnumWindows(_EnumProc(cb), 0)
    return found[0] if found else None


def send(open_chat, text):
    """open_chat() asks iRacing (through the SDK) to open a chat window. -> (ok, error)"""
    text = clean(text)
    if not text:
        return False, "Nothing to send"
    if not _user32:
        return False, "Sending to iRacing only works on Windows"
    with LOCK:
        hwnd = _window()
        if not hwnd:
            return False, "Couldn't find the iRacing window. Is the sim running?"
        try:
            open_chat()
        except Exception as e:
            return False, "iRacing didn't open its chat (%s)" % e
        time.sleep(0.4)              # the chat box needs a moment before it takes letters
        for ch in text:
            _user32.PostMessageW(hwnd, WM_CHAR, ord(ch), 1)
            time.sleep(0.01)
        time.sleep(0.05)
        _user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
        _user32.PostMessageW(hwnd, WM_CHAR, 13, 0x001C0001)
        _user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0xC01C0001)
        time.sleep(0.1)
    return True, ""
