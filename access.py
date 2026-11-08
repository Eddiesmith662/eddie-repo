"""Who may use the overlay (Nov 2026, plan doc Decisions: "Producers sign in to use the overlay").

The overlay only runs for a producer signed in to the league site (GLR HUB) with Discord. The sign-in itself is the
one in leagueupload.py (glr/OVERLAY-SIGNIN.md): the same sign-in sends the results, so there is one sign-in for all of it.

  - At start-up (and once a producer presses Allow, or Try again) the overlay asks the site GET /api/overlay/check,
    which answers with the person's "perms", read fresh from their Discord roles: "overlay" opens the overlay,
    "upload" sends results. Anyone with the Producer role gets both; an admin can Block a person on the site.
  - Never during a race: once the overlay is open it stays open until it's closed, whatever the site says meanwhile.
  - Offline: if the site can't be reached, the last good answer counts for 5 days, so a site outage or no internet
    on race night can't stop a show. After 5 days without reaching the site, it asks for the internet once.
  - An overlay key (vsglr_...) still sends results, but doesn't open the overlay: only a person's sign-in does.
  - Race control (start-race-control.bat) doesn't use this: stewards have their own sign-in (rcsite.py).

Until it's allowed, the control panel shows only the sign-in screen and the broadcast pages stay blank (server.py);
telemetry keeps running underneath, so nothing is missed once someone signs in.
"""
import math
import threading
import time

import diag
import leagueupload as lu

OFFLINE_DAYS = 5
OFFLINE = OFFLINE_DAYS * 86400
# what the control panel shows: the state, a message for the producer, who is signed in, and (offline) days left
#   checking  asking the site (start-up)
#   ok        allowed
#   offline   allowed on the last good answer: the site couldn't be reached
#   signin    nobody signed in on this PC (or the site signed it out)
#   denied    signed in, but this person may not use the overlay (no Producer role)
#   blocked   an admin turned this person's overlay access off on the site
#   offline-wait  the site can't be reached and there's no good answer from the last 5 days
STATUS = {"state": "checking", "msg": "Checking your sign-in with the league site…", "user": "", "daysLeft": None}
_lock = threading.Lock()
_busy = threading.Lock()
ON_CHANGE = None               # server.py: tell the pages
ENABLED = {"on": False}        # switched on by start() in overlay mode; race control and most tests never gate


def allowed():
    return not ENABLED["on"] or STATUS["state"] in ("ok", "offline")


def status():
    with _lock:
        return dict(STATUS, allowed=allowed())


def _set(state, msg, user="", days=None):
    with _lock:
        changed = (STATUS["state"], STATUS["msg"]) != (state, msg)
        STATUS.update(state=state, msg=msg, user=user, daysLeft=days)
    if changed:
        diag.log("Overlay access: %s%s" % (state, (" (%s)" % msg) if msg else ""))
    rec = lu.access_record()                         # no answer kept: let the site decide when results are sent
    lu.set_upload_allowed(not rec or "upload" in rec.get("perms", []))
    if ON_CHANGE:
        try:
            ON_CHANGE()
        except Exception as e:
            diag.error("Overlay access: %r" % (e,), e)


def _offline(why):
    """The site couldn't be reached (or had a problem): use the last good answer if it's from the last 5 days."""
    rec = lu.access_record()
    now = time.time()
    at = float((rec or {}).get("at") or 0)
    user = ((rec or {}).get("user") or {}).get("name", "")
    if rec and "overlay" in rec.get("perms", []) and at <= now + 86400 and now - at < OFFLINE:
        left = min(OFFLINE_DAYS, max(1, math.ceil((OFFLINE - (now - at)) / 86400)))
        return _set("offline", "%s. Working offline: the overlay needs to reach the league site within %d day%s."
                    % (why, left, "" if left == 1 else "s"), user, left)
    if rec and "overlay" in rec.get("perms", []):
        return _set("offline-wait", "%s, and the overlay hasn't reached it for over %d days. Connect this PC to the "
                    "internet, then press Try again." % (why, OFFLINE_DAYS), user)
    return _set("offline-wait", "%s, so your sign-in can't be checked. Connect this PC to the internet, then press "
                "Try again." % why, user)


def check():
    """Ask the site whether this PC's sign-in may use the overlay. Start-up, after Allow, and Try again only."""
    if not _busy.acquire(blocking=False):
        return                                       # already asking
    try:
        _check()
    except Exception as e:                           # never leaves the overlay stuck on "checking"
        diag.error("Overlay access: %r" % (e,), e)
        _offline("Couldn't check with the league site")
    finally:
        _busy.release()


def _check():
    token = lu.token()
    if not token:
        lu.save_access(None)
        return _set("signin", "Sign in with your Discord account to use the overlay.")
    with _lock:
        if STATUS["state"] not in ("ok", "offline"):
            STATUS.update(state="checking", msg="Checking your sign-in with the league site…")
    if ON_CHANGE:
        ON_CHANGE()
    try:
        code, j = lu._request("/api/overlay/check", token)
    except Exception as e:                           # the reason goes in the log, not on the producer's screen
        diag.log("Overlay access: couldn't reach the league site: %s" % (getattr(e, "reason", None) or e))
        return _offline("Couldn't reach the league site")
    j = j if isinstance(j, dict) else {}
    who = lu.signed_in() or {}
    if code == 200 and j.get("ok"):
        u = j.get("user") if isinstance(j.get("user"), dict) else who
        user = {"id": str(u.get("id", "")), "name": str(u.get("name", ""))}
        perms = [str(p) for p in (j.get("perms") or []) if isinstance(p, str)]
        if "overlay" not in perms:
            lu.save_access(None)
            return _set("denied", "Your Discord account (%s) doesn't have overlay access on the league site. Ask a "
                        "GLR HUB admin for the Producer role, or sign in with another account." % (user["name"] or "?"), user["name"])
        lu.save_access({"user": user, "perms": perms, "at": time.time()})
        return _set("ok", "", user["name"])
    if code == 401:
        lu.forget_token()                            # signed out on the site's Keys page, a year unused, or left the Discord
        return _set("signin", "This PC was signed out of the league site. Sign in with Discord again.")
    if code == 403 and j.get("blocked"):
        lu.save_access(None)
        return _set("blocked", j.get("error") or "Your overlay access was turned off by a GLR HUB admin. Ask an admin "
                    "to turn it back on.", who.get("name", ""))
    if code == 403:
        lu.save_access(None)
        return _set("denied", j.get("error") or "Your Discord account doesn't have the Producer role on the league site. "
                    "Ask a GLR HUB admin, or sign in with another account.", who.get("name", ""))
    return _offline("The league site had a problem (%s)" % code)


def check_soon():
    threading.Thread(target=check, daemon=True, name="overlay-access").start()


def start(on_change=None):
    """Overlay mode only (server.py main): the start-up check, in the background so the pages open straight away."""
    global ON_CHANGE
    ON_CHANGE = on_change
    ENABLED["on"] = True
    check_soon()
