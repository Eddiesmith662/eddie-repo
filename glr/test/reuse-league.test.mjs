// Reusing a league ID (Nov 2026): GLR sometimes gives an iRacing league to another series. An Admin sets the old
// series aside as a past series (it keeps everything), adds the new series on the same league ID, and can move a
// season that landed under the wrong series. A race follows its season; a season belongs to one series for good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, raceExport, ADMIN_ROLE } from "./helpers.mjs";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const one = (s, sql, ...a) => s.DB.raw.prepare(sql).get(...a);
async function setup() {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(-3) });                       // league 4242, season 500
  await s.addRace({ sub: 1001, date: week(-2) });
  await s.signIn(ADMIN);
  s.upload = async opts => { const fd = new FormData(); fd.append("file", new Blob([raceExport(opts)]), "race.json");
    const r = await s.go("/api/upload", { method: "POST", body: fd, headers: { origin: "https://glrhub.app" } }); return r.json(); };
  return s;
}

test("every table that points at a series is moved when it's set aside", async () => {
  const s = await setup();
  await s.page("/");
  // fill every table that has a series_id with a row for the series, whatever tables the site has by then
  const tables = s.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
  const withSeries = tables.filter(t => t !== "series" && s.DB.raw.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === "series_id"));
  assert.ok(withSeries.length >= 8, withSeries.join());
  // any column that names a series another way would be missed: there must be none
  for (const t of tables) for (const c of s.DB.raw.prepare(`PRAGMA table_info(${t})`).all())
    assert.ok(!/series|league/i.test(c.name) || c.name === "series_id" || t === "series" || c.name === "league_points", `${t}.${c.name}`);
  assert.match(text((await s.post("/test-cup/edit", { action: "retire", confirm: "wrong" })).html), /Type Test Cup to confirm/);
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM series WHERE past = 1").n, 0);
  const r = await s.post("/test-cup/edit", { action: "retire", confirm: "test cup" });
  assert.equal(r.status, 303);
  const past = one(s, "SELECT * FROM series WHERE slug = 'test-cup'");
  assert.equal(past.past, 1); assert.equal(past.was_league, 4242); assert.ok(past.id > 1e9);
  for (const t of withSeries) assert.equal(one(s, `SELECT COUNT(*) AS n FROM ${t} WHERE series_id = 4242`).n, 0, t);
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM events WHERE series_id = ?", past.id).n, 2);
  // its pages still work, marked as a past series, under a Past series heading on the home page
  assert.match(text((await s.page("/test-cup")).html), /Test Cup Past series/);
  assert.equal((await s.json("/api/standings/test-cup")).season.name, "Test Cup Season 1");
  assert.match(text((await s.page("/")).html), /Past series Series that have finished/);
  assert.match(text((await s.page("/test-cup/edit")).html), /it ran in iRacing league 4242 until/);
  assert.doesNotMatch(text((await s.page("/test-cup/rules")).html), /Next season/);
  assert.match(text((await s.post("/test-cup/signups", { action: "round", name: "X", keep_date: "2027-01-01", open_date: "2027-01-08" })).html), /past series: it doesn.{1,6}t take signups/);
  assert.match(text((await s.page("/history")).html), /Test Cup set aside as a past series: iRacing league 4242 is free/);
});

test("after the league is reused, each race lands in the right series", async () => {
  const s = await setup();
  await s.post("/test-cup/edit", { action: "retire", confirm: "Test Cup" });
  const past = one(s, "SELECT id FROM series WHERE slug = 'test-cup'").id;
  assert.equal((await s.post("/series/add", { id: "4242", short_name: "Late Models", slug: "", name: "" })).status, 303);
  assert.equal(one(s, "SELECT reused FROM series WHERE id = 4242").reused, 1);
  // a new season's race: the new series
  let r = await s.upload({ sub: 3000, date: new Date().toISOString(), season: 700, seasonName: "Late Models 2027", leagueName: "GLR Late Model SERIES" });
  assert.equal(r.ok, true);
  assert.equal(one(s, "SELECT series_id FROM events WHERE subsession_id = 3000").series_id, 4242);
  // the old series' race uploaded again: stays in the past series, and its name isn't touched
  r = await s.upload({ sub: 1001, date: week(-2) });
  assert.equal(r.ok, true);
  assert.equal(one(s, "SELECT series_id FROM events WHERE subsession_id = 1001").series_id, past);
  // another race of the old series' known season: the past series
  await s.upload({ sub: 1002, date: week(-1) });
  assert.equal(one(s, "SELECT series_id FROM events WHERE subsession_id = 1002").series_id, past);
  // an older season the site never had, from before the league changed hands: the past series
  await s.upload({ sub: 900, date: week(-40), season: 400, seasonName: "Test Cup Season 0" });
  assert.equal(one(s, "SELECT series_id FROM events WHERE subsession_id = 900").series_id, past);
  assert.equal(one(s, "SELECT series_id FROM seasons WHERE id = 400").series_id, past);
  assert.equal(one(s, "SELECT name FROM series WHERE id = ?", past).name, "GLR Test Cup SERIES");
  assert.equal(one(s, "SELECT name FROM series WHERE id = 4242").name, "GLR Late Model SERIES");
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM events WHERE series_id = 4242").n, 1);
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM events WHERE series_id = ?", past).n, 4);
  // the series list tells them apart
  const api = (await s.json("/api/series")).series;
  assert.equal(api.find(x => x.slug === "test-cup").past, 1);
  assert.equal(api.find(x => x.slug === "late-models").past, 0);
});

test("a season under the wrong series is moved to a past series with no league ID", async () => {
  const s = await setup();
  await s.addRace({ sub: 800, date: week(-60), season: 300, seasonName: "Dirt 2025" });      // the league ran another series before
  assert.equal((await s.post("/series/add", { id: "", past: "on", short_name: "Dirt", slug: "", name: "" })).status, 303);
  const dirt = one(s, "SELECT * FROM series WHERE slug = 'dirt'");
  assert.equal(dirt.past, 1); assert.equal(dirt.was_league, null);
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM seasons WHERE series_id = ?", dirt.id).n, 0);         // no first season
  assert.match(text((await s.page("/test-cup/edit")).html), /Move a season/);
  assert.match(text((await s.post("/test-cup/edit", { action: "move_season", season: "300", to: "" })).html), /Pick the series to move it to/);
  await s.post("/test-cup/edit", { action: "move_season", season: "300", to: String(dirt.id) });
  assert.equal(one(s, "SELECT series_id FROM events WHERE subsession_id = 800").series_id, dirt.id);
  assert.equal(one(s, "SELECT series_id FROM seasons WHERE id = 300").series_id, dirt.id);
  assert.equal((await s.json("/api/standings/dirt")).season.name, "Dirt 2025");
  assert.equal((await s.json("/api/standings/test-cup")).season.name, "Test Cup Season 1");
  // uploading that race again keeps it in Dirt
  await s.upload({ sub: 800, date: week(-60), season: 300, seasonName: "Dirt 2025" });
  assert.equal(one(s, "SELECT series_id FROM events WHERE subsession_id = 800").series_id, dirt.id);
  assert.match(text((await s.page("/history")).html), /Season moved to Dirt: Dirt 2025/);
});

test("only Admins set a series aside or move a season", async () => {
  const s = await setup();
  await s.signIn({ id: "9", roles: [], nick: "Racer Ray" });
  assert.equal((await s.post("/test-cup/edit", { action: "retire", confirm: "Test Cup" })).status, 404);
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM series WHERE past = 1").n, 0);
});
