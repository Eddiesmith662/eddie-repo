/*
 * The league database (Cloudflare D1, which is SQLite).
 *
 * Tables are created on first use, so a fresh database needs no setup step. Drivers are keyed by iRacing Cust ID,
 * and every name a driver has raced under is kept in driver_names (league nicknames make the sim and the export
 * disagree on names, the Cust ID never changes).
 */
import { applyDecisions, decisionText, KINDS, AMOUNT, CHANGES_ORDER } from "./stewards.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS series (
     id INTEGER PRIMARY KEY,            -- iRacing league id
     name TEXT NOT NULL DEFAULT '',     -- iRacing's league name
     short_name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
     role_id TEXT NOT NULL DEFAULT '',  -- Discord role whose members can edit this series
     hook_results TEXT NOT NULL DEFAULT '', hook_standings TEXT NOT NULL DEFAULT '', hook_penalties TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS seasons (
     id INTEGER PRIMARY KEY,            -- iRacing league season id
     series_id INTEGER,
     name TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS events (
     subsession_id INTEGER PRIMARY KEY, -- iRacing subsession id
     series_id INTEGER, season_id INTEGER,
     track TEXT, start_time TEXT, laps INTEGER,
     cautions INTEGER, caution_laps INTEGER, lead_changes INTEGER, sof INTEGER,
     status TEXT NOT NULL DEFAULT 'official',
     source TEXT, uploaded_at TEXT, uploaded_by TEXT,
     official_at TEXT, official_by TEXT, discord TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS events_season ON events (season_id, start_time)`,
  `CREATE TABLE IF NOT EXISTS drivers (
     cust_id INTEGER PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS driver_names (
     cust_id INTEGER NOT NULL, name TEXT NOT NULL,
     first_seen TEXT, last_seen TEXT,
     PRIMARY KEY (cust_id, name))`,
  `CREATE TABLE IF NOT EXISTS results (
     subsession_id INTEGER NOT NULL, session TEXT NOT NULL, cust_id INTEGER NOT NULL,
     name TEXT, car_number TEXT, car TEXT, car_class TEXT NOT NULL DEFAULT '',
     finish_pos INTEGER, class_pos INTEGER, start_pos INTEGER, laps INTEGER, laps_led INTEGER, incidents INTEGER,
     best_lap_ms INTEGER, best_lap_num INTEGER, avg_lap_ms INTEGER,
     interval_ms INTEGER, laps_down INTEGER, class_interval_ms INTEGER, class_laps_down INTEGER,
     reason_out TEXT, league_points INTEGER,
     PRIMARY KEY (subsession_id, session, cust_id))`,
  `CREATE INDEX IF NOT EXISTS results_driver ON results (cust_id, subsession_id)`,
  `CREATE TABLE IF NOT EXISTS season_rules (
     season_id INTEGER PRIMARY KEY, rules TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS adjustments (
     id INTEGER PRIMARY KEY AUTOINCREMENT, subsession_id INTEGER NOT NULL, cust_id INTEGER NOT NULL,
     points INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT, created_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS adjustments_event ON adjustments (subsession_id)`,
  `CREATE TABLE IF NOT EXISTS result_fixes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, subsession_id INTEGER NOT NULL, cust_id INTEGER NOT NULL, name TEXT,
     changes TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS discord_queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL, hook TEXT NOT NULL, kind TEXT NOT NULL,
     subsession_id INTEGER, body TEXT NOT NULL, edit_of TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
     last_error TEXT, created_at TEXT, sent_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS driver_aliases (
     from_cust INTEGER PRIMARY KEY, to_cust INTEGER NOT NULL, merged_at TEXT, merged_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS changes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT, series_id INTEGER, subsession_id INTEGER,
     kind TEXT NOT NULL, summary TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS changes_series ON changes (series_id, id)`,
  `CREATE TABLE IF NOT EXISTS roster (
     series_id INTEGER NOT NULL, cust_id INTEGER NOT NULL, name TEXT NOT NULL, car_number TEXT NOT NULL DEFAULT '',
     added_at TEXT, added_by TEXT, PRIMARY KEY (series_id, cust_id))`,
  `CREATE TABLE IF NOT EXISTS schedule (
     id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL, starts_at TEXT NOT NULL, track TEXT NOT NULL,
     notes TEXT NOT NULL DEFAULT '', subsession_id INTEGER, created_at TEXT, created_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS schedule_series ON schedule (series_id, starts_at)`,
  `CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS overlay_keys (
     id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
     created_at TEXT, created_by TEXT, last_used TEXT, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0)`,
  // stewarding: which iRacing driver a Discord member is, protests they file, and the stewards' decisions
  `CREATE TABLE IF NOT EXISTS driver_links (
     discord_id TEXT PRIMARY KEY, cust_id INTEGER NOT NULL, discord_name TEXT, linked_at TEXT)`,
  // everyone who has signed in with Discord (the admins' Accounts page), and claims on a driver someone else already has
  `CREATE TABLE IF NOT EXISTS accounts (discord_id TEXT PRIMARY KEY, name TEXT, first_seen TEXT, last_seen TEXT)`,
  // series directors: which series each official runs (with the Series official role from Site settings)
  `CREATE TABLE IF NOT EXISTS series_directors (
     discord_id TEXT NOT NULL, series_id INTEGER NOT NULL, assigned_at TEXT, assigned_by TEXT, PRIMARY KEY (discord_id, series_id))`,
  // team points (the Warrior points system): each season's teams and their drivers
  `CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL, season_id INTEGER NOT NULL, name TEXT NOT NULL, sort INTEGER)`,
  `CREATE TABLE IF NOT EXISTS team_members (team_id INTEGER NOT NULL, cust_id INTEGER NOT NULL, PRIMARY KEY (team_id, cust_id))`,
  // what a driver says about themselves (from GLR HUB, by the driver or an official): shown on their driver page and
  // in /api/drivers/<id> for the overlay
  `CREATE TABLE IF NOT EXISTS driver_profiles (cust_id INTEGER PRIMARY KEY, bio TEXT NOT NULL DEFAULT '', sponsor TEXT NOT NULL DEFAULT '',
     team TEXT NOT NULL DEFAULT '', hometown TEXT NOT NULL DEFAULT '', updated_at TEXT, updated_by TEXT)`,
  // an admin turned a person's overlay access off: wins over their Discord roles until it's lifted
  `CREATE TABLE IF NOT EXISTS help_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, discord_id TEXT NOT NULL, name TEXT, question TEXT NOT NULL, answer TEXT)`,
  `CREATE INDEX IF NOT EXISTS help_log_who ON help_log (discord_id, at)`,
  `CREATE TABLE IF NOT EXISTS overlay_blocks (discord_id TEXT PRIMARY KEY, blocked_at TEXT NOT NULL, blocked_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS link_claims (
     id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT NOT NULL, discord_name TEXT, cust_id INTEGER NOT NULL,
     created_at TEXT, status TEXT NOT NULL DEFAULT 'open', decided_by TEXT, decided_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS protests (
     id INTEGER PRIMARY KEY AUTOINCREMENT, subsession_id INTEGER NOT NULL, series_id INTEGER,
     filed_by TEXT NOT NULL, filer_cust INTEGER NOT NULL, against_cust INTEGER, lap TEXT NOT NULL DEFAULT '',
     what TEXT NOT NULL, video TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
     created_at TEXT, closed_at TEXT, closed_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS protests_event ON protests (subsession_id)`,
  `CREATE INDEX IF NOT EXISTS protests_open ON protests (status, series_id)`,
  `CREATE TABLE IF NOT EXISTS decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, subsession_id INTEGER NOT NULL, series_id INTEGER, protest_id INTEGER,
     cust_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
     adj_id INTEGER, source TEXT NOT NULL DEFAULT 'site', made_at TEXT, made_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS decisions_event ON decisions (subsession_id)`,
];
// columns added after the first version: [table, column, definition]
const ADDED = [
  ["series", "short_name", "TEXT NOT NULL DEFAULT ''"], ["series", "slug", "TEXT NOT NULL DEFAULT ''"], ["series", "role_id", "TEXT NOT NULL DEFAULT ''"],
  ["series", "hook_results", "TEXT NOT NULL DEFAULT ''"], ["series", "hook_standings", "TEXT NOT NULL DEFAULT ''"], ["series", "hook_penalties", "TEXT NOT NULL DEFAULT ''"],
  ["series", "teams", "INTEGER NOT NULL DEFAULT 0"], ["series", "hook_teams", "TEXT NOT NULL DEFAULT ''"],   // team points (the Warrior series only): an admin turns it on, on Edit series
  ["results", "orig_cust_id", "INTEGER"],
  ["overlay_keys", "kind", "TEXT NOT NULL DEFAULT 'overlay'"],
  ["schedule", "layout", "TEXT NOT NULL DEFAULT ''"], ["schedule", "length", "TEXT NOT NULL DEFAULT ''"],
  ["events", "official_at", "TEXT"], ["events", "official_by", "TEXT"], ["events", "discord", "TEXT NOT NULL DEFAULT '{}'"],
  ["results", "car_class", "TEXT NOT NULL DEFAULT ''"], ["results", "class_pos", "INTEGER"],
  ["results", "class_interval_ms", "INTEGER"], ["results", "class_laps_down", "INTEGER"],
  // race control's calls (phase 5c): its own id for the call, what it sent (lap, served or not, ...), and withdrawals
  ["decisions", "rc_uid", "TEXT"], ["decisions", "info", "TEXT NOT NULL DEFAULT '{}'"], ["decisions", "status", "TEXT NOT NULL DEFAULT 'active'"],
  ["decisions", "withdrawn_at", "TEXT"], ["decisions", "withdrawn_by", "TEXT"], ["decisions", "withdrawn_reason", "TEXT"],
  ["decisions", "withdrawn_site", "INTEGER NOT NULL DEFAULT 0"],
  ["decisions", "edited_at", "TEXT"], ["decisions", "edited_by", "TEXT"], ["decisions", "edited_from", "TEXT"],
  ["decisions", "edited_site", "INTEGER NOT NULL DEFAULT 0"],
];

// short names for the GLR series (by iRacing league id); officials can change them on the site
const SHORT = { 9310: "ARCA", 9309: "Grand National", 11390: "Foundation", 12070: "Sports Car", 11059: "Warrior", 6838: "Next Gen" };
// words in the site's own addresses, which a series can't use as its address
export const RESERVED = new Set(["api", "results", "drivers", "upload", "login", "logout", "auth", "health", "series", "edit", "admin", "keys", "history", "schedule", "settings", "theme", "protests", "rc"]);

export const slugify = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const shortFrom = (id, name) => SHORT[id] || String(name || "").replace(/^\s*GLR\s+/i, "").replace(/\s+SERIES\s*$/i, "").trim() || `Series ${id}`;

async function freeSlug(db, want, id) {
  let base = slugify(want) || `series-${id}`;
  if (RESERVED.has(base) || /^\d+$/.test(base)) base = `${base}-series`;
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const hit = await db.prepare(`SELECT id FROM series WHERE slug = ? AND id <> ?`).bind(slug, id).first();
    if (!hit) return slug;
  }
}

// give any series without a short name and address the defaults
async function nameSeries(db) {
  const rows = (await db.prepare(`SELECT id, name, short_name, slug FROM series WHERE short_name = '' OR slug = ''`).all()).results;
  for (const r of rows) {
    const short = r.short_name || shortFrom(r.id, r.name);
    await db.prepare(`UPDATE series SET short_name = ?, slug = ? WHERE id = ?`).bind(short, r.slug || await freeSlug(db, short, r.id), r.id).run();
  }
}

const readyFor = new WeakMap();          // per database (the site has one; tests make a fresh one each time)
export function ensureSchema(db) {
  let ready = readyFor.get(db);
  if (!ready) readyFor.set(db, ready = (async () => {
    await db.batch(SCHEMA.map(s => db.prepare(s)));
    for (const [table, col, def] of ADDED) {
      const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(c => c.name);
      if (!cols.includes(col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    }
    await db.prepare(`CREATE INDEX IF NOT EXISTS decisions_rc ON decisions (rc_uid)`).run();
    await nameSeries(db);
    await backfillChanges(db);
    await setDropWeeksOnce(db);
  })().catch(e => { readyFor.delete(db); throw e; }));
  return ready;
}

/*
 * Store one parsed export. Uploading the same race again replaces its results for the sessions in the file (a CSV
 * only carries the race, so a JSON's practice and qualifying stay). Event details the file doesn't have (a CSV has
 * no caution count) keep what's already stored.
 */
export async function importEvent(db, ev, by = "") {
  if (!ev.subsessionId) throw new Error("The file doesn't say which session it is. Use the JSON export, or keep the original CSV file name (it has the session number in it).");
  const race = ev.sessions.find(s => s.name === "race");
  if (!race || !race.results.length) throw new Error("There are no race results in this file.");
  await ensureSchema(db);
  const now = new Date().toISOString(), when = ev.startTime || now, st = [];
  const status = ev.status || "official";
  if (ev.league.id) st.push(db.prepare(`INSERT INTO series (id, name) VALUES (?1, ?2)
      ON CONFLICT(id) DO UPDATE SET name = CASE WHEN ?2 <> '' THEN ?2 ELSE name END`).bind(ev.league.id, ev.league.name));
  if (ev.season.id) st.push(db.prepare(`INSERT INTO seasons (id, series_id, name) VALUES (?1, ?2, ?3)
      ON CONFLICT(id) DO UPDATE SET series_id = COALESCE(?2, series_id), name = CASE WHEN ?3 <> '' THEN ?3 ELSE name END`)
      .bind(ev.season.id, ev.league.id, ev.season.name));
  st.push(db.prepare(`INSERT INTO events (subsession_id, series_id, season_id, track, start_time, laps, cautions, caution_laps,
        lead_changes, sof, source, uploaded_at, uploaded_by, status, official_at, official_by)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, CASE WHEN ?14 = 'official' THEN ?12 END, CASE WHEN ?14 = 'official' THEN ?13 END)
      ON CONFLICT(subsession_id) DO UPDATE SET series_id = COALESCE(?2, series_id), season_id = COALESCE(?3, season_id),
        track = COALESCE(NULLIF(?4, ''), track), start_time = COALESCE(NULLIF(?5, ''), start_time), laps = COALESCE(?6, laps),
        cautions = COALESCE(?7, cautions), caution_laps = COALESCE(?8, caution_laps), lead_changes = COALESCE(?9, lead_changes),
        sof = COALESCE(?10, sof), source = ?11, uploaded_at = ?12, uploaded_by = ?13, status = ?14,
        official_at = CASE WHEN ?14 = 'official' THEN COALESCE(official_at, ?12) ELSE NULL END,
        official_by = CASE WHEN ?14 = 'official' THEN COALESCE(official_by, ?13) ELSE NULL END`)
    .bind(ev.subsessionId, ev.league.id, ev.season.id, ev.track, ev.startTime, ev.laps, ev.cautions, ev.cautionLaps,
          ev.leadChanges, ev.sof, ev.source, now, by, status));
  const fixes = (await db.prepare(`SELECT COUNT(*) AS n FROM result_fixes WHERE subsession_id = ?`).bind(ev.subsessionId).first()).n;
  const before = await db.prepare(`SELECT status FROM events WHERE subsession_id = ?`).bind(ev.subsessionId).first();
  st.push(db.prepare(`DELETE FROM result_fixes WHERE subsession_id = ?`).bind(ev.subsessionId));   // the new results replace any fixes
  // drivers merged into another record: their results land on that record (and remember where they came from)
  const alias = new Map((await db.prepare(`SELECT from_cust, to_cust FROM driver_aliases`).all()).results.map(a => [a.from_cust, a.to_cust]));
  const seen = new Map();
  for (const s of ev.sessions) {
    st.push(db.prepare(`DELETE FROM results WHERE subsession_id = ? AND session = ?`).bind(ev.subsessionId, s.name));
    for (const r0 of s.results) {
      if (!r0.custId) continue;
      const r = alias.has(r0.custId) ? { ...r0, custId: alias.get(r0.custId), orig: r0.custId } : r0;
      if (r.name) seen.set(r.custId, r.name);
      st.push(db.prepare(`INSERT OR REPLACE INTO results (subsession_id, session, cust_id, name, car_number, car, car_class,
            finish_pos, class_pos, start_pos, laps, laps_led, incidents, best_lap_ms, best_lap_num, avg_lap_ms, interval_ms,
            laps_down, class_interval_ms, class_laps_down, reason_out, league_points, orig_cust_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(ev.subsessionId, s.name, r.custId, r.name, r.carNumber, r.car, r.carClass || "", r.finish, r.classPos ?? null,
              r.start, r.laps, r.lapsLed, r.incidents, r.bestLapMs, r.bestLapNum, r.avgLapMs, r.intervalMs, r.lapsDown,
              r.classIntervalMs ?? null, r.classLapsDown ?? null, r.reasonOut, r.leaguePoints, r.orig ?? null));
    }
  }
  for (const [id, name] of seen) {
    // the driver's shown name is the one from their most recent race
    st.push(db.prepare(`INSERT INTO drivers (cust_id, name) VALUES (?1, ?2) ON CONFLICT(cust_id) DO UPDATE SET name =
        CASE WHEN ?3 >= COALESCE((SELECT MAX(last_seen) FROM driver_names WHERE cust_id = ?1), '') THEN ?2 ELSE name END`)
      .bind(id, name, when));
    st.push(db.prepare(`INSERT INTO driver_names (cust_id, name, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)
        ON CONFLICT(cust_id, name) DO UPDATE SET first_seen = MIN(first_seen, ?3), last_seen = MAX(last_seen, ?3)`)
      .bind(id, name, when));
  }
  await db.batch(st);
  await nameSeries(db);
  await rcSync(db, ev.subsessionId);           // race control's points penalties made before the results came in
  return { subsessionId: ev.subsessionId, drivers: seen.size, results: race.results.length, fixesCleared: fixes,
           nowOfficial: status === "official" && (!before || before.status !== "official"), wasOfficial: !!before && before.status === "official",
           sessions: ev.sessions.map(s => s.name) };
}

const SERIES_COLS = `sr.id AS series_id, sr.name AS series_name, sr.short_name, sr.slug`;

// winners of each race: one per class (a single-class race has one class, so one winner)
async function winners(db, subs) {
  const out = new Map(subs.map(id => [id, []]));
  for (let i = 0; i < subs.length; i += 90) {
    const part = subs.slice(i, i + 90);
    const rows = (await db.prepare(`SELECT subsession_id, car_class, name, cust_id FROM results WHERE session = 'race'
        AND subsession_id IN (${part.map(() => "?").join(",")}) AND COALESCE(class_pos, finish_pos) = 1 ORDER BY finish_pos`).bind(...part).all()).results;
    for (const r of rows) out.get(r.subsession_id).push({ carClass: r.car_class, name: r.name, custId: r.cust_id });
  }
  return out;
}

async function withWinners(db, events) {
  const w = await winners(db, events.map(e => e.subsession_id));
  for (const e of events) e.winners = w.get(e.subsession_id) || [];
  return events;
}

const EVENT_LIST = `SELECT e.*, se.name AS season_name, ${SERIES_COLS},
    (SELECT COUNT(*) FROM results r WHERE r.subsession_id = e.subsession_id AND r.session = 'race') AS starters
  FROM events e LEFT JOIN seasons se ON se.id = e.season_id LEFT JOIN series sr ON sr.id = e.series_id`;

export async function listEvents(db, { season, series, limit = 500 } = {}) {
  await ensureSchema(db);
  const where = [], args = [];
  if (season) { where.push("e.season_id = ?"); args.push(season); }
  if (series) { where.push("e.series_id = ?"); args.push(series); }
  const st = db.prepare(`${EVENT_LIST} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.start_time DESC LIMIT ${Number(limit) || 500}`);
  return withWinners(db, (await (args.length ? st.bind(...args) : st).all()).results);
}

// every series with its latest race
export async function listSeries(db) {
  await ensureSchema(db);
  const rows = (await db.prepare(`SELECT sr.*, (SELECT COUNT(*) FROM events e WHERE e.series_id = sr.id) AS races,
      (SELECT subsession_id FROM events e WHERE e.series_id = sr.id ORDER BY start_time DESC LIMIT 1) AS latest
    FROM series sr ORDER BY sr.short_name COLLATE NOCASE`).all()).results;
  const latest = rows.map(r => r.latest).filter(Boolean);
  const evs = latest.length ? (await withWinners(db, (await db.prepare(`${EVENT_LIST} WHERE e.subsession_id IN (${latest.map(() => "?").join(",")})`).bind(...latest).all()).results)) : [];
  for (const r of rows) r.latestEvent = evs.find(e => e.subsession_id === r.latest) || null;
  return rows;
}

// one series by its address (or iRacing league id): its seasons, newest first, each with its races
export async function getSeries(db, key) {
  await ensureSchema(db);
  const sr = await db.prepare(`SELECT * FROM series WHERE slug = ? OR CAST(id AS TEXT) = ?`).bind(key, key).first();
  if (!sr) return null;
  const events = await listEvents(db, { series: sr.id });
  const seasons = new Map();
  for (const e of events) {
    const k = e.season_id || 0;
    if (!seasons.has(k)) seasons.set(k, { id: e.season_id, name: e.season_name || "Other races", events: [] });
    seasons.get(k).events.push(e);
  }
  sr.seasons = [...seasons.values()];
  return sr;
}

export async function setSeriesRole(db, id, role) {
  await ensureSchema(db);
  const r = String(role || "").trim();
  if (r && !/^\d{5,25}$/.test(r)) throw new Error("A Discord role ID is a long number. In Discord: Server Settings > Roles > right-click the role > Copy Role ID.");
  await db.prepare(`UPDATE series SET role_id = ? WHERE id = ?`).bind(r, id).run();
}

export async function seriesRoles(db) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT id, role_id FROM series WHERE role_id <> ''`).all()).results;
}

export async function seriesById(db, id) {
  await ensureSchema(db);
  return db.prepare(`SELECT * FROM series WHERE id = ?`).bind(id).first();
}

// a series' seasons, newest first, with how many races each has
// put a race in one of its series' seasons (a session run outside the season, Foundation, Richmond Nov 6 2026).
// A later upload of the same race keeps it there: the file has no season, and an upload never clears one.
export async function setEventSeason(db, sub, seasonId) {
  await ensureSchema(db);
  const ok = await db.prepare(`SELECT se.name FROM seasons se JOIN events e ON e.series_id = se.series_id WHERE e.subsession_id = ? AND se.id = ?`).bind(sub, seasonId).first();
  if (!ok) throw new Error("Pick one of this series' seasons.");
  await db.prepare(`UPDATE events SET season_id = ? WHERE subsession_id = ?`).bind(seasonId, sub).run();
  return ok.name;
}

export async function seasonsOf(db, seriesId) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT se.id, se.name, COUNT(e.subsession_id) AS races, MAX(e.start_time) AS last
      FROM seasons se LEFT JOIN events e ON e.season_id = se.id WHERE se.series_id = ? GROUP BY se.id ORDER BY last DESC`).bind(seriesId).all()).results;
}

// a season's rules: its own, else the latest earlier season's in the same series, else none (null)
export async function getRules(db, seasonId, seriesId) {
  await ensureSchema(db);
  const own = await db.prepare(`SELECT * FROM season_rules WHERE season_id = ?`).bind(seasonId).first();
  if (own) return { rules: JSON.parse(own.rules), own: true, updatedAt: own.updated_at, updatedBy: own.updated_by };
  const prev = await db.prepare(`SELECT sr.*, se.name FROM season_rules sr JOIN seasons se ON se.id = sr.season_id
      WHERE se.series_id = ? AND se.id <> ? ORDER BY (SELECT MAX(start_time) FROM events e WHERE e.season_id = se.id) DESC LIMIT 1`).bind(seriesId, seasonId).first();
  if (prev) return { rules: JSON.parse(prev.rules), own: false, from: prev.name };
  return { rules: null, own: false };
}

export async function saveRules(db, seasonId, rules, by) {
  await ensureSchema(db);
  await db.prepare(`INSERT INTO season_rules (season_id, rules, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(season_id) DO UPDATE SET rules = ?2, updated_at = ?3, updated_by = ?4`).bind(seasonId, JSON.stringify(rules), new Date().toISOString(), by).run();
}

// a season's races with their race results, oldest first
export async function seasonEvents(db, seasonId) {
  await ensureSchema(db);
  const evs = (await db.prepare(`SELECT subsession_id, start_time, track FROM events WHERE season_id = ? ORDER BY start_time`).bind(seasonId).all()).results;
  const rows = (await db.prepare(`SELECT r.* FROM results r JOIN events e ON e.subsession_id = r.subsession_id
      WHERE e.season_id = ? AND r.session = 'race'`).bind(seasonId).all()).results;
  for (const e of evs) e.results = rows.filter(r => r.subsession_id === e.subsession_id);
  return withDecisions(db, evs);
}

// the stewards' position penalties and disqualifications, applied to races read for pages, standings and stats
async function withDecisions(db, evs) {
  const acts = (await db.prepare(`SELECT * FROM decisions WHERE kind IN ('positions', 'time', 'dq') AND status = 'active' ORDER BY id`).all()).results;
  if (!acts.length) return evs;
  for (const e of evs) {
    const mine = acts.filter(d => d.subsession_id === e.subsession_id);
    if (mine.length) e.results = applyDecisions(e.results, mine);
  }
  return evs;
}

export async function listAdjustments(db, seasonId) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT a.*, e.track, e.start_time, (SELECT name FROM results r WHERE r.subsession_id = a.subsession_id
        AND r.cust_id = a.cust_id AND r.session = 'race') AS name
      FROM adjustments a JOIN events e ON e.subsession_id = a.subsession_id WHERE e.season_id = ? ORDER BY e.start_time, a.id`).bind(seasonId).all()).results;
}

export async function addAdjustment(db, seasonId, { sub, cust, points, reason }, by) {
  await ensureSchema(db);
  const ok = await db.prepare(`SELECT 1 AS ok FROM results r JOIN events e ON e.subsession_id = r.subsession_id
      WHERE e.season_id = ? AND r.subsession_id = ? AND r.cust_id = ? AND r.session = 'race'`).bind(seasonId, sub, cust).first();
  if (!ok) throw new Error("That driver isn't in that race's results.");
  const pts = Math.round(Number(points));
  if (!Number.isFinite(pts) || pts === 0) throw new Error("Enter the points to add or take away, like -25.");
  if (!String(reason || "").trim()) throw new Error("Give a reason. Drivers see it on the standings.");
  await db.prepare(`INSERT INTO adjustments (subsession_id, cust_id, points, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(sub, cust, pts, String(reason).trim().slice(0, 200), new Date().toISOString(), by).run();
  return (await db.prepare(`SELECT MAX(id) AS id FROM adjustments WHERE subsession_id = ? AND cust_id = ?`).bind(sub, cust).first()).id;
}

export async function deleteAdjustment(db, seasonId, id) {
  await ensureSchema(db);
  await db.prepare(`DELETE FROM adjustments WHERE id = ? AND subsession_id IN (SELECT subsession_id FROM events WHERE season_id = ?)`).bind(id, seasonId).run();
  await db.prepare(`DELETE FROM decisions WHERE adj_id = ? AND adj_id NOT IN (SELECT id FROM adjustments)`).bind(id).run();
}

// team points on or off for a series (only the Warrior series has them)
export async function setSeriesTeams(db, id, on) {
  await ensureSchema(db);
  await db.prepare(`UPDATE series SET teams = ? WHERE id = ?`).bind(on ? 1 : 0, id).run();
}

export async function updateSeries(db, id, { shortName, slug }) {
  await ensureSchema(db);
  const sr = await db.prepare(`SELECT * FROM series WHERE id = ?`).bind(id).first();
  if (!sr) throw new Error("No such series.");
  const short = String(shortName || "").trim().slice(0, 40);
  if (!short) throw new Error("The short name can't be empty.");
  const want = slugify(slug || short);
  if (!want) throw new Error("The address needs at least one letter or number.");
  if (RESERVED.has(want) || /^\d+$/.test(want)) throw new Error(`"${want}" is used by the site itself. Pick another address.`);
  const hit = await db.prepare(`SELECT short_name FROM series WHERE slug = ? AND id <> ?`).bind(want, id).first();
  if (hit) throw new Error(`${hit.short_name} already uses that address.`);
  await db.prepare(`UPDATE series SET short_name = ?, slug = ? WHERE id = ?`).bind(short, want, id).run();
  return { shortName: short, slug: want };
}

export async function getEvent(db, sub) {
  await ensureSchema(db);
  const ev = await db.prepare(`SELECT e.*, se.name AS season_name, ${SERIES_COLS} FROM events e
      LEFT JOIN seasons se ON se.id = e.season_id LEFT JOIN series sr ON sr.id = e.series_id WHERE e.subsession_id = ?`).bind(sub).first();
  if (!ev) return null;
  const rows = (await db.prepare(`SELECT * FROM results WHERE subsession_id = ? ORDER BY session, finish_pos`).bind(sub).all()).results;
  ev.sessions = {};
  for (const r of rows) (ev.sessions[r.session] = ev.sessions[r.session] || []).push(r);
  ev.decisions = await listDecisions(db, sub);
  if (ev.sessions.race) ev.sessions.race = applyDecisions(ev.sessions.race, ev.decisions.filter(d => d.status === "active")).sort((a, b) => (a.finish_pos || 999) - (b.finish_pos || 999));
  ev.classes = [...new Set((ev.sessions.race || []).map(r => r.car_class))];
  return ev;
}

export async function getDriver(db, cust) {
  await ensureSchema(db);
  const d = await db.prepare(`SELECT * FROM drivers WHERE cust_id = ?`).bind(cust).first();
  if (!d) return null;
  d.names = (await db.prepare(`SELECT name, first_seen, last_seen FROM driver_names WHERE cust_id = ? ORDER BY last_seen DESC`).bind(cust).all()).results;
  d.races = (await db.prepare(`SELECT r.*, e.track, e.start_time, e.season_id, se.name AS season_name, ${SERIES_COLS},
        (SELECT COUNT(*) FROM results x WHERE x.subsession_id = r.subsession_id AND x.session = 'race') AS starters,
        (SELECT COUNT(*) FROM results x WHERE x.subsession_id = r.subsession_id AND x.session = 'race' AND x.car_class = r.car_class) AS class_starters,
        (SELECT COUNT(DISTINCT car_class) FROM results x WHERE x.subsession_id = r.subsession_id AND x.session = 'race') AS class_count
      FROM results r JOIN events e ON e.subsession_id = r.subsession_id LEFT JOIN seasons se ON se.id = e.season_id
      LEFT JOIN series sr ON sr.id = e.series_id
      WHERE r.cust_id = ? AND r.session = 'race' ORDER BY e.start_time DESC`).bind(cust).all()).results;
  // races where the stewards changed the order: this driver's place and points after their decisions
  for (const x of d.races) {
    const acts = (await db.prepare(`SELECT * FROM decisions WHERE subsession_id = ? AND kind IN ('positions', 'time', 'dq') AND status = 'active' ORDER BY id`).bind(x.subsession_id).all()).results;
    if (!acts.length) continue;
    const all = (await db.prepare(`SELECT * FROM results WHERE subsession_id = ? AND session = 'race'`).bind(x.subsession_id).all()).results;
    const me = applyDecisions(all, acts).find(r => r.cust_id === x.cust_id);
    if (me) Object.assign(x, { finish_pos: me.finish_pos, class_pos: me.class_pos, league_points: me.league_points, reason_out: me.reason_out });
  }
  d.profile = await getProfile(db, cust);
  return d;
}

/*
 * Results from a producer's overlay. They go in as provisional, under the series' current season, and never
 * replace results already uploaded from iRacing's export (those are the official ones).
 */
export async function importOverlay(db, ev, by) {
  await ensureSchema(db);
  const sr = await db.prepare(`SELECT * FROM series WHERE id = ?`).bind(ev.league.id).first();
  if (!sr) return { ok: false, status: 404, error: `iRacing league ${ev.league.id} isn't on the site yet. Upload one of its iRacing results files first.` };
  const had = await db.prepare(`SELECT source, season_id, status FROM events WHERE subsession_id = ?`).bind(ev.subsessionId).first();
  if (had && (had.source !== "overlay" || had.status === "official")) return { ok: true, skipped: true, series: sr.short_name, message: "Official results for this race are already on the site." };
  const cur = had && had.season_id ? { season_id: had.season_id }
    : await db.prepare(`SELECT season_id FROM events WHERE series_id = ? AND season_id IS NOT NULL ORDER BY start_time DESC LIMIT 1`).bind(sr.id).first();
  const r = await importEvent(db, { ...ev, league: { id: sr.id, name: sr.name }, season: { id: cur ? cur.season_id : null, name: "" } }, by);
  return { ok: true, ...r, series: sr.short_name, replaced: !!had };
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = async t => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));

