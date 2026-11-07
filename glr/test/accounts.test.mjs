// Discord accounts and drivers: asked once after signing in, disputes go to an admin, the Accounts page, My races.
// Every person here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";
import { normName, fileProtest, addDecision, mergeDrivers } from "../src/db.js";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const member = (id, nick) => ({ id, roles: [], nick });

async function site() {
  const s = makeSite();
  await s.signIn(ADMIN);
  await s.addRace({ sub: 9001, date: week(0) });      // Racer A ... Racer J, cust 100 ... 109
  return s;
}
// sign in and return where the site sends them
async function signInTo(s, who, back = "") {
  s.who = who; s.cookie = "";
  const r = await s.go("/login" + (back ? "?back=" + encodeURIComponent(back) : ""));
  const state = new URL(r.headers.get("location")).searchParams.get("state");
  return (await s.go("/auth/callback?code=x&state=" + state)).headers.get("location");
}

test("names for matching drop car numbers and tags from Discord nicknames", () => {
  assert.equal(normName("Racer C #3"), "racer c");
  assert.equal(normName("[GLR] Racer_C 12"), "racer c");
  assert.equal(normName("Rácer Ç (crew chief)"), "racer c");
});

test("asked which driver once, after the first sign-in, with a guess from the nickname", async () => {
  const s = await site();
  const to = await signInTo(s, member("20", "Racer C #3"), "/test-cup");
  assert.equal(to, "/me/driver?first=1&back=%2Ftest-cup");
  const p = await s.page(to);
  assert.match(text(p.html), /Which driver are you\? .*One quick question, only this once/);
  assert.match(p.html, /value="racer c"/);                      // pre-filled with the nickname guess
  assert.match(p.html, /name="cust" value="102"/);              // Racer C is offered
  assert.doesNotMatch(p.html, /name="cust" value="101"/);       // ...and not every "Racer"
  const r = await s.post("/me/driver", { cust: "102", back: "/test-cup" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "https://glrhub.app/test-cup");
  assert.match((await s.page("/")).html, /href="\/me">My races</);
  assert.equal(await signInTo(s, member("20", "Racer C #3"), "/test-cup"), "/test-cup");   // not asked again
});

test("I don't race: never asked again, and no My races", async () => {
  const s = await site();
  await signInTo(s, member("21", "Crew Person"));
  assert.equal((await s.post("/me/driver", { cust: "0", back: "/" })).status, 303);
  assert.equal(await signInTo(s, member("21", "Crew Person")), "/");
  assert.doesNotMatch((await s.page("/")).html, /My races/);
  assert.match((await s.go("/me")).headers.get("location"), /\/me\/driver/);
});

test("not asked on the way to allowing race control or the overlay", async () => {
  const s = await site();
  assert.equal(await signInTo(s, member("22", "Racer D"), "/overlay/link?code=ABCD-EFGH"), "/overlay/link?code=ABCD-EFGH");
});

test("a driver someone else has goes to an admin, who decides", async () => {
  const s = await site();
  await signInTo(s, member("30", "Racer E"));
  await s.post("/me/driver", { cust: "104", back: "/" });
  await signInTo(s, member("31", "Racer E Real"));
  const r = await s.post("/me/driver", { cust: "104", back: "/" });
  assert.equal(r.status, 200);
  assert.match(text(r.html), /Waiting for an admin: you said you're Racer E/);
  assert.doesNotMatch((await s.page("/")).html, /My races/);    // nothing changes until an admin decides

  assert.equal((await s.page("/accounts")).status, 404);         // admins only
  await s.signIn(ADMIN);
  const acc = await s.page("/accounts");
  assert.match(text(acc.html), /Disputes .*Racer E Real Racer E Racer E/);
  const id = acc.html.match(/name="claim" value="(\d+)"/)[1];
  assert.match(text((await s.post("/accounts", { claim: id, action: "approve" })).html), /Approved: Racer E Real is now Racer E/);
  assert.match(text((await s.page("/accounts")).html), /Disputes None/);
  assert.match(text((await s.page("/history")).html), /Admin gave driver Racer E to Racer E Real \(was linked to Racer E\)/);
  assert.match(await signInTo(s, member("30", "Racer E")), /^\/me\/driver/);    // the one moved off is asked again
  assert.doesNotMatch(await signInTo(s, member("31", "Racer E Real")), /me\/driver/);
});

test("admins set and remove links on the Accounts page; officials see the link on driver pages, nobody else", async () => {
  const s = await site();
  await signInTo(s, member("40", "Somebody"));
  await s.post("/me/driver", { cust: "0", back: "/" });
  await s.signIn(ADMIN);
  assert.match(text((await s.post("/accounts", { action: "set", id: "40", driver: "Racer F (105)" })).html), /Set: Somebody is Racer F/);
  assert.match(text((await s.page("/drivers/105")).html), /Discord: Somebody/);
  assert.match(text((await s.post("/accounts", { action: "set", id: "40", driver: "Nobody Like This" })).html), /Couldn.{1,6}t tell which driver/);
  assert.match(text((await s.post("/accounts", { action: "unlink", id: "40" })).html), /Unlinked Somebody/);
  assert.match(text((await s.page("/drivers/105")).html), /Discord: not linked/);
  await signInTo(s, member("41", "Racer G"));
  assert.doesNotMatch((await s.page("/drivers/105")).html, /Discord:/);
  s.cookie = "";
  assert.doesNotMatch((await s.page("/drivers/105")).html, /Discord:/);
});

test("My races: their races, protests by or against them, and decisions about them", async () => {
  const s = await site();
  await fileProtest(s.DB, { sub: 9001, filedBy: "discord:9:x", filer: 101, against: 103, lap: "lap 4", what: "Pushed me wide", video: "" });
  await addDecision(s.DB, { sub: 9001, protestId: null, cust: 103, kind: "time", amount: 5, reason: "Avoidable contact" }, "discord:1:Test Admin");
  await signInTo(s, member("50", "Racer D"));
  await s.post("/me/driver", { cust: "103", back: "/" });
  const t = text((await s.page("/me")).html);
  assert.match(t, /My races Racer D/);
  assert.match(t, /Test Oval/);
  assert.match(t, /#2 Racer B protests #4 Racer D/);
  assert.match(t, /Avoidable contact/);
});

test("a link follows a driver merged into another record", async () => {
  const s = await site();
  await s.addRace({ sub: 9002, date: week(1), order: [20, 21] });      // Racer U (120), a second record
  await signInTo(s, member("60", "Racer U"));
  await s.post("/me/driver", { cust: "120", back: "/" });
  await mergeDrivers(s.DB, 100, 120, "test");
  assert.match((await s.page("/")).html, /My races/);
  assert.match(text((await s.page("/me")).html), /iRacing ID 100/);
});
