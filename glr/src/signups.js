// Season signups and car numbers (Nov 2026). Drivers sign up for a series' season and pick their car number.
//
// How it works (Eddie's decisions, Nov 9-10 2026):
// - Numbers are per series and per season, 1 to 3 digits. 7, 07 and 007 are different numbers, as in iRacing.
// - Two windows, set by the director: a keep-your-number window, where a driver who raced in the series last season
//   can confirm their old number and nobody else can take it; then an open window, first come, first served.
// - Every signup waits for a director's approval. A waiting signup holds its number.
// - A number is never freed by itself: only a decline, the driver withdrawing a waiting signup, or a director's release.
// - The site can't set numbers in iRacing: directors copy them from the entry list (CSV).
import { ensureSchema, easternToUtc } from "./db.js";

export const NUM_RE = /^\d{1,3}$/;
const ACTIVE = `status IN ('pending', 'approved')`;
const nowIso = () => new Date().toISOString();

export function cleanNumber(x) {
  const n = String(x ?? "").trim().replace(/^#/, "");
  if (!NUM_RE.test(n)) throw new Error("A car number is 1 to 3 digits, like 7, 07 or 124.");
  return n;
}

// where a round is: "soon" (before the keep window), "keep", "open" or "closed"
export function roundState(r, now = Date.now()) {
  if (!r) return "none";
  if (r.closed_at) return "closed";
  if (now < Date.parse(r.keep_at)) return "soon";
  return now < Date.parse(r.open_at) ? "keep" : "open";
}

// the series' current round: its newest
export async function currentRound(db, seriesId) {
  await ensureSchema(db);
  return db.prepare(`SELECT * FROM signup_rounds WHERE series_id = ? ORDER BY id DESC LIMIT 1`).bind(seriesId).first();
}

// every series' current round that isn't closed, for the Sign up page and the header link
export async function liveRounds(db) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT r.*, sr.short_name, sr.slug, sr.hidden FROM signup_rounds r JOIN series sr ON sr.id = r.series_id
    WHERE r.closed_at IS NULL AND r.id = (SELECT MAX(id) FROM signup_rounds x WHERE x.series_id = r.series_id) ORDER BY sr.short_name COLLATE NOCASE`).all()).results;
}

// a director opens signups, or changes the current round's name and dates. A new round starts once the last is closed.
export async function saveRound(db, seriesId, { name, keepDate, keepTime, openDate, openTime }, by) {
  await ensureSchema(db);
  const nm = String(name || "").trim().slice(0, 60);
  if (!nm) throw new Error("Name the season, like 2027 Season 1.");
  const keep = easternToUtc(keepDate, keepTime || "12:00 PM"), open = easternToUtc(openDate, openTime || "12:00 PM");
  if (Date.parse(open) <= Date.parse(keep)) throw new Error("Open signups to everyone after the keep-your-number window starts.");
  const cur = await currentRound(db, seriesId);
  if (cur && !cur.closed_at) {
    await db.prepare(`UPDATE signup_rounds SET name = ?, keep_at = ?, open_at = ? WHERE id = ?`).bind(nm, keep, open, cur.id).run();
    return { id: cur.id, name: nm, keep, open, created: false };
  }
  // "last season" is the season of the series' most recent race when signups are opened
  const last = await db.prepare(`SELECT season_id FROM events WHERE series_id = ? AND season_id IS NOT NULL ORDER BY start_time DESC LIMIT 1`).bind(seriesId).first();
  await db.prepare(`INSERT INTO signup_rounds (series_id, name, keep_at, open_at, from_season, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(seriesId, nm, keep, open, last ? last.season_id : null, nowIso(), by).run();
  return { id: (await currentRound(db, seriesId)).id, name: nm, keep, open, created: true };
}
export async function closeRound(db, roundId, closed) {
  await db.prepare(`UPDATE signup_rounds SET closed_at = ? WHERE id = ?`).bind(closed ? nowIso() : null, roundId).run();
}

// Whose number is whose from last season. A driver's number is the one from their most recent race; when two drivers
// ran the same number, it's held for whoever ran it in more races (then the more recent, then the lower iRacing ID).
// Returns byCust: cust -> { number, mine, holder } and byNumber: number -> { cust, name }.
export async function holds(db, round) {
  const byCust = new Map(), byNumber = new Map();
  if (!round || !round.from_season) return { byCust, byNumber };
  const rows = (await db.prepare(`SELECT r.cust_id, r.name, r.car_number, e.start_time FROM results r JOIN events e ON e.subsession_id = r.subsession_id
    WHERE e.season_id = ? AND r.session = 'race' ORDER BY e.start_time`).bind(round.from_season).all()).results;
  const d = new Map();
  for (const r of rows) {
    const n = String(r.car_number ?? "").trim();
    if (!NUM_RE.test(n)) continue;
    const x = d.get(r.cust_id) || { cust: r.cust_id, counts: new Map() };
    x.name = r.name; x.number = n; x.last = r.start_time; x.counts.set(n, (x.counts.get(n) || 0) + 1);
    d.set(r.cust_id, x);
  }
  for (const x of d.values()) {
    const c = { cust: x.cust, name: x.name, races: x.counts.get(x.number), last: x.last }, h = byNumber.get(x.number);
    if (!h || c.races > h.races || (c.races === h.races && (c.last > h.last || (c.last === h.last && c.cust < h.cust)))) byNumber.set(x.number, c);
  }
  for (const x of d.values()) { const h = byNumber.get(x.number); byCust.set(x.cust, { number: x.number, mine: h.cust === x.cust, holder: h.name }); }
  return { byCust, byNumber };
}

export async function listSignups(db, roundId) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT * FROM signups WHERE round_id = ? ORDER BY CAST(number AS INTEGER), number, id`).bind(roundId).all()).results;
}
export const activeOf = list => list.filter(x => x.status === "pending" || x.status === "approved");
// a driver's signup in a round: the one that counts, else their latest (to show a decline and its reason)
export const mineIn = (list, cust) => list.find(x => x.cust_id === cust && (x.status === "pending" || x.status === "approved"))
  || list.filter(x => x.cust_id === cust).sort((a, b) => b.id - a.id)[0] || null;

const taken = (db, roundId, number, notCust = 0) =>
  db.prepare(`SELECT name FROM signups WHERE round_id = ? AND number = ? AND ${ACTIVE} AND cust_id <> ?`).bind(roundId, number, notCust).first();
const just = (e, number) => /UNIQUE/i.test(String(e && e.message)) ? new Error(`#${number} was just taken. Pick another.`) : e;

// Sign a driver up, or change the number of their waiting signup. director: an official doing it for them (any time
// the round exists; approved at once). Returns { number, status, changed }.
export async function signUp(db, round, { cust, discordId = null, name, number, by, director = false }, now = Date.now()) {
  await ensureSchema(db);
  const state = roundState(round, now), num = cleanNumber(number);
  cust = Number(cust) || 0;
  if (!cust) throw new Error("The site doesn't know which driver this is.");
  if (state === "none") throw new Error("Signups aren't open for this series.");
  if (!director) {
    if (state === "soon") throw new Error("Signups haven't opened yet.");
    if (state === "closed") throw new Error("Signups are closed. Ask the Series Director.");
  }
  if (state === "soon" || state === "keep") {
    const h = await holds(db, round), held = h.byNumber.get(num), mine = h.byCust.get(cust);
    if (!director && !(mine && mine.mine && mine.number === num))
      throw new Error(mine && mine.mine ? `This week you can only keep your own number, #${mine.number}.` : "This week is for last season's drivers to keep their numbers. You can pick one when signups open to everyone.");
    if (held && held.cust !== cust) throw new Error(`#${num} is held for ${held.name} until signups open to everyone.`);
  }
  const other = await taken(db, round.id, num, cust);
  if (other) throw new Error(`#${num} is taken by ${other.name}.`);
  const have = await db.prepare(`SELECT * FROM signups WHERE round_id = ? AND cust_id = ? AND ${ACTIVE}`).bind(round.id, cust).first();
  const at = new Date(now).toISOString();
  try {
    if (have) {
      if (have.number === num && (!director || have.status === "approved")) return { number: num, status: have.status, changed: false };
      if (!director && have.status === "approved") throw new Error(`Your #${have.number} is approved. Ask the Series Director to change it.`);
      await db.prepare(`UPDATE signups SET number = ?, status = ?, decided_at = ?, decided_by = ? WHERE id = ?`)
        .bind(num, director ? "approved" : "pending", director ? at : null, director ? by : null, have.id).run();
      return { number: num, status: director ? "approved" : "pending", changed: true, was: have.number };
    }
    await db.prepare(`INSERT INTO signups (round_id, series_id, cust_id, discord_id, name, number, status, kept, created_at, created_by, decided_at, decided_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(round.id, round.series_id, cust, discordId, String(name || cust).slice(0, 80), num,
      director ? "approved" : "pending", state === "keep" ? 1 : 0, at, by, director ? at : null, director ? by : null).run();
  } catch (e) { throw just(e, num); }
  return { number: num, status: director ? "approved" : "pending", changed: false };
}

// a driver takes back their own waiting signup (an approved one needs the director)
export async function withdraw(db, round, cust) {
  const have = await db.prepare(`SELECT * FROM signups WHERE round_id = ? AND cust_id = ? AND ${ACTIVE}`).bind(round.id, cust).first();
  if (!have) throw new Error("You're not signed up for that series.");
  if (have.status === "approved") throw new Error(`Your #${have.number} is approved. Ask the Series Director to release it.`);
  await db.prepare(`UPDATE signups SET status = 'withdrawn', decided_at = ? WHERE id = ?`).bind(nowIso(), have.id).run();
  return have;
}

const one = async (db, id, seriesId) => {
  const s = await db.prepare(`SELECT * FROM signups WHERE id = ? AND series_id = ?`).bind(id, seriesId).first();
  if (!s) throw new Error("That signup isn't on this series any more.");
  return s;
};
// a director approves or declines a waiting signup. A decline needs a reason (the driver sees it) and frees the number.
export async function decide(db, seriesId, id, approve, reason, by) {
  const s = await one(db, id, seriesId);
  if (s.status !== "pending") throw new Error(s.status === "approved" ? "That signup is already approved." : "That signup isn't waiting any more.");
  const why = String(reason || "").trim().slice(0, 200);
  if (!approve && !why) throw new Error("Give the reason for declining. The driver sees it.");
  await db.prepare(`UPDATE signups SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?`).bind(approve ? "approved" : "declined", nowIso(), by, approve ? "" : why, id).run();
  return s;
}
// a director releases a number: the driver is off the entry list and the number is free
export async function release(db, seriesId, id, by) {
  const s = await one(db, id, seriesId);
  if (s.status !== "pending" && s.status !== "approved") throw new Error("That number is already free.");
  await db.prepare(`UPDATE signups SET status = 'released', decided_at = ?, decided_by = ? WHERE id = ?`).bind(nowIso(), by, id).run();
  return s;
}
// a director changes a signed-up driver's number
export async function changeNumber(db, seriesId, id, number, by) {
  const s = await one(db, id, seriesId), num = cleanNumber(number);
  if (s.status !== "pending" && s.status !== "approved") throw new Error("That driver isn't signed up any more.");
  if (num === s.number) throw new Error("That's the number they have.");
  const other = await taken(db, s.round_id, num, s.cust_id);
  if (other) throw new Error(`#${num} is taken by ${other.name}.`);
  try { await db.prepare(`UPDATE signups SET number = ?, decided_at = ?, decided_by = ? WHERE id = ?`).bind(num, nowIso(), by, id).run(); } catch (e) { throw just(e, num); }
  return { ...s, to: num };
}

// After the season starts: in the series' latest race since signups opened to everyone, who ran a number other than
// the one they signed up with, and who raced without an approved signup. Flags only; nothing is blocked.
export async function raceFlags(db, round) {
  if (!round) return null;
  const ev = await db.prepare(`SELECT subsession_id, track, start_time FROM events WHERE series_id = ? AND start_time > ? ORDER BY start_time DESC LIMIT 1`).bind(round.series_id, round.open_at).first();
  if (!ev) return null;
  const ran = (await db.prepare(`SELECT cust_id, name, car_number FROM results WHERE subsession_id = ? AND session = 'race' ORDER BY finish_pos`).bind(ev.subsession_id).all()).results;
  const list = await listSignups(db, round.id), ok = new Map(list.filter(x => x.status === "approved").map(x => [x.cust_id, x])),
    waiting = new Map(list.filter(x => x.status === "pending").map(x => [x.cust_id, x]));
  const different = [], unsigned = [];
  for (const r of ran) {
    const s = ok.get(r.cust_id), n = String(r.car_number ?? "").trim();
    if (s) { if (n && n !== s.number) different.push({ name: r.name, ran: n, signed: s.number }); }
    else unsigned.push({ name: r.name, ran: n, waiting: waiting.has(r.cust_id) });
  }
  return different.length || unsigned.length ? { event: ev, different, unsigned } : null;
}

// the entry list as a CSV, for entering numbers in the iRacing league
export function entryCsv(list) {
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return "Number,Driver,iRacing ID,Status\r\n" + activeOf(list).map(x => [x.number, x.name, x.cust_id, x.status === "approved" ? "Approved" : "Waiting"].map(q).join(",")).join("\r\n") + "\r\n";
}

// a driver who hasn't raced in GLR yet: make their driver record so their account can be linked to it
export async function newDriver(db, cust, name) {
  await ensureSchema(db);
  const id = Number(String(cust || "").trim()), nm = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!Number.isInteger(id) || id < 1 || id > 99999999) throw new Error("Enter your iRacing ID (the customer ID number on your iRacing profile).");
  if (nm.length < 3) throw new Error("Enter your name as it shows in iRacing.");
  if (await db.prepare(`SELECT 1 AS ok FROM drivers WHERE cust_id = ?`).bind(id).first()) return { cust: id, existed: true };
  await db.prepare(`INSERT INTO drivers (cust_id, name) VALUES (?, ?)`).bind(id, nm).run();
  return { cust: id, name: nm, existed: false };
}