export async function listKeys(db) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT id, name, kind, created_at, created_by, last_used, uses, revoked FROM overlay_keys ORDER BY revoked, id DESC`).all()).results;
}

// a new key: shown once, only its hash is kept
export async function createKey(db, name, by, kind = "overlay") {
  await ensureSchema(db);
  const n = String(name || "").trim().slice(0, 60);
  if (!n) throw new Error("Give the key a name, like the producer's name.");
  const key = "vsglr_" + hex(crypto.getRandomValues(new Uint8Array(24)));
  await db.prepare(`INSERT INTO overlay_keys (name, key_hash, created_at, created_by, kind) VALUES (?, ?, ?, ?, ?)`).bind(n, await sha(key), new Date().toISOString(), by, kind === "import" ? "import" : "overlay").run();
  return key;
}

export async function revokeKey(db, id) {
  await ensureSchema(db);
  await db.prepare(`UPDATE overlay_keys SET revoked = 1 WHERE id = ?`).bind(id).run();
}

// count = false: a read (the penalty box's calls), not a race sent: doesn't add to the key's "races sent"
export async function checkKey(db, key, kind = "overlay", count = true) {
  if (!/^vsglr_[0-9a-f]{48}$/.test(String(key || ""))) return null;
  await ensureSchema(db);
  const row = await db.prepare(`SELECT * FROM overlay_keys WHERE key_hash = ? AND revoked = 0 AND kind = ?`).bind(await sha(key), kind).first();
  if (row && count) await db.prepare(`UPDATE overlay_keys SET last_used = ?, uses = uses + 1 WHERE id = ?`).bind(new Date().toISOString(), row.id).run();
  return row;
}

// remove a race: its results, penalties, fixes, protests and decisions. Drivers left with no races go too.
export async function deleteEvent(db, sub) {
  await ensureSchema(db);
  await db.batch([
    db.prepare(`DELETE FROM adjustments WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM result_fixes WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM decisions WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM protests WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM results WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM events WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM driver_names WHERE cust_id NOT IN (SELECT cust_id FROM results)`),
    db.prepare(`DELETE FROM drivers WHERE cust_id NOT IN (SELECT cust_id FROM results)`),
  ]);
}

export async function listFixes(db, sub) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT * FROM result_fixes WHERE subsession_id = ? ORDER BY id`).bind(sub).all()).results
    .map(f => ({ ...f, changes: JSON.parse(f.changes) }));
}

