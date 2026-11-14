// Standings as a picture in Discord (Nov 2026): with the two Cloudflare secrets set, a standings post goes out with a
// picture of the standings card, taken by Cloudflare's Browser Run. Without them, or if the picture can't be made, it
// goes out as text, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";

const HOOK = "https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz";
const PNG = new Uint8Array(4000).fill(7);
async function setup({ secrets = true, shot = () => new Response(PNG, { headers: { "content-type": "image/png" } }) } = {}) {
  const s = makeSite();
  if (secrets) Object.assign(s.env, { CF_ACCOUNT_ID: "acct1", BROWSER_TOKEN: "tok1", CARD_WAIT_MS: 1 });
  const base = globalThis.fetch;
  s.shots = [];
  globalThis.fetch = async (u, init) => {
    if (String(u).startsWith("https://api.cloudflare.com/")) { s.shots.push({ url: String(u), auth: init.headers.authorization, body: JSON.parse(init.body) }); return shot(s.shots.length); }
    return base(u, init);
  };
  await s.addRace({ sub: 1000, date: week(-1) });
  await s.signIn({ id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" });
  await s.post("/test-cup/edit", { action: "hook", kind: "standings", url: HOOK });
  s.sent.length = 0;
  s.latest = () => s.post("/test-cup/edit", { action: "hook", kind: "standings", url: "", latest: "1" });
  s.hooks = () => s.sent.filter(x => x.url.startsWith(HOOK));
  return s;
}

test("the card page shows the top 20 like the standings page", async () => {
  const s = await setup();
  const r = await s.page("/test-cup/standings/card"), page = text(r.html);
  assert.equal(r.status, 200);
  assert.match(r.html, /<div id="card">/);
  assert.match(page, /Test Cup · Standings Test Cup Season 1/);
  assert.match(page, /Pos \+\/– # Driver Pts Behind/);
  assert.match(page, /1 \d+ Racer [A-Z]/);
  assert.match(page, /glrhub\.app\/test-cup\/standings/);
  assert.equal((await s.page("/test-cup/teams/card")).status, 404);          // no team points in this series
  assert.equal((await s.page("/nope/standings/card")).status, 404);
});

test("with the secrets set, the standings post is a picture of the card", async () => {
  const s = await setup();
  assert.match(text((await s.latest()).html), /Sent: standings/);
  assert.equal(s.shots.length, 1);
  assert.match(s.shots[0].url, /accounts\/acct1\/browser-run\/screenshot$/);
  assert.equal(s.shots[0].auth, "Bearer tok1");
  assert.match(s.shots[0].body.url, /^https:\/\/glrhub\.app\/test-cup\/standings\/card\?season=500$/);
  assert.equal(s.shots[0].body.selector, "#card");
  const post = s.hooks()[0];
  assert.ok(post.body instanceof FormData);
  const payload = JSON.parse(post.body.get("payload_json"));
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].image.url, "attachment://standings.png");
  assert.equal(payload.embeds[0].description, undefined);                     // the picture replaces the text list
  assert.match(payload.embeds[0].title, /Test Cup · Standings/);
  assert.equal(payload.card, undefined);
  const file = post.body.get("files[0]");
  assert.equal(file.name, "standings.png"); assert.equal(file.size, 4000); assert.equal(file.type, "image/png");
});

test("no secrets, or no picture: the post goes out as text, as before", async () => {
  for (const opts of [{ secrets: false }, { shot: () => new Response('{"success":false}', { status: 500, headers: { "content-type": "application/json" } }) },
    { shot: () => new Response("<html>", { headers: { "content-type": "text/html" } }) }, { shot: () => { throw new Error("down"); } }]) {
    const s = await setup(opts);
    assert.match(text((await s.latest()).html), /Sent: standings/);
    const post = JSON.parse(s.hooks()[0].body);
    assert.match(post.embeds[0].description, /1\. .*Racer/);
    assert.equal(post.embeds[0].image, undefined);
    assert.equal(post.card, undefined);                                        // the card's address never goes to Discord
    assert.equal(s.shots.length, opts.secrets === false ? 0 : 1);
  }
});

test("asked to slow down, the post waits its turn for the picture, and goes out as text if it never comes", async () => {
  let s = await setup({ shot: n => n === 1 ? new Response("{}", { status: 429 }) : new Response(PNG, { headers: { "content-type": "image/png" } }) });
  assert.match(text((await s.latest()).html), /Sent: standings/);
  assert.equal(s.shots.length, 2);
  assert.ok(s.hooks()[0].body instanceof FormData);
  s = await setup({ shot: () => new Response("{}", { status: 429 }) });
  await s.latest();                                                            // three turns in this go, all busy
  assert.equal(s.hooks().length, 0);
  assert.match(text((await s.page("/test-cup/edit")).html), /Waiting to make the standings picture/);
  s.DB.raw.prepare("UPDATE discord_queue SET next_try = 0").run();
  await s.post("/test-cup/edit", { action: "hook", kind: "standings", url: "", test: "1" });           // the next run of the queue
  const posts = s.hooks().filter(x => typeof x.body === "string").map(x => JSON.parse(x.body));
  assert.ok(posts.some(p => /1\. .*Racer/.test((p.embeds[0] || {}).description || "")));
});
