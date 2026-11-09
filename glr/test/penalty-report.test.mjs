// Sending a race's penalty report to Discord by hand, from its stewards' report (Nov 2026).
// Decisions made while the race was provisional aren't posted by themselves; this sends all of them in one post.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, text, ADMIN_ROLE } from "./helpers.mjs";
import { addAdjustment } from "../src/db.js";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const RC = "333333";
const HOOK = "https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz";

async function setup({ hook = true } = {}) {
  const s = makeSite();
  await s.signIn(ADMIN);
  await s.addRace({ sub: 9001, date: new Date(Date.now() - 3 * 3600e3).toISOString(), order: [0, 1, 2, 3] });
  await s.post("/settings", { theme: "glr", short: "GLR", steward_role: RC });
  if (hook) await s.post("/test-cup/edit", { action: "hook", kind: "penalties", url: HOOK });
  s.DB.raw.prepare("UPDATE events SET status = 'provisional' WHERE subsession_id = 9001").run();
  const race = (await s.json("/api/results/9001")).event.sessions.race;
  return { s, race };
}
const posts = s => s.sent.filter(x => x.url.startsWith(HOOK)).map(x => JSON.parse(x.body));

test("one post with every penalty on the race; withdrawn and no action left out", async () => {
  const { s, race } = await setup();
  const [a, b, c, d] = race.map(r => String(r.cust_id));
  await s.post("/results/9001/stewards", { action: "decide", cust: b, kind: "time", amount: "5", reason: "Jumped the restart" });
  await s.post("/results/9001/stewards", { action: "decide", cust: c, kind: "warning", reason: "Blocking" });
  await s.post("/results/9001/stewards", { action: "decide", cust: d, kind: "none", reason: "Racing incident" });
  await s.post("/results/9001/stewards", { action: "decide", cust: a, kind: "points", amount: "-10", reason: "Rough driving" });
  const season = s.DB.raw.prepare("SELECT season_id FROM events WHERE subsession_id = 9001").get().season_id;
  await addAdjustment(s.DB, season, { sub: 9001, cust: Number(d), points: -3, reason: "Late to the drivers' meeting" }, "test");
  const undo = s.DB.raw.prepare("SELECT id FROM decisions WHERE kind = 'warning'").get().id;
  await s.post("/results/9001/stewards", { action: "undo", id: String(undo) });
  assert.equal(posts(s).length, 0);                                    // provisional: nothing posted by itself

  const page = (await s.page("/results/9001/stewards")).html;
  assert.match(page, /Send penalty report to Discord/);
  const r = await s.post("/results/9001/stewards", { action: "report" });
  assert.match(text(r.html), /Sent: the penalty report \(3 penalties\)/);
  const [p] = posts(s);
  assert.match(p.embeds[0].title, /Test Cup: penalty report/);
  const desc = p.embeds[0].description;
  assert.match(desc, /results still provisional/);
  assert.match(desc, /Jumped the restart/);
  assert.match(desc, /Rough driving/);
  assert.match(desc, /Late to the drivers. meeting/);
  assert.doesNotMatch(desc, /Blocking|Racing incident/);
  assert.equal((desc.match(/Rough driving/g) || []).length, 1);         // a points decision isn't listed twice
  assert.match(text((await s.page("/history")).html), /Penalty report for Test Oval posted to Discord by hand \(3\)/);
});

test("only directors and admins see the button; without a webhook it says where to add one", async () => {
  const { s, race } = await setup({ hook: false });
  await s.post("/results/9001/stewards", { action: "decide", cust: String(race[1].cust_id), kind: "time", amount: "5", reason: "x" });
  assert.match(text((await s.page("/results/9001/stewards")).html), /add a Penalties webhook on Edit series/);
  await s.signIn({ id: "71", roles: [RC], nick: "Steward Sam" });              // race control: steward, not a director
  assert.doesNotMatch((await s.page("/results/9001/stewards")).html, /penalty report/);
  assert.match(text((await s.post("/results/9001/stewards", { action: "report" })).html), /Only the series.{1,6} directors and admins/);
});

test("nothing to send says so", async () => {
  const { s } = await setup();
  assert.match(text((await s.post("/results/9001/stewards", { action: "report" })).html), /No penalties to send for this race/);
  assert.equal(posts(s).length, 0);
});