const FIX_FIELDS = { finish_pos: "Finish", reason_out: "Status", laps: "Laps", laps_led: "Laps led", incidents: "Incidents", league_points: "League points" };

/*
 * Correct one driver's race result. A new finishing position moves the others up or down to make room (and
 * recounts positions in each class). Every fix is kept with its reason. Re-uploading the iRacing file replaces the
 * race's results, fixes included.
 */
export async function fixResult(db, sub, cust, want, reason, by) {
  await ensureSchema(db);
  const why = String(reason || "").trim();
  if (!why) throw new Error("Give a reason. It's shown on the race page.");
  const rows = (await db.prepare(`SELECT * FROM results WHERE subsession_id = ? AND session = 'race' ORDER BY finish_pos`).bind(sub).all()).results;
  const me = rows.find(r => r.cust_id === cust);
  if (!me) throw new Error("That driver isn't in this race's results.");
  const changes = {}, set = {};
  const intOrNull = (v, min, max) => { if (v === "" || v == null) return undefined; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new Error("Check the numbers."); return n; };
  const pos = intOrNull(want.finish_pos, 1, rows.length);
  if (pos !== undefined && pos !== me.finish_pos) { changes.finish_pos = [me.finish_pos, pos]; }
  for (const [k, min, max] of [["laps", 0, 10000], ["laps_led", 0, 10000], ["incidents", 0, 1000], ["league_points", -1000, 10000]]) {
    const v = intOrNull(want[k], min, max);
    if (v !== undefined && v !== me[k]) { changes[k] = [me[k], v]; set[k] = v; }
  }
  const st = String(want.reason_out ?? "").trim().slice(0, 40);
  if (st && st !== me.reason_out) { changes.reason_out = [me.reason_out, st]; set.reason_out = st; }
  if (!Object.keys(changes).length) throw new Error("Nothing was changed.");
  const st2 = [];
  if (changes.finish_pos) {
    const order = rows.filter(r => r !== me);
    order.splice(pos - 1, 0, me);
    const inClass = new Map();
    order.forEach((r, i) => {
      const cp = (inClass.get(r.car_class) || 0) + 1; inClass.set(r.car_class, cp);
      if (r.finish_pos !== i + 1 || r.class_pos !== cp)
        st2.push(db.prepare(`UPDATE results SET finish_pos = ?, class_pos = ? WHERE subsession_id = ? AND session = 'race' AND cust_id = ?`).bind(i + 1, cp, sub, r.cust_id));
    });
  }
  const cols = Object.keys(set);
  if (cols.length) st2.push(db.prepare(`UPDATE results SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE subsession_id = ? AND session = 'race' AND cust_id = ?`).bind(...cols.map(c => set[c]), sub, cust));
  st2.push(db.prepare(`INSERT INTO result_fixes (subsession_id, cust_id, name, changes, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(sub, cust, me.name, JSON.stringify(changes), why.slice(0, 200), new Date().toISOString(), by));
  await db.batch(st2);
  return Object.entries(changes).map(([k, [a, b]]) => `${FIX_FIELDS[k]} ${a ?? "–"} → ${b}`).join(", ");
}
export { FIX_FIELDS };

export async function markOfficial(db, sub, by) {
  await ensureSchema(db);
  const ev = await db.prepare(`SELECT status FROM events WHERE subsession_id = ?`).bind(sub).first();
  if (!ev) throw new Error("No such race.");
  if (ev.status === "official") return false;
  await db.prepare(`UPDATE events SET status = 'official', official_at = ?, official_by = ? WHERE subsession_id = ?`).bind(new Date().toISOString(), by, sub).run();
  return true;
}

// a webhook link: only Discord's own; stored like a password, never shown back in full
export const HOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d{5,25})\/([\w-]{20,200})$/;
export const HOOKS = ["results", "standings", "teams", "penalties"];   // teams: only a series with team points
export async function setHook(db, id, kind, url) {
  if (!HOOKS.includes(kind)) throw new Error("Unknown post type.");
  const u = String(url || "").trim();
  if (u && !HOOK_RE.test(u)) throw new Error("That isn't a Discord webhook link. In Discord: channel settings › Integrations › Webhooks › Copy Webhook URL.");
  await ensureSchema(db);
  await db.prepare(`UPDATE series SET hook_${kind} = ? WHERE id = ?`).bind(u, id).run();
}

/* ---------- change history ---------- */

// who did it, from the "discord:<id>:<name>" / "overlay:<id>:<name>" stamps the site keeps
export const whoName = by => { const m = /^(discord|overlay|import|site):[^:]*:(.*)$/.exec(by || ""); return m ? (m[1] === "overlay" ? `Overlay (${m[2]})` : m[1] === "import" ? `Import (${m[2]})` : m[2]) : by || ""; };

export async function logChange(db, { by = "", seriesId = null, sub = null, kind, summary }) {
  try {
    await ensureSchema(db);
    await db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(new Date().toISOString(), String(by || ""), seriesId, sub, kind, String(summary || "").slice(0, 300)).run();
  } catch (e) { console.error("history", e); }      // the history is a record; never let it block the change itself
}

// one time (November 2026, at the league's request): every season drops each driver's 2 worst races. Seasons without
// their own rules take the rules they were carrying over. Later changes are made on each series' Rules page as usual.
export async function setDropWeeksOnce(db) {
  if (await db.prepare(`SELECT 1 AS ok FROM site_settings WHERE key = 'once_drops_2'`).first()) return;
  const seasons = (await db.prepare(`SELECT id, series_id, name FROM seasons`).all()).results;
  const now = new Date().toISOString(), by = "site:0:Site update (league request)", st = [];
  for (const se of seasons) {
    const own = await db.prepare(`SELECT rules FROM season_rules WHERE season_id = ?`).bind(se.id).first();
    const prev = own ? null : await db.prepare(`SELECT sr.rules FROM season_rules sr JOIN seasons x ON x.id = sr.season_id
        WHERE x.series_id = ? AND x.id <> ? ORDER BY (SELECT MAX(start_time) FROM events e WHERE e.season_id = x.id) DESC LIMIT 1`).bind(se.series_id, se.id).first();
    const rules = { ...JSON.parse((own || prev || {}).rules || "{}"), drops: 2 };
    st.push(db.prepare(`INSERT INTO season_rules (season_id, rules, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(season_id) DO UPDATE SET rules = ?2, updated_at = ?3, updated_by = ?4`).bind(se.id, JSON.stringify(rules), now, by));
    st.push(db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary) VALUES (?, ?, ?, NULL, 'rules', ?)`)
      .bind(now, by, se.series_id, `Drop weeks set to 2 for ${se.name}`));
  }
  st.push(db.prepare(`INSERT INTO site_settings (key, value) VALUES ('once_drops_2', ?)`).bind(now));
  await db.batch(st);
}

