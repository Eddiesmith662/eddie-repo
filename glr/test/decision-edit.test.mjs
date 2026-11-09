// Changing a decision after further review (Nov 2026): race control, the series' directors and admins.
// Made-up drivers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text } from "./helpers.mjs";

const RC_ROLE = "333333";
const STEWARD = { id: "60", roles: [RC_ROLE], nick: "Steward One" };
async function rcToken(s, pc = "pc1aaa") {
  const asJson = async (path, init) => (await s.go(path, init)).json();
  const start = await asJson("/api/rc/link", { method: "POST", body: JSON.stringify({ pc }) });
  await s.signIn(STEWARD);
  await s.post(`/rc/link?code=${start.code}`, { code: start.code });
  return (await asJson("/api/rc/link/poll", { method: "POST", body: JSON.stringify({ poll: start.poll }) })).token;
}
const put = (s, token, sub, calls) => s.go(`/api/rc/races/${sub}`, { method: "PUT", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ type: "vspeed_race_control", version: 1, subsessionId: sub, leagueId: 4242, sessionNum: 2, sessionName: "RACE", track: "Test Oval", pc: "pc1aaa", calls }) });
const call = (n, extra = {}) => ({ uid: `pc1aaa:c${n}`, kind: "warning", amount: 0, reason: "Test call", custId: 101, carNumber: "2", driverName: "Racer B",
  lap: 12, sessionTime: 900.5, incident: null, madeAt: "2026-11-06T02:25:30Z", status: "active", sim: null, ...extra });
async function setup() {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(0) });
  await s.signIn();
  await s.post("/settings", { theme: "glr", short: "GLR", steward_role: RC_ROLE });
  return s;
}
const dec = (s, uid) => s.DB.raw.prepare("SELECT * FROM decisions WHERE rc_uid = ?").get(uid);
const order = async s => (await s.json("/api/results/1000")).event.sessions.race.map(r => r.cust_id);

test("a race control call changed on the site: results follow, the report shows what it was, race control can't change it back", async () => {
  const s = await setup();
  const token = await rcToken(s);
  assert.equal((await put(s, token, 1000, [call(1, { kind: "time", amount: 60, reason: "Pass under caution", custId: 100, carNumber: "1", driverName: "Racer A" })])).status, 200);
  assert.notEqual((await order(s))[0], 100);                             // +60 s: Racer A drops from the win
  await s.signIn(STEWARD);                                               // race control on the site, after the race
  const id = dec(s, "pc1aaa:c1").id;
  assert.match((await s.page("/results/1000/stewards")).html, />Edit<\/button>/);
  const r = await s.post("/results/1000/stewards", { action: "edit", id: String(id), kind: "warning", amount: "", reason: "Reviewed: he gave the place back" });
  assert.match(text(r.html), /Decision saved: Racer A: now Warning/);
  assert.equal((await order(s))[0], 100);                                // back to the win
  assert.match(text(r.html), /Changed \S+ \d+, \d+ by Steward One, was \+60 seconds: Pass under caution/);
  // race control sends the race again (still with the old call): the change stays
  await put(s, token, 1000, [call(1, { kind: "time", amount: 60, reason: "Pass under caution", custId: 100, carNumber: "1", driverName: "Racer A" })]);
  assert.equal(dec(s, "pc1aaa:c1").kind, "warning");
  assert.equal((await order(s))[0], 100);
  await s.signIn({ id: "1", roles: ["111111"], nick: "Test Admin" });
  assert.match(text((await s.page("/history")).html), /Stewards changed a decision: Racer A: \+60 seconds \(Pass under caution\) → Warning \(Reviewed: he gave the place back\), a race control call/);
});

test("a points penalty changed: the standings follow; a second change keeps the race-night version as 'was'", async () => {
  const s = await setup();
  await s.post("/results/1000/stewards", { action: "decide", cust: "102", kind: "points", amount: "10", reason: "Rough driving" });
  const pts = async () => (await s.json("/api/standings/test-cup")).groups[0].regular.find(x => x.custId === 102).points;
  const before = await pts();
  const id = s.DB.raw.prepare("SELECT id FROM decisions").get().id;
  await s.post("/results/1000/stewards", { action: "edit", id: String(id), kind: "points", amount: "5", reason: "Reduced on appeal" });
  assert.equal(await pts(), before + 5);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM adjustments").get().n, 1);
  await s.post("/results/1000/stewards", { action: "edit", id: String(id), kind: "none", amount: "", reason: "Overturned" });
  assert.equal(await pts(), before + 10);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM adjustments").get().n, 0);
  assert.match(text((await s.page("/results/1000/stewards")).html), /Overturned Changed .* was -10 points: Rough driving/);
});

test("nobody edits a decision about their own car, and drivers can't edit at all", async () => {
  const s = await setup();
  await s.post("/results/1000/stewards", { action: "decide", cust: "101", kind: "warning", reason: "Blocking" });
  const id = String(s.DB.raw.prepare("SELECT id FROM decisions").get().id);
  // a steward who is Racer B (101)
  await s.signIn({ id: "61", roles: [RC_ROLE], nick: "Racer B" });
  await s.post("/me/driver", { cust: "101" });
  assert.doesNotMatch((await s.page("/results/1000/stewards")).html, />Edit<\/button>/);
  assert.match(text((await s.post("/results/1000/stewards", { action: "edit", id, kind: "none", reason: "x" })).html), /your own car/);
  await s.signIn({ id: "70", roles: [], nick: "Just A Driver" });
  assert.equal((await s.post("/results/1000/stewards", { action: "edit", id, kind: "none", reason: "x" })).status, 404);
  assert.equal(s.DB.raw.prepare("SELECT kind FROM decisions").get().kind, "warning");
});
