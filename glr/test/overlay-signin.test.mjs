// The broadcast overlay signing in with a producer's Discord account (instead of an overlay key): code, Allow, token.
// Made-up producers and drivers throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";

const PRODUCER = "444444", RC = "333333";
const producer = { id: "80", roles: [PRODUCER], nick: "Producer Pat" };
const call = (s, token, method, path, body) => s.go(path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body && JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));
const results = sub => ({ type: "vspeed_overlay_result", version: 1, subsessionId: sub, leagueId: 4242, track: "Test Oval", startTime: new Date().toISOString(),
  laps: 100, official: false, results: [0, 1].map(i => ({ custId: 100 + i, name: "Racer " + "AB"[i], carNumber: String(i + 1), car: "Test Car", carClass: "",
    finish: i + 1, classPos: i + 1, start: i + 1, laps: 100, lapsLed: i ? 0 : 100, incidents: 0, bestLapMs: 30000, bestLapNum: 4, intervalMs: i * 1000, lapsDown: 0, reasonOut: "Running" })) });

async function setup() {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(0) });
  await s.signIn();
  await s.post("/settings", { theme: "glr", short: "GLR", steward_role: RC, producer_role: PRODUCER });
  return s;
}
// the overlay asks for a code, the producer presses Allow, the overlay polls and gets its token
async function signIn(s, who = producer, pc = "ovpc01") {
  const start = await (await s.go("/api/overlay/link", { method: "POST", body: JSON.stringify({ pc }) })).json();
  assert.match(start.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(start.url, /^https:\/\/glrhub\.app\/overlay\/link\?code=/);
  assert.equal(start.expiresIn, 600);
  const poll = () => s.go("/api/overlay/link/poll", { method: "POST", body: JSON.stringify({ poll: start.poll }) }).then(r => r.json());
  assert.equal((await poll()).state, "waiting");
  await s.signIn(who);
  const page = text((await s.page(`/overlay/link?code=${start.code}`)).html);
  if (!/Allow/.test(page)) return { page };
  await s.post(`/overlay/link?code=${start.code}`, { code: start.code });
  const done = await poll();
  assert.equal((await poll()).state, "expired");                          // handed over once
  return { page, token: done.token, user: done.user };
}

test("a producer signs the overlay in: the Allow page says it's the broadcast overlay, the token works on all three endpoints", async () => {
  const s = await setup();
  const { page, token, user } = await signIn(s);
  assert.match(page, /Broadcast overlay sign-in/);
  assert.match(page, /broadcast overlay .*not race control/);
  assert.match(token, /^vsov_[0-9a-f]{64}$/);
  assert.equal(user.name, "Producer Pat");
  const check = await call(s, token, "GET", "/api/overlay/check");
  assert.deepEqual([check.status, check.body.user.name], [200, "Producer Pat"]);
  const sent = await call(s, token, "POST", "/api/overlay/results", results(2000));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await call(s, token, "GET", "/api/overlay/calls/1000")).status, 200);
  // the results record who sent them
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  assert.match(text((await s.page("/history")).html), /Producer Pat Test Cup Overlay Provisional results from the overlay: Test Oval/);
  assert.match(text((await s.page("/history")).html), /Broadcast overlay signed in on PC ovpc01/);
});

test("the token stops working when the Producer role is removed (at the next role check)", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  assert.equal((await call(s, token, "GET", "/api/overlay/check")).status, 200);
  s.who = { ...producer, roles: [] };                                     // removed from the role in Discord
  s.DB.raw.prepare("UPDATE sessions SET checked = 0").run();              // 15 minutes later
  const r = await call(s, token, "GET", "/api/overlay/check");
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Producer role/);
  assert.equal((await call(s, token, "POST", "/api/overlay/results", results(2001))).status, 403);
  assert.equal((await call(s, token, "GET", "/api/overlay/calls/1000")).status, 403);
});

test("signing out from the overlay ends the token", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  assert.equal((await call(s, token, "POST", "/api/overlay/signout")).body.ok, true);
  assert.equal((await call(s, token, "GET", "/api/overlay/check")).status, 401);
});

test("the Keys page lists signed-in overlays, and turning one off there ends it", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  const keys = await s.page("/keys");
  assert.match(text(keys.html), /Overlay sign-ins .*Producer Pat ovpc01/);
  const id = keys.html.match(/name="rc_revoke" value="([0-9a-f]+)"/)[1];
  await s.post("/keys", { rc_revoke: id });
  assert.equal((await call(s, token, "GET", "/api/overlay/check")).status, 401);
  assert.match(text((await s.page("/history")).html), /Overlay signed out: Producer Pat/);
});

