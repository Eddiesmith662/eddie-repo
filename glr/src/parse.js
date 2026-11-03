/*
 * iRacing results exports -> one plain shape the site stores.
 *
 * Two files come from the iRacing members site for a session: the JSON export (every session: practice, qualifying,
 * race) and the CSV export (the race only, three blocks: event, league, results). Both become:
 *
 *   { source, subsessionId, league: {id, name}, season: {id, name}, track, startTime, laps, cautions, cautionLaps,
 *     leadChanges, sof, sessions: [{ name: "race" | "qualify" | "practice" | ..., results: [ result, ... ] }] }
 *
 *   result = { custId, name, carNumber, car, carClass, finish, classPos, start, laps, lapsLed, incidents, bestLapMs,
 *              bestLapNum, avgLapMs, intervalMs, lapsDown, classIntervalMs, classLapsDown, reasonOut, leaguePoints }
 *
 * In a multi-class race classPos, classIntervalMs and classLapsDown are measured against the class leader. In a
 * single-class race they equal the overall values.
 *
 * Positions are counted from 1 (the JSON counts from 0). Times are milliseconds (the JSON uses 1/10000 s). A car
 * a lap or more down has lapsDown set and no intervalMs.
 */

// positions, gaps and laps down within each class, from the overall order (fills what the file didn't give)
function classify(results) {
  const lead = new Map();
  for (const r of results) {
    if (!lead.has(r.carClass)) lead.set(r.carClass, { r, n: 0 });
    const L = lead.get(r.carClass);
    L.n++;
    if (r.classPos == null) r.classPos = L.n;
    const down = Math.max(0, (L.r.laps || 0) - (r.laps || 0));
    if (r.classLapsDown == null) r.classLapsDown = down;
    if (r.classIntervalMs === undefined) {
      const a = L.r, same = r === a;
      r.classIntervalMs = same ? 0 : down > 0 ? null
        : a.lapsDown === 0 && r.lapsDown === 0 && r.intervalMs != null && a.intervalMs != null ? r.intervalMs - a.intervalMs : null;
    }
  }
  return results;
}

const num = v => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const ms10k = v => (num(v) !== null && Number(v) > 0 ? Math.round(Number(v) / 10) : null);   // 1/10000 s -> ms

function sessionName(s) {
  const n = String(s.simsession_name || s.simsession_type_name || "").toLowerCase();
  if (n.includes("race")) return "race";
  if (n.includes("qual")) return "qualify";
  if (n.includes("practice")) return "practice";
  if (n.includes("warm")) return "warmup";
  return n || "session";
}

export function parseJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error("That file isn't valid JSON."); }
  const d = obj && obj.data ? obj.data : obj;
  if (!d || !Array.isArray(d.session_results)) throw new Error("This doesn't look like an iRacing results export (no session results in it).");
  const track = d.track || {};
  const sessions = d.session_results.map(s => {
    const rows = s.results || [];
    const lead = rows.reduce((m, r) => Math.max(m, num(r.laps_complete) || 0), 0);
    return {
      name: sessionName(s),
      results: rows.filter(r => !r.ai).map(r => {
        const laps = num(r.laps_complete) || 0, down = lead - laps;
        return {
          custId: num(r.cust_id), name: String(r.display_name || ""),
          carNumber: String((r.livery && r.livery.car_number) || ""), car: String(r.car_name || ""),
          carClass: String(r.car_class_short_name || r.car_class_name || ""),
          finish: num(r.finish_position) !== null ? Number(r.finish_position) + 1 : null,
          classPos: num(r.finish_position_in_class) !== null && r.finish_position_in_class >= 0 ? Number(r.finish_position_in_class) + 1 : null,
          start: num(r.starting_position) !== null && r.starting_position >= 0 ? Number(r.starting_position) + 1 : null,
          laps, lapsLed: num(r.laps_lead) || 0, incidents: num(r.incidents),
          bestLapMs: ms10k(r.best_lap_time), bestLapNum: num(r.best_lap_num) > 0 ? num(r.best_lap_num) : null,
          avgLapMs: ms10k(r.average_lap),
          intervalMs: down > 0 ? null : (num(r.interval) !== null && r.interval >= 0 ? Math.round(r.interval / 10) : null),
          lapsDown: down > 0 ? down : 0,
          classIntervalMs: num(r.class_interval) !== null && r.class_interval >= 0 ? Math.round(r.class_interval / 10) : undefined,
          reasonOut: String(r.reason_out || ""), leaguePoints: num(r.league_points),
        };
      }).sort((a, b) => (a.finish || 999) - (b.finish || 999)),
    };
  });
  for (const s of sessions) if (s.name === "race") classify(s.results);
  return {
    source: "iracing-json", subsessionId: num(d.subsession_id),
    league: { id: num(d.league_id), name: String(d.league_name || "") },
    season: { id: num(d.league_season_id), name: String(d.league_season_name || "") },
    track: [track.track_name, track.config_name].filter(Boolean).join(" - "),
    startTime: String(d.start_time || ""), laps: num(d.event_laps_complete), cautions: num(d.num_cautions),
    cautionLaps: num(d.num_caution_laps), leadChanges: num(d.num_lead_changes), sof: num(d.event_strength_of_field),
    sessions,
  };
}

