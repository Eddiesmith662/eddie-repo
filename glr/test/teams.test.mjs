// Team points (the Warrior points system): per race, a team's drivers' finishing points added up and divided by how
// many of them raced; the season is every race added up. Teams, drivers and series here are all made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, raceExport, ADMIN_ROLE } from "./helpers.mjs";
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

test("team CSV files: one row per driver (Team, Driver, iRacing ID) or the team grid", () => {
  const drivers = [
    { cust_id: 100, name: "Racer Alpha", aliases: ["Racer Alpha Jr"], here: true },
    { cust_id: 101, name: "Racer Bravo4", aliases: [], here: true },
    { cust_id: 102, name: "Racer Q Charlie", aliases: [], here: true },
    { cust_id: 103, name: "Same Name", aliases: [], here: false },
    { cust_id: 104, name: "Same Name", aliases: [], here: false },
  ];
  // one row per driver; a blank team = the row above; quotes and a byte-order mark from Excel
  let r = parseTeams('\uFEFFTeam,Driver,iRacing ID\r\n"Red Team, East",Racer Alpha Jr,\r\n,Same Name,104\r\nBlue Team,Racer Bravo,101\r\n', drivers);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.teams, [{ name: "Red Team, East", custs: [100, 104] }, { name: "Blue Team", custs: [101] }]);
  // the grid, saved as CSV (Excel in some countries uses semicolons)
  r = parseTeams("Red Team;Blue Team\nRacer Alpha;racer bravo4\nRacer Charlie;\n", drivers);
  assert.deepEqual(r.teams, [{ name: "Red Team", custs: [100, 102] }, { name: "Blue Team", custs: [101] }]);
  r = parseTeams("Team,Driver\nRed Team,Same Name\nRed Team,Nobody Here\nBlue Team,Racer Alpha", drivers);
  assert.deepEqual(r.problems.map(p => [p.team, p.text]), [["Red Team", "Same Name"], ["Red Team", "Nobody Here"]]);
  r = parseTeams("Team,Driver\nRed Team,Racer Alpha\nBlue Team,Racer Alpha", drivers);
  assert.match(r.problems[0].why, /already on Red Team/);
});

test("only a series with team points turned on has a Teams tab", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: week(0) });
  assert.doesNotMatch((await s.page("/test-cup/standings")).html, /\/test-cup\/teams/);   // not even for an admin
  assert.equal((await s.page("/test-cup/teams")).status, 404);
  await s.post("/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", teams_form: "1", teams: "on" });
  assert.match((await s.page("/test-cup/standings")).html, /href="\/test-cup\/teams"/);
  assert.match(text((await s.page("/history")).html), /Team points turned on/);
  await s.post("/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", teams_form: "1" });
  assert.equal((await s.page("/test-cup/teams")).status, 404);
});

test("the Teams tab: directors set the teams, everyone sees the team standings", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: week(0), order: [0, 1, 2, 3, 4] });     // A 40, B 39, C 38, D 37, E 36
  await s.addRace({ sub: 9002, date: week(1), order: [3, 2, 0] });           // D 40, C 39, A 38
  await s.post("/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", teams_form: "1", teams: "on" });
  let p = await s.page("/test-cup/teams");
  assert.match(text(p.html), /No teams for this season yet/);
  const csv = t => [["file", new File([t], "teams.csv", { type: "text/csv" })]];
  const r = await s.post("/test-cup/teams", csv("Team,Driver,iRacing ID\nRed Team,Racer A,\nRed Team,Racer B,\nBlue Team,Racer C,\nBlue Team,Racer D,\nRed Team,Racer Z,"));
  assert.match(text(r.html), /Nothing was saved.*Red Team: "Racer Z": No driver by that name/);
  assert.match(text((await s.post("/test-cup/teams", csv("Team,Driver,iRacing ID\nRed Team,Racer A,\n,Racer B,\nBlue Team,Racer C,\n,Racer D,103"))).html), /Saved: 2 teams, 4 drivers/);
  s.cookie = "";                                                             // the public sees it
  p = await s.page("/test-cup/teams");
  assert.match(p.html, /href="\/test-cup\/teams"/);
  // Red: (40+39)/2 = 39.5, then 38/1 = 38 -> 77.5. Blue: (38+37)/2 = 37.5, then (40+39)/2 = 39.5 -> 77
  assert.match(text(p.html), /1 Red Team 77\.5 39\.5 2 of 2 38 1 of 2 2 Blue Team 77 37\.5 2 of 2 39\.5 2 of 2/);
  assert.doesNotMatch(p.html, /Save teams/);
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  assert.match(text((await s.page("/history")).html), /Teams for Test Cup Season 1 saved: 2 teams, 4 drivers/);
  // the teams back as CSV, to edit and upload again
  const dl = await s.go("/test-cup/teams?csv=1");
  assert.match(dl.headers.get("content-disposition"), /test-cup-teams\.csv/);
  assert.equal(await dl.text(), "Team,Driver,iRacing ID\r\nRed Team,Racer A,100\r\nRed Team,Racer B,101\r\nBlue Team,Racer C,102\r\nBlue Team,Racer D,103\r\n");
  assert.match(text((await s.post("/test-cup/teams", { action: "clear" })).html), /Saved: this season has no teams now/);
});

