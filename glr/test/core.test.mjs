// Results parsing, standings and stats, without the web pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExport, parseOverlay } from "../src/parse.js";
import { computeStandings, GLR_PLAYOFFS } from "../src/standings.js";
import { computeStats } from "../src/stats.js";
import { raceExport, week } from "./helpers.mjs";

// a parsed race in the shape the standings take (what the database hands back)
const asEvent = text => {
  const ev = parseExport(text);
  const race = ev.sessions.find(s => s.name === "race");
  return { subsession_id: ev.subsessionId, start_time: ev.startTime, track: ev.track, results: race.results.map(r => ({
    cust_id: r.custId, name: r.name, car_number: r.carNumber, car_class: r.carClass, finish_pos: r.finish, class_pos: r.classPos,
    start_pos: r.start, laps: r.laps, laps_led: r.lapsLed, incidents: r.incidents, best_lap_ms: r.bestLapMs, reason_out: r.reasonOut,
    laps_down: r.lapsDown, class_laps_down: r.classLapsDown, league_points: r.leaguePoints })) };
};
const season = (n, f = () => ({})) => [...Array(n)].map((_, i) => asEvent(raceExport({ sub: 1000 + i, date: week(i), ...f(i) })));
const row = (st, cust) => st.groups[0].regular.find(r => r.custId === cust);

test("parses an iRacing results export", () => {
  const ev = parseExport(raceExport({ sub: 1, date: week(0) }));
  assert.equal(ev.subsessionId, 1);
  assert.equal(ev.league.id, 4242);
  assert.equal(ev.season.id, 500);
  const race = ev.sessions.find(s => s.name === "race");
  assert.equal(race.results.length, 10);
  assert.equal(race.results[0].name, "Racer A");
  assert.equal(race.results[0].finish, 1);
});

test("multi-class races get places within each class", () => {
  const ev = parseExport(raceExport({ sub: 2, date: week(0), order: [0, 1, 2, 3], classes: { 0: "GTP", 1: "GT3", 2: "GTP", 3: "GT3" } }));
  const race = ev.sessions.find(s => s.name === "race").results;
  const pos = Object.fromEntries(race.map(r => [r.name, [r.carClass, r.classPos]]));
  assert.deepEqual(pos["Racer B"], ["GT3", 1]);
  assert.deepEqual(pos["Racer C"], ["GTP", 2]);
});

test("rejects files that aren't results", () => {
  assert.throws(() => parseExport("hello", "x.txt"));
  assert.throws(() => parseExport("{}", "x.json"));
  assert.throws(() => parseOverlay({ type: "something else" }));
});

test("standings with iRacing's points add up", () => {
  const st = computeStandings({}, season(3));
  assert.equal(row(st, 100).points, 120);       // won all three: 40 each
  assert.equal(row(st, 100).pos, 1);
  assert.equal(row(st, 109).points, 93);        // last all three: 31 each
});

test("points table, bonuses and their reasons", () => {
  const rules = { points: { source: "table", table: [10, 8, 6], others: 1 }, bonus: { win: 2, led: 1, mostLed: 1 } };
  const st = computeStandings(rules, season(1, () => ({ led: { 0: 60, 1: 40 } })));
  assert.equal(row(st, 100).points, 14);        // 10 + win 2 + led 1 + most led 1
  assert.equal(row(st, 101).points, 9);         // 8 + led 1
  assert.equal(row(st, 105).points, 1);         // past the table
  const pts = st.groups[0].races[0].points[100];
  assert.ok(pts.bonusReasons.some(r => /Led a lap/.test(r)));
});

test("drop weeks drop the worst race", () => {
  const races = season(3, i => ({ order: i === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] : undefined }));
  assert.equal(row(computeStandings({ drops: 0 }, races), 100).points, 111);
  assert.equal(row(computeStandings({ drops: 1 }, races), 100).points, 80);
});

test("places moved since the last race", () => {
  // race 2: the 6th-place driver wins, everyone ahead of him drops one place on the day
  const races = season(2, i => ({ order: i === 1 ? [5, 0, 1, 2, 3, 4, 6, 7, 8, 9] : undefined }));
  const st = computeStandings({}, races);
  assert.equal(row(st, 100).chg, 0);            // still first
  assert.ok(row(st, 105).chg > 0);              // 6th -> 3rd
  assert.equal(row(st, 103).chg, -1);           // 4th -> 5th
});

test("GLR playoffs: field of 12 after the regular season", () => {
  const order = [...Array(14).keys()];
  const st = computeStandings({ playoffs: GLR_PLAYOFFS }, season(11, () => ({ order })));
  const po = st.groups[0].playoffs;
  assert.ok(po && po.started);
  assert.equal(po.current.name, "Round of 12");
  assert.equal(po.current.rows.length, 12);
  assert.equal(po.current.rows[0].custId, 100); // the regular-season leader starts the round on top (seed bonus)
});

test("stats count wins, poles and laps led per class", () => {
  const rows = computeStats(season(3, i => ({ start: [1, 0, 2, 3, 4, 5, 6, 7, 8, 9] })));
  const a = rows.find(r => r.custId === 100), b = rows.find(r => r.custId === 101);
  assert.equal(a.wins, 3);
  assert.equal(a.lapsLed, 300);
  assert.equal(b.poles, 3);
  assert.equal(a.starts, 3);
});
