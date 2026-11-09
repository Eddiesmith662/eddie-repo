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
  assert.equal((await s.go("/api/series/nope/points")).status, 404);
});