// the first time: fill the history from what the site already recorded before it had one
async function backfillChanges(db) {
  if ((await db.prepare(`SELECT COUNT(*) AS n FROM changes`).first()).n) return;
  await db.batch([
    db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary)
      SELECT uploaded_at, uploaded_by, series_id, subsession_id, 'upload', 'Results uploaded: ' || COALESCE(track, '') FROM events WHERE uploaded_at IS NOT NULL`),
    db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary)
      SELECT f.created_at, f.created_by, e.series_id, f.subsession_id, 'fix', 'Result fixed: ' || COALESCE(f.name, '') || ' (' || f.reason || ')'
      FROM result_fixes f JOIN events e ON e.subsession_id = f.subsession_id`),
    db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary)
      SELECT a.created_at, a.created_by, e.series_id, a.subsession_id, 'penalty', 'Penalty: ' || COALESCE((SELECT name FROM results r WHERE r.subsession_id = a.subsession_id
        AND r.cust_id = a.cust_id AND r.session = 'race'), a.cust_id) || ' ' || a.points || ' points (' || a.reason || ')'
      FROM adjustments a JOIN events e ON e.subsession_id = a.subsession_id`),
    db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary)
      SELECT r.updated_at, r.updated_by, se.series_id, NULL, 'rules', 'Rules saved for ' || se.name FROM season_rules r JOIN seasons se ON se.id = r.season_id WHERE r.updated_at IS NOT NULL`),
    db.prepare(`INSERT INTO changes (at, by, series_id, subsession_id, kind, summary) VALUES (?, '', NULL, NULL, 'note', 'History starts here; earlier entries were filled in from what the site had recorded')`)
      .bind(new Date().toISOString()),
  ]);
}

export async function listChanges(db, { seriesIds = null, limit = 300 } = {}) {
  await ensureSchema(db);
  const where = seriesIds ? `WHERE c.series_id IN (${seriesIds.map(() => "?").join(",") || "NULL"})` : "";
  const st = db.prepare(`SELECT c.*, sr.short_name, sr.slug, e.track FROM changes c LEFT JOIN series sr ON sr.id = c.series_id
      LEFT JOIN events e ON e.subsession_id = c.subsession_id ${where} ORDER BY c.at DESC, c.id DESC LIMIT ${Number(limit) || 300}`);
  return (await (seriesIds && seriesIds.length ? st.bind(...seriesIds) : st).all()).results;
}

/* ---------- merging drivers ---------- */

// a driver's names and shown name, rebuilt from their results
async function rebuildNames(db, cust) {
  await db.batch([
    db.prepare(`DELETE FROM driver_names WHERE cust_id = ?`).bind(cust),
    db.prepare(`INSERT INTO driver_names (cust_id, name, first_seen, last_seen)
      SELECT r.cust_id, r.name, MIN(e.start_time), MAX(e.start_time) FROM results r JOIN events e ON e.subsession_id = r.subsession_id
      WHERE r.cust_id = ? AND r.name <> '' GROUP BY r.name`).bind(cust),
  ]);
  const top = await db.prepare(`SELECT name FROM driver_names WHERE cust_id = ? ORDER BY last_seen DESC LIMIT 1`).bind(cust).first();
  if (top) await db.prepare(`INSERT INTO drivers (cust_id, name) VALUES (?1, ?2) ON CONFLICT(cust_id) DO UPDATE SET name = ?2`).bind(cust, top.name).run();
  else await db.prepare(`DELETE FROM drivers WHERE cust_id = ?`).bind(cust).run();
}

/*
 * Merge driver `drop` into driver `keep`: every result, penalty and fix moves over, and later uploads under `drop`'s
 * iRacing ID land on `keep`. Each moved result remembers where it came from, so separateDriver() can undo it.
 */
export async function mergeDrivers(db, keep, drop, by) {
  await ensureSchema(db);
  if (!keep || !drop || keep === drop) throw new Error("Pick two different drivers.");
  const [a, b] = await Promise.all([keep, drop].map(c => db.prepare(`SELECT * FROM drivers WHERE cust_id = ?`).bind(c).first()));
  if (!a || !b) throw new Error("No driver with that iRacing ID has raced here.");
  const clash = await db.prepare(`SELECT e.track, e.start_time FROM results x JOIN results y ON y.subsession_id = x.subsession_id AND y.session = x.session
      JOIN events e ON e.subsession_id = x.subsession_id WHERE x.cust_id = ? AND y.cust_id = ? LIMIT 1`).bind(keep, drop).first();
  if (clash) throw new Error(`They can't be the same driver: both raced at ${clash.track} on ${String(clash.start_time).slice(0, 10)}.`);
  await db.batch([
    db.prepare(`UPDATE results SET orig_cust_id = COALESCE(orig_cust_id, ?1), cust_id = ?2 WHERE cust_id = ?1`).bind(drop, keep),
    db.prepare(`UPDATE adjustments SET cust_id = ? WHERE cust_id = ?`).bind(keep, drop),
    db.prepare(`UPDATE result_fixes SET cust_id = ? WHERE cust_id = ?`).bind(keep, drop),
    db.prepare(`UPDATE driver_aliases SET to_cust = ? WHERE to_cust = ?`).bind(keep, drop),
    db.prepare(`INSERT OR REPLACE INTO driver_aliases (from_cust, to_cust, merged_at, merged_by) VALUES (?, ?, ?, ?)`).bind(drop, keep, new Date().toISOString(), by),
    db.prepare(`DELETE FROM driver_names WHERE cust_id = ?`).bind(drop),
    // their info follows them, unless the kept record already has some
    db.prepare(`INSERT OR IGNORE INTO driver_profiles (cust_id, bio, sponsor, team, hometown, updated_at, updated_by) SELECT ?, bio, sponsor, team, hometown, updated_at, updated_by FROM driver_profiles WHERE cust_id = ?`).bind(keep, drop),
    db.prepare(`DELETE FROM driver_profiles WHERE cust_id = ?`).bind(drop),
    db.prepare(`DELETE FROM drivers WHERE cust_id = ?`).bind(drop),
    // a Discord account linked to the merged record follows it, unless someone is already linked to the kept one
    db.prepare(`UPDATE driver_links SET cust_id = ?1 WHERE cust_id = ?2 AND NOT EXISTS (SELECT 1 FROM driver_links WHERE cust_id = ?1)`).bind(keep, drop),
    db.prepare(`DELETE FROM driver_links WHERE cust_id = ?`).bind(drop),
    db.prepare(`UPDATE link_claims SET cust_id = ? WHERE cust_id = ?`).bind(keep, drop),
  ]);
  await rebuildNames(db, keep);
  return { kept: a.name, merged: b.name };
}