test("only producers (and admins) can allow an overlay; an admin counts as a producer", async () => {
  const s = await setup();
  const steward = await signIn(s, { id: "81", roles: [RC], nick: "Steward Sam" });
  assert.equal(steward.token, undefined);
  assert.match(steward.page, /needs the Producer role/);
  const admin = await signIn(s, { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  assert.match(admin.token, /^vsov_/);
});

test("an overlay token isn't race control's, and a code for one program can't be allowed on the other's page", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  assert.equal((await call(s, token, "GET", "/api/rc/check")).status, 401);
  const rcStart = await (await s.go("/api/rc/link", { method: "POST", body: "{}" })).json();
  await s.signIn(producer);
  assert.match(text((await s.page(`/overlay/link?code=${rcStart.code}`)).html), /expired or was already used/);
});

test("overlay keys keep working as before", async () => {
  const s = await setup();
  const key = (await s.post("/keys", { name: "Old Overlay" })).html.match(/vsglr_[0-9a-f]{48}/)[0];
  assert.deepEqual((await call(s, key, "GET", "/api/overlay/check")).body, { ok: true, name: "Old Overlay" });
  assert.equal((await call(s, key, "POST", "/api/overlay/results", results(2002))).status, 200);
  assert.equal((await call(s, key, "GET", "/api/overlay/calls/1000")).status, 200);
});

// Overlay permissions and the admin's Block switch (Nov 2026). The overlay reads "perms" once at start-up.
const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const block = async (s, id, on = true) => { await s.signIn(ADMIN); return s.post("/accounts", { action: on ? "block" : "unblock", id }); };

test("check gives a signed-in overlay its permissions; an overlay key gets none", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  assert.deepEqual((await call(s, token, "GET", "/api/overlay/check")).body.perms, ["overlay", "upload"]);
  const admin = await signIn(s, ADMIN, "ovpc02");
  assert.deepEqual((await call(s, admin.token, "GET", "/api/overlay/check")).body.perms, ["overlay", "upload"]);
});

test("check reads Discord roles fresh at start-up: a removed role counts straight away, not 15 minutes later", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  s.who = { ...producer, roles: [] };
  assert.equal((await call(s, token, "GET", "/api/overlay/check")).status, 403);
  s.who = producer;
  assert.equal((await call(s, token, "GET", "/api/overlay/check")).status, 200);
});

test("a blocked producer gets 403 with text the overlay shows as it is, can't allow a new PC, and unblocking restores them", async () => {
  const s = await setup();
  const { token } = await signIn(s);
  const r = await block(s, "80");
  assert.match(text(r.html), /Producer Pat is blocked from the overlay/);
  const accounts = text((await s.page("/accounts")).html);
  assert.match(accounts, /Blocked \S+ .*by Test Admin.*Unblock/);
  assert.match(text((await s.page("/history")).html), /Admin blocked Producer Pat from the broadcast overlay/);
  for (const [m, p, b] of [["GET", "/api/overlay/check"], ["POST", "/api/overlay/results", results(2003)], ["GET", "/api/overlay/calls/1000"]]) {
    const res = await call(s, token, m, p, b);
    assert.equal(res.status, 403, p);
    assert.equal(res.body.error, "Your overlay access was turned off by a GLR HUB admin. Ask an admin to turn it back on.");
    assert.equal(res.body.blocked, true);
  }
  const again = await signIn(s, producer, "ovpc03");                     // the block wins over the Producer role
  assert.equal(again.token, undefined);
  assert.match(again.page, /turned off by a GLR HUB admin/);
  await block(s, "80", false);
  assert.equal((await call(s, token, "GET", "/api/overlay/check")).status, 200);
  assert.match(text((await s.page("/history")).html), /Admin unblocked Producer Pat/);
});

test("an admin can't block themselves, and a block doesn't touch race control or overlay keys", async () => {
  const s = await setup();
  await signIn(s);
  assert.match(text((await block(s, "1")).html), /can.{1,6}t block yourself/);
  const key = (await s.post("/keys", { name: "Old Overlay" })).html.match(/vsglr_[0-9a-f]{48}/)[0];
  await block(s, "80");
  assert.equal((await call(s, key, "GET", "/api/overlay/check")).status, 200);
});
