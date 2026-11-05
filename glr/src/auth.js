/*
 * Sign in with Discord. Access is managed with roles in the league's Discord server: the admin role (DISCORD_ROLE_ID)
 * can edit every series, and each series can name its own role whose members edit only that series. Give someone a
 * role and they can sign in; take it away and they're out within 15 minutes.
 *
 * Cloudflare secrets on the vspeed-glr worker (never in the repo):
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET   from the Discord application (Developer Portal > OAuth2)
 *   DISCORD_GUILD_ID                           the league's Discord server
 *   DISCORD_ROLE_ID                            the admin role (every series)
 *
 * Sessions live in the database; the browser only holds a random token (the database keeps its hash).
 */
import { ensureSchema, seriesRoles } from "./db.js";

const API = "https://discord.com/api/v10";
const COOKIE = "glr_session", STATE = "glr_state";
const DAYS = 30, RECHECK_MS = 15 * 60 * 1000;

export const configured = env => !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_GUILD_ID && env.DISCORD_ROLE_ID);
const redirectUri = url => `${url.origin}/glr/auth/callback`;

const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, discord_id TEXT NOT NULL, name TEXT, avatar TEXT,
  access_token TEXT, refresh_token TEXT, token_expires INTEGER,
  created INTEGER, expires INTEGER, checked INTEGER)`;
const readyFor = new WeakMap();          // per database, like ensureSchema
async function schema(db) {
  await ensureSchema(db);
  let ready = readyFor.get(db);
  if (!ready) readyFor.set(db, ready = (async () => {
    await db.prepare(SCHEMA).run();
    const cols = (await db.prepare(`PRAGMA table_info(sessions)`).all()).results.map(c => c.name);
    if (!cols.includes("roles")) await db.prepare(`ALTER TABLE sessions ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'`).run();
  })().catch(e => { readyFor.delete(db); throw e; }));
  return ready;
}

// the roles that matter here: the admin role plus any series' role
async function relevant(env, roles) {
  const series = await seriesRoles(env.DB);
  return roles.filter(r => r === env.DISCORD_ROLE_ID || series.some(s => s.role_id === r));
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const cookies = req => Object.fromEntries((req.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/glr; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const redirect = (to, headers = []) => { const h = new Headers({ location: to, "cache-control": "no-store" }); for (const c of headers) h.append("set-cookie", c); return new Response(null, { status: 302, headers: h }); };

async function discordToken(env, url, body) {
  const r = await fetch(`${API}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, redirect_uri: redirectUri(url), ...body }) });
  if (!r.ok) throw new Error("discord token " + r.status);
  return r.json();
}
const discordGet = (path, token) => fetch(API + path, { headers: { authorization: `Bearer ${token}` } });

// the member's roles in the league server: null = not in the server, false = Discord couldn't be asked
async function memberRoles(env, token) {
  const r = await discordGet(`/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, token);
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) return false;
  const m = await r.json();
  return { roles: m.roles || [], nick: m.nick || "" };
}

// GET /glr/login
export function login(env, url, back = "/glr") {
  const state = randomToken();
  const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(url),
    scope: "identify guilds.members.read", state, prompt: "none" });
  const safeBack = /^\/glr(\/|$)/.test(back) ? back : "/glr";
  return redirect(`https://discord.com/oauth2/authorize?${q}`, [setCookie(STATE, `${state}|${encodeURIComponent(safeBack)}`, 600)]);
}

// GET /glr/auth/callback  -> { response } or { error, name }
export async function callback(request, env, url) {
  const [state, back] = (cookies(request)[STATE] || "").split("|");
  if (url.searchParams.get("error")) return { error: "Sign-in was cancelled." };
  if (!state || state !== url.searchParams.get("state")) return { error: "That sign-in link expired. Try again." };
  const tok = await discordToken(env, url, { grant_type: "authorization_code", code: url.searchParams.get("code") || "" });
  const user = await (await discordGet("/users/@me", tok.access_token)).json();
  const name = user.global_name || user.username || "";
  const mem = await memberRoles(env, tok.access_token);
  if (mem === false) return { error: "Discord didn't answer. Try again in a minute.", name };
  if (!mem) return { error: "You're not in the league's Discord server.", name };
  await schema(env.DB);
  const roles = await relevant(env, mem.roles);
  if (!roles.length) return { error: "You don't have an officials role in the league's Discord server.", name };
  const token = randomToken(), now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, discord_id, name, avatar, access_token, refresh_token, token_expires, created, expires, checked, roles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), user.id, mem.nick || name, user.avatar || "", tok.access_token, tok.refresh_token || "",
          now + (tok.expires_in || 0) * 1000, now, now + DAYS * 864e5, now, JSON.stringify(roles)).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE expires < ?`).bind(now).run();
  return { response: redirect(decodeURIComponent(back || "/glr"), [setCookie(COOKIE, token, DAYS * 86400), setCookie(STATE, "", 0)]) };
}

// the signed-in official, or null. Re-asks Discord about the role every 15 minutes.
export async function currentUser(request, env) {
  const token = cookies(request)[COOKIE];
  if (!token || !configured(env)) return null;
  await schema(env.DB);
  const h = await sha256(token), now = Date.now();
  const s = await env.DB.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).bind(h).first();
  if (!s || s.expires < now) return null;
  let roles = JSON.parse(s.roles || "[]");
  if (now - s.checked > RECHECK_MS || !roles.length) {   // no roles saved: a session from before series roles, ask Discord now
    let access = s.access_token;
    try {
      if (s.token_expires < now + 60000 && s.refresh_token) {
        const t = await discordToken(env, new URL(request.url), { grant_type: "refresh_token", refresh_token: s.refresh_token });
        access = t.access_token;
        await env.DB.prepare(`UPDATE sessions SET access_token = ?, refresh_token = ?, token_expires = ? WHERE token_hash = ?`)
          .bind(t.access_token, t.refresh_token || s.refresh_token, now + (t.expires_in || 0) * 1000, h).run();
      }
      const mem = await memberRoles(env, access);
      if (mem) roles = await relevant(env, mem.roles);
      if (mem === null || (mem && !roles.length)) {
        await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(h).run();
        return null;
      }
      if (mem) await env.DB.prepare(`UPDATE sessions SET checked = ?, roles = ?, name = COALESCE(NULLIF(?, ''), name) WHERE token_hash = ?`)
        .bind(now, JSON.stringify(roles), mem.nick, h).run();
      // mem === false: Discord is down; keep the session and ask again next time
    } catch (e) {
      // refresh refused (the person disconnected the app in Discord): sign them out
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(h).run();
      return null;
    }
  }
  return { id: s.discord_id, name: s.name, avatar: s.avatar, roles, admin: roles.includes(env.DISCORD_ROLE_ID) };
}

// POST /glr/logout
export async function logout(request, env) {
  const token = cookies(request)[COOKIE];
  if (token && configured(env)) { await schema(env.DB); await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run(); }
  return redirect("/glr", [setCookie(COOKIE, "", 0)]);
}

// may this signed-in person edit this series? (admins: every series)
export const canEdit = (user, series) => !!user && (user.admin || (!!series && !!series.role_id && user.roles.includes(series.role_id)));
