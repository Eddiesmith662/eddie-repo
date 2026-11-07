"""League site upload: sends each race's results to the league site (GLR HUB, glrhub.app) when it ends.

Off until the producer connects the overlay in the control panel (Setup > League site upload), either way:
  - Sign in with Discord (Nov 2026, glr/OVERLAY-SIGNIN.md): a code, Allow on the site with a Producer's Discord
    account, and the site hands this PC a token (vsov_...) tied to that person. No admin and no pasting needed.
  - An overlay key (vsglr_...) made by an admin on the site's Keys page and pasted in, as before.
Both are kept in data/league-site-key.json, never in settings.json, logs or diagnostics. When both are there the
sign-in is used; if the site has forgotten it (signed out, turned off on the Keys page), the key takes over.
Results go when iRacing has them a minute after the checkered, and again when iRacing makes them official; the site
files them as Provisional until the iRacing results file is uploaded there.

Nothing is lost if the internet drops or the site is down: each race waits in data/league-upload/ and is sent once
the site answers. Only league races are sent (the sim says which iRacing league the session belongs to). A race the
site turns down (e.g. a league that isn't on the site yet) is never deleted: it's moved to data/league-upload/refused/,
and putting the file back in data/league-upload/ sends it again.
"""
import datetime
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request

import datafiles
import net

# GLR HUB (Nov 2026; the old vspeedlivetiming.app/glr still answers). VSPEED_SITE points it at a test copy of the site.
SITE = (os.environ.get("VSPEED_SITE") or "https://glrhub.app").rstrip("/")
DIR = os.path.join(datafiles.DATA, "league-upload")
REFUSED_DIR = os.path.join(DIR, "refused")
RETRY = 60                     # seconds between tries while something is waiting
TRY_AGAIN = (408, 425, 429)   # turned down for now (timeout, too many requests): try again, like a site problem
LOCK = threading.Lock()
_wake = threading.Event()
_cfg = {"on": False, "key": "", "token": ""}     # token: this PC's Discord sign-in (vsov_...), from the key file
_START = {}                    # queued file -> the race time of its first copy (the file is gone once it's sent)
_log = print
STATUS = {"state": "off", "msg": "", "last": ""}
DEFAULTS = {"on": False, "key": ""}
# race control (start-race-control.bat) sets this to its sign-in token: a steward signed in to the site sends the
# official results with it, so a race nobody broadcasts needs no overlay key (plan doc, phase 5c). The overlay key,
# when there is one and the upload is on, is used first.
TOKEN_SOURCE = None


def _key():
    """-> what to send as "Authorization: Bearer ...": this PC's sign-in, else its overlay key, else race control's
    sign-in; "" when the upload is off and race control isn't signed in."""
    with LOCK:
        on, key, token = _cfg["on"], _cfg["key"], _cfg["token"]
    if on and (token or key):
        return token or key
    try:
        return (TOKEN_SOURCE() or "") if TOKEN_SOURCE else ""
    except Exception:
        return ""


# The overlay key and the Discord sign-in live in a file of their own, not in settings.json (Nov 2026): settings.json is
# copied around (its .bak and .broken-... copies, folder copies, OneDrive), and race control keeps its sign-in apart the
# same way. Only this module reads or writes it; the pages only ever learn whether a key is saved and who is signed in.
KEY_FILE = os.path.join(datafiles.DATA, "league-site-key.json")
# the key file once read (None = not read yet), so pages asking 5 times a second don't read the disk:
# {"key", "token", "user": {"id", "name"} or None, "pc"}
_stored = {"key": None}


def _creds():
    if _stored["key"] is None:
        d = datafiles.load_json(KEY_FILE, {})
        d = d if isinstance(d, dict) else {}
        u = d.get("user") if isinstance(d.get("user"), dict) else None
        _stored.update(key=str(d.get("key") or "").strip(), token=str(d.get("token") or "").strip(),
                       user={"id": str(u.get("id", "")), "name": str(u.get("name", ""))} if u else None, pc=str(d.get("pc") or ""))
    return _stored


