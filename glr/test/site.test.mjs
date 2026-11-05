// The site end to end: pages, sign-in and roles, uploads, overlay results, officials' tools, schedules and widgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, raceExport, week, text } from "./helpers.mjs";

const seeded = async (n = 3) => { const s = makeSite(); for (let i = 0; i < n; i++) await s.addRace({ sub: 1000 + i, date: week(i) }); return s; };
const overlayRace = (sub, extra = {}) => ({
  type: "vspeed_overlay_result", version: 1, subsessionId: sub, leagueId: 4242, track: "Test Oval", startTime: new Date().toISOString(),
  laps: 100, cautions: 2, cautionLaps: 8, leadChanges: 3, official: false,
  results: [0, 1, 2].map(i => ({ custId: 100 + i, name: "Racer " + "ABC"[i], carNumber: String(i + 1), car: "Test Car", carClass: "",
    finish: i + 1, classPos: i + 1, start: i + 1, laps: 100, lapsLed: i ? 0 : 100, incidents: 0, bestLapMs: 30000, bestLapNum: 4,
    intervalMs: i * 1000, lapsDown: 0, reasonOut: "Running" })), ...extra });

test("public pages open without signing in", async () => {
  const s = await seeded();
  for (const p of ["/glr", "/glr/test-cup", "/glr/test-cup/standings", "/glr/test-cup/schedule", "/glr/test-cup/stats", "/glr/test-cup/drivers",
    "/glr/test-cup/rules", "/glr/test-cup/penalties", "/glr/results/1000", "/glr/drivers/100", "/glr/drivers", "/glr/schedule", "/glr/test-cup/embed",
    "/glr/test-cup/widget/standings", "/glr/test-cup/widget/schedule", "/glr/test-cup/widget/results"]) {
    const { status } = await s.page(p);
    assert.equal(status, 200, p);
  }
  assert.equal((await s.page("/glr/results/5")).status, 404);
  assert.equal((await s.page("/glr/drivers/1")).status, 404);
  const series = (await s.json("/glr/api/series")).series;
  assert.equal(series[0].slug, "test-cup");
});

test("standings page shows the leader", async () => {
  const s = await seeded();
  const t = text((await s.page("/glr/test-cup/standings")).html);
  assert.match(t, /1 1 Racer A 120/);
});

test("uploads need a signed-in official", async () => {
  const s = makeSite();
  assert.equal((await s.upload(raceExport({ sub: 1, date: week(0) }))).status, 401);
  assert.equal(await s.signIn(), 302);
  const up = await s.upload(raceExport({ sub: 1, date: week(0) }));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await s.json("/glr/api/results/1")).event.status, "official");
});

test("people without a league role can't sign in", async () => {
  const s = makeSite();
  await s.signIn({ id: "9", roles: [], nick: "Fan" });
  assert.equal((await s.json("/glr/api/me")).user, null);
});

test("a series official can only change their own series", async () => {
  const s = await seeded(1);
  await s.addRace({ sub: 2000, date: week(0), league: 5555, leagueName: "GLR Other SERIES", season: 600 });
  await s.signIn();
  assert.equal((await s.post("/glr/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", role_id: "222222" })).status, 303);
  await s.signIn({ id: "2", roles: ["222222"], nick: "Cup Official" });
  assert.ok((await s.page("/glr/test-cup/rules")).html.includes("Save rules"));
  assert.ok(!(await s.page("/glr/other/rules")).html.includes("Save rules"));
  const other = await s.upload(raceExport({ sub: 2001, date: week(1), league: 5555, leagueName: "GLR Other SERIES", season: 600 }));
  assert.equal(other.body.ok, false);
});

test("overlay results come in provisional and an official makes them official", async () => {
  const s = await seeded(1);
  await s.signIn();
  const keys = await s.post("/glr/keys", { name: "Test Producer" });
  const key = keys.html.match(/vsglr_[0-9a-f]{48}/)[0];
  const send = async body => { const r = await s.go("/glr/api/overlay/results", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer " + key, "content-type": "application/json" } }); return { status: r.status, body: await r.json() }; };
  assert.equal((await s.go("/glr/api/overlay/check", { headers: { authorization: "Bearer vsglr_" + "0".repeat(48) } })).status, 401);
  assert.equal((await send({ ...overlayRace(3000), leagueId: 77 })).body.ok, false);   // a league that isn't on the site
  assert.equal((await send(overlayRace(3000))).status, 200);
  assert.equal((await s.json("/glr/api/results/3000")).event.status, "provisional");
  await s.post("/glr/results/3000", { action: "official" });
  assert.equal((await s.json("/glr/api/results/3000")).event.status, "official");
  assert.equal((await send(overlayRace(3000))).body.skipped, true);                    // can't overwrite official results
});

test("fixing a result, then removing the race", async () => {
  const s = await seeded(2);
  await s.signIn();
  const r = await s.post("/glr/results/1001", { cust: "100", finish_pos: "3", reason: "Penalty for jumping the start" });
  assert.match(text(r.html), /Fixed:/);
  assert.match(text((await s.page("/glr/results/1001")).html), /Penalty for jumping the start/);
  const del = await s.post("/glr/results/1001", { action: "delete" });
  assert.equal(del.status, 303);
  assert.equal((await s.page("/glr/results/1001")).status, 404);
  assert.match(text((await s.page("/glr/history")).html), /Race removed/);
});

test("schedule lines are added and results attach to the line they belong to", async () => {
  const s = makeSite();
  await s.addRace({ sub: 1, date: week(0) });
  await s.signIn();
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await s.post("/glr/test-cup/schedule", { bulk: `${day(-7)}, 8:00 PM, Test Oval\n${day(14)}, 8:00 PM, Other Oval, Playoffs: Round of 12` });
  let races = (await s.json("/glr/api/series/test-cup/schedule")).races;
  assert.equal(races.length, 2);
  assert.equal(races[1].notes, "Playoffs: Round of 12");
  await s.addRace({ sub: 2, date: new Date(Date.parse(races[0].startsAt) + 10 * 60000).toISOString() });   // goes green 10 minutes after the listed time
  races = (await s.json("/glr/api/series/test-cup/schedule")).races;
  assert.equal(races[0].subsessionId, 2);
});

test("the site theme can be changed by an admin", async () => {
  const s = await seeded(1);
  assert.ok((await s.page("/glr")).html.includes("glr-logo.png"));          // GLR theme by default
  await s.signIn();
  await s.post("/glr/settings", { theme: "vspeed" });
  assert.ok(!(await s.page("/glr")).html.includes("glr-logo.png"));
});

test("the GLR theme has a Dark switch that's remembered", async () => {
  const s = await seeded(1);
  let html = (await s.page("/glr/test-cup/standings")).html;
  assert.ok(html.includes('id="modeSw"'));
  assert.ok(!html.includes('<html lang="en" class="dark">'));
  s.cookie = "glr_mode=dark";
  html = (await s.page("/glr/test-cup/standings")).html;
  assert.ok(html.includes('<html lang="en" class="dark">'));
  assert.equal((await s.go("/glr/theme/glr-logo-dark.png")).status, 200);
  await s.signIn();
  await s.post("/glr/settings", { theme: "vspeed" });                    // the VSPEED theme is dark already: no switch
  assert.ok(!(await s.page("/glr")).html.includes('id="modeSw"'));
});
