// Team points (the Warrior points system): per race, a team's drivers' finishing points added up and divided by how
// many of them raced; the season is every race added up. Teams, drivers and series here are all made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";
import { teamStandings, parseTeams } from "../src/teams.js";

// Racer A..J are cust 100..109; default points 40, 39, 38 ... by finishing place
test("team score per race = drivers' points / drivers who raced; season = sum; no drivers = 0", () => {
  const race = (sub, pts) => ({ subsession_id: sub, start_time: "2026-09-0" + sub, track: "T", points: Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, { base: v }])) });
  const st = { groups: [{ races: [race(1, { 100: 40, 101: 39, 102: 38 }), race(2, { 100: 30, 103: 20 })] }] };
  const ts = teamStandings([
    { id: 1, name: "Red Team", members: [{ cust_id: 100, name: "A" }, { cust_id: 101, name: "B" }, { cust_id: 104, name: "E" }] },
    { id: 2, name: "Blue Team", members: [{ cust_id: 102, name: "C" }, { cust_id: 103, name: "D" }] },
    { id: 3, name: "Green Team", members: [{ cust_id: 105, name: "F" }] },
  ], st);
  const red = ts.teams.find(t => t.name === "Red Team"), blue = ts.teams.find(t => t.name === "Blue Team");
  assert.deepEqual(red.races.map(r => [r.score, r.raced, r.of]), [[39.5, 2, 3], [30, 1, 3]]);   // (40+39)/2, then 30/1
  assert.equal(red.total, 69.5);
  assert.deepEqual(blue.races.map(r => r.score), [38, 20]);
  assert.equal(blue.total, 58);
  assert.deepEqual(ts.teams.map(t => [t.name, t.pos, t.total]), [["Red Team", 1, 69.5], ["Blue Team", 2, 58], ["Green Team", 3, 0]]);
  assert.equal(red.drivers.get(100).points, 70);
});

test("pasting teams: a spreadsheet grid or one team per line, matched by name, alias or iRacing ID", () => {
  const drivers = [
    { cust_id: 100, name: "Racer Alpha", aliases: ["Racer Alpha Jr"], here: true },
    { cust_id: 101, name: "Racer Bravo", aliases: [], here: true },
    { cust_id: 102, name: "Racer Q Charlie", aliases: [], here: true },
    { cust_id: 103, name: "Same Name", aliases: [], here: false },
    { cust_id: 104, name: "Same Name", aliases: [], here: false },
  ];
  let r = parseTeams("Red Team\tBlue Team\nRacer Alpha\tracer bravo\nRacer Charlie\t\n", drivers);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.teams, [{ name: "Red Team", custs: [100, 102] }, { name: "Blue Team", custs: [101] }]);
  r = parseTeams("Red Team: Racer Alpha Jr, Same Name (104)\nBlue Team: 101", drivers);
  assert.deepEqual(r.teams, [{ name: "Red Team", custs: [100, 104] }, { name: "Blue Team", custs: [101] }]);
  r = parseTeams("Red Team: Same Name, Nobody Here\nBlue Team: Racer Alpha", drivers);
  assert.deepEqual(r.problems.map(p => [p.team, p.text]), [["Red Team", "Same Name"], ["Red Team", "Nobody Here"]]);
  r = parseTeams("Red Team: Racer Alpha\nBlue Team: Racer Alpha", drivers);
  assert.match(r.problems[0].why, /already on Red Team/);
});

test("the Teams tab: directors set the teams, everyone sees the team standings", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: week(0), order: [0, 1, 2, 3, 4] });     // A 40, B 39, C 38, D 37, E 36
  await s.addRace({ sub: 9002, date: week(1), order: [3, 2, 0] });           // D 40, C 39, A 38
  let p = await s.page("/test-cup/teams");
  assert.match(text(p.html), /No teams for this season yet/);
  const r = await s.post("/test-cup/teams", { teams: "Red Team\tBlue Team\nRacer A\tRacer C\nRacer B\tRacer D\nRacer Z\t" });
  assert.match(text(r.html), /Nothing was saved.*Red Team: "Racer Z": No driver by that name/);
  await s.post("/test-cup/teams", { teams: "Red Team\tBlue Team\nRacer A\tRacer C\nRacer B\tRacer D" });
  s.cookie = "";                                                             // the public sees it
  p = await s.page("/test-cup/teams");
  assert.match(p.html, /href="\/test-cup\/teams"/);
  // Red: (40+39)/2 = 39.5, then 38/1 = 38 -> 77.5. Blue: (38+37)/2 = 37.5, then (40+39)/2 = 39.5 -> 77
  assert.match(text(p.html), /1 Red Team 77\.5 39\.5 2 of 2 38 1 of 2 2 Blue Team 77 37\.5 2 of 2 39\.5 2 of 2/);
  assert.doesNotMatch(p.html, /Save teams/);
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  assert.match(text((await s.page("/history")).html), /Teams for Test Cup Season 1 saved: 2 teams, 4 drivers/);
  assert.match((await s.page("/test-cup/teams")).html, /Red Team: Racer A \(100\), Racer B \(101\)/);   // the box holds the teams to edit
});
