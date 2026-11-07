// The Downloads page: the VSPEED programs for the accounts that use them, linked to GitHub's zip of the latest release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, text, ADMIN_ROLE } from "./helpers.mjs";

const PRODUCER = "444444", RC = "555555", OFFICIAL = "666666";

async function site() {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.post("/settings", { theme: "glr", short: "GLR", steward_role: RC, producer_role: PRODUCER, official_role: OFFICIAL });
  // GitHub's API, counted, in front of the fake Discord
  const discord = globalThis.fetch;
  s.github = { calls: 0, answer: () => new Response(JSON.stringify({ tag_name: "v1.5.42" })) };
  globalThis.fetch = async (u, init) => String(u).startsWith("https://api.github.com/") ? (s.github.calls++, s.github.answer()) : discord(u, init);
  return s;
}
const as = (s, id, roles) => s.signIn({ id, roles, nick: "Person " + id });

test("producers get the overlay, stewards race control, with the latest version's zip", async () => {
  const s = await site();
  await as(s, "10", [PRODUCER]);
  let p = await s.page("/downloads");
  assert.match(p.html, /href="\/downloads">Downloads</);
  assert.match(text(p.html), /Download the VSPEED broadcast overlay v1\.5\.42/);
  assert.match(p.html, /href="https:\/\/github\.com\/Eddiesmith662\/eddie-repo\/archive\/refs\/tags\/v1\.5\.42\.zip"/);
  assert.match(text(p.html), /Double-click start\.bat .*Setup &gt; League site upload &gt; Sign in with Discord/);
  assert.doesNotMatch(p.html, /race control<\/a>/i);
  assert.match(p.html, /C:\\VSPEED/);

  await as(s, "11", [RC]);
  p = await s.page("/downloads");
  assert.match(text(p.html), /Download VSPEED race control v1\.5\.42 .*start-race-control\.bat/);
  assert.doesNotMatch(p.html, /broadcast overlay<\/a>/);
  assert.equal(s.github.calls, 1);                           // looked up once, then kept for an hour
});

test("nobody else sees it; a director with a series does", async () => {
  const s = await site();
  await as(s, "20", []);
  assert.doesNotMatch((await s.page("/")).html, /Downloads/);
  assert.equal((await s.page("/downloads")).status, 404);
  await as(s, "21", [OFFICIAL]);                             // the role but no series yet
  assert.equal((await s.page("/downloads")).status, 404);
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: "2026-08-24T00:30:00Z" });
  await s.post("/accounts", { action: "direct", id: "21", series: "4242" });
  await as(s, "21", [OFFICIAL]);
  assert.match(text((await s.page("/downloads")).html), /Download VSPEED race control/);
});

test("GitHub unreachable: the releases page, or the last version known", async () => {
  const s = await site();
  s.github.answer = () => { throw new Error("offline"); };
  await as(s, "10", [PRODUCER]);
  assert.match((await s.page("/downloads")).html, /href="https:\/\/github\.com\/Eddiesmith662\/eddie-repo\/releases\/latest"/);
  await s.DB.prepare(`UPDATE site_settings SET value = '0' WHERE key = 'release_checked'`).run();
  s.github.answer = () => new Response(JSON.stringify({ tag_name: "v1.5.43" }));
  assert.match((await s.page("/downloads")).html, /tags\/v1\.5\.43\.zip/);
  await s.DB.prepare(`UPDATE site_settings SET value = '0' WHERE key = 'release_checked'`).run();
  s.github.answer = () => new Response("rate limited", { status: 403 });
  assert.match((await s.page("/downloads")).html, /tags\/v1\.5\.43\.zip/);   // kept
});
