// Shared test helpers: made-up races in iRacing's export format, and a test copy of the site with a fake Discord.
// Every driver here is invented (Racer A, Racer B, ...). Never put real driver names in this folder.
import { makeD1 } from "./d1shim.mjs";
import worker from "../src/index.js";
import { parseExport } from "../src/parse.js";
import { importEvent } from "../src/db.js";

export const ORIGIN = "https://vspeedlivetiming.app";
export const ADMIN_ROLE = "111111";

// driver i: cust_id 100+i, "Racer A", "Racer B", ...
export const driver = i => ({ cust_id: 100 + i, display_name: "Racer " + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ""), livery: { car_number: String(i + 1) } });

/**
 * One race as iRacing's results export (JSON text).
 *   order:   driver numbers in finishing order (default 0..9)
 *   start:   driver numbers in starting order (default = order)
 *   classes: { driverNumber: "Class name" } for a multi-class race
 *   led:     { driverNumber: laps led }   out: { driverNumber: "Disconnected" }
 *   points:  iRacing league points by finishing place (default 40, 39, 38, ...)
 */
export function raceExport({ sub, date, order = [...Array(10).keys()], start, classes = {}, led, out = {}, points,
  league = 4242, leagueName = "GLR Test Cup SERIES", season = 500, seasonName = "Test Cup Season 1", track = "Test Oval", laps = 100 } = {}) {
  const startOrder = start || order;
  led = led || { [order[0]]: laps };
  const results = order.map((d, i) => ({
    ...driver(d), car_name: "Test Car", car_class_short_name: classes[d] || "",
    finish_position: i, starting_position: startOrder.indexOf(d), laps_complete: out[d] ? laps - 20 : laps, laps_lead: led[d] || 0,
    incidents: i % 4, best_lap_time: 300000 + i * 100, best_lap_num: 5, average_lap: 310000, interval: out[d] ? -1 : i * 10000,
    reason_out: out[d] || "Running", league_points: points ? points[i] ?? 0 : Math.max(0, 40 - i),
  }));
  return JSON.stringify({ data: {
    subsession_id: sub, league_id: league, league_name: leagueName, league_season_id: season, league_season_name: seasonName,
    track: { track_name: track }, start_time: date, event_laps_complete: laps,
    session_results: [{ simsession_name: "RACE", results }],
  } });
}

// a date n weeks after the first race of the test season
export const week = n => new Date(Date.parse("2026-08-24T00:30:00Z") + n * 7 * 864e5).toISOString();

/**
 * A fresh test copy of the site with its own empty database.
 * site.who is the Discord user who signs in next: { id, roles, nick }. Starts as an admin.
 */
export function makeSite() {
  const DB = makeD1();
  const env = { DB, DISCORD_CLIENT_ID: "c", DISCORD_CLIENT_SECRET: "s", DISCORD_GUILD_ID: "g", DISCORD_ROLE_ID: ADMIN_ROLE };
  const s = { DB, env, who: { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" }, cookie: "", sent: [] };
  // fake Discord (sign-in) and record anything else the site sends out, like webhook posts
  globalThis.fetch = async (u, init) => {
    u = String(u);
    if (u.endsWith("/oauth2/token")) return new Response('{"access_token":"a","refresh_token":"b","expires_in":9999}');
    if (u.endsWith("/users/@me")) return new Response(JSON.stringify({ id: s.who.id, username: "u" }));
    if (/\/users\/@me\/guilds\/.+\/member$/.test(u)) return new Response(JSON.stringify({ roles: s.who.roles, nick: s.who.nick }));
    s.sent.push({ url: u, body: init && init.body });
    return new Response(JSON.stringify({ id: "999" }), { headers: { "content-type": "application/json" } });
  };
  s.go = async (path, init = {}) => {
    const h = new Headers(init.headers || {});
    if (!h.has("authorization")) h.set("cookie", s.cookie);
    const waits = [];
    const r = await worker.fetch(new Request(ORIGIN + path, { ...init, headers: h }), env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(";")[0], k = kv.split("=")[0];
      s.cookie = s.cookie.split("; ").filter(x => x && !x.startsWith(k + "=")).concat(/Max-Age=0/.test(c) ? [] : [kv]).join("; ");
    }
    return r;
  };
  s.page = async path => { const r = await s.go(path); return { status: r.status, html: await r.text() }; };
  s.json = async path => (await s.go(path)).json();
  s.signIn = async (who) => {
    if (who) s.who = who;
    s.cookie = "";
    const r = await s.go("/glr/login");
    const state = new URL(r.headers.get("location")).searchParams.get("state");
    return (await s.go("/glr/auth/callback?code=x&state=" + state)).status;
  };
  s.post = async (path, fields) => {
    const fd = new FormData();
    for (const [k, v] of Array.isArray(fields) ? fields : Object.entries(fields)) fd.append(k, v);
    const r = await s.go(path, { method: "POST", body: fd, headers: { origin: ORIGIN } });
    return { status: r.status, location: r.headers.get("location"), html: await r.text() };
  };
  s.upload = async (text, name = "results.json") => {
    const fd = new FormData(); fd.append("file", new Blob([text]), name);
    const r = await s.go("/glr/api/upload", { method: "POST", body: fd, headers: { origin: ORIGIN } });
    return { status: r.status, body: await r.json() };
  };
  s.addRace = (opts, by = "") => importEvent(DB, parseExport(raceExport(opts)), by);
  return s;
}

// the page's text without tags, for simple "does it say X" checks
export const text = html => html.replace(/<script[^]*?<\/script>/g, "").replace(/<style[^]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
