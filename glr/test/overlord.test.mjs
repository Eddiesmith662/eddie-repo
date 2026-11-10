// The overlord (Nov 2026): one person above admin, named by Discord user ID in Cloudflare (OVERLORD_ID). Settings,
// Overlay keys, the Help question log, overlay blocks and the whole site's History are theirs alone; to admins those
// aren't there. Until OVERLORD_ID is set, admins keep them (the other tests run that way).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";

const OWNER = { id: "42", roles: [], nick: "The Owner" };                  // no admin role: the ID alone is enough
const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
async function setup() {
  const s = makeSite();
  s.env.OVERLORD_ID = "42"; s.env.ANTHROPIC_API_KEY = "sk-test";
  await s.addRace({ sub: 1000, date: week(0) });
  await s.signIn({ id: "80", roles: [], nick: "Producer Pat" });           // an account to block
  return s;
}

test("the overlord has everything an admin has, plus the overlord-only pages, without the admin role", async () => {
  const s = await setup();
  await s.signIn(OWNER);
  const home = (await s.page("/")).html;
  for (const l of ["/accounts", "/keys", "/settings", "/series/add", "/history"]) assert.match(home, new RegExp(`href="${l}"`), l);
  for (const p of ["/settings", "/keys", "/help/log", "/accounts", "/history", "/test-cup/edit", "/test-cup/director"]) assert.equal((await s.page(p)).status, 200, p);
  assert.match((await s.page("/accounts")).html, /<th>Overlay<\/th>/);
  assert.match(text((await s.post("/accounts", { action: "block", id: "80" })).html), /Producer Pat is blocked from the overlay/);
  assert.match(text((await s.page("/history")).html), /Admin blocked Producer Pat from the broadcast overlay/);
  assert.equal((await s.json("/api/me")).user.overlord, true);
});

test("to an admin, the overlord-only things aren't there", async () => {
  const s = await setup();
  await s.signIn(OWNER);
  await s.post("/accounts", { action: "block", id: "80" });
  await s.post("/test-cup/edit", { short_name: "Test Cup", slug: "test-cup", teams_form: "1", teams: "on" });     // a series change
  await s.signIn(ADMIN);
  const home = (await s.page("/")).html;
  assert.match(home, /href="\/accounts"/);
  for (const l of ["/keys", "/settings", "/help/log"]) assert.doesNotMatch(home, new RegExp(`href="${l}"`), l);
  for (const p of ["/settings", "/keys", "/help/log"]) {
    const r = await s.page(p);
    assert.equal(r.status, 404, p);
    assert.match(text(r.html), /Not found Check the link\./, p);           // the same as any wrong address: it doesn't say why
    assert.doesNotMatch(r.html, /overlord|owner/i, p);
  }
  assert.equal((await s.post("/settings", { theme: "glr", short: "X" })).status, 404);
  assert.equal((await s.post("/keys", { name: "Sneaky" })).status, 404);
  const acc = await s.page("/accounts");
  assert.doesNotMatch(acc.html, /<th>Overlay<\/th>|Blocked|Unblock/);      // no column, and not who is blocked
  assert.match(text((await s.post("/accounts", { action: "unblock", id: "80" })).html), /You can.{1,6}t change that/);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM overlay_blocks").get().n, 1);
  // History: every series' changes, but not accounts, settings or keys
  const hist = text((await s.page("/history")).html);
  assert.match(hist, /Team points turned on/);
  assert.doesNotMatch(hist, /blocked Producer Pat/);
  // admins keep the rest
  for (const p of ["/accounts", "/series/add", "/test-cup/edit", "/test-cup/director", "/test-cup/signups"]) assert.equal((await s.page(p)).status, 200, p);
  assert.equal((await s.json("/api/me")).user.overlord, false);
});

test("the Help chat tells an admin those things belong to the site owner, and the owner gets the question log link", async () => {
  const s = await setup();
  const inner = globalThis.fetch; let sys = "";
  globalThis.fetch = async (u, init) => String(u).includes("anthropic") ? (sys = JSON.parse(init.body).system, new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }))) : inner(u, init);
  const ask = () => s.go("/api/help", { method: "POST", headers: { origin: "https://glrhub.app", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "How do I change the role IDs?" }] }) });
  await s.signIn(ADMIN);
  assert.equal((await ask()).status, 200);
  assert.match(sys, /belong to the site owner only/);
  assert.doesNotMatch((await s.page("/")).html, /What people asked/);
  await s.signIn(OWNER);
  await ask();
  assert.doesNotMatch(sys, /belong to the site owner only/);
  assert.match((await s.page("/")).html, /href="\/help\/log">What people asked/);
  globalThis.fetch = inner;
});