def _save_creds():
    c = _creds()
    if c["key"] or c["token"]:
        datafiles.write_json(KEY_FILE, {"key": c["key"], "token": c["token"], "user": c["user"], "pc": c["pc"],
                                        "note": "The league site key and sign-in for this PC. Keep it private: don't share "
                                                "this file. Sign out or remove the key on the Setup tab."}, indent=1)
    else:
        try:
            os.remove(KEY_FILE)
        except OSError:
            pass


def stored_key():
    """The overlay key saved on this PC, or ""."""
    return _creds()["key"]


def save_key(key):
    """Save the overlay key ("" removes it; a sign-in stays)."""
    _creds()["key"] = str(key or "").strip()
    _save_creds()


def signed_in():
    """Who this PC is signed in to the league site as ({"id", "name"}), or None."""
    c = _creds()
    return dict(c["user"] or {"id": "", "name": ""}) if c["token"] else None


def _forget_token():
    c = _creds()
    c["token"], c["user"] = "", None
    _save_creds()
    with LOCK:
        _cfg["token"] = ""


# ---------------------------------------------------------------- Sign in with Discord (glr/OVERLAY-SIGNIN.md)
SIGNIN = {"link": None}        # the sign-in under way: {"code", "url", "poll", "until"}, or None
POLL_EVERY = 2.0
ON_SIGNED_IN = None            # server.py: switch the upload on and tell the pages, once a producer has pressed Allow


def _pc_name():
    c = _creds()
    if not c["pc"]:
        c["pc"] = (socket.gethostname() or "overlay")[:40]
    return c["pc"]


def sign_in():
    """Ask the site for a code. -> (ok, message, {"code", "url"}); the code is then polled for in the background."""
    try:
        code, j = _request("/api/overlay/link", "", {"pc": _pc_name()})
    except Exception as e:
        return False, "Couldn't reach the league site (%s)" % (getattr(e, "reason", None) or e), {}
    if code != 200 or not j.get("ok") or not j.get("poll"):
        return False, j.get("error") or "The league site said no (%s)" % code, {}
    link = {"code": str(j.get("code") or ""), "url": str(j.get("url") or ""), "poll": str(j["poll"]),
            "until": time.time() + float(j.get("expiresIn") or 600)}
    SIGNIN["link"] = link
    threading.Thread(target=_poll_sign_in, args=(link,), daemon=True, name="league-signin").start()
    _log("League site: sign-in started (code %s)" % link["code"])
    return True, "", {"code": link["code"], "url": link["url"]}


def _poll_sign_in(link):
    """Every 2 seconds until the producer presses Allow, the code runs out, or the sign-in is cancelled."""
    while SIGNIN["link"] is link:
        time.sleep(POLL_EVERY)
        if SIGNIN["link"] is not link:
            return                                   # cancelled, or a new sign-in started
        if time.time() > link["until"]:
            SIGNIN["link"] = None
            _set("error", "The sign-in code ran out: press Sign in with Discord again")
            return
        try:
            code, j = _request("/api/overlay/link/poll", "", {"poll": link["poll"]})
        except Exception:
            continue                                 # no internet for a moment: keep trying until the code runs out
        state = j.get("state") if code == 200 else None
        if state == "ok" and j.get("token"):
            u = j.get("user") or {}
            user = {"id": str(u.get("id", "")), "name": str(u.get("name", ""))}   # its own copy: a Sign out can't pull it away
            c = _creds()
            with LOCK:                               # in use first, then saved and shown as signed in
                _cfg["token"] = str(j["token"])
            c["user"], c["token"] = dict(user), str(j["token"])
            _save_creds()
            SIGNIN["link"] = None
            _set("ready", "Signed in as %s" % (user["name"] or "a producer"))
            _log("League site: signed in as %s" % (user["name"] or "?"))
            if ON_SIGNED_IN:
                try:
                    ON_SIGNED_IN(dict(user))
                except Exception as e:
                    _log("League site: %r" % (e,))
            _wake.set()
            return
        if state == "expired":
            SIGNIN["link"] = None
            _set("error", "That sign-in code was used or ran out: press Sign in with Discord again")
            return


def cancel_sign_in():
    SIGNIN["link"] = None


