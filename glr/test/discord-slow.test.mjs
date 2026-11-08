// Discord slow or busy (Nov 8 2026: signed-in pages hung while the site waited on Discord's role check).
// The page loads anyway with the last roles, nobody is signed out, and the site asks again a minute later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, ADMIN_ROLE } from "./helpers.mjs";
import { discordTiming } from "../src/auth.js";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
discordTiming.ms = 200;

// Discord answers nothing until the site gives up (mode "slow"), or answers with a status (e.g. 503, 429, 400)
function trouble(s, mode, only = /discord\.com/) {
  const inner = globalThis.fetch;
  s.calls = 0;
  globalThis.fetch = (u, init = {}) => {
    if (!only.test(String(u))) return inner(u, init);
    s.calls++;
    if (mode === "slow") return new Promise((_, no) => {
      const keep = setTimeout(() => {}, 10000);                      // Node doesn't wait for the abort timer by itself
      init.signal.addEventListener("abort", () => { clearTimeout(keep); no(init.signal.reason); });
    });
    return Promise.resolve(new Response('{"error":"x"}', { status: mode }));
  };
  return () => { globalThis.fetch = inner; };
}
async function signedIn() {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(0) });
  await s.signIn(ADMIN);
  s.DB.raw.prepare("UPDATE sessions SET checked = 0").run();            // the 15-minute role check is due
  return s;
}
const signedInAs = async s => (text((await s.page("/")).html).match(/Test Admin Sign out/) || [])[0];

test("Discord slow: the page loads within the limit, still signed in with the last roles, asked again a minute later", async () => {
  const s = await signedIn();
  const undo = trouble(s, "slow");
  const t = Date.now();
  assert.ok(await signedInAs(s));
  assert.ok(Date.now() - t < 2000);
  assert.equal(s.calls, 1);
  assert.ok(await signedInAs(s));                                      // next page: not asked again straight away
  assert.equal(s.calls, 1);
  s.DB.raw.prepare("UPDATE sessions SET checked = checked - 61000").run();   // a minute later
  await s.page("/");
  assert.equal(s.calls, 2);
  undo();
});

test("Discord busy (503, 429) on the role check or the token refresh: still signed in", async () => {
  for (const status of [503, 429]) {
    const s = await signedIn();
    let undo = trouble(s, status);
    assert.ok(await signedInAs(s), String(status));
    undo();
    s.DB.raw.prepare("UPDATE sessions SET checked = 0, token_expires = 0").run();     // needs a token refresh too
    undo = trouble(s, status, /oauth2\/token/);
    assert.ok(await signedInAs(s), "refresh " + status);
    undo();
  }
});

test("Discord turning the refresh down (the person disconnected the app) still signs them out", async () => {
  const s = await signedIn();
  s.DB.raw.prepare("UPDATE sessions SET token_expires = 0").run();
  const undo = trouble(s, 400, /oauth2\/token/);
  assert.equal(await signedInAs(s), undefined);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  undo();
});

test("signing in while Discord is slow says to try again, instead of an error page", async () => {
  const s = makeSite();
  const undo = trouble(s, "slow");
  const r = await s.go("/login");
  const state = new URL(r.headers.get("location")).searchParams.get("state");
  const p = await s.go("/auth/callback?code=x&state=" + state);
  assert.equal(p.status, 403);
  assert.match(text(await p.text()), /Discord didn.{1,6}t answer\. Try again in a minute/);
  undo();
});
