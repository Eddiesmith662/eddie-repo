// Race control and the site (phase 5c): signing in from the program, calls for a race, and what they do to results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text } from "./helpers.mjs";
import { applyDecisions } from "../src/stewards.js";

const RC_ROLE = "333333";

// a site with one race, the race control role set, and a steward signed in from race control: returns the token
async function signedIn(s, who = { id: "60", roles: [RC_ROLE], nick: "Steward One" }, pc = "pc1aaa") {
  const asJson = async (path, init) => (await s.go(path, init)).json();
  const start = await asJson("/api/rc/link", { method: "POST", body: JSON.stringify({ pc }) });
  assert.match(start.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await asJson("/api/rc/link/poll", { method: "POST", body: JSON.stringify({ poll: start.poll }) })).state, "waiting");
  await s.signIn(who);
  const page = await s.page(`/rc/link?code=${start.code}`);
  assert.match(text(page.html), new RegExp(start.code));
  await s.post(`/rc/link?code=${start.code}`, { code: start.code });
  const done = await asJson("/api/rc/link/poll", { method: "POST", body: JSON.stringify({ poll: start.poll }) });
  assert.equal(done.state, "ok");
  assert.equal(done.user.name, who.nick);
  assert.equal((await asJson("/api/rc/link/poll", { method: "POST", body: JSON.stringify({ poll: start.poll }) })).state, "expired");   // handed over once
  return done.token;
}
const setup = async () => {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(0) });
  await s.signIn();
  await s.post("/settings", { theme: "glr", short: "GLR", steward_role: RC_ROLE });
  return s;
};
const rc = (s, token, method, path, body) => s.go(path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body && JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));
const call = (n, extra = {}) => ({ uid: `pc1aaa:c${n}`, kind: "warning", amount: 0, reason: "Test call", custId: 101, carNumber: "2", driverName: "Racer B",
  lap: 12, sessionTime: 900.5, incident: null, madeAt: "2026-11-06T02:25:30Z", status: "active", sim: null, ...extra });
const file = (sub, calls, extra = {}) => ({ type: "vspeed_race_control", version: 1, subsessionId: sub, leagueId: 4242, sessionNum: 2, sessionName: "RACE", track: "Test Oval", pc: "pc1aaa", calls, ...extra });

test("race control signs in with a code and Allow, and check says what it may steward", async () => {
  const s = await setup();
  const token = await signedIn(s);
  assert.match(token, /^vsrc_[0-9a-f]{64}$/);
  const c = await rc(s, token, "GET", "/api/rc/check");
  assert.deepEqual([c.status, c.body.user.name, c.body.series], [200, "Steward One", "all"]);
  // the Keys page lists it, and signing it out there ends it
  await s.signIn({ id: "1", roles: ["111111"], nick: "Test Admin" });
  const keys = await s.page("/keys");
  assert.match(text(keys.html), /Steward One pc1aaa/);
  const id = keys.html.match(/name="rc_revoke" value="([0-9a-f]+)"/)[1];
  await s.post("/keys", { rc_revoke: id });
  assert.equal((await rc(s, token, "GET", "/api/rc/check")).status, 401);
});

test("signing out from the program ends the token; a driver can't allow race control", async () => {
  const s = await setup();
  const token = await signedIn(s);
  assert.equal((await rc(s, token, "POST", "/api/rc/signout")).body.ok, true);
  assert.equal((await rc(s, token, "GET", "/api/rc/check")).status, 401);
  const start = await (await s.go("/api/rc/link", { method: "POST" })).json();
  await s.signIn({ id: "70", roles: [], nick: "Just A Driver" });
  assert.match(text((await s.page(`/rc/link?code=${start.code}`)).html), /needs the race control role/);
});

