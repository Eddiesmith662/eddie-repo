/*
 * Sign in with Discord. Any member of the league's Discord server can sign in (drivers do, to file protests). What
 * they can do comes from their roles there:
 *   admin role (DISCORD_ROLE_ID)      edits every series, and is a steward everywhere
 *   Series official role (Site settings) + an admin's assignment (Accounts)   edits those series, and stewards them
 *   (before that role is set: each series' own role, from Edit series)
 *   race control role (Site settings) steward for every series: reviews protests and makes decisions
 * Roles are checked again every 15 minutes, so taking one away takes effect within that.
 *
 * Cloudflare secrets on the vspeed-glr worker (never in the repo):
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET   from the Discord application (Developer Portal > OAuth2)
 *   DISCORD_GUILD_ID                           the league's Discord server
 *   DISCORD_ROLE_ID                            the admin role (every series)
 *
 * Sessions live in the database; the browser only holds a random token (the database keeps its hash).
 *
 * The programs on the league's PCs sign in the same way: the program asks for a code, the person opens the site's link
 * page, signs in with Discord as usual and presses Allow. The program then gets a token that acts as that person: a
 * session of its own, with the same role checks as the browser (re-checked every 15 minutes, so a removed role stops
 * it). Signing out in the program, or turning it off on the Keys page, ends it.
 *   race control (stewards)      token "vsrc_...", session kind 'rc', link page /rc/link
 *   broadcast overlay (producers) token "vsov_...", session kind 'ov', link page /overlay/link
 */
import { ensureSchema, seriesRoles, getSetting, linkedDriver, noteAccount, directorOf } from "./db.js";

const API = "https://discord.com/api/v10";
const COOKIE = "glr_session", STATE = "glr_state";
const DAYS = 30, RECHECK_MS = 15 * 60 * 1000;

export const configured = env => !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_GUILD_ID && env.DISCORD_ROLE_ID);
const redirectUri = url => `${url.origin}/auth/callback`;

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
    if (!cols.includes("kind")) await db.prepare(`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'web'`).run();
    if (!cols.includes("label")) await db.prepare(`ALTER TABLE sessions ADD COLUMN label TEXT`).run();
    if (!cols.includes("last_used")) await db.prepare(`ALTER TABLE sessions ADD COLUMN last_used INTEGER`).run();
    // race control sign-in codes waiting for a steward to press Allow (10 minutes)
    await db.prepare(`CREATE TABLE IF NOT EXISTS rc_links (code TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, pc TEXT,
      created INTEGER, expires INTEGER, token TEXT, user_id TEXT, user_name TEXT)`).run();
    // which program the code is for (rc_links holds every program's codes: 'rc' race control, 'ov' the overlay)
    const lcols = (await db.prepare(`PRAGMA table_info(rc_links)`).all()).results.map(c => c.name);
    if (!lcols.includes("kind")) await db.prepare(`ALTER TABLE rc_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'rc'`).run();
  })().catch(e => { readyFor.delete(db); throw e; }));
  return ready;
}