// undo a merge: the results that came from `drop` go back to it, with their penalties and fixes
export async function separateDriver(db, keep, drop) {
  await ensureSchema(db);
  const races = (await db.prepare(`SELECT DISTINCT subsession_id FROM results WHERE cust_id = ? AND orig_cust_id = ?`).bind(keep, drop).all()).results.map(r => r.subsession_id);
  const inRaces = races.length ? `AND subsession_id IN (${races.join(",")})` : "AND 0";
  await db.batch([
    db.prepare(`UPDATE results SET cust_id = ?1, orig_cust_id = NULL WHERE cust_id = ?2 AND orig_cust_id = ?1`).bind(drop, keep),
    db.prepare(`UPDATE adjustments SET cust_id = ? WHERE cust_id = ? ${inRaces}`).bind(drop, keep),
    db.prepare(`UPDATE result_fixes SET cust_id = ? WHERE cust_id = ? ${inRaces}`).bind(drop, keep),
    db.prepare(`DELETE FROM driver_aliases WHERE from_cust = ? AND to_cust = ?`).bind(drop, keep),
  ]);
  await rebuildNames(db, keep);
  await rebuildNames(db, drop);
  return races.length;
}

export async function aliasesOf(db, cust) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT a.*, (SELECT name FROM results r WHERE r.orig_cust_id = a.from_cust ORDER BY r.subsession_id DESC LIMIT 1) AS name
      FROM driver_aliases a WHERE a.to_cust = ? ORDER BY merged_at`).bind(cust).all()).results;
}

export async function findDrivers(db) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT cust_id, name FROM drivers ORDER BY name COLLATE NOCASE`).all()).results;
}

/* ---------- driver lists ---------- */

// every race of a series (all seasons, or one), oldest first, with its race results
export async function seriesEvents(db, seriesId, seasonId = null) {
  await ensureSchema(db);
  const where = seasonId ? "e.series_id = ? AND e.season_id = ?" : "e.series_id = ?", args = seasonId ? [seriesId, seasonId] : [seriesId];
  const evs = (await db.prepare(`SELECT e.subsession_id, e.start_time, e.track, e.season_id FROM events e WHERE ${where} ORDER BY e.start_time`).bind(...args).all()).results;
  const rows = (await db.prepare(`SELECT r.* FROM results r JOIN events e ON e.subsession_id = r.subsession_id WHERE ${where} AND r.session = 'race'`).bind(...args).all()).results;
  const bySub = new Map(evs.map(e => [e.subsession_id, Object.assign(e, { results: [] })]));
  for (const r of rows) bySub.get(r.subsession_id)?.results.push(r);
  return withDecisions(db, evs);
}

// every race of every series, grouped by series (for the league driver list)
export async function allSeriesEvents(db) {
  await ensureSchema(db);
  const evs = (await db.prepare(`SELECT subsession_id, start_time, track, series_id FROM events ORDER BY start_time`).all()).results;
  const rows = (await db.prepare(`SELECT r.cust_id, r.name, r.car_number, r.car_class, r.finish_pos, r.class_pos, r.start_pos, r.laps, r.laps_led, r.laps_down,
      r.class_laps_down, r.reason_out, r.best_lap_ms, r.incidents, r.subsession_id FROM results r WHERE r.session = 'race'`).all()).results;
  const bySub = new Map(evs.map(e => [e.subsession_id, Object.assign(e, { results: [] })]));
  for (const r of rows) bySub.get(r.subsession_id)?.results.push(r);
  await withDecisions(db, evs);
  const out = new Map();
  for (const e of evs) { if (!out.has(e.series_id)) out.set(e.series_id, []); out.get(e.series_id).push(e); }
  return out;
}

export async function listRoster(db, seriesId = null) {
  await ensureSchema(db);
  const st = db.prepare(`SELECT * FROM roster ${seriesId ? "WHERE series_id = ?" : ""} ORDER BY name COLLATE NOCASE`);
  return (await (seriesId ? st.bind(seriesId) : st).all()).results;
}