test("calls arrive before the results, become decisions, and change the results once they're in", async () => {
  const s = await setup();
  const token = await signedIn(s);
  const sub = 2000;
  let r = await rc(s, token, "PUT", `/api/rc/races/${sub}`, file(sub, [
    call(1), call(2, { kind: "time", amount: 25, reason: "Pass under caution", custId: 100, carNumber: "1", driverName: "Racer A" }),
    call(3, { kind: "points", amount: 10, reason: "Rough driving", custId: 102 }),
    call(4, { kind: "stopgo", amount: 30, reason: "Jumped the restart", custId: 103, sim: { command: "!black #4 30", state: "served", servedLap: 44 } }),
    call(5, { kind: "noaction", reason: "Racing incident", custId: 104 })]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.decisions.length, 5);
  assert.equal(r.body.decisions[0].madeBy, "Steward One");
  assert.equal(r.body.decisions.find(d => d.uid === "pc1aaa:c5").kind, "noaction");
  // sending the same file again changes nothing
  r = await rc(s, token, "PUT", `/api/rc/races/${sub}`, file(sub, [call(1)]));
  assert.equal(r.body.decisions.length, 5);
  // the results come in: Racer A (won by 1 s) gets +25 s, more than the whole field's gap, so last of the lead lap
  await s.addRace({ sub, date: week(1) });
  const race = (await s.json(`/api/results/${sub}`)).event.sessions.race;
  assert.equal(race.find(x => x.cust_id === 100).finish_pos, 10);    // gaps in the test race: 1 s per place
  assert.equal(race[0].cust_id, 101);
  // the points penalty waited for the race's season, then went on the Penalties tab
  assert.match(text((await s.page("/test-cup/penalties")).html), /Stewards: Rough driving/);
  // the report shows the served stop and go, the lap, and race control
  const rep = text((await s.page(`/results/${sub}/stewards`)).html);
  assert.match(rep, /Stop and go \(30 s\) served lap 44 race control, lap 12/);
  assert.match(rep, /\+25 seconds/);
});

test("withdrawn stays withdrawn, and two stewards' calls both land", async () => {
  const s = await setup();
  const t1 = await signedIn(s);
  const t2 = await signedIn(s, { id: "61", roles: [RC_ROLE], nick: "Steward Two" }, "pc2bbb");
  const sub = 1000;
  await rc(s, t1, "PUT", `/api/rc/races/${sub}`, file(sub, [call(1, { kind: "positions", amount: 2, reason: "Avoidable contact" })]));
  await rc(s, t2, "PUT", `/api/rc/races/${sub}`, file(sub, [call(1, { uid: "pc2bbb:c1", kind: "warning", custId: 105 })], { pc: "pc2bbb" }));
  let calls = (await rc(s, t1, "GET", `/api/rc/races/${sub}`)).body.decisions;
  assert.deepEqual(calls.map(c => [c.uid, c.madeBy]), [["pc1aaa:c1", "Steward One"], ["pc2bbb:c1", "Steward Two"]]);
  assert.equal((await s.json(`/api/results/${sub}`)).event.sessions.race.find(x => x.cust_id === 101).finish_pos, 4);
  // race control withdraws it: the result goes back, the call stays on the report crossed out
  await rc(s, t1, "PUT", `/api/rc/races/${sub}`, file(sub, [call(1, { kind: "positions", amount: 2, reason: "Avoidable contact", status: "withdrawn", withdrawnReason: "Wrong car" })]));
  assert.equal((await s.json(`/api/results/${sub}`)).event.sessions.race.find(x => x.cust_id === 101).finish_pos, 2);
  assert.match(text((await s.page(`/results/${sub}/stewards`)).html), /Withdrawn: Wrong car/);
  // sent again as active: it's back (race control withdrew it, so race control can bring it back)
  await rc(s, t1, "PUT", `/api/rc/races/${sub}`, file(sub, [call(1, { kind: "positions", amount: 2, reason: "Avoidable contact" })]));
  assert.equal((await s.json(`/api/results/${sub}`)).event.sessions.race.find(x => x.cust_id === 101).finish_pos, 4);
  // an official withdraws it on the site: race control sending it again as active doesn't bring it back
  await s.signIn({ id: "1", roles: ["111111"], nick: "Test Admin" });
  const did = s.DB.raw.prepare("SELECT id FROM decisions WHERE rc_uid = 'pc1aaa:c1'").get().id;
  await s.post(`/results/${sub}/stewards`, { action: "undo", id: String(did) });
  await rc(s, t1, "PUT", `/api/rc/races/${sub}`, file(sub, [call(1, { kind: "positions", amount: 2, reason: "Avoidable contact" })]));
  calls = (await rc(s, t1, "GET", `/api/rc/races/${sub}`)).body.decisions;
  assert.equal(calls[0].status, "withdrawn");
  assert.equal(calls[0].withdrawnOnSite, true);
  assert.equal((await s.json(`/api/results/${sub}`)).event.sessions.race.find(x => x.cust_id === 101).finish_pos, 2);
});

test("race control is turned away from series it can't steward and races that aren't GLR", async () => {
  const s = await setup();
  await s.addRace({ sub: 3000, date: week(0), league: 5555, leagueName: "GLR Other SERIES", season: 600 });
  await s.post("/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", role_id: "222222" });
  const token = await signedIn(s, { id: "62", roles: ["222222"], nick: "Cup Steward" });
  assert.deepEqual((await rc(s, token, "GET", "/api/rc/check")).body.series, [4242]);
  assert.equal((await rc(s, token, "PUT", "/api/rc/races/3000", file(3000, [call(1)], { leagueId: 5555 }))).status, 403);
  assert.equal((await rc(s, token, "PUT", "/api/rc/races/4000", file(4000, [call(1)], { leagueId: 7777 }))).status, 404);
  assert.equal((await rc(s, token, "PUT", "/api/rc/races/3000", file(3000, [call(1)]))).status, 400);   // that session is another series'
  // a call from another PC's id is refused
  assert.equal((await rc(s, token, "PUT", "/api/rc/races/1000", file(1000, [call(1, { uid: "otherpc:c1" })]))).status, 400);
});

