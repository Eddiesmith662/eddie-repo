/*
 * VSPEED announcer relay (Cloudflare Worker + one Durable Object per show).
 *
 * The overlay on the producer's PC sends a small update twice a second (POST /push). Announcers open
 * /a/<channel>/<view code> in any browser; the page holds one live connection (/a/<channel>/<view code>/events,
 * server-sent events) and the show's Durable Object hands every update to every connected page. Data only flows
 * one way: nothing on this side can change anything on the producer's PC.
 *
 * Keys, with no database: the producer key for a channel is "<channel>.<signature>", where the signature is an
 * HMAC of the channel name with the CHANNEL_SECRET secret (set in the Cloudflare dashboard, never in this repo).
 * /admin makes those keys. The view code in announcer links is chosen by the producer's overlay and sent with
 * every update; making a new one there turns the old links off.
 */
import PAGE from "./announcer.html";

const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PUSH = 256 * 1024;      // one update is a few KB
const IDLE_CLOSE_MS = 5 * 60e3;    // no update for 5 minutes: the show is over, close the announcer pages' streams
const PING_MS = 25e3;             // keep quiet streams open through proxies
const SAVE_MS = 30e3;             // keep the latest update in storage this often (for a page that opens mid-show)

const enc = new TextEncoder();

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(secret, channel) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode("producer:" + channel))).slice(0, 32);
}