export async function addRoster(db, seriesId, { cust, name, number }, by) {
  await ensureSchema(db);
  const id = Number(String(cust || "").trim());
  if (!Number.isInteger(id) || id < 1 || id > 99999999) throw new Error("Enter the driver's iRacing ID (the number on their iRacing profile).");
  const known = await db.prepare(`SELECT name FROM drivers WHERE cust_id = ?`).bind(id).first();
  const n = String(name || "").trim().slice(0, 80) || (known && known.name) || "";
  if (!n) throw new Error("Enter the driver's name.");
  const num = String(number || "").trim().replace(/^#/, "").slice(0, 4);
  if (num && !/^\d{1,4}$/.test(num)) throw new Error("A car number is up to 4 digits, like 07.");
  await db.prepare(`INSERT INTO roster (series_id, cust_id, name, car_number, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(series_id, cust_id) DO UPDATE SET name = ?3, car_number = ?4`).bind(seriesId, id, n, num, new Date().toISOString(), by).run();
  return { cust: id, name: n, number: num, raced: !!known };
}

export async function removeRoster(db, seriesId, cust) {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT name FROM roster WHERE series_id = ? AND cust_id = ?`).bind(seriesId, cust).first();
  await db.prepare(`DELETE FROM roster WHERE series_id = ? AND cust_id = ?`).bind(seriesId, cust).run();
  return row && row.name;
}

/* ---------- schedule ---------- */

// "2026-11-10" + "8:00 PM" in US Eastern time -> ISO UTC. Times are entered in Eastern; pages show each viewer's own time.
export function easternToUtc(date, time) {
  let y, mo, d;
  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(date || ""), us = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*$/.exec(date || "");
  if (iso) [y, mo, d] = [+iso[1], +iso[2], +iso[3]];
  else if (us) [mo, d, y] = [+us[1], +us[2], +us[3] < 100 ? 2000 + +us[3] : +us[3]];
  else throw new Error(`"${String(date || "").trim()}" isn't a date. Use 2026-11-10 or 11/10/2026.`);
  const t = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*$/i.exec(time || "8:00 PM");
  if (!t) throw new Error(`"${String(time).trim()}" isn't a time. Use 8:00 PM or 20:00.`);
  let h = +t[1]; const mi = +(t[2] || 0), ap = (t[3] || "").toLowerCase()[0];
  if (ap === "p" && h < 12) h += 12; if (ap === "a" && h === 12) h = 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error("Check the date and time.");
  // find the UTC moment whose Eastern wall clock reads y-mo-d h:mi (Eastern is UTC-4 or UTC-5)
  for (const off of [4, 5]) {
    const u = Date.UTC(y, mo - 1, d, h + off, mi);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(u)).map(x => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return new Date(u).toISOString();
  }
  return new Date(Date.UTC(y, mo - 1, d, h + 5, mi)).toISOString();
}

// attach uploaded races to schedule entries of the same series within a day and a half
async function linkSchedule(db, seriesId) {
  const open = (await db.prepare(`SELECT id, starts_at FROM schedule WHERE series_id = ? AND subsession_id IS NULL AND starts_at < ?`)
    .bind(seriesId, new Date(Date.now() + 864e5).toISOString()).all()).results;
  if (!open.length) return;
  const evs = (await db.prepare(`SELECT subsession_id, start_time FROM events WHERE series_id = ? AND subsession_id NOT IN
      (SELECT subsession_id FROM schedule WHERE subsession_id IS NOT NULL)`).bind(seriesId).all()).results;
  for (const s of open) {
    const t = Date.parse(s.starts_at);
    const best = evs.map(e => ({ e, d: Math.abs(Date.parse(e.start_time) - t) })).filter(x => x.d < 36 * 3600e3).sort((a, b) => a.d - b.d)[0];
    if (best) { await db.prepare(`UPDATE schedule SET subsession_id = ? WHERE id = ?`).bind(best.e.subsession_id, s.id).run(); evs.splice(evs.indexOf(best.e), 1); }
  }
}

export async function listSchedule(db, seriesId) {
  await ensureSchema(db);
  await linkSchedule(db, seriesId);
  return (await db.prepare(`SELECT s.*, e.season_id, se.name AS season_name, e.track AS result_track, e.status, e.laps AS result_laps FROM schedule s
      LEFT JOIN events e ON e.subsession_id = s.subsession_id LEFT JOIN seasons se ON se.id = e.season_id
      WHERE s.series_id = ? ORDER BY s.starts_at`).bind(seriesId).all()).results.map(splitLayout);
}

// upcoming races in every series (the league calendar), and each series' next race
export async function upcoming(db, days = 60) {
  await ensureSchema(db);
  const now = new Date(Date.now() - 4 * 3600e3).toISOString(), until = new Date(Date.now() + days * 864e5).toISOString();
  return (await db.prepare(`SELECT s.*, sr.short_name, sr.slug FROM schedule s JOIN series sr ON sr.id = s.series_id
      WHERE s.subsession_id IS NULL AND s.starts_at >= ? AND s.starts_at <= ? ORDER BY s.starts_at`).bind(now, until).all()).results.map(splitLayout);
}

// "Daytona - Road Course" written as one track name: the part after " - " is the layout
function splitLayout(r) {
  if (!r.layout && / - /.test(r.track || "")) { const i = r.track.indexOf(" - "); return { ...r, track: r.track.slice(0, i), layout: r.track.slice(i + 3) }; }
  return r;
}
const LENGTH_RE = /^\s*\d+(?:\.\d+)?\s*(?:laps?|mins?|minutes?|hrs?|hours?)\b(?:\s*(?:or|\/|\+)\s*\d+(?:\.\d+)?\s*(?:laps?|mins?|minutes?|hrs?|hours?))?\s*$/i;

function scheduleFields({ track, layout, length, notes }) {
  let tr = String(track || "").trim().slice(0, 100), lay = String(layout || "").trim().slice(0, 60);
  if (!tr) throw new Error("Enter the track.");
  if (!lay && / - /.test(tr)) { const i = tr.indexOf(" - "); lay = tr.slice(i + 3); tr = tr.slice(0, i); }
  return { tr, lay, len: String(length || "").trim().slice(0, 40), notes: String(notes || "").trim().slice(0, 120) };
}

export async function addSchedule(db, seriesId, { date, time, track, layout, length, notes }, by) {
  await ensureSchema(db);
  const f = scheduleFields({ track, layout, length, notes });
  const at = easternToUtc(date, time);
  await db.prepare(`INSERT INTO schedule (series_id, starts_at, track, layout, length, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(seriesId, at, f.tr, f.lay, f.len, f.notes, new Date().toISOString(), by).run();
  return { at, track: f.tr };
}

export async function editSchedule(db, seriesId, id, { date, time, track, layout, length, notes }) {
  await ensureSchema(db);
  const f = scheduleFields({ track, layout, length, notes });
  const at = easternToUtc(date, time);
  const r = await db.prepare(`UPDATE schedule SET starts_at = ?, track = ?, layout = ?, length = ?, notes = ? WHERE id = ? AND series_id = ?`)
    .bind(at, f.tr, f.lay, f.len, f.notes, id, seriesId).run();
  return { at, track: f.tr };
}

// a pasted season: one race per line, "date, time, track, notes" (time and notes optional)
export async function addScheduleLines(db, seriesId, text, by) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Paste at least one line.");
  if (lines.length > 60) throw new Error("That's more than 60 races. Paste a season at a time.");
  const rows = lines.map((l, i) => {
    const parts = l.split(/\s*[,\t]\s*/);
    let [date, time, ...rest] = parts;
    if (time && !/\d/.test(time)) { rest = [time, ...rest]; time = ""; }        // no time given: the second part is the track
    if (!rest.length) throw new Error(`Line ${i + 1}: needs at least a date and a track ("${l}").`);
    const len = rest.slice(1).filter(x => LENGTH_RE.test(x)), other = rest.slice(1).filter(x => !LENGTH_RE.test(x));
    try { return { date, time: time || "8:00 PM", track: rest[0], length: len.join(" or "), notes: other.join(", ") }; }
    catch (e) { throw new Error(`Line ${i + 1}: ${e.message}`); }
  });
  rows.forEach((r, i) => { try { easternToUtc(r.date, r.time); } catch (e) { throw new Error(`Line ${i + 1}: ${e.message}`); } });
  for (const r of rows) await addSchedule(db, seriesId, r, by);
  return rows.length;
}

export async function deleteSchedule(db, seriesId, id) {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT track, starts_at FROM schedule WHERE id = ? AND series_id = ?`).bind(id, seriesId).first();
  await db.prepare(`DELETE FROM schedule WHERE id = ? AND series_id = ?`).bind(id, seriesId).run();
  return row;
}

// attach a race's results to a schedule line by hand (e.g. a race run on a different night than planned)
export async function scheduleEntry(db, id) {
  await ensureSchema(db);
  return db.prepare(`SELECT * FROM schedule WHERE id = ?`).bind(id).first();
}
export async function linkScheduleTo(db, id, sub) {
  await ensureSchema(db);
  const other = await db.prepare(`SELECT id, track FROM schedule WHERE subsession_id = ? AND id <> ?`).bind(sub, id).first();
  if (other) return { ok: false, error: `Those results are already on the schedule (${other.track}).` };
  await db.prepare(`UPDATE schedule SET subsession_id = ? WHERE id = ?`).bind(sub, id).run();
  return { ok: true };
}

export async function getSetting(db, key) {
  await ensureSchema(db);
  const r = await db.prepare(`SELECT value FROM site_settings WHERE key = ?`).bind(key).first();
  return r ? r.value : "";
}
export async function setSetting(db, key, value) {
  await ensureSchema(db);
  await db.prepare(`INSERT INTO site_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(key, String(value)).run();
}

/* ---------- stewarding: protests and decisions ---------- */

// which iRacing driver a signed-in Discord member is. They're asked once, right after their first sign-in.
// cust_id 0 means they answered "I don't race".
export async function linkedDriver(db, discordId) {
  await ensureSchema(db);
  return db.prepare(`SELECT l.*, d.name FROM driver_links l LEFT JOIN drivers d ON d.cust_id = l.cust_id WHERE l.discord_id = ?`).bind(discordId).first();
}

// a Discord account signed in (the Accounts page lists everyone who has)
export async function noteAccount(db, discordId, name) {
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO accounts (discord_id, name, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)
      ON CONFLICT(discord_id) DO UPDATE SET name = ?2, last_seen = ?3`).bind(discordId, name || "", now).run();
}

/**
 * Someone says which driver they are (cust 0: "I don't race"). A driver who is already linked to another account
 * isn't moved: it becomes a claim for an admin to decide. Returns { linked } or { claim, holder }.
 */
export async function linkDriver(db, discordId, discordName, cust) {
  await ensureSchema(db);
  cust = Number(cust) || 0;
  if (cust && !await db.prepare(`SELECT 1 AS ok FROM drivers WHERE cust_id = ?`).bind(cust).first()) throw new Error("Pick yourself from the list.");
  const taken = cust ? await db.prepare(`SELECT discord_name FROM driver_links WHERE cust_id = ? AND discord_id <> ?`).bind(cust, discordId).first() : null;
  const now = new Date().toISOString();
  if (taken) {
    if (!await db.prepare(`SELECT 1 AS ok FROM link_claims WHERE discord_id = ? AND cust_id = ? AND status = 'open'`).bind(discordId, cust).first())
      await db.prepare(`INSERT INTO link_claims (discord_id, discord_name, cust_id, created_at) VALUES (?, ?, ?, ?)`).bind(discordId, discordName, cust, now).run();
    return { claim: true, holder: taken.discord_name || "" };
  }
  await db.batch([
    db.prepare(`INSERT INTO driver_links (discord_id, cust_id, discord_name, linked_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(discord_id) DO UPDATE SET cust_id = ?2, discord_name = ?3, linked_at = ?4`).bind(discordId, cust, discordName, now),
    // they settled on an answer: any claim they were waiting on is dropped
    db.prepare(`UPDATE link_claims SET status = 'dropped', decided_at = ? WHERE discord_id = ? AND status = 'open'`).bind(now, discordId),
  ]);
  return { linked: true };
}

// an admin sets an account's driver (cust 0: "doesn't race"). Whoever had that driver before is unlinked and asked
// again at their next sign-in. Returns that account's name, or "".
export async function setLink(db, discordId, cust) {
  await ensureSchema(db);
  cust = Number(cust) || 0;
  if (cust && !await db.prepare(`SELECT 1 AS ok FROM drivers WHERE cust_id = ?`).bind(cust).first()) throw new Error("No driver with that iRacing ID.");
  const prev = cust ? await db.prepare(`SELECT discord_id, discord_name FROM driver_links WHERE cust_id = ? AND discord_id <> ?`).bind(cust, discordId).first() : null;
  const acc = await db.prepare(`SELECT name FROM accounts WHERE discord_id = ?`).bind(discordId).first();
  const name = acc ? acc.name : (await db.prepare(`SELECT discord_name FROM driver_links WHERE discord_id = ?`).bind(discordId).first() || {}).discord_name || "";
  const now = new Date().toISOString();
  await db.batch([
    ...(prev ? [db.prepare(`DELETE FROM driver_links WHERE discord_id = ?`).bind(prev.discord_id)] : []),
    db.prepare(`INSERT INTO driver_links (discord_id, cust_id, discord_name, linked_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(discord_id) DO UPDATE SET cust_id = ?2, discord_name = ?3, linked_at = ?4`).bind(discordId, cust, name, now),
  ]);
  return prev ? prev.discord_name || prev.discord_id : "";
}
export async function unlinkDriver(db, discordId) {
  await ensureSchema(db);
  await db.prepare(`DELETE FROM driver_links WHERE discord_id = ?`).bind(discordId).run();
}

// the Discord account linked to a driver (driver pages, for officials)
export async function linkedAccount(db, cust) {
  await ensureSchema(db);
  return db.prepare(`SELECT l.discord_id, COALESCE(a.name, l.discord_name) AS name FROM driver_links l LEFT JOIN accounts a ON a.discord_id = l.discord_id
      WHERE l.cust_id = ? AND l.cust_id <> 0`).bind(cust).first();
}

// the Accounts page: every Discord account that has signed in, with its driver
export async function listAccounts(db) {
  await ensureSchema(db);
  // accounts from before this list existed: linked ones, and anyone signed in now
  await db.prepare(`INSERT OR IGNORE INTO accounts (discord_id, name, first_seen, last_seen) SELECT discord_id, discord_name, linked_at, linked_at FROM driver_links`).run();
  try {
    await db.prepare(`INSERT OR IGNORE INTO accounts (discord_id, name, first_seen, last_seen)
        SELECT discord_id, name, datetime(MIN(created) / 1000, 'unixepoch'), datetime(MAX(created) / 1000, 'unixepoch') FROM sessions WHERE kind = 'web' GROUP BY discord_id`).run();
  } catch { /* no sessions table yet */ }
  return (await db.prepare(`SELECT a.*, l.cust_id, l.linked_at, d.name AS driver FROM accounts a LEFT JOIN driver_links l ON l.discord_id = a.discord_id
      LEFT JOIN drivers d ON d.cust_id = l.cust_id ORDER BY a.name COLLATE NOCASE`).all()).results;
}

// a season's teams, in the order they were entered: [{ id, name, members: [{ cust_id, name }] }]
export async function getTeams(db, seriesId, seasonId) {
  await ensureSchema(db);
  const teams = (await db.prepare(`SELECT id, name FROM teams WHERE series_id = ? AND season_id = ? ORDER BY sort, id`).bind(seriesId, seasonId).all()).results;
  const rows = (await db.prepare(`SELECT m.team_id, m.cust_id, COALESCE(d.name, CAST(m.cust_id AS TEXT)) AS name FROM team_members m JOIN teams t ON t.id = m.team_id
      LEFT JOIN drivers d ON d.cust_id = m.cust_id WHERE t.series_id = ? AND t.season_id = ? ORDER BY d.name COLLATE NOCASE`).bind(seriesId, seasonId).all()).results;
  for (const t of teams) t.members = rows.filter(r => r.team_id === t.id).map(({ cust_id, name }) => ({ cust_id, name }));
  return teams;
}
// replace a season's teams: [{ name, custs: [cust ids] }] ([] removes them all)
export async function saveTeams(db, seriesId, seasonId, teams) {
  await ensureSchema(db);
  const old = (await db.prepare(`SELECT id FROM teams WHERE series_id = ? AND season_id = ?`).bind(seriesId, seasonId).all()).results.map(r => r.id);
  const st = old.map(id => db.prepare(`DELETE FROM team_members WHERE team_id = ?`).bind(id));
  st.push(db.prepare(`DELETE FROM teams WHERE series_id = ? AND season_id = ?`).bind(seriesId, seasonId));
  await db.batch(st);
  for (const [i, t] of teams.entries()) {
    const { id } = await db.prepare(`INSERT INTO teams (series_id, season_id, name, sort) VALUES (?, ?, ?, ?) RETURNING id`).bind(seriesId, seasonId, t.name, i).first();
    if (t.custs.length) await db.batch(t.custs.map(c => db.prepare(`INSERT OR IGNORE INTO team_members (team_id, cust_id) VALUES (?, ?)`).bind(id, c)));
  }
}
// every driver with the names they've raced under, for matching pasted team lists. here: has raced in this series
export async function driversForMatching(db, seriesId) {
  await ensureSchema(db);
  const ds = (await db.prepare(`SELECT d.cust_id, d.name, EXISTS (SELECT 1 FROM results r JOIN events e ON e.subsession_id = r.subsession_id
      WHERE r.cust_id = d.cust_id AND e.series_id = ?) AS here FROM drivers d`).bind(seriesId).all()).results;
  const names = (await db.prepare(`SELECT cust_id, name FROM driver_names`).all()).results;
  const by = new Map(ds.map(d => [d.cust_id, { ...d, here: !!d.here, aliases: [] }]));
  for (const n of names) if (by.has(n.cust_id)) by.get(n.cust_id).aliases.push(n.name);
  return [...by.values()];
}

// a driver's own info (bio, sponsor, team, hometown), or null if they haven't written any
export const PROFILE_FIELDS = { team: 80, sponsor: 120, hometown: 80, bio: 1000 };   // longest each may be
export async function getProfile(db, cust) {
  await ensureSchema(db);
  const p = await db.prepare(`SELECT bio, sponsor, team, hometown, updated_at FROM driver_profiles WHERE cust_id = ?`).bind(cust).first();
  return p && Object.keys(PROFILE_FIELDS).some(k => p[k]) ? p : null;
}
// save it (empty fields clear them). Returns the fields that changed.
export async function saveProfile(db, cust, fields, by) {
  await ensureSchema(db);
  const old = await db.prepare(`SELECT * FROM driver_profiles WHERE cust_id = ?`).bind(cust).first() || {};
  const v = {};
  for (const [k, max] of Object.entries(PROFILE_FIELDS)) {
    let x = String(fields[k] ?? "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (k !== "bio") x = x.replace(/\s+/g, " ");
    v[k] = x.slice(0, max);
  }
  const changed = Object.keys(PROFILE_FIELDS).filter(k => (old[k] || "") !== v[k]);
  if (changed.length) await db.prepare(`INSERT INTO driver_profiles (cust_id, bio, sponsor, team, hometown, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(cust_id) DO UPDATE SET bio = ?2, sponsor = ?3, team = ?4, hometown = ?5, updated_at = ?6, updated_by = ?7`)
    .bind(cust, v.bio, v.sponsor, v.team, v.hometown, new Date().toISOString(), by).run();
  return changed;
}

// overlay blocks: { blocked_at, blocked_by } or null; all of them for the Accounts page
// the Help chat's question log: what officials asked, for admins to see where the learning curve is
export async function logHelp(db, { id, name, question, answer }) {
  await db.prepare(`INSERT INTO help_log (at, discord_id, name, question, answer) VALUES (?, ?, ?, ?, ?)`)
    .bind(new Date().toISOString(), id, name || "", question, answer || "").run();
}
// how many questions this person asked today (UTC)
export async function helpToday(db, id, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return (await db.prepare(`SELECT COUNT(*) AS n FROM help_log WHERE discord_id = ? AND at >= ?`).bind(id, day).first()).n;
}
export async function listHelp(db, limit = 200) {
  return (await db.prepare(`SELECT * FROM help_log ORDER BY id DESC LIMIT ?`).bind(limit).all()).results;
}

export async function getBlock(db, discordId) {
  await ensureSchema(db);
  return db.prepare(`SELECT blocked_at, blocked_by FROM overlay_blocks WHERE discord_id = ?`).bind(discordId).first();
}
export async function listBlocks(db) {
  await ensureSchema(db);
  return new Map((await db.prepare(`SELECT * FROM overlay_blocks`).all()).results.map(b => [b.discord_id, b]));
}
export async function setBlock(db, discordId, on, by) {
  await ensureSchema(db);
  if (on) await db.prepare(`INSERT OR IGNORE INTO overlay_blocks (discord_id, blocked_at, blocked_by) VALUES (?, ?, ?)`).bind(discordId, new Date().toISOString(), by).run();
  else await db.prepare(`DELETE FROM overlay_blocks WHERE discord_id = ?`).bind(discordId).run();
}

/**
 * Races on a series' schedule with no results on the site by noon Eastern the day after (the Director tab flags them).
 * Only the last 14 days, so an old cancelled race doesn't stay flagged forever. A race with results uploaded within a
 * day and a half of its time counts as having them even if the schedule didn't link it.
 */
export async function missedResults(db, seriesId, now = Date.now()) {
  await ensureSchema(db);
  const rows = (await db.prepare(`SELECT id, starts_at, track FROM schedule WHERE series_id = ? AND subsession_id IS NULL AND starts_at < ? AND starts_at > ? ORDER BY starts_at`)
    .bind(seriesId, new Date(now).toISOString(), new Date(now - 15 * 864e5).toISOString()).all()).results;
  if (!rows.length) return [];
  const evs = (await db.prepare(`SELECT start_time FROM events WHERE series_id = ?`).bind(seriesId).all()).results.map(e => Date.parse(e.start_time));
  return rows.filter(r => {
    const t = Date.parse(r.starts_at);
    if (evs.some(e => Math.abs(e - t) < 36 * 3600e3)) return false;
    return now >= nextNoonEastern(t) && now - t < 14 * 864e5;
  });
}
// noon in New York on the day after the moment t (Eastern time, daylight saving included)
export function nextNoonEastern(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day + 1, 12);            // noon "UTC" on the next day ...
  const off = n => { const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(n)).find(x => x.type === "timeZoneName").value;
    const m = /GMT([+-]\d+)(?::(\d+))?/.exec(s); return m ? (+m[1]) * 60 + Math.sign(+m[1]) * (+(m[2] || 0)) : 0; };
  return guess - off(guess + 5 * 3600e3) * 60e3;                            // ... moved to noon in New York
}