test("race control's token can send results for a race with no broadcast", async () => {
  const s = await setup();
  const token = await signedIn(s);
  const body = { type: "vspeed_overlay_result", version: 1, subsessionId: 5000, leagueId: 4242, track: "Test Oval", startTime: new Date().toISOString(), laps: 100, official: false,
    results: [0, 1].map(i => ({ custId: 100 + i, name: "Racer " + "AB"[i], carNumber: String(i + 1), car: "Test Car", carClass: "", finish: i + 1, classPos: i + 1, start: i + 1,
      laps: 100, lapsLed: i ? 0 : 100, incidents: 0, bestLapMs: 30000, bestLapNum: 4, intervalMs: i * 1000, lapsDown: 0, reasonOut: "Running" })) };
  const r = await rc(s, token, "POST", "/api/overlay/results", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await s.json("/api/results/5000")).event.status, "provisional");
});

test("a time penalty only re-sorts cars on the same lap", () => {
  const rows = [[100, 100, 0], [101, 100, 5000], [102, 100, 9000], [103, 99, null]].map(([c, laps, gap], i) =>
    ({ cust_id: c, car_class: "", finish_pos: i + 1, class_pos: i + 1, laps, interval_ms: gap, league_points: 40 - i }));
  const out = applyDecisions(rows, [{ cust_id: 100, kind: "time", amount: 60, reason: "x" }]);
  const pos = c => out.find(r => r.cust_id === c).finish_pos;
  assert.deepEqual([pos(101), pos(102), pos(100), pos(103)], [1, 2, 3, 4]);   // behind the lead-lap cars, never behind the lapped car
  assert.equal(out.find(r => r.cust_id === 100).league_points, 38);
});

test("the overlay reads a race's calls with its key, without the stewards' names, and it doesn't count as a race sent", async () => {
  const s = await setup();
  const token = await signedIn(s);
  await rc(s, token, "PUT", "/api/rc/races/1000", file(1000, [call(1, { kind: "stopgo", amount: 30, reason: "Jumped the restart" })]));
  await s.signIn({ id: "1", roles: ["111111"], nick: "Test Admin" });
  const key = (await s.post("/keys", { name: "Producer" })).html.match(/vsglr_[0-9a-f]{48}/)[0];
  const r = await rc(s, key, "GET", "/api/overlay/calls/1000");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.calls.map(c => [c.kind, c.amount, c.reason, c.carNumber]), [["stopgo", 30, "Jumped the restart", "2"]]);
  assert.equal(r.body.calls[0].madeBy, undefined);
  assert.equal(s.DB.raw.prepare("SELECT uses FROM overlay_keys").get().uses, 0);
  assert.equal((await rc(s, "vsglr_" + "0".repeat(48), "GET", "/api/overlay/calls/1000")).status, 401);
});