def sign_out():
    """Tell the site to forget this PC's sign-in, then forget it here. -> (ok, message)"""
    token = _creds()["token"]
    if not token:
        return False, "This PC isn't signed in"
    reached = True
    try:
        code, _ = _request("/api/overlay/signout", token, {})
        reached = code in (200, 401)                 # 401: the site had already forgotten it
    except Exception:
        reached = False
    _forget_token()
    _log("League site: signed out%s" % ("" if reached else " on this PC (the site couldn't be reached)"))
    if reached:
        return True, "Signed out of the league site"
    return True, ("Signed out on this PC. The league site couldn't be reached, so also turn this sign-in off on the "
                  "site's Keys page (Overlay sign-ins)")


def move_key_out_of_settings(state, log=print):
    """Before Nov 2026 the key was kept in settings.json ("leagueUpload": {"key": ...}). Move it into its own file, then
    take it out of settings.json and its last-good copy (settings.json.bak). Returns True if a key was moved."""
    with state.lock:
        lu = state.settings.get("leagueUpload")
        old = str((lu or {}).get("key") or "").strip() if isinstance(lu, dict) else ""
    if not old:
        return False
    if not stored_key():
        save_key(old)                        # saved on its own first, so it's never only in memory
    with state.lock:
        state.settings["leagueUpload"].pop("key", None)
    state.save()
    bak = datafiles.SETTINGS_FILE + ".bak"
    try:
        with open(bak, encoding="utf-8") as f:
            b = json.load(f)
        if isinstance(b, dict) and isinstance(b.get("leagueUpload"), dict) and "key" in b["leagueUpload"]:
            b["leagueUpload"].pop("key", None)
            datafiles.write_json(bak, b, indent=2)
    except (OSError, ValueError):
        pass
    log("League site upload: the overlay key moved out of settings.json into %s" % os.path.basename(KEY_FILE))
    return True


def configure(cfg):
    """On/off (settings.json "leagueUpload") and the key (the key file). The sign-in comes from the key file unless
    cfg says otherwise ("token")."""
    cfg = cfg or {}
    token = str(cfg["token"] if "token" in cfg else _creds()["token"] or "").strip()
    with LOCK:
        changed = (_cfg["on"], _cfg["key"], _cfg["token"]) != (bool(cfg.get("on")), str(cfg.get("key") or "").strip(), token)
        _cfg["on"] = bool(cfg.get("on"))
        _cfg["key"] = str(cfg.get("key") or "").strip()
        _cfg["token"] = token
    if changed:                              # a new key or switch: start the status over
        STATUS["state"], STATUS["msg"] = "ready", ""
    _wake.set()


def _ms(t):
    try:
        t = float(t)
    except (TypeError, ValueError):
        return None
    return int(round(t * 1000)) if t > 0 else None


def _status(r):
    s = str(r.get("ReasonOutStr") or "").strip()
    if r.get("ReasonOutId") == 32 or s.lower() == "disco":
        return "Disconnected"
    return s or "Running"


def build(live, sess, info, official):
    """The race in the site's "vspeed_overlay_result" form, from iRacing's own results for the session."""
    cars = {c["idx"]: c for c in live.get("cars") or []}
    rows = []
    lead = max([r.get("LapsComplete") or 0 for r in sess.get("ResultsPositions") or []] or [0])
    for r in sorted((r for r in sess.get("ResultsPositions") or [] if r.get("CarIdx") in cars), key=lambda r: r.get("Position") or 999):
        c = cars[r["CarIdx"]]
        down = max(0, lead - (r.get("LapsComplete") or 0)) if (r.get("Lap") or 0) > 0 else 0   # laps behind the leader, as iRacing's results file counts them
        inc = r.get("Incidents")
        rows.append({
            "custId": c.get("custId", ""), "name": c.get("name", ""), "carNumber": c.get("num", ""),
            "car": c.get("carFull") or c.get("car", ""), "carClass": c.get("cls", ""),
            "finish": r.get("Position"), "classPos": (r.get("ClassPosition") or 0) + 1, "start": c.get("startPos") or None,
            "laps": r.get("LapsComplete"), "lapsLed": r.get("LapsLed"), "incidents": inc if isinstance(inc, int) and inc >= 0 else None,
            "bestLapMs": _ms(r.get("FastestTime")), "bestLapNum": r.get("FastestLap") if (r.get("FastestLap") or 0) > 0 else None,
            "intervalMs": None if down else (_ms(r.get("Time")) or 0), "lapsDown": down, "reasonOut": _status(r),
        })
    return {
        "type": "vspeed_overlay_result", "version": 1, "subsessionId": info.get("subId"), "leagueId": info.get("leagueId"),
        "track": live.get("track") or info.get("track", ""),
        "startTime": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "laps": sess.get("ResultsLapsComplete"), "cautions": sess.get("ResultsNumCautionFlags"),
        "cautionLaps": sess.get("ResultsNumCautionLaps"), "leadChanges": sess.get("ResultsNumLeadChanges"),
        "official": bool(official), "results": rows,
    }


