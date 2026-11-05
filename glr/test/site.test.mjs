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

test("league members without a role sign in as drivers, not officials", async () => {
  const s = await seeded(1);
  await s.signIn({ id: "9", roles: [], nick: "Fan" });
  const me = (await s.json("/glr/api/me")).user;
  assert.equal(me.official, false);
  assert.equal((await s.upload(raceExport({ sub: 5, date: week(5) }))).status, 403);
  assert.equal((await s.page("/glr/history")).status, 404);
  assert.ok(!(await s.page("/glr")).html.includes("Upload results"));
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

test("a driver files a protest and a steward decides it", async () => {
  const s = await seeded(2);
  // admin sets the race control role
  await s.signIn();
  await s.post("/glr/settings", { theme: "glr", short: "GLR", steward_role: "333333" });
  // a driver (Racer C, cust 102) signs in, links once and files
  await s.signIn({ id: "50", roles: [], nick: "Driver C" });
  let r = await s.post("/glr/results/1001/stewards", { action: "protest", against: "101", lap: "12", what: "Turned me in turn 3 without a lift." });
  assert.match(text(r.html), /First pick which driver you are/);        // not linked yet: no driver to file as
  r = await s.post("/glr/results/1001/stewards", { action: "link", cust: "102" });
  assert.match(text(r.html), /Linked/);
  r = await s.post("/glr/results/1001/stewards", { action: "protest", against: "101", lap: "12", what: "Turned me in turn 3 without a lift." });
  assert.match(text(r.html), /Protest filed/);
  const pid = Number(text(r.html).match(/number (\d+)/)[1]);
  // the public report shows who protested whom, but not what was written
  s.cookie = "";
  let pub = text((await s.page("/glr/results/1001/stewards")).html);
  assert.match(pub, /Racer C protests #2 Racer B/);
  assert.ok(!pub.includes("without a lift"));
  // a driver can't decide; a steward (race control role) can
  await s.signIn({ id: "50", roles: [], nick: "Driver C" });
  assert.equal((await s.post("/glr/results/1001/stewards", { action: "decide", protest: String(pid), cust: "101", kind: "positions", amount: "3", reason: "x" })).status, 404);
  await s.signIn({ id: "60", roles: ["333333"], nick: "Steward" });
  assert.ok((await s.page("/glr/protests")).html.includes(`stewards#p${pid}`));
  r = await s.post("/glr/results/1001/stewards", { action: "decide", protest: String(pid), cust: "101", kind: "positions", amount: "3", reason: "Avoidable contact" });
  assert.match(text(r.html), /Decision saved: Racer B: Moved back 3 places/);
  const ev = (await s.json("/glr/api/results/1001")).event;
  assert.equal(ev.sessions.race.find(x => x.cust_id === 101).finish_pos, 5);
  assert.equal(ev.decisions[0].made_by, undefined);                  // steward names stay off the public data
  assert.equal((await listStatus(s, pid)), "decided");
  // the standings follow: Racer B scored 5th place points in race 2
  const st = (await s.json("/glr/api/standings/test-cup")).groups[0].regular;
  assert.equal(st.find(x => x.custId === 101).points, 39 + 36);
  // a steward of the race control role can't edit the series
  assert.ok(!(await s.page("/glr/test-cup/rules")).html.includes("Save rules"));
  // take it back: the result goes back and the protest reopens
  const did = s.DB.raw.prepare("select id from decisions").get().id;
  await s.post("/glr/results/1001/stewards", { action: "undo", id: String(did) });
  assert.equal((await s.json("/glr/api/results/1001")).event.sessions.race.find(x => x.cust_id === 101).finish_pos, 2);
  assert.equal((await listStatus(s, pid)), "open");
});

const listStatus = async (s, id) => s.DB.raw.prepare("select status from protests where id = ?").get(id).status;

test("points penalties and disqualifications from the stewards, and decisions survive a re-upload", async () => {
  const s = await seeded(2);
  await s.signIn();                                                    // admin: a steward everywhere
  await s.post("/glr/results/1001/stewards", { action: "decide", cust: "103", kind: "points", amount: "10", reason: "Rough driving" });
  await s.post("/glr/results/1001/stewards", { action: "decide", cust: "100", kind: "dq", reason: "Car failed inspection" });
  let st = (await s.json("/glr/api/standings/test-cup")).groups[0].regular;
  assert.equal(st.find(x => x.custId === 100).points, 40);             // race 1 only
  assert.equal(st.find(x => x.custId === 103).points, 37 + 38 - 10);   // moved up to 3rd in race 2 (38), minus 10
  assert.match(text((await s.page("/glr/test-cup/penalties")).html), /Stewards: Rough driving/);
  // the results file comes in again: the decisions still apply
  await s.upload(raceExport({ sub: 1001, date: week(1) }));
  const race = (await s.json("/glr/api/results/1001")).event.sessions.race;
  assert.equal(race.find(x => x.cust_id === 100).reason_out, "Disqualified");
  assert.equal(race[0].cust_id, 101);
  // the driver page shows the place after the stewards
  assert.match(text((await s.page("/glr/drivers/100")).html), /Disqualified/);
});

test("a driver can't protest a race they weren't in, and can withdraw their own", async () => {
  const s = await seeded(1);
  await s.addRace({ sub: 2000, date: week(3), order: [20, 21, 22] });
  await s.signIn({ id: "70", roles: [], nick: "Driver U" });
  await s.post("/glr/results/2000/stewards", { action: "link", cust: "120" });
  let r = await s.page("/glr/results/1000/stewards");
  assert.match(text(r.html), /wasn't in this race/);
  r = await s.post("/glr/results/2000/stewards", { action: "protest", against: "", lap: "", what: "Big crash on the restart, needs a look." });
  const pid = Number(text(r.html).match(/number (\d+)/)[1]);
  await s.post("/glr/results/2000/stewards", { action: "withdraw", id: String(pid) });
  assert.equal(await listStatus(s, pid), "withdrawn");
});

test("the one-time drop weeks change sets 2 on every season, once", async () => {
  const { setDropWeeksOnce } = await import("../src/db.js");
  const s = await seeded(3);
  await s.addRace({ sub: 2000, date: week(0), league: 5555, leagueName: "GLR Other SERIES", season: 600 });
  s.DB.raw.prepare("INSERT INTO season_rules (season_id, rules) VALUES (600, ?)").run(JSON.stringify({ bonus: { win: 3 } }));
  s.DB.raw.prepare("DELETE FROM site_settings WHERE key = 'once_drops_2'").run();   // as on the live site before the change
  await setDropWeeksOnce(s.DB);
  const rules = id => JSON.parse(s.DB.raw.prepare("SELECT rules FROM season_rules WHERE season_id = ?").get(id).rules);
  assert.equal(rules(500).drops, 2);
  assert.equal(rules(600).drops, 2);
  assert.equal(rules(600).bonus.win, 3);                                   // the rest of a season's rules stay
  const a = (await s.json("/glr/api/standings/test-cup")).groups[0].regular.find(x => x.custId === 100);
  assert.equal(a.points, 40);                                              // 3 races, 2 dropped
  s.DB.raw.prepare("UPDATE season_rules SET rules = ? WHERE season_id = 500").run(JSON.stringify({ drops: 0 }));
  await setDropWeeksOnce(s.DB);                                            // already done: changes nothing
  assert.equal(rules(500).drops, 0);
  await s.signIn();
  assert.match(text((await s.page("/glr/history")).html), /Drop weeks set to 2 for Test Cup Season 1/);
});

test("officials take a driver out of the playoffs on the Rules page, and saving the rules keeps it", async () => {
  const s = await seeded(3);
  await s.signIn();
  let r = await s.post("/glr/test-cup/rules", { action: "out_add", cust: "101", reason: "Withdrew from the playoffs" });
  assert.equal(r.status, 200);   // playoffs are off: the list only shows once they're on, but the choice is kept
  const { GLR_PLAYOFFS } = await import("../src/standings.js");
  const form = [["source", "iracing"], ["drops", "0"], ["byClass", "on"], ["ties", "share"], ...[1000, 1001, 1002].map(x => ["count", String(x)]),
    ["po", "on"], ["winIn", "on"], ["regularRaces", "10"], ["minStarts", "0"], ["field", "4"], ["winBonus", "3"], ["seedBonus", "5, 3, 1"],
    ["r0_name", "Final"], ["r0_races", "1"], ["r0_drivers", "4"], ["r0_reset", "1000"], ["r0_win", "on"], ["r0_final", "on"]];
  r = await s.post("/glr/test-cup/rules", form);
  assert.match(text(r.html), /Saved/);
  const page = text((await s.page("/glr/test-cup/rules")).html);
  assert.match(page, /Not in the playoffs .*Racer B Withdrew from the playoffs/);
  assert.match(text((await s.page("/glr/test-cup/standings")).html), /Out: Withdrew from the playoffs/);
  r = await s.post("/glr/test-cup/rules", { action: "out_remove", cust: "101" });
  assert.match(text(r.html), /Put back/);
  assert.match(text((await s.page("/glr/history")).html), /Taken out of the playoffs: Racer B/);
  assert.ok(GLR_PLAYOFFS.winIn);
});
