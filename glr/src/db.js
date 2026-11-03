/*
 * The league database (Cloudflare D1, which is SQLite).
 *
 * Tables are created on first use, so a fresh database needs no setup step. Drivers are keyed by iRacing Cust ID,
 * and every name a driver has raced under is kept in driver_names (league nicknames make the sim and the export
 * disagree on names, the Cust ID never changes).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS series (
     id INTEGER PRIMARY KEY,            -- iRacing league id
     name TEXT NOT NULL DEFAULT '',     -- iRacing's league name
     short_name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
     role_id TEXT NOT NULL DEFAULT '')  -- Discord role whose members can edit this series`,
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
     source TEXT, uploaded_at TEXT, uploaded_by TEXT)`,
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
  `CREATE TABLE IF NOT EXISTS overlay_keys (
     id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
     created_at TEXT, created_by TEXT, last_used TEXT, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0)`,
];
// columns added after the first version: [table, column, definition]
const ADDED = [
  ["series", "short_name", "TEXT NOT NULL DEFAULT ''"], ["series", "slug", "TEXT NOT NULL DEFAULT ''"], ["series", "role_id", "TEXT NOT NULL DEFAULT ''"],
  ["results", "car_class", "TEXT NOT NULL DEFAULT ''"], ["results", "class_pos", "INTEGER"],
  ["results", "class_interval_ms", "INTEGER"], ["results", "class_laps_down", "INTEGER"],
];

// short names for the GLR series (by iRacing league id); officials can change them on the site
const SHORT = { 9310: "ARCA", 9309: "Grand National", 11390: "Foundation", 12070: "Sports Car", 11059: "Warrior", 6838: "Next Gen" };
// words in the site's own addresses, which a series can't use as its address
export const RESERVED = new Set(["api", "results", "drivers", "upload", "login", "logout", "auth", "health", "series", "edit", "admin", "keys"]);

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

let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = (async () => {
    await db.batch(SCHEMA.map(s => db.prepare(s)));
    for (const [table, col, def] of ADDED) {
      const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(c => c.name);
      if (!cols.includes(col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    }
    await nameSeries(db);
  })().catch(e => { ready = null; throw e; });
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
        lead_changes, sof, source, uploaded_at, uploaded_by, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(subsession_id) DO UPDATE SET series_id = COALESCE(?2, series_id), season_id = COALESCE(?3, season_id),
        track = COALESCE(NULLIF(?4, ''), track), start_time = COALESCE(NULLIF(?5, ''), start_time), laps = COALESCE(?6, laps),
        cautions = COALESCE(?7, cautions), caution_laps = COALESCE(?8, caution_laps), lead_changes = COALESCE(?9, lead_changes),
        sof = COALESCE(?10, sof), source = ?11, uploaded_at = ?12, uploaded_by = ?13, status = ?14`)
    .bind(ev.subsessionId, ev.league.id, ev.season.id, ev.track, ev.startTime, ev.laps, ev.cautions, ev.cautionLaps,
          ev.leadChanges, ev.sof, ev.source, now, by, status));
  const fixes = (await db.prepare(`SELECT COUNT(*) AS n FROM result_fixes WHERE subsession_id = ?`).bind(ev.subsessionId).first()).n;
  st.push(db.prepare(`DELETE FROM result_fixes WHERE subsession_id = ?`).bind(ev.subsessionId));   // the new results replace any fixes
  const seen = new Map();
  for (const s of ev.sessions) {
    st.push(db.prepare(`DELETE FROM results WHERE subsession_id = ? AND session = ?`).bind(ev.subsessionId, s.name));
    for (const r of s.results) {
      if (!r.custId) continue;
      if (r.name) seen.set(r.custId, r.name);
      st.push(db.prepare(`INSERT OR REPLACE INTO results (subsession_id, session, cust_id, name, car_number, car, car_class,
            finish_pos, class_pos, start_pos, laps, laps_led, incidents, best_lap_ms, best_lap_num, avg_lap_ms, interval_ms,
            laps_down, class_interval_ms, class_laps_down, reason_out, league_points)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(ev.subsessionId, s.name, r.custId, r.name, r.carNumber, r.car, r.carClass || "", r.finish, r.classPos ?? null,
              r.start, r.laps, r.lapsLed, r.incidents, r.bestLapMs, r.bestLapNum, r.avgLapMs, r.intervalMs, r.lapsDown,
              r.classIntervalMs ?? null, r.classLapsDown ?? null, r.reasonOut, r.leaguePoints));
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
  return { subsessionId: ev.subsessionId, drivers: seen.size, results: race.results.length, fixesCleared: fixes,
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
}

export async function deleteAdjustment(db, seasonId, id) {
  await ensureSchema(db);
  await db.prepare(`DELETE FROM adjustments WHERE id = ? AND subsession_id IN (SELECT subsession_id FROM events WHERE season_id = ?)`).bind(id, seasonId).run();
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
  const had = await db.prepare(`SELECT source, season_id FROM events WHERE subsession_id = ?`).bind(ev.subsessionId).first();
  if (had && had.source !== "overlay") return { ok: true, skipped: true, series: sr.short_name, message: "Official results for this race are already on the site." };
  const cur = had && had.season_id ? { season_id: had.season_id }
    : await db.prepare(`SELECT season_id FROM events WHERE series_id = ? AND season_id IS NOT NULL ORDER BY start_time DESC LIMIT 1`).bind(sr.id).first();
  const r = await importEvent(db, { ...ev, league: { id: sr.id, name: sr.name }, season: { id: cur ? cur.season_id : null, name: "" } }, by);
  return { ok: true, ...r, series: sr.short_name, replaced: !!had };
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = async t => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));

export async function listKeys(db) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT id, name, created_at, created_by, last_used, uses, revoked FROM overlay_keys ORDER BY revoked, id DESC`).all()).results;
}

// a new key: shown once, only its hash is kept
export async function createKey(db, name, by) {
  await ensureSchema(db);
  const n = String(name || "").trim().slice(0, 60);
  if (!n) throw new Error("Give the key a name, like the producer's name.");
  const key = "vsglr_" + hex(crypto.getRandomValues(new Uint8Array(24)));
  await db.prepare(`INSERT INTO overlay_keys (name, key_hash, created_at, created_by) VALUES (?, ?, ?, ?)`).bind(n, await sha(key), new Date().toISOString(), by).run();
  return key;
}

export async function revokeKey(db, id) {
  await ensureSchema(db);
  await db.prepare(`UPDATE overlay_keys SET revoked = 1 WHERE id = ?`).bind(id).run();
}

export async function checkKey(db, key) {
  if (!/^vsglr_[0-9a-f]{48}$/.test(String(key || ""))) return null;
  await ensureSchema(db);
  const row = await db.prepare(`SELECT * FROM overlay_keys WHERE key_hash = ? AND revoked = 0`).bind(await sha(key)).first();
  if (row) await db.prepare(`UPDATE overlay_keys SET last_used = ?, uses = uses + 1 WHERE id = ?`).bind(new Date().toISOString(), row.id).run();
  return row;
}

// remove a race: its results, its penalties and its fixes. Drivers left with no races go too.
export async function deleteEvent(db, sub) {
  await ensureSchema(db);
  await db.batch([
    db.prepare(`DELETE FROM adjustments WHERE subsession_id = ?`).bind(sub),
    db.prepare(`DELETE FROM result_fixes WHERE subsession_id = ?`).bind(sub),
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