// the roles that matter here: the admin role, any series' role, the race control role and the producer role
async function relevant(env, roles) {
  const series = await seriesRoles(env.DB), rc = await getSetting(env.DB, "steward_role"), pr = await getSetting(env.DB, "producer_role"), so = await getSetting(env.DB, "official_role");
  return roles.filter(r => r === env.DISCORD_ROLE_ID || (rc && r === rc) || (pr && r === pr) || (so && r === so) || series.some(s => s.role_id === r));
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const cookies = req => Object.fromEntries((req.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
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

// GET /login
export function login(env, url, back = "/") {
  const state = randomToken();
  const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(url),
    scope: "identify guilds.members.read", state, prompt: "none" });
  const safeBack = /^\/(?!\/)/.test(back) ? back : "/";        // only this site's own pages
  return redirect(`https://discord.com/oauth2/authorize?${q}`, [setCookie(STATE, `${state}|${encodeURIComponent(safeBack)}`, 600)]);
}

// GET /auth/callback  -> { response } or { error, name }
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
  const token = randomToken(), now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, discord_id, name, avatar, access_token, refresh_token, token_expires, created, expires, checked, roles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), user.id, mem.nick || name, user.avatar || "", tok.access_token, tok.refresh_token || "",
          now + (tok.expires_in || 0) * 1000, now, now + DAYS * 864e5, now, JSON.stringify(roles)).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE expires < ?`).bind(now).run();
  await noteAccount(env.DB, user.id, mem.nick || name);
  // asked once, right after signing in: which driver are they? (not on the way to allowing race control or the overlay)
  let to = decodeURIComponent(back || "/");
  if (!/^\/(rc|overlay)\/link/.test(to) && !await linkedDriver(env.DB, user.id)) to = "/me/driver?first=1&back=" + encodeURIComponent(to);
  return { response: redirect(to, [setCookie(COOKIE, token, DAYS * 86400), setCookie(STATE, "", 0)]) };
}

// the signed-in person (browser cookie), or null. Re-asks Discord about their roles every 15 minutes.
export async function currentUser(request, env) {
  const token = cookies(request)[COOKIE];
  if (!token || !configured(env)) return null;
  return userFor(request, env, token, "web");
}

// the programs that sign in with a code: their token's start, their session kind and their Allow page
export const PROGRAMS = {
  rc: { prefix: "vsrc_", page: "/rc/link", name: "race control" },
  ov: { prefix: "vsov_", page: "/overlay/link", name: "broadcast overlay" },
};
const bearerToken = (request, kind) => {
  const m = /^Bearer\s+(vs(?:rc|ov)_[0-9a-f]{64})$/.exec(request.headers.get("authorization") || "");
  return m && (!kind || m[1].startsWith(PROGRAMS[kind].prefix)) ? m[1] : null;
};

// the person behind a program's "Authorization: Bearer vsrc_/vsov_..." token, or null
export async function programUser(request, env, kind) {
  const token = bearerToken(request, kind);
  if (!token || !configured(env)) return null;
  return userFor(request, env, token, kind);
}
export const raceControlUser = (request, env) => programUser(request, env, "rc");
export const overlayUser = (request, env) => programUser(request, env, "ov");

async function userFor(request, env, token, kind) {
  await schema(env.DB);
  const h = await sha256(token), now = Date.now();
  const s = await env.DB.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND kind = ?`).bind(h, kind).first();
  if (!s || s.expires < now) return null;
  if (kind === "rc" && now - (s.last_used || 0) > 60000)         // a signed-in race control PC stays signed in while it's used
    await env.DB.prepare(`UPDATE sessions SET last_used = ?, expires = ? WHERE token_hash = ?`).bind(now, now + 365 * 864e5, h).run();
  let roles = JSON.parse(s.roles || "[]");
  if (now - s.checked > RECHECK_MS) {
    let access = s.access_token;
    try {
      if (s.token_expires < now + 60000 && s.refresh_token) {
        const t = await discordToken(env, new URL(request.url), { grant_type: "refresh_token", refresh_token: s.refresh_token });
        access = t.access_token;
        // Discord replaces the refresh token each time: give the new one to every session sharing it (the browser and
        // any race control PCs of the same person), or the others would be signed out on their next check
        await env.DB.prepare(`UPDATE sessions SET access_token = ?, refresh_token = ?, token_expires = ? WHERE discord_id = ? AND refresh_token = ?`)
          .bind(t.access_token, t.refresh_token || s.refresh_token, now + (t.expires_in || 0) * 1000, s.discord_id, s.refresh_token).run();
      }
      const mem = await memberRoles(env, access);
      if (mem) roles = await relevant(env, mem.roles);
      if (mem === null) {                                    // left the league's Discord server
        await env.DB.prepare(`DELETE FROM sessions WHERE discord_id = ?`).bind(s.discord_id).run();
        return null;
      }
      if (mem) await env.DB.prepare(`UPDATE sessions SET checked = ?, roles = ?, name = COALESCE(NULLIF(?, ''), name) WHERE discord_id = ?`)
        .bind(now, JSON.stringify(roles), mem.nick, s.discord_id).run();
      // mem === false: Discord is down; keep the session and ask again next time
    } catch (e) {
      // refresh refused (the person disconnected the app in Discord): sign them out
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(h).run();
      return null;
    }
  }
  return describe(env, { id: s.discord_id, name: s.name, avatar: s.avatar, roles });
}

/* ---------- programs' sign-in: code, Allow, token (race control and the overlay) ---------- */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";      // no 0/O or 1/I to mix up
export const LINK_MS = 10 * 60 * 1000;                      // a code works for 10 minutes
export const TOKEN_DAYS = 365;                               // a token lasts a year from its last use

