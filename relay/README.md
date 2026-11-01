# VSPEED announcer relay

A small Cloudflare Worker that passes the overlay's live data to remote announcers. The overlay on the producer's PC
sends one small update about once a second; every announcer with the show's link open in a browser gets it straight
away. Data only flows one way, and nothing here can change anything on the producer's PC.

```
Producer PC (overlay) ──1 update/s──▶ this relay (one Durable Object per show) ──live──▶ announcer browsers
```

## One-time setup (Cloudflare)

1. **Deploy it from GitHub.** Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** →
   connect GitHub and pick this repo. Set **Root directory** to `relay` and leave the build and deploy commands as they
   are (it deploys with `npx wrangler deploy`). Optional: under the Worker's **Settings → Build → Build watch paths**,
   set `relay/*` so it only redeploys when the relay itself changes.
2. **Set the relay password.** In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, name
   `CHANNEL_SECRET`, and a long random password as the value. Keep it private: it's what makes producer codes.
   Changing it later turns every producer code off (make new ones).
3. The relay's address is **https://vspeedlivetiming.app** (set in `wrangler.toml`; the domain has to be in the same
   Cloudflare account). The `*.workers.dev` address keeps working too.

## For each show

1. Open `https://vspeedlivetiming.app/admin` (or press **Producer codes** at the top of the control panel), type a show name (e.g. `glr-cup`) and the relay password, and press
   **Make the code**. One code per show; several shows can run at the same time.
2. Give that code to the show's producer only. In the overlay's control panel: **Setup tab → Announcer page**, paste
   it and press **Save** (it switches the feed on).
3. The producer copies the **announcer link** (Setup tab, or **Copy announcer link** on the Race tab) and sends it to
   the announcers. Anyone with the link can watch; **New link** makes a fresh one and the old one stops working.

## What the announcer page shows

Track, lap X of Y and laps to go, the flag and the caution count; the running order with gaps, intervals (red within
half a second), laps led, last and best laps, pit stops and laps since the last stop, positions gained, and on pit
road / black flag / repairs tags; which car the camera is on and which graphics are up; recent incidents; live points
with the cutline; the standings; and the producer's notes, which flash when they change. A dot in the corner shows
how fresh the numbers are, and turns red if updates stop.

## Costs

Each update from a producer is one Worker request and one Durable Object request; updates passed on to announcers
are free, however many are watching. A 3-hour show is about 11,000 updates. The Workers Paid plan includes 1 million
Durable Object requests a month, so about 90 show-nights a month before any extra charge (a few cents per million after
that). Each show sleeps when its producer's overlay stops sending.

## Files

```
wrangler.toml        Cloudflare settings (no secrets)
src/index.js         the Worker: producer updates, announcer pages, producer codes (/admin), one Durable Object per show
src/announcer.html   the announcer page
```
