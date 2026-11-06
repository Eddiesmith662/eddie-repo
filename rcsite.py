"""Race control <-> the league site (plan phase 5c): signing in, sending each race's calls, reading the other stewards'.

Signing in: the steward presses Sign in, allows race control on the site with their Discord account, and the site
hands this PC a race control token (it lasts until they sign out, or until it's turned off on the site's Keys page or
their steward role is taken away). The token is kept only in data/race-control/signin.json, never in settings.json,
the logs or the diagnostics zip.

Sending: after every change to a race's calls, the whole race (every call made on this PC) is sent to the site with
PUT /glr/api/rc/races/<session>. Sending twice is harmless: the site adds or updates each call by its uid
("<this PC's id>:<call id>"). Races waiting to go are listed in data/race-control/outbox.json, so a race that couldn't
be sent (site down, internet out) goes when the program next can, even after a restart. A race the site turns down
(not a GLR series, or no steward role for it) is kept on this PC with the site's reason, and tried again only when
one of its calls changes.

Reading back: every 10 seconds while a race is open, GET /glr/api/rc/races/<session> gives every call on the race:
the other stewards' (shown in the call log under their name) and this PC's, so a call an official withdrew on the
site shows withdrawn here too.

The demo race (no iRacing league or session id) never goes to the site. The request format is in the plan doc, Race
control -> "Sending calls to the site (phase 5c)".
"""
import json
import os
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request

import datafiles
import leagueupload
import net
import racecontrol

SITE = leagueupload.SITE         # the same league site the results go to
SIGNIN_FILE = os.path.join(racecontrol.DIR, "signin.json")     # {"pc", "token", "user": {"id", "name"}}
OUTBOX_FILE = os.path.join(racecontrol.DIR, "outbox.json")     # {"pending": [race keys], "refused": {race key: why}}
READ_EVERY = 10.0              # seconds between reading the open race back from the site
POLL_EVERY = 2.0               # seconds between checks while the steward is allowing race control on the site
RETRY = (15, 30, 60, 60)       # seconds before trying again when the site can't be reached
TRY_AGAIN = (408, 425, 429)    # the site was busy: try again, like any server problem

LOCK = threading.Lock()
_log = print
_wake = threading.Event()
_st = {"pc": "", "token": "", "user": None, "link": None, "pending": [], "refused": {}, "fails": 0, "nextTry": 0.0,
       "lastRead": 0.0, "readKey": None}
STATUS = {"state": "out", "msg": "", "last": ""}


# ---------------------------------------------------------------- saved files
def _save_signin():
    datafiles.write_json(SIGNIN_FILE, {"pc": _st["pc"], "token": _st["token"], "user": _st["user"]}, indent=1)


def _save_outbox():
    try:
        datafiles.write_json(OUTBOX_FILE, {"pending": _st["pending"], "refused": _st["refused"]}, indent=1)
    except OSError as e:
        _log("Race control: couldn't save the list of races waiting for the site (%s)" % e)


def _load():
    s = datafiles.load_json(SIGNIN_FILE, {}, backup=True) or {}
    s = s if isinstance(s, dict) else {}
    _st["pc"] = str(s.get("pc") or "")
    _st["token"] = str(s.get("token") or "")
    _st["user"] = s.get("user") if isinstance(s.get("user"), dict) else None
    if not _st["pc"]:                       # made once per install, so two stewards' PCs never clash on the site
        _st["pc"] = secrets.token_hex(4)
        try:
            _save_signin()
        except OSError as e:
            _log("Race control: couldn't save this PC's id (%s)" % e)
    o = datafiles.load_json(OUTBOX_FILE, {}, backup=True) or {}
    o = o if isinstance(o, dict) else {}
    _st["pending"] = [str(k) for k in o.get("pending") or [] if k]
    _st["refused"] = {str(k): str(v) for k, v in (o.get("refused") or {}).items()}


def _set(state, msg=""):
    if (STATUS["state"], STATUS["msg"]) != (state, msg):
        STATUS["state"], STATUS["msg"] = state, msg
        racecontrol.touch()                  # the page shows it


