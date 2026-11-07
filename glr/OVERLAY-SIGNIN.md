# The broadcast overlay signing in to GLR HUB

For the overlay chat. The site side is live (Nov 7, 2026). It works like race control's sign-in (`rcsite.py`), but
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
| `GET /api/overlay/check` | nothing | `{"ok": true, "name": "overlay (Producer Pat)", "user": {"id", "name"}}`. With a key: `{"ok": true, "name": "<key name>"}`, as before. |
| `POST /api/overlay/results` | the `vspeed_overlay_result` race file, as now | as now: `{"ok": true, ...}` (the results are filed as provisional; `skipped` if the race is already official) |
| `GET /api/overlay/calls/<session>` | nothing | as now: `{"ok": true, "subsessionId": ..., "calls": [...]}` |

Results sent with a token are recorded as sent by that producer (their Discord name, in the site's History), where a
key records the key's name.

## Errors

The reason is always in `error`.

| Code | Meaning | What the overlay should do |
| --- | --- | --- |
| **401** | The site doesn't know this key or token: it was signed out, turned off on the Keys page, its year ran out, or the person left the league's Discord. | Show "Signed out of the league site", and offer Sign in again (or a key). Results keep waiting in the queue, as now. |
| **403** | The token is fine, but the person doesn't have the **Producer role** any more. Roles are checked again at most every 15 minutes, so this follows a role change within 15 minutes. | Show the `error` text. Retrying won't help until an admin gives the role back. |
| 400 | Something is wrong in the results file (as now). | As now. |
| 405 | Results sent without POST. | n/a |

## Signing out

`POST /api/overlay/signout` with `Authorization: Bearer vsov_...` returns `{"ok": true}`, and the token stops working
straight away. Then forget the token on the PC. An admin can also sign a PC out on the site's Keys page ("Overlay
sign-ins"); the overlay then gets 401.

## Not changed

- **Overlay keys** keep working exactly as before, for overlays that have one and for one-off jobs like the import
  backfill.
- **Race control's sign-in** (`/api/rc/...`, `vsrc_` tokens) is separate. An overlay token doesn't work for race
  control, and a code from one can't be allowed on the other's page. A race control token still works on the overlay's
  results and calls endpoints, as before.
- **Nothing goes on air from the site.** This only changes who the site trusts. The penalty box and everything else
  still wait for the producer's Show.