// POST /api/rc/link, /api/overlay/link -> { code, url, poll, expiresIn }
export async function linkStart(env, url, pc = "", kind = "rc") {
  await schema(env.DB);
  const pick = crypto.getRandomValues(new Uint8Array(8));
  const code = [...pick].map(b => CODE_CHARS[b % CODE_CHARS.length]).join("").replace(/^(.{4})/, "$1-");
  const poll = randomToken(), now = Date.now();
  await env.DB.prepare(`DELETE FROM rc_links WHERE expires < ?`).bind(now).run();
  await env.DB.prepare(`INSERT INTO rc_links (code, poll_hash, pc, created, expires, kind) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(code, await sha256(poll), String(pc || "").slice(0, 40), now, now + LINK_MS, kind).run();
  return { code, url: `${url.origin}${PROGRAMS[kind].page}?code=${code}`, poll, expiresIn: LINK_MS / 1000 };
}

// POST /api/rc/link/poll, /api/overlay/link/poll -> { state: "waiting" | "ok" | "expired", token, user }
export async function linkPoll(env, poll, kind = "rc") {
  await schema(env.DB);
  const l = await env.DB.prepare(`SELECT * FROM rc_links WHERE poll_hash = ? AND kind = ?`).bind(await sha256(String(poll || "")), kind).first();
  if (!l || l.expires < Date.now()) return { state: "expired" };
  if (!l.token) return { state: "waiting" };
  await env.DB.prepare(`DELETE FROM rc_links WHERE code = ?`).bind(l.code).run();      // the token is handed over once
  return { state: "ok", token: l.token, user: { id: l.user_id, name: l.user_name } };
}

export async function linkFind(env, code) {
  await schema(env.DB);
  const l = await env.DB.prepare(`SELECT code, pc, expires, token, kind FROM rc_links WHERE code = ?`).bind(String(code || "").toUpperCase()).first();
  return l && l.expires > Date.now() ? l : null;
}

// the signed-in person pressed Allow: a session for the program, sharing their Discord sign-in
export async function linkAllow(request, env, code, user) {
  const l = await linkFind(env, code);
  if (!l || l.token) return false;
  const web = await env.DB.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND kind = 'web'`).bind(await sha256(cookies(request)[COOKIE] || "")).first();
  if (!web) return false;
  const token = PROGRAMS[l.kind].prefix + randomToken(), now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, discord_id, name, avatar, access_token, refresh_token, token_expires, created, expires, checked, roles, kind, label, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), web.discord_id, web.name, web.avatar, web.access_token, web.refresh_token, web.token_expires,
          now, now + TOKEN_DAYS * 864e5, web.checked, web.roles, l.kind, l.pc || "", now).run();
  await env.DB.prepare(`UPDATE rc_links SET token = ?, user_id = ?, user_name = ? WHERE code = ?`).bind(token, user.id, user.name, l.code).run();
  return true;
}

// sign out from the program (its own token): POST /api/rc/signout, /api/overlay/signout
export async function programSignOut(request, env, kind) {
  const token = bearerToken(request, kind);
  if (!token) return false;
  await schema(env.DB);
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ? AND kind = ?`).bind(await sha256(token), kind).run();
  return true;
}

// the Keys page: a program's signed-in PCs, and turning one off
export async function listProgramSessions(env, kind) {
  await schema(env.DB);
  return (await env.DB.prepare(`SELECT substr(token_hash, 1, 16) AS id, name, label, created, last_used FROM sessions WHERE kind = ? ORDER BY last_used DESC`).bind(kind).all()).results;
}
export async function revokeProgramSession(env, id) {
  await schema(env.DB);
  const s = await env.DB.prepare(`SELECT name, kind FROM sessions WHERE kind IN ('rc', 'ov') AND substr(token_hash, 1, 16) = ?`).bind(String(id || "")).first();
  await env.DB.prepare(`DELETE FROM sessions WHERE kind IN ('rc', 'ov') AND substr(token_hash, 1, 16) = ?`).bind(String(id || "")).run();
  return s;
}

// what this person can do: admin, official (edits a series), steward (race control role), producer (producer role:
// connects an overlay), and their linked driver
async function describe(env, u) {
  const admin = u.roles.includes(env.DISCORD_ROLE_ID);
  const rc = await getSetting(env.DB, "steward_role"), pr = await getSetting(env.DB, "producer_role"), so = await getSetting(env.DB, "official_role");
  // the series they direct: with the Series official role set, the role plus an admin's assignment; before that, each
  // series' own role (the old way, until an admin saves the Series official role on Site settings)
  const directs = so ? (u.roles.includes(so) ? await directorOf(env.DB, u.id) : [])
    : (await seriesRoles(env.DB)).filter(x => x.role_id && u.roles.includes(x.role_id)).map(x => x.id);
  const official = admin || directs.length > 0;
  const link = await linkedDriver(env.DB, u.id);
  return { ...u, admin, official, directs, steward: admin || (!!rc && u.roles.includes(rc)), producer: admin || (!!pr && u.roles.includes(pr)),
    cust: link && link.cust_id ? link.cust_id : null, driverName: link ? link.name || "" : "", noDriver: !!link && !link.cust_id };
}

// POST /logout
export async function logout(request, env) {
  const token = cookies(request)[COOKIE];
  if (token && configured(env)) { await schema(env.DB); await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run(); }
  return redirect("/", [setCookie(COOKIE, "", 0)]);
}

// may this signed-in person edit this series? (admins: every series)
export const canEdit = (user, series) => !!user && (user.admin || (!!series && (user.directs || []).includes(series.id)));
// may they review protests and make decisions for this series? (race control role, or the series' officials)
export const canSteward = (user, series) => !!user && (user.steward || canEdit(user, series));