function sameText(a, b) {          // compare without stopping at the first difference
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// "<channel>.<signature>" -> the channel, if the signature is right
async function checkKey(env, key) {
  if (!env.CHANNEL_SECRET || typeof key !== "string") return null;
  const dot = key.lastIndexOf(".");
  if (dot < 1) return null;
  const channel = key.slice(0, dot), sig = key.slice(dot + 1);
  if (!CHANNEL_RE.test(channel)) return null;
  return sameText(sig, await signature(env.CHANNEL_SECRET, channel)) ? channel : null;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const html = (body, status = 200) => new Response(body, {
  status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex",
                     "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function simplePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{margin:0;background:#141416;color:#eee;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;display:flex;justify-content:center;padding:40px 16px}
main{max-width:560px;width:100%}h1{font-size:20px;margin:0 0 14px;border-left:4px solid #FF0D40;padding-left:10px}
label{display:block;margin:14px 0 4px;color:#aaa;font-size:13px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #444;background:#222;color:#fff;font-size:15px}
button{margin-top:16px;padding:10px 18px;border:0;border-radius:6px;background:#FF0D40;color:#fff;font-size:15px;cursor:pointer}
code{display:block;word-break:break-all;background:#222;border:1px solid #444;border-radius:6px;padding:10px;margin-top:8px;user-select:all}
.hint{color:#999;font-size:13px}</style></head><body><main>${body}</main></body></html>`;
}

const ADMIN_FORM = (msg = "") => simplePage("Producer codes", `<h1>Producer codes</h1>
<p class="hint">Makes the code a producer pastes into the overlay (Setup tab → Announcer page). One code per show.
Anyone with a code can send to that show's announcer page, so share it only with that show's producer.</p>
<form method="post"><label>Show name (lower case letters, numbers and dashes, e.g. glr-cup)</label><input name="channel" required pattern="[a-z0-9][a-z0-9\\-]{0,39}">
<label>Relay password (the CHANNEL_SECRET set in Cloudflare)</label><input name="secret" type="password" required>
<button>Make the code</button></form>${msg}`);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // the producer's overlay: one update
    if (request.method === "POST" && url.pathname === "/push") {
      const channel = await checkKey(env, (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
      if (!channel) return json({ ok: false, error: "This producer code isn't valid. Make a new one at /admin." }, 401);
      const len = +(request.headers.get("content-length") || 0);
      if (len > MAX_PUSH) return json({ ok: false, error: "Update too big" }, 413);
      const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channel));
      return stub.fetch("https://show/push", { method: "POST", body: await request.text() });
    }

    // announcer page and its live stream: /a/<channel>/<view code>[/events]
    if (parts[0] === "a" && parts.length >= 3 && CHANNEL_RE.test(parts[1]) && TOKEN_RE.test(parts[2])) {
      if (parts.length === 3) return html(PAGE);
      if (parts.length === 4 && parts[3] === "events") {
        const stub = env.CHANNELS.get(env.CHANNELS.idFromName(parts[1]));
        return stub.fetch("https://show/events?token=" + encodeURIComponent(parts[2]));
      }
    }

    // making producer codes
    if (url.pathname === "/admin") {
      if (!env.CHANNEL_SECRET) return html(simplePage("Not set up", "<h1>Not set up yet</h1><p>Set the CHANNEL_SECRET secret in the Cloudflare dashboard first.</p>"), 503);
      if (request.method === "POST") {
        const f = await request.formData();
        const channel = String(f.get("channel") || "").trim().toLowerCase();
        if (!sameText(String(f.get("secret") || ""), env.CHANNEL_SECRET)) return html(ADMIN_FORM('<p style="color:#ff6b6b">Wrong relay password.</p>'), 403);
        if (!CHANNEL_RE.test(channel)) return html(ADMIN_FORM('<p style="color:#ff6b6b">Use lower case letters, numbers and dashes for the show name.</p>'), 400);
        const code = `${url.origin}/k/${channel}.${await signature(env.CHANNEL_SECRET, channel)}`;
        return html(ADMIN_FORM(`<label>Producer code for <b>${esc(channel)}</b> (paste it into the overlay's Setup tab)</label><code>${esc(code)}</code>`));
      }
      return html(ADMIN_FORM());
    }

    // someone opened a producer code as a link
    if (parts[0] === "k") return html(simplePage("Producer code", "<h1>This is a producer code</h1><p>Paste it into the overlay's control panel: Setup tab → Announcer page. Announcers get a different link from the producer.</p>"));
    if (url.pathname === "/") return html(simplePage("VSPEED announcer relay", "<h1>VSPEED announcer relay</h1><p class=\"hint\">Announcers: open the link your producer sent you.</p>"));
    return html(simplePage("Not found", "<h1>Not found</h1><p class=\"hint\">Check the link, or ask your producer for a new one.</p>"), 404);
  },
};

/* One show. Holds the latest update and the open announcer pages, and hands each update to all of them. */
export class Channel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.viewers = new Set();       // { writer, token }
    this.token = null;              // the current view code
    this.data = null;               // the latest update's data, as JSON text
    this.at = 0;                    // when it came in
    this.savedAt = 0;
    this.alarmOn = false;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(["token", "data", "at"]);
      this.token = s.get("token") || null;
      this.data = s.get("data") || null;
      this.at = s.get("at") || 0;
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/push") return this.push(request);
    if (url.pathname === "/events") return this.events(url.searchParams.get("token") || "");
    return new Response("Not found", { status: 404 });
  }

  async push(request) {
    let msg;
    try { msg = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: "Not JSON" }, 400); }
    const token = String(msg.token || "");
    if (!TOKEN_RE.test(token)) return json({ ok: false, error: "Missing view code" }, 400);
    if (token !== this.token) {                                       // a new announcer link: the old one stops working
      for (const v of this.viewers) if (v.token !== token) this.drop(v, "event: replaced\ndata: {}\n\n");
      this.token = token;
      await this.ctx.storage.put("token", token);
    }
    const now = Date.now();
    this.data = JSON.stringify(msg.data || {});
    this.at = now;
    this.send(this.message());
    if (now - this.savedAt > SAVE_MS) { this.savedAt = now; await this.ctx.storage.put({ data: this.data, at: now }); }
    if (!this.alarmOn) { this.alarmOn = true; await this.ctx.storage.setAlarm(now + PING_MS); }
    return json({ ok: true, viewers: this.viewers.size });
  }

  events(token) {
    const head = { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" };
    if (!this.token || token !== this.token) {
      // an old or mistyped link: tell the page once and close (the page stops retrying)
      return new Response(`event: ${this.token ? "replaced" : "nochannel"}\ndata: {}\n\n`, { headers: head });
    }
    if (Date.now() - this.at > IDLE_CLOSE_MS) {
      // no show on right now: the last update (if any), then close; the page checks back once a minute
      return new Response((this.data ? this.message() : "") + "event: idle\ndata: {}\n\n", { headers: head });
    }
    const { readable, writable } = new TransformStream();
    const v = { writer: writable.getWriter(), token };
    this.viewers.add(v);
    this.write(v, "retry: 3000\n" + (this.data ? this.message() : "event: ping\ndata: {}\n\n"));
    return new Response(readable, { headers: head });
  }

  // the update as sent to pages, with its age, so a page that connects later knows how old it is
  message() {
    return 'data: {"age":' + Math.max(0, Date.now() - this.at) + ',"data":' + this.data + "}\n\n";
  }

  write(v, text) {
    v.writer.write(enc.encode(text)).catch(() => this.drop(v));
  }

  send(text) {
    for (const v of this.viewers) this.write(v, text);
  }

  drop(v, last) {
    if (!this.viewers.delete(v)) return;
    try { if (last) v.writer.write(enc.encode(last)).catch(() => {}); v.writer.close().catch(() => {}); } catch (e) {}
  }

  // every 25 s while a show is on: keep quiet streams open; after 5 quiet minutes, tell the pages the show is over
  async alarm() {
    await this.ready;
    const now = Date.now();
    if (now - this.at > IDLE_CLOSE_MS) {
      for (const v of [...this.viewers]) this.drop(v, "event: idle\ndata: {}\n\n");
      if (this.data) await this.ctx.storage.put({ data: this.data, at: this.at });
      this.alarmOn = false;
      return;                                                         // no new alarm: the show sleeps until the next update
    }
    this.send("event: ping\ndata: {}\n\n");          // pages count these too: a silent stream means reconnect
    await this.ctx.storage.setAlarm(now + PING_MS);
  }
}
