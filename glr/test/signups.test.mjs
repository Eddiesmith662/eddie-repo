// Season signups and car numbers (Nov 2026): two windows, director approval, one page for several series.
// Made-up drivers: Racer A is iRacing ID 100 and ran #1, Racer B is 101 and ran #2, and so on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";
import { holds, currentRound, roundState } from "../src/signups.js";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const who = (n, nick) => ({ id: String(500 + n), roles: [], nick });
const dayStr = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const P = "/test-cup/signups";

// two series with last season's races; drivers B, C and K linked to accounts
async function setup({ keep = -1, open = 3 } = {}) {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(0) });
  await s.addRace({ sub: 1001, date: week(1) });
  await s.addRace({ sub: 2000, date: week(0), league: 5151, leagueName: "GLR Other Cup SERIES", season: 600, seasonName: "Other Cup Season 1" });
  await s.signIn(ADMIN);
  await s.post("/other-cup/edit", { action: "name", short_name: "Other Cup", slug: "other-cup" });
  s.open = async (slug = "test-cup", k = keep, o = open) => { await s.signIn(ADMIN);
    return s.post(`/${slug}/signups`, { action: "round", name: "2027 Season 1", keep_date: dayStr(k), keep_time: "00:01", open_date: dayStr(o), open_time: "00:01" }); };
  s.as = async (n, nick, cust) => { await s.signIn(who(n, nick)); if (cust) await s.post("/me/driver", { cust: String(cust) }); };
  s.rid = slug => s.DB.raw.prepare("SELECT r.id FROM signup_rounds r JOIN series sr ON sr.id = r.series_id WHERE sr.slug = ? ORDER BY r.id DESC").get(slug).id;
  s.rows = () => s.DB.raw.prepare("SELECT name, number, status FROM signups ORDER BY id").all().map(x => `${x.name} #${x.number} ${x.status}`);
  return s;
}
const slugOf = async s => (await s.json("/api/series")).series.map(x => x.slug);