// CSV with quotes, commas and newlines inside quotes
function csvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const secs = v => { const m = /^-?(\d+):(\d+(?:\.\d+)?)$/.exec(String(v).trim()); if (m) return Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000);
                    const n = num(String(v).replace(/^-/, "")); return n !== null && n > 0 ? Math.round(n * 1000) : null; };

export function parseCsv(text, filename = "") {
  const rows = csvRows(text).filter(r => r.some(c => c.trim() !== ""));
  const find = first => rows.findIndex(r => String(r[0]).trim().toLowerCase() === first);
  const hEvent = find("start time"), hLeague = find("league name"), hRes = find("fin pos");
  if (hRes < 0) throw new Error("This doesn't look like an iRacing results CSV (no \"Fin Pos\" table in it).");
  const pick = (hi, name) => { if (hi < 0) return ""; const i = rows[hi].map(c => c.trim().toLowerCase()).indexOf(name); return i >= 0 && rows[hi + 1] ? rows[hi + 1][i] : ""; };
  const head = rows[hRes].map(c => c.trim().toLowerCase()), col = name => head.indexOf(name);
  const g = (r, name) => { const i = col(name); return i >= 0 ? String(r[i] ?? "").trim() : ""; };
  const results = rows.slice(hRes + 1).filter(r => g(r, "cust id")).map(r => {
    const iv = g(r, "interval"), down = /(\d+)\s*L/i.exec(iv);
    return {
      custId: num(g(r, "cust id")), name: g(r, "name"), carNumber: g(r, "car #"), car: g(r, "car"), carClass: g(r, "car class"),
      finish: num(g(r, "fin pos")), start: num(g(r, "start pos")), laps: num(g(r, "laps comp")) || 0,
      lapsLed: num(g(r, "laps led")) || 0, incidents: num(g(r, "inc")),
      bestLapMs: secs(g(r, "fastest lap time")), bestLapNum: num(g(r, "fast lap#")),
      avgLapMs: secs(g(r, "average lap time")),
      intervalMs: down ? null : (secs(iv) ?? 0), lapsDown: down ? Number(down[1]) : 0,
      reasonOut: g(r, "out"), leaguePoints: num(g(r, "league points")),
    };
  }).sort((a, b) => (a.finish || 999) - (b.finish || 999));
  classify(results);
  const sub = /(\d{6,})/.exec(filename || "");
  return {
    source: "iracing-csv", subsessionId: sub ? Number(sub[1]) : null,
    league: { id: num(pick(hLeague, "league id")), name: pick(hLeague, "league name") },
    season: { id: num(pick(hLeague, "league season id")), name: pick(hLeague, "league season") },
    track: pick(hEvent, "track"), startTime: pick(hEvent, "start time"),
    laps: results.reduce((m, r) => Math.max(m, r.laps), 0), cautions: null, cautionLaps: null, leadChanges: null, sof: null,
    sessions: [{ name: "race", results }],
  };
}

// either file: JSON if it starts like JSON, otherwise CSV
export function parseExport(text, filename = "") {
  const t = String(text || "").replace(/^﻿/, "").trimStart();
  return t.startsWith("{") || t.startsWith("[") ? parseJson(t) : parseCsv(t, filename);
}
