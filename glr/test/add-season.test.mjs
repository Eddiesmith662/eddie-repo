// Add season (Nov 2026): a Series Director adds the next season on the Rules tab before its first race, sets its
// rules ahead of time, and the first race of a new iRacing season takes it over with iRacing's season name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const UP = -4242;                                          // the upcoming season's stand-in id: minus the league id
const dayStr = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function setup() {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(-2) });          // season 500, "Test Cup Season 1"
  await s.signIn(ADMIN);
  s.slug = s.DB.raw.prepare("SELECT slug FROM series WHERE id = 4242").get().slug;
  s.R = `/${s.slug}/rules`;
  return s;
}

test("add the next season, set its rules, and the first race of a new iRacing season takes it over", async () => {
  const s = await setup();
  assert.match(text((await s.page(s.R)).html), /Next season Add the next season before its first race/);
  assert.match(text((await s.post(s.R, { action: "season_add", name: " " })).html), /Name the season/);
  assert.match(text((await s.post(s.R, { action: "season_add", name: "test cup season 1" })).html), /already has a season called/);
  const added = text((await s.post(s.R, { action: "season_add", name: "2027 Season 1" })).html);
  assert.match(added, /Added 2027 Season 1/);
  assert.match(added, /2027 Season 1 \(upcoming\)/);        // in the season picker
  // pages still open on the season being raced
  assert.equal((await s.json(`/api/standings/${s.slug}`)).season.name, "Test Cup Season 1");
  assert.equal((await s.json(`/api/series/${s.slug}/points`)).season.id, 500);
  // its rules start as the latest season's, and saving makes them its own
  assert.match(text((await s.page(`${s.R}?season=${UP}`)).html), /2027 Season 1/);
  await s.post(`${s.R}?season=${UP}`, { source: "table", table: "60, 50, 40", others: "2", season: String(UP) });
  assert.notEqual((await s.json(`/api/series/${s.slug}/points`)).table[0], 60);     // not this season's rules
  // a late upload from the season that just ended doesn't take it
  await s.addRace({ sub: 1001, date: week(-1) });
  assert.equal(s.DB.raw.prepare("SELECT name FROM seasons WHERE id = ?").get(UP).name, "2027 Season 1");
  // the new iRacing season's first race does, with iRacing's name
  await s.addRace({ sub: 2000, date: new Date().toISOString(), season: 600, seasonName: "Test Cup Season 2", order: [0, 1, 2, 3, 4] });
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM seasons WHERE id < 0").get().n, 0);
  const st = await s.json(`/api/standings/${s.slug}`);
  assert.equal(st.season.name, "Test Cup Season 2");
  assert.deepEqual(st.groups[0].regular.slice(0, 4).map(x => x.points), [60, 50, 40, 2]);
  assert.match(text((await s.page(s.R)).html), /Next season Add the next season/);    // room for the one after
  assert.match(text((await s.page("/history")).html), /Season added: 2027 Season 1/);
});

test("an old season's file doesn't take the upcoming season; rename and remove", async () => {
  const s = await setup();
  await s.post(s.R, { action: "season_add", name: "2027 Season 1" });
  await s.addRace({ sub: 900, date: week(-30), season: 400, seasonName: "Test Cup Season 0" });
  assert.equal(s.DB.raw.prepare("SELECT name FROM seasons WHERE id = ?").get(UP).name, "2027 Season 1");
  assert.match(text((await s.post(s.R, { action: "season_add", name: "2027 Spring" })).html), /Renamed 2027 Season 1 to 2027 Spring/);
  await s.post(`${s.R}?season=${UP}`, { source: "table", table: "9, 8", others: "1", season: String(UP) });
  assert.match(text((await s.post(s.R, { action: "season_remove" })).html), /Removed 2027 Spring/);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM seasons WHERE id < 0").get().n, 0);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM season_rules WHERE season_id < 0").get().n, 0);
  assert.match(text((await s.post(s.R, { action: "season_remove" })).html), /no upcoming season/);
});

test("only the series' Series Directors and Admins can add a season", async () => {
  const s = await setup();
  await s.signIn({ id: "9", roles: [], nick: "Racer Ray" });
  assert.doesNotMatch(text((await s.page(s.R)).html), /Next season/);
  assert.equal((await s.post(s.R, { action: "season_add", name: "2027 Season 1" })).status, 404);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM seasons WHERE id < 0").get().n, 0);
});

test("signups and the upcoming season share one name", async () => {
  const s = await setup();
  const P = `/${s.slug}/signups`;
  await s.post(s.R, { action: "season_add", name: "2027 Season 1" });
  assert.match((await s.page(P)).html, /name="name"[^>]*value="2027 Season 1"/);      // filled in for you
  await s.post(P, { action: "round", name: "2027 Season 1", keep_date: dayStr(1), open_date: dayStr(8) });
  await s.post(s.R, { action: "season_add", name: "2027 Spring" });                    // renaming the season renames the signups
  assert.equal(s.DB.raw.prepare("SELECT name FROM signup_rounds").get().name, "2027 Spring");
  await s.post(P, { action: "round", name: "2027 Summer", keep_date: dayStr(1), open_date: dayStr(8) });   // and the other way
  assert.equal(s.DB.raw.prepare("SELECT name FROM seasons WHERE id = ?").get(UP).name, "2027 Summer");
  // opening signups with no upcoming season adds it
  const t = await setup();
  await t.post(`/${t.slug}/signups`, { action: "round", name: "2027 Season 1", keep_date: dayStr(1), open_date: dayStr(8) });
  assert.equal(t.DB.raw.prepare("SELECT name FROM seasons WHERE id = ?").get(UP).name, "2027 Season 1");
});