test("keep-your-number week: last season's drivers keep theirs with one click; nobody else can take it or sign up yet", async () => {
  const s = await setup();
  assert.deepEqual(await slugOf(s), ["other-cup", "test-cup"]);
  const r = await s.open();
  assert.match(text(r.html), /Opened signups for 2027 Season 1/);
  assert.match((await s.page("/")).html, /href="\/signup">Sign up</);                 // the header link appears
  await s.as(1, "Racer B", 101);
  const page = (await s.page("/signup")).html;
  assert.match(text(page), /Keep-your-number week/);
  assert.match(text(page), /Keep #2 ?, my number last season/);
  const rid = s.rid("test-cup");
  assert.match(text((await s.post("/signup", { action: "signup", [`s_${rid}`]: "1", [`n_${rid}`]: "99" })).html), /Test Cup: #2 is yours, waiting for the director/);
  // someone who didn't race last season waits for the open window, even with a number typed in
  await s.signIn(who(2, "Newcomer Ned"));
  const nd = await s.post("/signup", { action: "newdriver", cust: "777001", name: "Newcomer Ned" });
  assert.match(text(nd.html), /Welcome, Newcomer Ned/);
  assert.match(text(nd.html), /You didn.{1,6}t race in Test Cup last season/);
  assert.match(text((await s.post("/signup", { action: "signup", [`s_${rid}`]: "1", [`n_${rid}`]: "3" })).html), /Test Cup: pick a number/);
  assert.deepEqual(s.rows(), ["Racer B #2 pending"]);
  // the director can't hand a held number to someone else during the week
  await s.signIn(ADMIN);
  assert.match(text((await s.post(P, { action: "add", cust: "777001", number: "3" })).html), /#3 is held for Racer C until signups open to everyone/);
  assert.match(text((await s.page(P)).html), /Held for last season.{1,6}s drivers until .*#1 Racer A, #3 Racer C/);
});

test("a number two drivers shared last season is held for whoever ran it more", async () => {
  const s = await setup();
  s.DB.raw.prepare("UPDATE results SET car_number = '2' WHERE cust_id = 102 AND subsession_id = 1001").run();   // Racer C ran #2 in the latest race only
  s.DB.raw.prepare("UPDATE results SET car_number = '2' WHERE cust_id = 101").run();
  await s.open();
  const h = await holds(s.DB, await currentRound(s.DB, 4242));
  assert.equal(h.byNumber.get("2").name, "Racer B");
  assert.deepEqual(h.byCust.get(102), { number: "2", mine: false, holder: "Racer B" });
  await s.as(3, "Racer C", 102);
  assert.match(text((await s.page("/signup")).html), /you and Racer B both ran #2, and it.{1,6}s held for Racer B/);
});

test("open window: first come, first served; one page for several series; the same number where it's free", async () => {
  const s = await setup({ keep: -5, open: -1 });
  await s.open("test-cup"); await s.open("other-cup");
  const a = s.rid("test-cup"), b = s.rid("other-cup");
  await s.as(1, "Racer B", 101);
  let r = await s.post("/signup", { action: "signup", same: "24", [`s_${a}`]: "1", [`s_${b}`]: "1" });
  assert.match(text(r.html), /Other Cup: #24 is yours, waiting.*Test Cup: #24 is yours, waiting/);
  // the next driver wants 24 everywhere too: taken in both; then 7 in one and 07 in the other (different numbers)
  await s.as(3, "Racer C", 102);
  r = await s.post("/signup", { action: "signup", same: "24", [`s_${a}`]: "1", [`s_${b}`]: "1" });
  assert.match(text(r.html), /Other Cup: #24 is taken by Racer B\..*Test Cup: #24 is taken by Racer B\./);
  assert.match(r.html, new RegExp(`name="s_${a}" value="1" checked`));                  // still ticked, to try another
  assert.match(text(r.html), /Taken \(1\): #24/);
  r = await s.post("/signup", { action: "signup", [`s_${a}`]: "1", [`n_${a}`]: "7", [`s_${b}`]: "1", [`n_${b}`]: "#07" });
  assert.match(text(r.html), /Other Cup: #07 is yours.*Test Cup: #7 is yours/);
  // bad numbers, and changing a waiting signup
  assert.match(text((await s.post("/signup", { action: "signup", [`s_${a}`]: "1", [`n_${a}`]: "1234" })).html), /1 to 3 digits/);
  assert.match(text((await s.post("/signup", { action: "signup", [`s_${a}`]: "1", [`n_${a}`]: "07" })).html), /Test Cup: #07 is your number now/);
  assert.deepEqual(s.rows(), ["Racer B #24 pending", "Racer B #24 pending", "Racer C #07 pending", "Racer C #07 pending"]);
  // withdrawing a waiting signup frees the number
  assert.match(text((await s.post("/signup", { action: "withdraw", withdraw: String(b) })).html), /Other Cup: your signup for #07 is withdrawn/);
  assert.equal(s.DB.raw.prepare("SELECT status FROM signups WHERE round_id = ? AND cust_id = 102").get(b).status, "withdrawn");
  // signed out: can read the page, can't sign up
  s.cookie = "";
  assert.match(text((await s.page("/signup")).html), /Sign in with Discord to sign up/);
  assert.equal((await s.post("/signup", { action: "signup", [`s_${a}`]: "1", [`n_${a}`]: "5" })).status, 302);
});

test("two drivers going for the same number at the same moment: the database lets only one have it", async () => {
  const s = await setup({ keep: -5, open: -1 });
  await s.open();
  const rid = s.rid("test-cup"), at = new Date().toISOString();
  s.DB.raw.prepare("INSERT INTO signups (round_id, series_id, cust_id, name, number, status, created_at) VALUES (?, 4242, 101, 'Racer B', '24', 'pending', ?)").run(rid, at);
  assert.throws(() => s.DB.raw.prepare("INSERT INTO signups (round_id, series_id, cust_id, name, number, status, created_at) VALUES (?, 4242, 102, 'Racer C', '24', 'pending', ?)").run(rid, at), /UNIQUE/);
  assert.throws(() => s.DB.raw.prepare("INSERT INTO signups (round_id, series_id, cust_id, name, number, status, created_at) VALUES (?, 4242, 101, 'Racer B', '25', 'pending', ?)").run(rid, at), /UNIQUE/);
});

test("the director approves, declines with a reason, changes and releases; a number is only freed by them", async () => {
  const s = await setup({ keep: -5, open: -1 });
  await s.open();
  const rid = s.rid("test-cup");
  await s.as(1, "Racer B", 101); await s.post("/signup", { action: "signup", [`s_${rid}`]: "1", [`n_${rid}`]: "24" });
  await s.as(3, "Racer C", 102); await s.post("/signup", { action: "signup", [`s_${rid}`]: "1", [`n_${rid}`]: "88" });
  const id = n => String(s.DB.raw.prepare("SELECT id FROM signups WHERE number = ? ORDER BY id DESC").get(n).id);
  await s.signIn(ADMIN);
  assert.match(text((await s.page("/test-cup/director")).html), /2 signups are waiting for 2027 Season 1/);
  assert.match(text((await s.post(P, { action: "approve", id: id("24") })).html), /Approved Racer B, #24/);
  assert.match(text((await s.post(P, { action: "decline", id: id("88"), reason: "" })).html), /Give the reason for declining/);
  assert.match(text((await s.post(P, { action: "decline", id: id("88"), reason: "Reserved for the pace car" })).html), /Declined Racer C\. #88 is free/);
  // the driver sees the decline and its reason, and can sign up again; an approved driver can't change it themselves
  await s.signIn(who(3, "Racer C"));
  assert.match(text((await s.page("/signup")).html), /Declined #88: Reserved for the pace car/);
  await s.post("/signup", { action: "signup", [`s_${rid}`]: "1", [`n_${rid}`]: "3" });
  await s.signIn(who(1, "Racer B"));
  assert.match(text((await s.page("/signup")).html), /#24 Approved To change it, ask the series director/);
  assert.match(text((await s.post("/signup", { action: "withdraw", withdraw: String(rid) })).html), /Your #24 is approved\. Ask the series director to release it/);
  // the director changes a number, signs a driver up, and releases one
  await s.signIn(ADMIN);
  assert.match(text((await s.post(P, { action: "number", id: id("24"), number: "3" })).html), /#3 is taken by Racer C/);
  assert.match(text((await s.post(P, { action: "number", id: id("24"), number: "42" })).html), /Changed Racer B to #42/);
  assert.match(text((await s.post(P, { action: "add", cust: "100", number: "1" })).html), /Added Racer A, #1/);
  assert.match(text((await s.post(P, { action: "add", cust: "888001", number: "9" })).html), /Enter the driver.{1,6}s name/);
  assert.match(text((await s.post(P, { action: "release", id: id("42") })).html), /Released #42\. Racer B is off the entry list/);
  assert.deepEqual(s.rows(), ["Racer B #42 released", "Racer C #88 declined", "Racer C #3 pending", "Racer A #1 approved"]);
  // the public entry list, the CSV and History
  s.cookie = "";
  const drivers = text((await s.page("/test-cup/drivers")).html);
  assert.match(drivers, /2027 Season 1 entry list 2 drivers signed up.*1 Racer A Approved 3 Racer C Waiting for the director/);
  assert.equal((await s.page(P + ".csv")).status, 302);
  await s.signIn(ADMIN);
  assert.equal((await s.page(P + ".csv")).html, "Number,Driver,iRacing ID,Status\r\n1,Racer A,100,Approved\r\n3,Racer C,102,Waiting\r\n");
  const hist = text((await s.page("/history")).html);
  for (const x of [/Signups opened for 2027 Season 1/, /Signup approved: Racer B #24/, /Signup declined: Racer C #88 \(2027 Season 1\): Reserved for the pace car/,
    /Car number changed: Racer B #24 → #42/, /Driver signed up by an official: Racer A #1/, /Number released: #42, Racer B/]) assert.match(hist, x);
});

test("only the series' directors and admins manage signups; closing stops drivers, not the director", async () => {
  const s = await setup({ keep: -5, open: -1 });
  await s.open();
  const rid = s.rid("test-cup");
  await s.as(1, "Racer B", 101);
  assert.equal((await s.page(P)).status, 404);
  assert.equal((await s.post(P, { action: "close" })).status, 404);
  await s.signIn(ADMIN);
  assert.match(text((await s.post(P, { action: "close" })).html), /Closed signups/);
  assert.equal(roundState(await currentRound(s.DB, 4242)), "closed");
  assert.doesNotMatch((await s.page("/")).html, /href="\/signup">Sign up</);
  assert.match(text((await s.post(P, { action: "add", cust: "100", number: "1" })).html), /Added Racer A, #1/);
  await s.signIn(who(1, "Racer B"));
  assert.match(text((await s.page("/signup")).html), /No series is taking signups right now/);
  await s.signIn(ADMIN);
  assert.match(text((await s.post(P, { action: "reopen" })).html), /Reopened signups/);
  assert.match(text((await s.post(P, { action: "round", name: "2027 Season 1", keep_date: dayStr(2), open_date: dayStr(1) })).html), /after the keep-your-number window starts/);
});

test("after the season starts: the Director tab flags a different number, and racing without signing up", async () => {
  const s = await setup({ keep: -5, open: -1 });
  await s.open();
  for (const [cust, name, num] of [[100, "Racer A", "1"], [101, "Racer B", "42"]]) await s.post(P, { action: "add", cust: String(cust), name, number: num });
  await s.addRace({ sub: 3000, date: new Date().toISOString(), order: [0, 1, 2], season: 501, seasonName: "Test Cup Season 2", track: "New Oval" });
  const d = text((await s.page("/test-cup/director")).html);
  assert.match(d, /Car numbers in the last race .*New Oval\) don.{1,6}t match the signups/);
  const p = text((await s.page(P)).html);
  assert.match(p, /Racer B ran #2, signed up as #42\./);
  assert.match(p, /Racer C raced as #3 without signing up\./);
  assert.doesNotMatch(p, /Racer A ran/);
});
