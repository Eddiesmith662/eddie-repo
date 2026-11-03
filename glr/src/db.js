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
     name TEXT NOT NULL DEFAULT '')`,
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
     name TEXT, car_number TEXT, car TEXT,
     finish_pos INTEGER, start_pos INTEGER, laps INTEGER, laps_led INTEGER, incidents INTEGER,
     best_lap_ms INTEGER, best_lap_num INTEGER, avg_lap_ms INTEGER,
     interval_ms INTEGER, laps_down INTEGER, reason_out TEXT, league_points INTEGER,
     PRIMARY KEY (subsession_id, session, cust_id))`,
  `CREATE INDEX IF NOT EXISTS results_driver ON results (cust_id, subsession_id)`,
];

let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; });
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
      st.push(db.prepare(`INSERT OR REPLACE INTO results (subsession_id, session, cust_id, name, car_number, car, finish_pos,
            start_pos, laps, laps_led, incidents, best_lap_ms, best_lap_num, avg_lap_ms, interval_ms, laps_down, reason_out,
            league_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(ev.subsessionId, s.name, r.custId, r.name, r.carNumber, r.car, r.finish, r.start, r.laps, r.lapsLed,
              r.incidents, r.bestLapMs, r.bestLapNum, r.avgLapMs, r.intervalMs, r.lapsDown, r.reasonOut, r.leaguePoints));
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
  return { subsessionId: ev.subsessionId, drivers: seen.size, results: race.results.length,
           sessions: ev.sessions.map(s => s.name) };
}

export async function listEvents(db, { season } = {}) {
  await ensureSchema(db);
  const q = `SELECT e.*, se.name AS season_name, sr.name AS series_name,
        (SELECT name FROM results r WHERE r.subsession_id = e.subsession_id AND r.session = 'race' AND r.finish_pos = 1) AS winner,
        (SELECT cust_id FROM results r WHERE r.subsession_id = e.subsession_id AND r.session = 'race' AND r.finish_pos = 1) AS winner_id,
        (SELECT COUNT(*) FROM results r WHERE r.subsession_id = e.subsession_id AND r.session = 'race') AS starters
      FROM events e LEFT JOIN seasons se ON se.id = e.season_id LEFT JOIN series sr ON sr.id = e.series_id
      ${season ? "WHERE e.season_id = ?" : ""} ORDER BY e.start_time DESC LIMIT 500`;
  const st = db.prepare(q);
  return (await (season ? st.bind(season) : st).all()).results;
}

export async function getEvent(db, sub) {
  await ensureSchema(db);
  const ev = await db.prepare(`SELECT e.*, se.name AS season_name, sr.name AS series_name FROM events e
      LEFT JOIN seasons se ON se.id = e.season_id LEFT JOIN series sr ON sr.id = e.series_id WHERE e.subsession_id = ?`).bind(sub).first();
  if (!ev) return null;
  const rows = (await db.prepare(`SELECT * FROM results WHERE subsession_id = ? ORDER BY session, finish_pos`).bind(sub).all()).results;
  ev.sessions = {};
  for (const r of rows) (ev.sessions[r.session] = ev.sessions[r.session] || []).push(r);
  return ev;
}

export async function getDriver(db, cust) {
  await ensureSchema(db);
  const d = await db.prepare(`SELECT * FROM drivers WHERE cust_id = ?`).bind(cust).first();
  if (!d) return null;
  d.names = (await db.prepare(`SELECT name, first_seen, last_seen FROM driver_names WHERE cust_id = ? ORDER BY last_seen DESC`).bind(cust).all()).results;
  d.races = (await db.prepare(`SELECT r.*, e.track, e.start_time, e.season_id, se.name AS season_name,
        (SELECT COUNT(*) FROM results x WHERE x.subsession_id = r.subsession_id AND x.session = 'race') AS starters
      FROM results r JOIN events e ON e.subsession_id = r.subsession_id LEFT JOIN seasons se ON se.id = e.season_id
      WHERE r.cust_id = ? AND r.session = 'race' ORDER BY e.start_time DESC`).bind(cust).all()).results;
  return d;
}
