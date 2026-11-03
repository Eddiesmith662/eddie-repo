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
     short_name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '')`,
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
];
// columns added after the first version: [table, column, definition]
const ADDED = [
  ["series", "short_name", "TEXT NOT NULL DEFAULT ''"], ["series", "slug", "TEXT NOT NULL DEFAULT ''"],
  ["results", "car_class", "TEXT NOT NULL DEFAULT ''"], ["results", "class_pos", "INTEGER"],
  ["results", "class_interval_ms", "INTEGER"], ["results", "class_laps_down", "INTEGER"],
];

// short names for the GLR series (by iRacing league id); officials can change them on the site
const SHORT = { 9310: "ARCA", 9309: "Grand National", 11390: "Foundation", 12070: "Sports Car", 11059: "Warrior", 6838: "Next Gen" };
// words in the site's own addresses, which a series can't use as its address
export const RESERVED = new Set(["api", "results", "drivers", "upload", "login", "logout", "auth", "health", "series", "edit", "admin"]);

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
  if (ev.league.id) st.push(db.prepare(`INSERT INTO series (id, name) VALUES (?1, ?2)
      ON CONFLICT(id) DO UPDATE SET name = CASE WHEN ?2 <> '' THEN ?2 ELSE name END`).bind(ev.league.id, ev.league.name));
  if (ev.season.id) st.push(db.prepare(`INSERT INTO seasons (id, series_id, name) VALUES (?1, ?2, ?3)
      ON CONFLICT(id) DO UPDATE SET series_id = COALESCE(?2, series_id), name = CASE WHEN ?3 <> '' THEN ?3 ELSE name END`)
      .bind(ev.season.id, ev.league.id, ev.season.name));
  st.push(db.prepare(`INSERT INTO events (subsession_id, series_id, season_id, track, start_time, laps, cautions, caution_laps,
        lead_changes, sof, source, uploaded_at, uploaded_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(subsession_id) DO UPDATE SET series_id = COALESCE(?2, series_id), season_id = COALESCE(?3, season_id),
        track = COALESCE(NULLIF(?4, ''), track), start_time = COALESCE(NULLIF(?5, ''), start_time), laps = COALESCE(?6, laps),
        cautions = COALESCE(?7, cautions), caution_laps = COALESCE(?8, caution_laps), lead_changes = COALESCE(?9, lead_changes),
        sof = COALESCE(?10, sof), source = ?11, uploaded_at = ?12, uploaded_by = ?13`)
    .bind(ev.subsessionId, ev.league.id, ev.season.id, ev.track, ev.startTime, ev.laps, ev.cautions, ev.cautionLaps,
          ev.leadChanges, ev.sof, ev.source, now, by));
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
  return { subsessionId: ev.subsessionId, drivers: seen.size, results: race.results.length,
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
