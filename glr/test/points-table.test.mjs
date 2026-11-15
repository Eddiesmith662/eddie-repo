// One points table on the site (Nov 2026): the Grand National's iRacing points copied into its rules, so races sent by
// the overlay or race control score at once (Phoenix, Nov 8 2026: an overlay race marked official scored 0 for everyone
// under "iRacing points"). The overlay reads the same table for its live points.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, text } from "./helpers.mjs";
import { computeStandings } from "../src/standings.js";

const VSPEED = [46, 42, ...Array.from({ length: 41 }, (_, i) => 41 - i)];      // P1 46, P2 42, P3 41 … P43 1

test("own table: a car with 0 laps scores nothing when ticked, and bonuses for leading", () => {
  const rows = [
    { cust_id: 1, finish_pos: 1, laps: 100, laps_led: 60, name: "A" },
    { cust_id: 2, finish_pos: 2, laps: 100, laps_led: 5, name: "B" },
    { cust_id: 3, finish_pos: 3, laps: 99, laps_led: 0, name: "C" },
    { cust_id: 4, finish_pos: 4, laps: 0, laps_led: 0, name: "D" }];
  const ev = { subsession_id: 1, start_time: "2026-11-09T01:00:00Z", results: rows };
  const pts = z => Object.fromEntries(computeStandings({ points: { source: "table", table: VSPEED, zeroLaps: z }, bonus: { led: 1, mostLed: 1 } }, [ev])
    .groups[0].regular.map(x => [x.name, x.points]));
  assert.deepEqual(pts(true), { A: 48, B: 43, C: 41, D: 0 });
  assert.equal(pts(false).D, 40);
});

test("the rules form saves the box, the Rules tab says so, and the overlay can read the table", async () => {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: new Date(Date.now() - 864e5).toISOString() });
  await s.signIn();
  assert.equal((await s.json("/api/series/test-cup/points")).source, "iracing");
  const r = await s.post("/test-cup/rules", { source: "table", table: VSPEED.join(", "), others: "0", zero_laps: "on", b_led: "1", b_mostLed: "1" });
  assert.notEqual(r.status, 500);
  assert.match(text((await s.page("/test-cup/rules")).html), /P1 46, P2 42, P3 41.*; a car with 0 laps scores nothing\./);
  const api = await s.json("/api/series/test-cup/points");
  assert.equal(api.source, "table");
  assert.deepEqual(api.table.slice(0, 4), [46, 42, 41, 40]);
  assert.equal(api.zeroLaps, true);
  assert.deepEqual(api.bonus, { win: 0, pole: 0, led: 1, mostLed: 1, fastLap: 0 });
  // the rest of the rules the overlay scores with: drop weeks, classes, ties and the playoff format (no driver names)
  assert.deepEqual([api.drops, api.byClass, api.ties], [0, false, "share"]);
  assert.equal(api.playoffs.enabled, false);
  await s.post("/test-cup/rules", { source: "table", table: "40, 35", others: "1", drops: "2", byClass: "on", ties: "wins", po: "on", regularRaces: "20", field: "10", minStarts: "3",
    winIn: "on", seedBonus: "15, 10, 8", winBonus: "5", r0_name: "Round of 10", r0_races: "3", r0_drivers: "10", r1_name: "Final 4", r1_races: "1", r1_drivers: "4", r1_final: "on" });
  // a driver the stewards took out of the playoffs: named in the rules, never in this answer
  const row = s.DB.raw.prepare("SELECT season_id, rules FROM season_rules").get(), rules = JSON.parse(row.rules);
  rules.playoffs.out = [{ cust: 101, reason: "Withdrew" }];
  s.DB.raw.prepare("UPDATE season_rules SET rules = ? WHERE season_id = ?").run(JSON.stringify(rules), row.season_id);
  const full = await s.json("/api/series/test-cup/points");
  assert.deepEqual([full.drops, full.byClass, full.ties], [2, true, "wins"]);
  assert.deepEqual([full.playoffs.enabled, full.playoffs.field, full.playoffs.regularRaces, full.playoffs.minStarts, full.playoffs.winIn, full.playoffs.winBonus], [true, 10, 20, 3, true, 5]);
  assert.deepEqual(full.playoffs.seedBonus, [15, 10, 8]);
  assert.deepEqual(full.playoffs.rounds, [{ name: "Round of 10", races: 3, drivers: 10 }, { name: "Final 4", races: 1, drivers: 4 }]);
  assert.deepEqual(Object.keys(full.playoffs).sort(), ["enabled", "field", "minStarts", "regularRaces", "rounds", "seedBonus", "winBonus", "winIn"]);
  for (const r of full.playoffs.rounds) assert.deepEqual(Object.keys(r).sort(), ["drivers", "name", "races"]);
  assert.equal(/Withdrew|"out"|101/.test(JSON.stringify(full)), false);
  assert.equal((await s.go("/api/series/nope/points")).status, 404);
});

test("the Rules form starts our own points table with the GLR table, and keeps a table that was saved", async () => {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: new Date(Date.now() - 7 * 864e5).toISOString() });
  await s.signIn();
  const glr = "46, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1";
  let html = (await s.page("/test-cup/rules")).html;
  assert.ok(html.includes(`name="table" value="${glr}"`), "the form starts with the GLR table");
  assert.match(text(html), /Filled in with the GLR table/);
  // it's only a starting value: the series still scores with iRacing's points until someone saves it
  assert.equal((await s.json("/api/series/test-cup/points")).source, "iracing");
  assert.deepEqual((await s.json("/api/series/test-cup/points")).table, []);
  // saved as it stands: the series scores with it
  await s.post("/test-cup/rules", { source: "table", table: glr, others: "0" });
  const api = await s.json("/api/series/test-cup/points");
  assert.deepEqual([api.source, api.table.length, api.table[0], api.table[1], api.table[42]], ["table", 43, 46, 42, 1]);
  // a table someone changed stays as they left it, with no note
  await s.post("/test-cup/rules", { source: "table", table: "50, 40, 30", others: "5" });
  html = (await s.page("/test-cup/rules")).html;
  assert.ok(html.includes(`name="table" value="50, 40, 30"`));
  assert.doesNotMatch(text(html), /Filled in with the GLR table/);
});
