// A scheduled race with no results on the site by noon Eastern the next day shows on the series' Director tab.
// Made-up drivers and tracks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text } from "./helpers.mjs";
import { missedResults } from "../src/db.js";

const at = iso => Date.parse(iso);

test("flagged from noon Eastern the next day, not before; gone once results arrive", async () => {
  const s = makeSite();
  await s.addRace({ sub: 1, date: week(-3) });
  const id = s.DB.raw.prepare("SELECT id FROM series LIMIT 1").get().id;
  // Thu Nov 5 2026, 8 PM Eastern (01:00 UTC Nov 6); Eastern is UTC-5 in November
  s.DB.raw.prepare("INSERT INTO schedule (series_id, starts_at, track) VALUES (?, ?, ?)").run(id, "2026-11-06T01:00:00.000Z", "Test Oval");
  assert.equal((await missedResults(s.DB, id, at("2026-11-06T16:59:00Z"))).length, 0);     // 11:59 AM Eastern Friday
  assert.equal((await missedResults(s.DB, id, at("2026-11-06T17:00:00Z"))).length, 1);     // noon Eastern Friday
  // summer: Eastern is UTC-4, so noon is 16:00 UTC
  s.DB.raw.prepare("INSERT INTO schedule (series_id, starts_at, track) VALUES (?, ?, ?)").run(id, "2026-07-10T00:00:00.000Z", "Summer Oval");
  assert.equal((await missedResults(s.DB, id, at("2026-07-10T15:59:00Z"))).length, 0);
  assert.equal((await missedResults(s.DB, id, at("2026-07-10T16:00:00Z"))).length, 1);
  assert.equal((await missedResults(s.DB, id, at("2026-08-10T16:00:00Z"))).length, 0);     // old ones drop off after two weeks
});

test("the Director tab lists it under Needs attention, and results clear it", async () => {
  const s = makeSite();
  await s.addRace({ sub: 1, date: week(-3) });
  await s.signIn();
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await s.post("/test-cup/schedule", { bulk: `${day(-3)}, 8:00 PM, Missing Oval` });
  let p = text((await s.page("/test-cup/director")).html);
  assert.match(p, /1 scheduled race has no results on the site yet.* Missing Oval/);
  const races = (await s.json("/api/series/test-cup/schedule")).races;
  const r = races.find(x => x.track === "Missing Oval");
  await s.addRace({ sub: 2, date: new Date(Date.parse(r.startsAt) + 10 * 60000).toISOString() });
  p = text((await s.page("/test-cup/director")).html);
  assert.doesNotMatch(p, /no results on the site yet/);
});