// the series an admin has assigned to this Discord account
export async function directorOf(db, discordId) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT series_id FROM series_directors WHERE discord_id = ?`).bind(discordId).all()).results.map(r => r.series_id);
}
// every assignment: { discord_id, series_id, name, short_name }
export async function listDirectors(db) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT sd.*, a.name, sr.short_name FROM series_directors sd LEFT JOIN accounts a ON a.discord_id = sd.discord_id
      JOIN series sr ON sr.id = sd.series_id ORDER BY sr.short_name, a.name COLLATE NOCASE`).all()).results;
}
export async function setDirector(db, discordId, seriesId, on, by) {
  await ensureSchema(db);
  if (on) await db.prepare(`INSERT OR IGNORE INTO series_directors (discord_id, series_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)`)
    .bind(discordId, seriesId, new Date().toISOString(), by).run();
  else await db.prepare(`DELETE FROM series_directors WHERE discord_id = ? AND series_id = ?`).bind(discordId, seriesId).run();
}
// each account's Discord roles, as of their last sign-in check (the Accounts page shows who has the role)
export async function accountRoles(db) {
  try {
    const rows = (await db.prepare(`SELECT discord_id, roles FROM sessions WHERE kind = 'web' ORDER BY checked`).all()).results;
    return new Map(rows.map(r => [r.discord_id, JSON.parse(r.roles || "[]")]));
  } catch { return new Map(); }
}

// claims on a driver someone else is linked to: the open ones, or the one with this id
export async function listClaims(db, { open = true, discordId = null } = {}) {
  await ensureSchema(db);
  const w = [], a = [];
  if (open) w.push("c.status = 'open'");
  if (discordId) { w.push("c.discord_id = ?"); a.push(discordId); }
  return (await db.prepare(`SELECT c.*, d.name AS driver, l.discord_id AS holder_id, COALESCE(ha.name, l.discord_name) AS holder
      FROM link_claims c LEFT JOIN drivers d ON d.cust_id = c.cust_id LEFT JOIN driver_links l ON l.cust_id = c.cust_id
      LEFT JOIN accounts ha ON ha.discord_id = l.discord_id ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY c.id`).bind(...a).all()).results;
}
// an admin decides a claim. Approving moves the driver to the claimant. Returns the claim, or null.
export async function decideClaim(db, id, approve, by) {
  await ensureSchema(db);
  const c = (await db.prepare(`SELECT c.*, d.name AS driver FROM link_claims c LEFT JOIN drivers d ON d.cust_id = c.cust_id WHERE c.id = ? AND c.status = 'open'`).bind(id).first());
  if (!c) return null;
  if (approve) c.moved_from = await setLink(db, c.discord_id, c.cust_id);
  await db.prepare(`UPDATE link_claims SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`).bind(approve ? "approved" : "rejected", by, new Date().toISOString(), id).run();
  return c;
}