def queue(live, sess, info, sess_num, official):
    """Called when the overlay saves a race's results. Queues them for the site if the upload is on."""
    if not _key():
        return
    if not info.get("leagueId") or not info.get("subId"):
        _log("League site upload: not a league race, nothing sent")
        return
    body = build(live, sess, info, official)
    if not body["results"]:
        return
    path = os.path.join(DIR, "%s-%s.json" % (info.get("subId"), sess_num))
    with LOCK:
        start = _START.get(path)
        if start is None:                    # keep the first copy's time as the race time when the official copy replaces it
            try:
                with open(path, encoding="utf-8") as f:
                    start = json.load(f).get("startTime")
            except (OSError, ValueError, AttributeError):
                pass
        body["startTime"] = start or body["startTime"]
        _START[path] = body["startTime"]
        datafiles.write_json(path, body)     # raises if it can't be saved: race results tries again
    _log("League site upload: race %s queued (%d drivers%s)" % (info.get("subId"), len(body["results"]), ", official" if official else ""))
    _wake.set()


def _request(path, key, body=None, timeout=15):
    """GET (no body) or POST (a body) to the site; key "" sends no Authorization (the sign-in's code and polling)."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "VSPEED-Overlay"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(SITE + path, data=data, method="POST" if data else "GET", headers=headers)
    try:
        r = net.urlopen(req, timeout)
        return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}


def check(key=None):
    """Does the site accept this key (or, with none given, this PC's sign-in, else its key)? -> (ok, message)"""
    c = _creds()
    key = key if key is not None else (c["token"] or c["key"])
    if not key:
        return False, "Sign in with Discord or paste a key from the league site first"
    try:
        code, j = _request("/api/overlay/check", key)
    except Exception as e:
        return False, "Couldn't reach the league site (%s)" % (getattr(e, "reason", None) or e)
    if code == 200 and j.get("ok"):
        u = j.get("user") or {}
        return True, ("Signed in as %s: the site accepts it" % u["name"]) if u.get("name") else "Key works (%s)" % j.get("name", "")
    if code == 401 and key == c["token"]:
        return False, "Signed out of the league site: sign in with Discord again"
    return False, j.get("error") or "The site said no (%s)" % code


def pending():
    try:
        return sorted(f for f in os.listdir(DIR) if f.endswith(".json"))
    except OSError:
        return []


def _set(state, msg):
    STATUS["state"], STATUS["msg"] = state, msg


def _send_all():
    with LOCK:
        on = _cfg["on"]
    key = _key()
    if not key:
        return _set("off", "") if not on else _set("setup", "Sign in with Discord or paste a key from the league site")
    files = pending()
    if not files:
        if STATUS["state"] not in ("ok", "error"):     # keep the last result or problem on show
            _set("ready", "On. Results go to the site when each race ends.")
        return
    for name in files:
        path = os.path.join(DIR, name)
        try:
            with open(path, "rb") as f:
                raw = f.read()
            body = json.loads(raw.decode("utf-8"))
        except OSError:
            continue                         # locked for a moment (OneDrive): next time
        except ValueError:
            _set_aside(path, None, "it couldn't be read")
            continue
        try:
            code, j = _request("/api/overlay/results", key, body)
        except Exception as e:
            return _set("waiting", "Can't reach the league site; %d race%s waiting, trying again every minute" % (len(files), "" if len(files) == 1 else "s"))
        signin = key.startswith("vsov_") and key == _creds()["token"]
        if code == 401 and signin:
            # the site has forgotten this PC's sign-in (signed out, turned off on its Keys page, a year unused, or the
            # person left the league's Discord). Forget it here too; with a key as well, that takes over. Nothing is lost:
            # the races keep waiting
            _forget_token()
            _log("League site upload: signed out by the site (%s)" % (j.get("error") or 401))
            if stored_key():
                _wake.set()
                return _set("waiting", "Signed out of the league site; sending with the overlay key instead")
            return _set("error", "Signed out of the league site: sign in with Discord again. %d race%s waiting"
                        % (len(files), "" if len(files) == 1 else "s"))
        if code == 403 and signin:
            # signed in, but no Producer role any more: only an admin can fix that (the races keep waiting)
            return _set("error", j.get("error") or "Your Discord account doesn't have the Producer role on the league site")
        if code in (401, 403):
            return _set("error", j.get("error") or "The site doesn't accept this key")
        if code == 200 and j.get("ok"):
            _done_with(path, raw)
            what = j.get("message") if j.get("skipped") else "%s results at %s sent (%d drivers)" % (j.get("series", ""), body.get("track", ""), len(body.get("results") or []))
            STATUS["last"] = time.strftime("%H:%M") + " · " + what
            _set("ok", what)
            _log("League site upload: " + what)
        elif 400 <= code < 500 and code not in TRY_AGAIN:   # the site can't use it (e.g. a league that isn't on the site)
            why = j.get("error") or "the site answered %s" % code
            _set_aside(path, raw, why)
            _set("error", "Race %s not taken: %s (kept in data\\league-upload\\refused)" % (body.get("subsessionId"), why))
        else:
            return _set("waiting", "The league site had a problem (%s); trying again every minute" % code)


def _done_with(path, raw):
    """Remove a sent race, unless a newer copy (e.g. the official results) was queued while it was being sent:
    that one stays and goes next. (Before, the newer copy was deleted unsent.)"""
    with LOCK:
        try:
            with open(path, "rb") as f:
                if f.read() != raw:
                    _wake.set()
                    return
            os.remove(path)
        except OSError:
            pass


def _set_aside(path, raw, why):
    """A race the site won't take, or a file that can't be read: moved to refused/, never deleted."""
    with LOCK:
        try:
            if raw is not None:
                with open(path, "rb") as f:
                    if f.read() != raw:      # a newer copy came in meanwhile: send that one instead
                        _wake.set()
                        return
            os.makedirs(REFUSED_DIR, exist_ok=True)
            dest = os.path.join(REFUSED_DIR, os.path.basename(path))
            if os.path.exists(dest):
                dest = os.path.join(REFUSED_DIR, "%s-%s.json" % (os.path.basename(path)[:-5], time.strftime("%Y%m%d-%H%M%S")))
            os.replace(path, dest)
            _log("League site upload: %s not taken (%s); kept as %s" % (os.path.basename(path), why, os.path.relpath(dest, datafiles.DATA)))
        except OSError as e:
            _log("League site upload: couldn't set %s aside: %r" % (os.path.basename(path), e))


def _loop():
    while True:
        _wake.wait(RETRY)
        _wake.clear()
        try:
            _send_all()
        except Exception as e:
            _log("League site upload: %r" % (e,))


def start(cfg, log=print, on_signed_in=None):
    """cfg: settings.json's "leagueUpload" (on/off); the key and sign-in come from the key file.
    on_signed_in(user): called once a producer presses Allow (server.py switches the upload on)."""
    global _log, ON_SIGNED_IN
    _log = log
    ON_SIGNED_IN = on_signed_in
    configure({"on": bool((cfg or {}).get("on")), "key": stored_key()})
    threading.Thread(target=_loop, daemon=True).start()


def status():
    """For the control panel: never the key or the token."""
    link = SIGNIN["link"]
    who = signed_in()
    return {"state": STATUS["state"], "msg": STATUS["msg"], "last": STATUS["last"], "waiting": len(pending()),
            "user": who["name"] if who else "", "site": SITE,
            "signin": {"code": link["code"], "url": link["url"], "left": max(0, round(link["until"] - time.time()))} if link else None}