# ---------------------------------------------------------------- talking to the site
def _request(method, path, body=None, token=None, timeout=15):
    """-> (http status, json answer). Raises when the site can't be reached at all."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "VSPEED-RaceControl"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(SITE + path, data=data, method=method, headers=headers)
    try:
        r = net.urlopen(req, timeout)
        return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}


def _why(e):
    return str(getattr(e, "reason", None) or e)


# ---------------------------------------------------------------- signing in and out
def token():
    """The race control token, or "" (also used by the league upload, for official results with no overlay key)."""
    with LOCK:
        return _st["token"]


def user():
    with LOCK:
        return dict(_st["user"]) if _st["token"] and _st["user"] else None


def sign_in():
    """Sign in pressed: ask the site for a code. -> (ok, error, {"url", "code"}) The page opens the url."""
    try:
        code, j = _request("POST", "/api/rc/link", {"pc": (socket.gethostname() or "race control")[:40]})
    except Exception as e:
        return False, "Couldn't reach the league site (%s)" % _why(e), None
    if code != 200 or not j.get("ok") or not j.get("poll"):
        return False, j.get("error") or "The site said no (%s)" % code, None
    with LOCK:
        _st["link"] = {"code": j.get("code", ""), "url": j.get("url", ""), "poll": j["poll"],
                       "until": time.time() + float(j.get("expiresIn") or 600), "next": 0.0}
    _set("linking", "Press Allow on the site (code %s)" % j.get("code", ""))
    _log("Race control: signing in to the league site (code %s)" % j.get("code", ""))
    _wake.set()
    return True, "", {"url": j.get("url", ""), "code": j.get("code", "")}


def cancel_sign_in():
    with LOCK:
        _st["link"] = None
    _set("out" if not _st["token"] else "ok", "")


def _poll_link():
    with LOCK:
        link = _st["link"]
    if not link or time.time() < link["next"]:
        return
    if time.time() > link["until"]:
        with LOCK:
            _st["link"] = None
        return _set("out", "The sign-in code ran out. Press Sign in to try again.")
    link["next"] = time.time() + POLL_EVERY
    try:
        code, j = _request("POST", "/api/rc/link/poll", {"poll": link["poll"]})
    except Exception:
        return                                  # try again in 2 s
    state = j.get("state")
    if code == 200 and state == "ok" and j.get("token"):
        u = j.get("user") or {}
        with LOCK:
            _st.update(token=str(j["token"]), user={"id": str(u.get("id", "")), "name": str(u.get("name", ""))}, link=None)
            for key in _st["refused"]:           # a race turned down before may be allowed now
                if key not in _st["pending"]:
                    _st["pending"].append(key)
            _st["refused"] = {}
            try:
                _save_signin()
            except OSError as e:
                _log("Race control: couldn't save the sign-in (%s); it lasts until the program closes" % e)
            _save_outbox()
        current = racecontrol.current_key()
        if current:
            mark(current)
        _set("ok", "Signed in as %s" % _st["user"]["name"])
        _log("Race control: signed in to the league site as %s" % _st["user"]["name"])
    elif state == "expired" or code != 200:
        with LOCK:
            _st["link"] = None
        _set("out", "The sign-in code ran out. Press Sign in to try again.")


def sign_out():
    with LOCK:
        tok, name = _st["token"], (_st["user"] or {}).get("name", "")
        _st.update(token="", user=None, link=None)
        try:
            _save_signin()
        except OSError:
            pass
    if tok:
        try:
            _request("POST", "/api/rc/signout", token=tok)
        except Exception:
            pass                                # the token is gone from this PC either way
        _log("Race control: %s signed out of the league site" % (name or "the steward"))
    _set("out", "")
    return True


def _signed_out_by_site(why):
    with LOCK:
        _st.update(token="", user=None)
        try:
            _save_signin()
        except OSError:
            pass
    _set("out", (why or "The site turned this sign-in off.") + " Press Sign in to sign in again.")
    _log("Race control: the league site turned the sign-in off (%s)" % why)


def check():
    """Test pressed. -> (ok, message)"""
    tok = token()
    if not tok:
        return False, "Not signed in"
    try:
        code, j = _request("GET", "/api/rc/check", token=tok)
    except Exception as e:
        return False, "Couldn't reach the league site (%s)" % _why(e)
    if code == 401:
        _signed_out_by_site(j.get("error"))
        return False, j.get("error") or "Signed out"
    if code == 200 and j.get("ok"):
        series = j.get("series")
        return True, "Signed in as %s, steward for %s" % ((j.get("user") or {}).get("name", ""),
                                                          "every series" if series == "all" else "%d series" % len(series or []))
    return False, j.get("error") or "The site said no (%s)" % code


# ---------------------------------------------------------------- sending races
def mark(key):
    """A race's calls changed (racecontrol tells us): queue it for the site."""
    if not key:
        return
    with LOCK:
        if key not in _st["pending"]:
            _st["pending"].append(key)
        _st["refused"].pop(key, None)
        _st["nextTry"] = 0.0 if not _st["fails"] else _st["nextTry"]
        _save_outbox()
    _wake.set()