// find drivers by name, any name they've raced under. Each: { cust_id, name, also, taken }
export async function searchDrivers(db, q, limit = 25) {
  await ensureSchema(db);
  const words = normName(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  const rows = (await db.prepare(`SELECT d.cust_id, d.name, n.name AS alias, (SELECT discord_id FROM driver_links l WHERE l.cust_id = d.cust_id) AS holder
      FROM drivers d LEFT JOIN driver_names n ON n.cust_id = d.cust_id`).all()).results;
  const found = new Map();
  for (const r of rows) {
    for (const nm of [r.name, r.alias]) {
      if (!nm) continue;
      const n = normName(nm), nw = n.split(" ");
      if (!words.every(w => nw.some(x => x.startsWith(w)))) continue;     // each word starts a word of the name
      const score = n === words.join(" ") ? 0 : n.startsWith(words[0]) ? 1 : 2;
      const was = found.get(r.cust_id);
      if (!was || score < was.score) found.set(r.cust_id, { cust_id: r.cust_id, name: r.name, also: nm !== r.name ? nm : "", taken: !!r.holder, score });
    }
  }
  return [...found.values()].sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, limit);
}
// a name for matching: lower case, letters and digits only. A Discord nickname also loses a car number or tag
// ("Racer A #12", "Racer A [GLR]", "racer_a 12"), which drivers often add to it.
export const normName = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[\[(][^\])]*[\])]/g, " ").replace(/#\s*\d+/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/(^| )\d+( |$)/g, " ").trim().replace(/\s+/g, " ");

// "My races": what the stewards decided about this driver, newest first
export async function decisionsFor(db, cust, limit = 50) {
  await ensureSchema(db);
  const rows = (await db.prepare(`SELECT d.*, e.track, e.start_time, sr.short_name AS series FROM decisions d JOIN events e ON e.subsession_id = d.subsession_id
      LEFT JOIN series sr ON sr.id = d.series_id WHERE d.cust_id = ? ORDER BY e.start_time DESC, d.id DESC LIMIT ?`).bind(cust, limit).all()).results;
  for (const d of rows) d.info = JSON.parse(d.info || "{}");
  return rows;
}

const PROTEST_COLS = `p.*, e.track, e.start_time, sr.short_name AS series, sr.slug,
  (SELECT name FROM results r WHERE r.subsession_id = p.subsession_id AND r.session = 'race' AND r.cust_id = p.filer_cust) AS filer_name,
  (SELECT car_number FROM results r WHERE r.subsession_id = p.subsession_id AND r.session = 'race' AND r.cust_id = p.filer_cust) AS filer_number,
  (SELECT name FROM results r WHERE r.subsession_id = p.subsession_id AND r.session = 'race' AND r.cust_id = p.against_cust) AS against_name,
  (SELECT car_number FROM results r WHERE r.subsession_id = p.subsession_id AND r.session = 'race' AND r.cust_id = p.against_cust) AS against_number`;

export async function fileProtest(db, { sub, filedBy, filer, against, lap, what, video }) {
  await ensureSchema(db);
  const ev = await db.prepare(`SELECT series_id FROM events WHERE subsession_id = ?`).bind(sub).first();
  if (!ev) throw new Error("No race with that session number.");
  const inRace = async c => !!await db.prepare(`SELECT 1 AS ok FROM results WHERE subsession_id = ? AND session = 'race' AND cust_id = ?`).bind(sub, c).first();
  if (!await inRace(filer)) throw new Error("Only drivers in this race can protest it.");
  const vs = Number(against) || null;
  if (vs && (vs === filer || !await inRace(vs))) throw new Error("Pick the driver you're protesting from this race's drivers.");
  const text = String(what || "").trim();
  if (text.length < 10) throw new Error("Say what happened (where, and what the other driver did).");
  const link = String(video || "").trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw new Error("The video link should start with https://");
  await db.prepare(`INSERT INTO protests (subsession_id, series_id, filed_by, filer_cust, against_cust, lap, what, video, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(sub, ev.series_id, filedBy, filer, vs, String(lap || "").trim().slice(0, 40), text.slice(0, 2000), link.slice(0, 500), new Date().toISOString()).run();
  return (await db.prepare(`SELECT MAX(id) AS id FROM protests WHERE subsession_id = ?`).bind(sub).first()).id;
}

// protests: for one race, for some series (null = all), or filed by one driver; open first, newest first
export async function listProtests(db, { sub = null, seriesIds = null, filer = null, involving = null, open = false, limit = 200 } = {}) {
  await ensureSchema(db);
  const w = [], a = [];
  if (sub) { w.push("p.subsession_id = ?"); a.push(sub); }
  if (seriesIds) { if (!seriesIds.length) return []; w.push(`p.series_id IN (${seriesIds.map(() => "?").join(",")})`); a.push(...seriesIds); }
  if (filer) { w.push("p.filer_cust = ?"); a.push(filer); }
  if (involving) { w.push("(p.filer_cust = ? OR p.against_cust = ?)"); a.push(involving, involving); }
  if (open) w.push("p.status = 'open'");
  return (await db.prepare(`SELECT ${PROTEST_COLS} FROM protests p JOIN events e ON e.subsession_id = p.subsession_id
      LEFT JOIN series sr ON sr.id = p.series_id ${w.length ? "WHERE " + w.join(" AND ") : ""}
      ORDER BY p.status = 'open' DESC, p.id DESC LIMIT ?`).bind(...a, limit).all()).results;
}
export async function getProtest(db, id) {
  await ensureSchema(db);
  return db.prepare(`SELECT ${PROTEST_COLS} FROM protests p JOIN events e ON e.subsession_id = p.subsession_id
      LEFT JOIN series sr ON sr.id = p.series_id WHERE p.id = ?`).bind(id).first();
}
// status: open | decided | withdrawn
export async function setProtestStatus(db, id, status, by) {
  await ensureSchema(db);
  await db.prepare(`UPDATE protests SET status = ?, closed_at = CASE WHEN ? = 'open' THEN NULL ELSE ? END, closed_by = CASE WHEN ? = 'open' THEN NULL ELSE ? END WHERE id = ?`)
    .bind(status, status, new Date().toISOString(), status, by, id).run();
}

export async function listDecisions(db, sub) {
  await ensureSchema(db);
  const rows = (await db.prepare(`SELECT d.*, (SELECT name FROM results r WHERE r.subsession_id = d.subsession_id AND r.session = 'race' AND r.cust_id = d.cust_id) AS name,
      (SELECT car_number FROM results r WHERE r.subsession_id = d.subsession_id AND r.session = 'race' AND r.cust_id = d.cust_id) AS car_number
      FROM decisions d WHERE d.subsession_id = ? ORDER BY d.id`).bind(sub).all()).results;
  for (const d of rows) {                       // race control's calls can come before the results: use the name it sent
    d.info = JSON.parse(d.info || "{}");
    if (!d.name) d.name = d.info.driverName || String(d.cust_id);
    if (!d.car_number) d.car_number = d.info.carNumber || "";
  }
  return rows;
}

/**
 * A steward's decision on a race (from a protest, or on their own). A points penalty goes on the series' penalties
 * list too, so the standings take it off. Deciding a protest closes it.
 */
export async function addDecision(db, { sub, protestId = null, cust, kind, amount = 0, reason = "", source = "site" }, by) {
  await ensureSchema(db);
  const ev = await db.prepare(`SELECT series_id, season_id FROM events WHERE subsession_id = ?`).bind(sub).first();
  if (!ev) throw new Error("No race with that session number.");
  if (!KINDS[kind]) throw new Error("Pick a decision.");
  if (!await db.prepare(`SELECT 1 AS ok FROM results WHERE subsession_id = ? AND session = 'race' AND cust_id = ?`).bind(sub, cust).first())
    throw new Error("That driver isn't in this race's results.");
  const why = String(reason || "").trim().slice(0, 300);
  if (!why) throw new Error("Give the reason. Drivers see it on the stewards' report.");
  let n = Math.round(Number(amount) || 0), adj = null;
  if (kind === "positions" && n < 1) throw new Error("Enter how many places to move the driver back.");
  if (kind === "time" && n < 1) throw new Error("Enter how many seconds to add.");
  if (kind === "points") {
    if (!n) throw new Error("Enter the points, like 10 to take 10 off.");
    n = -Math.abs(n);                       // a points penalty always takes points off
    if (!ev.season_id) throw new Error("This race isn't in a season, so there are no standings to take points from.");
    adj = await addAdjustment(db, ev.season_id, { sub, cust, points: n, reason: `Stewards: ${why}` }, by);
  }
  if (!AMOUNT[kind]) n = 0;
  n = kind === "points" ? n : Math.abs(n);
  if (protestId && !await db.prepare(`SELECT 1 AS ok FROM protests WHERE id = ? AND subsession_id = ?`).bind(protestId, sub).first()) throw new Error("That protest isn't for this race.");
  await db.prepare(`INSERT INTO decisions (subsession_id, series_id, protest_id, cust_id, kind, amount, reason, adj_id, source, made_at, made_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(sub, ev.series_id, protestId, cust, kind, n, why, adj, source, new Date().toISOString(), by).run();
  if (protestId) await setProtestStatus(db, protestId, "decided", by);
  return { id: (await db.prepare(`SELECT MAX(id) AS id FROM decisions WHERE subsession_id = ?`).bind(sub).first()).id, text: decisionText({ kind, amount: n }) };
}

// change a decision after further review (Nov 2026): its penalty, amount and reason. Works for race control's calls
// too; once changed on the site, race control sending the race again doesn't change it back. The report shows what it
// was (edited_from), and the points penalty for a points decision is made again to match.
export async function editDecision(db, sub, id, { kind, amount = 0, reason = "" }, by) {
  await ensureSchema(db);
  const d = await db.prepare(`SELECT * FROM decisions WHERE id = ? AND subsession_id = ?`).bind(id, sub).first();
  if (!d) throw new Error("That decision isn't on this race any more.");
  if (d.status === "withdrawn") throw new Error("That call was withdrawn. Make a new decision instead.");
  const ev = await db.prepare(`SELECT season_id FROM events WHERE subsession_id = ?`).bind(sub).first();
  if (!KINDS[kind]) throw new Error("Pick a decision.");
  const why = String(reason || "").trim().slice(0, 300);
  if (!why) throw new Error("Give the reason. Drivers see it on the stewards' report.");
  let n = Math.round(Number(amount) || 0);
  if (kind === "positions" && n < 1) throw new Error("Enter how many places to move the driver back.");
  if (kind === "time" && n < 1) throw new Error("Enter how many seconds to add.");
  if (kind === "points") {
    if (!n) throw new Error("Enter the points, like 10 to take 10 off.");
    if (!ev || !ev.season_id) throw new Error("This race isn't in a season, so there are no standings to take points from.");
    n = -Math.abs(n);
  } else n = AMOUNT[kind] ? Math.abs(n) : 0;
  if (kind === d.kind && n === d.amount && why === d.reason) throw new Error("Nothing changed.");
  if (d.adj_id) {
    await db.prepare(`DELETE FROM adjustments WHERE id = ?`).bind(d.adj_id).run();
    await db.prepare(`UPDATE decisions SET adj_id = NULL WHERE id = ?`).bind(id).run();
  }
  let adj = null;
  if (kind === "points") adj = await addAdjustment(db, ev.season_id, { sub, cust: d.cust_id, points: n, reason: `Stewards: ${why}` }, by);
  // the first version stays as "was", so a decision changed twice still shows what it was on race night
  const was = d.edited_from || `${decisionText(d)}: ${d.reason || ""}`;
  await db.prepare(`UPDATE decisions SET kind = ?, amount = ?, reason = ?, adj_id = ?, edited_at = ?, edited_by = ?, edited_from = ?, edited_site = 1 WHERE id = ?`)
    .bind(kind, n, why, adj, new Date().toISOString(), by, was, id).run();
  return { before: { ...d, text: decisionText(d) }, after: { kind, amount: n, reason: why, text: decisionText({ kind, amount: n }) } };
}

// take a decision back: its points penalty goes too, and its protest opens again if nothing else decided it
export async function deleteDecision(db, sub, id, by = "", reason = "") {
  await ensureSchema(db);
  const d = await db.prepare(`SELECT * FROM decisions WHERE id = ? AND subsession_id = ?`).bind(id, sub).first();
  if (!d) return null;
  if (d.source === "race control") {           // race control's calls stay on the report, withdrawn, and stay withdrawn
    if (d.adj_id) await db.prepare(`DELETE FROM adjustments WHERE id = ?`).bind(d.adj_id).run();
    await db.prepare(`UPDATE decisions SET status = 'withdrawn', withdrawn_site = 1, withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ?, adj_id = NULL WHERE id = ?`)
      .bind(new Date().toISOString(), by, String(reason || "Withdrawn on the site").slice(0, 200), id).run();
    return { ...d, withdrawn: true };
  }
  if (d.adj_id) await db.prepare(`DELETE FROM adjustments WHERE id = ?`).bind(d.adj_id).run();
  await db.prepare(`DELETE FROM decisions WHERE id = ?`).bind(id).run();
  if (d.protest_id && !await db.prepare(`SELECT 1 AS ok FROM decisions WHERE protest_id = ?`).bind(d.protest_id).first())
    await setProtestStatus(db, d.protest_id, "open", "");
  return d;
}

/* ---------- race control: the calls for a race (phase 5c) ---------- */

const RC_KIND = { noaction: "none" };                         // race control's names that differ from the site's
const RC_NAME = { none: "noaction" };

/**
 * A race file from race control (one steward's PC, every call it has for the race). Each call is added or updated by
 * its uid; calls from other PCs and from the site are left alone. A call withdrawn on the site stays withdrawn.
 * Works before the race's results are on the site: points penalties wait for the race's season (rcSync).
 * -> { changed: [...decisions that changed the order], added: [...new active decisions] }
 */
export async function saveRaceCalls(db, sub, file, by) {
  await ensureSchema(db);
  const pc = String(file.pc || "").trim();
  if (!pc) throw new Error("The race file has no pc id.");
  const calls = Array.isArray(file.calls) ? file.calls.slice(0, 300) : [];
  const now = new Date().toISOString(), seriesId = Number(file.leagueId);
  const res = { changed: [], added: [] };
  for (const c of calls) {
    const uid = String(c.uid || "");
    if (!uid.startsWith(pc + ":")) throw new Error(`Call ${uid || "(no uid)"} isn't from this pc.`);
    const kind = RC_KIND[c.kind] || c.kind;
    if (!KINDS[kind]) throw new Error(`Call ${uid}: unknown kind ${c.kind}.`);
    const cust = Math.round(Number(c.custId)) || 0;
    if (!cust) throw new Error(`Call ${uid}: no driver (custId).`);
    let amount = Math.round(Number(c.amount) || 0);
    amount = !AMOUNT[kind] ? 0 : kind === "points" ? -Math.abs(amount) : Math.abs(amount);
    const reason = String(c.reason || "").trim().slice(0, 300);
    const info = JSON.stringify({ lap: c.lap ?? null, sessionTime: c.sessionTime ?? null, incident: c.incident ?? null, sim: c.sim ?? null,
      carNumber: String(c.carNumber || ""), driverName: String(c.driverName || ""), pc, sessionNum: file.sessionNum ?? null });
    const withdrawn = c.status === "withdrawn";
    const old = await db.prepare(`SELECT * FROM decisions WHERE rc_uid = ?`).bind(uid).first();
    if (!old) {
      await db.prepare(`INSERT INTO decisions (subsession_id, series_id, cust_id, kind, amount, reason, source, made_at, made_by, rc_uid, info, status, withdrawn_at, withdrawn_by, withdrawn_reason)
          VALUES (?, ?, ?, ?, ?, ?, 'race control', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(sub, seriesId, cust, kind, amount, reason, String(c.madeAt || now), by, uid, info, withdrawn ? "withdrawn" : "active",
              withdrawn ? String(c.withdrawnAt || now) : null, withdrawn ? by : null, withdrawn ? String(c.withdrawnReason || "").slice(0, 200) : null).run();
      if (!withdrawn) { res.added.push({ uid, kind, cust }); if (CHANGES_ORDER(kind)) res.changed.push(uid); }
      continue;
    }
    if (old.subsession_id !== sub) throw new Error(`Call ${uid} belongs to another race.`);
    const same = old.kind === kind && old.amount === amount && old.reason === reason && old.cust_id === cust;
    let status = old.status, wAt = old.withdrawn_at, wBy = old.withdrawn_by, wWhy = old.withdrawn_reason;
    if (!old.withdrawn_site) {                     // withdrawn on the site: race control can't bring it back
      if (withdrawn && old.status === "active") { status = "withdrawn"; wAt = String(c.withdrawnAt || now); wBy = by; wWhy = String(c.withdrawnReason || "").slice(0, 200); }
      if (!withdrawn && old.status === "withdrawn") { status = "active"; wAt = wBy = wWhy = null; }
    }
    if (old.edited_site) {                         // changed on the site after review: race control keeps its lap info only
      await db.prepare(`UPDATE decisions SET info = ?, status = ?, withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ?`)
        .bind(info, status, wAt, wBy, wWhy, old.id).run();
      if (status !== old.status && CHANGES_ORDER(old.kind)) res.changed.push(uid);
      if (old.adj_id && status !== "active") {
        await db.prepare(`DELETE FROM adjustments WHERE id = ?`).bind(old.adj_id).run();
        await db.prepare(`UPDATE decisions SET adj_id = NULL WHERE id = ?`).bind(old.id).run();
      }
      continue;
    }
    await db.prepare(`UPDATE decisions SET cust_id = ?, kind = ?, amount = ?, reason = ?, info = ?, status = ?, withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ?`)
      .bind(cust, kind, amount, reason, info, status, wAt, wBy, wWhy, old.id).run();
    if ((!same || status !== old.status) && (CHANGES_ORDER(kind) || CHANGES_ORDER(old.kind))) res.changed.push(uid);
    if (old.adj_id && (!same || status !== "active")) {      // the points penalty is made again to match (rcSync)
      await db.prepare(`DELETE FROM adjustments WHERE id = ?`).bind(old.adj_id).run();
      await db.prepare(`UPDATE decisions SET adj_id = NULL WHERE id = ?`).bind(old.id).run();
    }
  }
  await rcSync(db, sub);
  return res;
}

// race control's points penalties go on the series' penalties once the race (and its season) is on the site
export async function rcSync(db, sub) {
  await ensureSchema(db);
  const ev = await db.prepare(`SELECT season_id FROM events WHERE subsession_id = ?`).bind(sub).first();
  if (!ev || !ev.season_id) return;
  const todo = (await db.prepare(`SELECT * FROM decisions WHERE subsession_id = ? AND source = 'race control' AND kind = 'points' AND status = 'active' AND adj_id IS NULL`).bind(sub).all()).results;
  for (const d of todo) {
    try {
      const adj = await addAdjustment(db, ev.season_id, { sub, cust: d.cust_id, points: d.amount, reason: `Stewards: ${d.reason || "race control"}` }, d.made_by || "");
      await db.prepare(`UPDATE decisions SET adj_id = ? WHERE id = ?`).bind(adj, d.id).run();
    } catch (e) { /* that driver isn't in the results (yet): tried again when results come in */ }
  }
}

// every call on a race (all stewards' PCs, and decisions made on the site), for race control to show
export async function raceCalls(db, sub) {
  return (await listDecisions(db, sub)).map(d => ({
    uid: d.rc_uid || `site:${d.id}`, source: d.source, kind: RC_NAME[d.kind] || d.kind, amount: d.kind === "points" ? Math.abs(d.amount) : d.amount,
    reason: d.reason, custId: d.cust_id, carNumber: d.car_number || "", driverName: d.name || "", lap: d.info.lap ?? null,
    madeAt: d.made_at, madeBy: whoName(d.made_by), status: d.status, withdrawnAt: d.withdrawn_at || null,
    withdrawnBy: d.withdrawn_by ? whoName(d.withdrawn_by) : null, withdrawnReason: d.withdrawn_reason || null, withdrawnOnSite: !!d.withdrawn_site,
    sim: d.info.sim || null,
  }));
}
