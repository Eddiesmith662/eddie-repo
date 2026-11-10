# The broadcast overlay signing in to GLR HUB

For the overlay chat. The site side is live (Nov 7, 2026; permissions and the admin's Block switch added Nov 8, 2026). It works like race control's sign-in (`rcsite.py`), but
with its own endpoints and its own token, and the person needs the **Producer** role instead of a steward role.

The overlay can now get its access from the site in either of two ways:

- **An overlay key** (`vsglr_...`), made by an admin on the Keys page and pasted in. Unchanged; it keeps working.
- **A producer's sign-in** (`vsov_...`). The producer presses Sign in in the overlay and Allow on the site. No admin
  and no pasting needed.

The same three overlay endpoints accept either one, sent as `Authorization: Bearer <key or token>`.

Site: `https://glrhub.app`. The old `https://vspeedlivetiming.app/glr` answers every `/api/...` request below the same
way, so older overlays keep working, but new code should use glrhub.app.

## Signing in

1. **The producer presses Sign in.** The overlay asks the site for a code:

   `POST /api/overlay/link`, body `{"pc": "<short id for this PC>"}` (optional; it's shown on the Keys page, max 40
   characters).

   It returns `{"ok": true, "code": "K7QF-2MXP", "url": "https://glrhub.app/overlay/link?code=K7QF-2MXP", "poll": "<secret>", "expiresIn": 600}`

   Show the code, and open `url` in the producer's browser.
2. **On that page, the producer signs in with Discord** (if they aren't already), checks the code matches, and presses
   **Allow**. The page says it's the broadcast overlay, not race control. Without the Producer role (or the admin
   role), they get "The overlay needs the Producer role" and no Allow button.
3. **The overlay polls every 2 seconds** until it gets an answer:

   `POST /api/overlay/link/poll`, body `{"poll": "<secret>"}`

   It returns one of:
   - `{"ok": true, "state": "waiting"}`: not allowed yet. Keep polling.
   - `{"ok": true, "state": "ok", "token": "vsov_<64 hex>", "user": {"id": "<discord id>", "name": "<discord name>"}}`:
     signed in. The token is handed over **once**; the next poll says `expired`.
   - `{"ok": true, "state": "expired"}`: the code is past its 10 minutes, was already used, or the poll secret is
     wrong. Stop, and let the producer press Sign in again.

**How long things last**
- A code works for **10 minutes**.
- A token lasts **365 days from its last use**. Each request that's more than a minute after the last one extends it,
  so an overlay used every week never runs out.
- Keep the token on that PC only, like the overlay key: never in diagnostics zips or logs, and never shown in full.

## Using it

The same endpoints as with an overlay key:

| Request | Sends | Gets back |
| --- | --- | --- |
| `GET /api/overlay/check` | nothing | `{"ok": true, "name": "overlay (Producer Pat)", "user": {"id", "name"}, "perms": ["overlay", "upload"]}`. With a key: `{"ok": true, "name": "<key name>"}`, as before, with no `perms`. |
| `POST /api/overlay/results` | the `vspeed_overlay_result` race file, as now | as now: `{"ok": true, ...}` (the results are filed as provisional; `skipped` if the race is already official) |
| `GET /api/overlay/calls/<session>` | nothing | as now: `{"ok": true, "subsessionId": ..., "calls": [...]}` |

### Permissions (`perms`)

`check` with a `vsov_` token answers with `perms`, the list of what this person may do, worked out from their Discord
roles **read fresh from Discord at that check** (not the 15-minute role cache), so a role change counts at the next
start-up:

- `"overlay"`: may open the overlay.
- `"upload"`: may send results.

Producer or admin gives both. Later site features will add more names to this list: ignore names you don't know, and
treat a name that's missing as not allowed. Call `check` once at start-up (never during a race); working offline on the
last good answer for 5 days is the overlay's choice, and the site doesn't need to know.

With an overlay key (`vsglr_`) there is **no** `perms`: keys keep working for uploads and calls only, and don't open the
overlay.

Results sent with a token are recorded as sent by that producer (their Discord name, in the site's History), where a
key records the key's name.

### Announcer producer code (`POST /api/overlay/announcer`, Nov 9, 2026)

The overlay gets its announcer relay producer code from GLR HUB: one show per producer.

- Request: `POST /api/overlay/announcer`, `Authorization: Bearer <vsov_ token>`, JSON `{"show": "<the show the overlay
  uses now, or empty>"}`.
- Answer: `{"ok": true, "show": "glr-arca", "code": "https://vspeedlivetiming.app/k/glr-arca.<sig>"}`. `sig` is the
  relay's own signature (relay/src/index.js `signature()`: base64url HMAC-SHA256 with `CHANNEL_SECRET` over
  `"producer:" + show`, first 32 characters), so the relay accepts it unchanged.
- The show is stored on the site and fixed once given. The first time, `show` is kept if it fits the relay's rule
  (`^[a-z0-9][a-z0-9-]{0,39}$`) and no other producer holds it, so existing announcer links keep working. Otherwise
  one is made from the Discord name (`sam-o-brien`, then `sam-o-brien-2`; `producer` if the name has no letters).
- Only a producer's own Discord sign-in: an overlay key or race control's sign-in gets **403** ("Sign the overlay in
  with Discord…"). Not signed in **401**, blocked **403** with `blocked: true`, as on every overlay endpoint.
- **503** `"The announcer relay isn't set up on GLR HUB yet"` until the `CHANNEL_SECRET` secret (the relay's value) is
  in GLR HUB's Cloudflare settings.
- The code is a key: the site gives it only to that signed-in producer, and never logs it or shows it on a page. The
  overlay should keep it like its sign-in token (not in diagnostics zips or logs).

## Errors

The reason is always in `error`.

| Code | Meaning | What the overlay should do |
| --- | --- | --- |
| **401** | The site doesn't know this key or token: it was signed out, turned off on the Keys page, its year ran out, or the person left the league's Discord. | Show "Signed out of the league site", and offer Sign in again (or a key). Results keep waiting in the queue, as now. |
| **403** | The token is fine, but the person doesn't have the **Producer role** any more. `check` reads the roles fresh; results and calls re-check them at most every 15 minutes. | Show the `error` text. Retrying won't help until an admin gives the role back. |
| **403** with `"blocked": true` | An admin turned this person's overlay access off with **Block** on the Accounts page. The block wins over their Discord roles until an admin unblocks them. `error` is always `Your overlay access was turned off by a GLR HUB Admin. Ask an Admin to turn it back on.` | Show the `error` text as it is. Don't offer Sign in again: they can't allow a new PC either while blocked. Results stay in the queue. |
| 400 | Something is wrong in the results file (as now). | As now. |
| 405 | Results sent without POST. | n/a |

## Signing out

`POST /api/overlay/signout` with `Authorization: Bearer vsov_...` returns `{"ok": true}`, and the token stops working
straight away. Then forget the token on the PC. An admin can also sign a PC out on the site's Keys page ("Overlay
sign-ins"); the overlay then gets 401. That's for one PC; **Block** (on the Accounts page) is for the person, on every
PC, and gives 403 as above.

## Not changed

- **Overlay keys** keep working exactly as before, for overlays that have one and for one-off jobs like the import
  backfill.
- **Race control's sign-in** (`/api/rc/...`, `vsrc_` tokens) is separate. An overlay token doesn't work for race
  control, and a code from one can't be allowed on the other's page. A race control token still works on the overlay's
  results and calls endpoints, as before, unless that person is blocked (then 403 as above). Blocking only touches the
  overlay endpoints: their race control and website access are unchanged.
- **Nothing goes on air from the site.** This only changes who the site trusts. The penalty box and everything else
  still wait for the producer's Show.
