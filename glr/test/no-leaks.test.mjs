// No Discord webhook link in anything the public can read. Nov 9 2026: /api/series sent hook_teams (Warrior's team
// standings webhook) to everyone, because the public helper removed webhook fields by name and missed the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, ADMIN_ROLE } from "./helpers.mjs";

const HOOK = "https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz";

test("with all four webhooks set, no public JSON or page carries a hook_ field or a webhook link", async () => {
  const s = makeSite();
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.addRace({ sub: 1000, date: week(0) });
  await s.post("/test-cup/edit", { action: "teams", teams: "1" });
  for (const kind of ["results", "standings", "penalties", "teams"]) await s.post("/test-cup/edit", { action: "hook", kind, url: HOOK + kind });
  const row = s.DB.raw.prepare("SELECT * FROM series").get();
  for (const k of ["hook_results", "hook_standings", "hook_penalties", "hook_teams"]) assert.match(row[k], /webhooks/, k);   // they are set
  await s.post("/results/1000/stewards", { action: "decide", cust: "101", kind: "warning", reason: "Blocking" });
  s.cookie = "";                                                          // signed out: the public
  const paths = ["/api/series", "/api/series/test-cup", `/api/series/${row.id}`, "/api/series/test-cup/points", "/api/series/test-cup/schedule",
    "/api/series/test-cup/stats", "/api/series/test-cup/drivers", "/api/standings/test-cup", "/api/results/1000", "/api/schedule", "/api/drivers", "/api/drivers/101",
    "/", "/schedule", "/drivers", "/drivers/101", "/test-cup", "/test-cup/standings", "/test-cup/schedule", "/test-cup/stats", "/test-cup/drivers", "/test-cup/rules",
    "/test-cup/penalties", "/test-cup/teams", "/test-cup/history", "/test-cup/embed", "/test-cup/widget/standings", "/test-cup/widget/schedule", "/test-cup/widget/results",
    "/test-cup/widget/teams", "/results/1000", "/results/1000/stewards", "/test-cup/edit", "/test-cup/director", "/history"];
  let read = 0;
  for (const p of paths) {
    const r = await s.go(p);
    const body = await r.text();
    if (r.status === 200) read++;
    assert.doesNotMatch(body, /hook_/, p);
    assert.doesNotMatch(body, /discord\.com\/api\/webhooks|discordapp\.com\/api\/webhooks/, p);
    assert.doesNotMatch(body, /abcdefghijklmnopqrstuvwxyz/, p);
  }
  assert.ok(read >= 20, `only ${read} pages answered`);
  const api = (await s.json("/api/series")).series[0];
  assert.deepEqual(Object.keys(api).sort(), ["id", "latest", "latestEvent", "name", "races", "short_name", "slug", "teams"]);
  assert.equal((await s.json("/api/series/test-cup")).series.short_name, "Test Cup");
});