def _send_pending():
    with LOCK:
        tok, todo = _st["token"], list(_st["pending"])
        if not tok or not todo or time.time() < _st["nextTry"]:
            return
    for key in todo:
        f, ver = racecontrol.race_file(key, _st["pc"])
        if f is None:                           # the demo race, or a file that's gone: nothing to send
            with LOCK:
                _st["pending"] = [k for k in _st["pending"] if k != key]
                _save_outbox()
            continue
        try:
            code, j = _request("PUT", "/api/rc/races/%s" % f["subsessionId"], f, token=tok)
        except Exception as e:
            with LOCK:
                _st["fails"] += 1
                wait = RETRY[min(_st["fails"], len(RETRY)) - 1]
                _st["nextTry"] = time.time() + wait
            return _set("waiting", "Can't reach the league site (%s): calls are kept here and sent in %d s" % (_why(e), wait))
        if code == 401:
            return _signed_out_by_site(j.get("error"))
        with LOCK:
            if code == 200 and j.get("ok"):
                _st["fails"], _st["nextTry"] = 0, 0.0
                if racecontrol.version_of(key) == ver:          # nothing changed while it was on its way
                    _st["pending"] = [k for k in _st["pending"] if k != key]
                _save_outbox()
                STATUS["last"] = time.strftime("%H:%M")
                ok = True
            elif 400 <= code < 500 and code not in TRY_AGAIN:
                why = j.get("error") or "the site answered %s" % code
                _st["pending"] = [k for k in _st["pending"] if k != key]
                _st["refused"][key] = why
                _save_outbox()
                ok = False
            else:
                _st["fails"] += 1
                wait = RETRY[min(_st["fails"], len(RETRY)) - 1]
                _st["nextTry"] = time.time() + wait
                ok = None
        if ok:
            racecontrol.apply_site(key, j.get("decisions") or [], _st["pc"])
            n = len(f["calls"])
            _set("ok", "Race %s: %d call%s on the site (%s)" % (f["subsessionId"], n, "" if n == 1 else "s", STATUS["last"]))
        elif ok is False:
            _set("refused", "Race %s not taken: %s. The calls are kept on this PC." % (f["subsessionId"], why))
            _log("Race control: the league site turned down race %s (%s)" % (f["subsessionId"], why))
        else:
            return _set("waiting", "The league site had a problem (%s): calls are kept here and sent in %d s" % (code, wait))


def _read_back():
    key = racecontrol.current_key()
    tok = token()
    if not tok or not key or time.time() - _st["lastRead"] < READ_EVERY:
        return
    sub = racecontrol.race_sub(key)
    if not sub:
        return
    _st["lastRead"] = time.time()
    try:
        code, j = _request("GET", "/api/rc/races/%s" % sub, token=tok)
    except Exception:
        return                                  # the send side reports the site being down
    if code == 401:
        return _signed_out_by_site(j.get("error"))
    if code == 200 and j.get("ok"):
        racecontrol.apply_site(key, j.get("decisions") or [], _st["pc"])


def _loop():
    while True:
        _wake.wait(1.0)
        _wake.clear()
        try:
            _poll_link()
            _send_pending()
            _read_back()
        except Exception as e:                  # never stops race control
            _log("Race control: league site error %r" % (e,))
            time.sleep(5)


def status():
    with LOCK:
        u = _st["user"] if _st["token"] else None
        link = _st["link"]
        return {"state": STATUS["state"], "msg": STATUS["msg"], "user": dict(u) if u else None,
                "link": {"code": link["code"], "url": link["url"]} if link else None,
                "waiting": len(_st["pending"]), "refused": dict(_st["refused"])}


def start(log=print, loop=True):
    global _log
    _log = log
    os.makedirs(racecontrol.DIR, exist_ok=True)
    _load()
    if mark not in racecontrol.ON_CHANGE:
        racecontrol.ON_CHANGE.append(mark)
    if _st["token"]:
        _set("ok", "Signed in as %s" % (_st["user"] or {}).get("name", ""))
        if _st["pending"]:
            _set("waiting", "%d race%s waiting to go to the site" % (len(_st["pending"]), "" if len(_st["pending"]) == 1 else "s"))
    if loop:
        threading.Thread(target=_loop, daemon=True, name="race-control-site").start()