test("points by the size of the field (the Warrior way): 1st = cars that did a lap, 0 laps scores nothing and doesn't count for the team", async () => {
  const { computeStandings } = await import("../src/standings.js");
  // five cars, the last one never completed a lap: the four that did score 4, 3, 2, 1 (as on the Warrior points sheet)
  const row = (cust, pos, laps) => ({ cust_id: cust, name: "Racer " + cust, finish_pos: pos, laps, car_class: "", start_pos: pos, laps_led: 0 });
  const ev = { subsession_id: 1, start_time: "2026-09-01", track: "Test Oval", results: [row(100, 1, 50), row(101, 2, 50), row(102, 3, 49), row(103, 4, 20), row(104, 5, 0)] };
  const st = computeStandings({ points: { source: "field" } }, [ev]);
  assert.deepEqual(Object.fromEntries(Object.entries(st.groups[0].races[0].points).map(([id, x]) => [id, x.base])), { 100: 4, 101: 3, 102: 2, 103: 1, 104: 0 });
  const ts = teamStandings([{ id: 1, name: "Red Team", members: [{ cust_id: 103, name: "D" }, { cust_id: 104, name: "E" }] }], st);
  assert.deepEqual(ts.teams[0].races[0], { sum: 1, raced: 1, of: 2, score: 1 });   // 1 point / 1 driver: the 0-lap car isn't counted
});

test("team standings: a website widget and a Discord post after each official race, only with team points on", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: week(0), order: [0, 1, 2, 3] });
  assert.equal((await s.go("/test-cup/widget/teams")).status, 404);
  assert.doesNotMatch((await s.page("/test-cup/embed")).html, /Team standings/);
  assert.doesNotMatch((await s.page("/test-cup/edit")).html, /Team standings \(after each official race\)/);

  await s.post("/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", teams_form: "1", teams: "on" });
  await s.post("/test-cup/teams", [["file", new File(["Team,Driver\nRed Team,Racer A\nRed Team,Racer B\nBlue Team,Racer C\nBlue Team,Racer D"], "t.csv")]]);
  assert.match((await s.page("/test-cup/embed")).html, /<option value="teams">Team standings<\/option>/);
  const w = await s.page("/test-cup/widget/teams");
  assert.match(text(w.html), /Test Cup team standings .*1 Red Team 39\.5 2 Blue Team 37\.5 -2/);

  assert.match((await s.page("/test-cup/edit")).html, /Team standings \(after each official race\)/);
  await s.post("/test-cup/edit", { action: "hook", kind: "teams", url: "https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz" });
  s.sent.length = 0;
  const up = await s.upload(raceExport({ sub: 9002, date: new Date(Date.now() - 3 * 3600e3).toISOString(), order: [3, 2, 1, 0] }));
  assert.equal(up.status, 200);
  const posts = s.sent.filter(x => x.url.includes("/webhooks/123456/")).map(x => JSON.parse(x.body));
  const team = posts.find(p => /Team standings/.test(p.embeds[0].title));
  assert.ok(team, "a team standings post went to the teams webhook");
  assert.match(team.embeds[0].title, /Test Cup · Team standings · 2 races/);
  // race 1: Red (40+39)/2 = 39.5, Blue (38+37)/2 = 37.5; race 2 reversed: Red 37.5, Blue 39.5 -> both 77, sharing 1st
  assert.equal(team.embeds[0].description, "1. Blue Team: **77**\n1. Red Team: **77**");
});

test("embed codes and widget links use glrhub.app, not the old address", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: week(0) });
  const e = (await s.page("/test-cup/embed")).html;
  assert.match(e, /const O="https:\/\/glrhub\.app"/);
  for (const w of ["standings", "schedule", "results"]) {
    const h = (await s.page(`/test-cup/widget/${w}`)).html;
    assert.doesNotMatch(h, /vspeedlivetiming/, w);
    assert.match(h, /href="https:\/\/glrhub\.app\//, w);
  }
  assert.doesNotMatch(e, /vspeedlivetiming/);
});

test("Send latest posts the real results, standings or team standings for the latest official race", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 9001, date: week(0), order: [0, 1, 2, 3] });             // an old race: never posted on its own
  const hook = "https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz";
  for (const kind of ["results", "standings", "penalties"]) await s.post("/test-cup/edit", { action: "hook", kind, url: hook });
  const edit = (await s.page("/test-cup/edit")).html;
  assert.equal((edit.match(/>Send latest</g) || []).length, 2);                   // results and standings; not penalties
  for (const [kind, title] of [["results", /Test Oval/], ["standings", /Standings · 1 race/]]) {
    s.sent.length = 0;
    const r = await s.post("/test-cup/edit", { action: "hook", kind, url: "", latest: "1" });
    assert.match(text(r.html), /Sent: .* for Test Oval/);
    assert.match(JSON.parse(s.sent.find(x => x.url.startsWith(hook)).body).embeds[0].title, title);
  }
  assert.match(text((await s.page("/history")).html), /Standings for Test Oval posted to Discord by hand/);
});
