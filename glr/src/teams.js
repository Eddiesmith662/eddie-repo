/*
 * Team points (the Warrior points system). Each driver scores their finishing points in a race as usual (the series'
 * points for their finishing position: no bonuses, no penalty points). A team's score for a race is its drivers'
 * points added together, divided by how many of the team's drivers raced that night. A race none of them raced scores
 * 0. The season total is every race's team score added up. Pure: no database, no web.
 */
import { normName } from "./db.js";

const round = n => Math.round(n * 1000) / 1000;

/**
 * teams: [{ id, name, members: [{ cust_id, name }] }]
 * standings: computeStandings(...) for the season (its races, with each driver's base points)
 * -> { races: [{ subsession_id, start_time, track }], teams: [{ ...team, total, pos, races: [{ score, raced, of, sum }], drivers: Map }] }
 */
export function teamStandings(teams, standings) {
  // every counted race, with each driver's finishing points (all classes together)
  const byRace = new Map();
  for (const g of standings.groups) for (const r of g.races) {
    if (!byRace.has(r.subsession_id)) byRace.set(r.subsession_id, { subsession_id: r.subsession_id, start_time: r.start_time, track: r.track, pts: new Map() });
    for (const [id, x] of Object.entries(r.points)) byRace.get(r.subsession_id).pts.set(Number(id), x.base);
  }
  const races = [...byRace.values()].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  const out = teams.map(t => {
    const drivers = new Map(t.members.map(m => [m.cust_id, { ...m, points: 0, races: 0 }]));
    const per = races.map(r => {
      const in_ = t.members.filter(m => r.pts.has(m.cust_id));
      const sum = in_.reduce((a, m) => a + r.pts.get(m.cust_id), 0);
      for (const m of in_) { const d = drivers.get(m.cust_id); d.points += r.pts.get(m.cust_id); d.races++; }
      return { sum, raced: in_.length, of: t.members.length, score: in_.length ? round(sum / in_.length) : 0 };
    });
    return { ...t, races: per, total: round(per.reduce((a, x) => a + x.score, 0)), drivers };
  });
  out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  out.forEach((t, i) => { t.pos = i && t.total === out[i - 1].total ? out[i - 1].pos : i + 1; });   // equal totals share a place
  return { races: races.map(({ pts, ...r }) => r), teams: out };
}

// a name for loose matching: also without middle initials and Jr/Sr/II/III ("Racer Q Test Jr" = "Racer Test")
// (only when at least a first and last name are left, so "Racer Z" doesn't become just "racer")
const loose = s => { const w = normName(s).split(" ").filter(w => w.length > 1 && !/^(jr|sr|ii|iii|iv)$/.test(w)); return w.length > 1 ? w.join(" ") : ""; };

// a CSV file's rows (quoted fields, commas or semicolons, any line ending)
export function csvRows(text) {
  text = String(text || "").replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0], sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : (first.includes("\t") && !first.includes(",") ? "\t" : ",");
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell.trim()); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(r => r.some(Boolean));
}

/**
 * Teams from a CSV file. Two layouts:
 *   - one row per driver, with a header row: Team, Driver, iRacing ID (the ID is optional; a blank Team means the
 *     same team as the row above)
 *   - the team grid: team names across the first row, each team's drivers in the column below
 * A driver is matched by their name as the site knows it (any name they've raced under), or by the iRacing ID.
 * drivers: [{ cust_id, name, aliases: [names], here }] (here: has raced in this series, preferred when names clash)
 * -> { teams: [{ name, custs: [] }], problems: [{ team, text, why }] }
 */
export function parseTeams(text, drivers) {
  const rows = csvRows(text), cols = [];
  const head = (rows[0] || []).map(h => h.toLowerCase());
  const ti = head.findIndex(h => /^team/.test(h)), di = head.findIndex(h => /^(driver|name)/.test(h)), ii = head.findIndex(h => /iracing|\bid\b|cust/.test(h));
  if (ti >= 0 && di >= 0) {
    let team = "";
    for (const r of rows.slice(1)) {
      team = r[ti] || team;
      const name = r[di] || "", id = ii >= 0 ? (r[ii] || "").replace(/\D/g, "") : "";
      if (!team || (!name && !id)) continue;
      let c = cols.find(x => x.name === team);
      if (!c) cols.push(c = { name: team, entries: [] });
      c.entries.push(id ? `${name} (${id})` : name);
    }
  } else {
    (rows[0] || []).forEach((name, j) => { if (name) cols.push({ name, entries: rows.slice(1).map(r => r[j] || "").filter(Boolean) }); });
  }
  const byId = new Map(drivers.map(d => [d.cust_id, d]));
  const exact = new Map(), lax = new Map();
  const add = (map, k, d) => { if (!k) return; const a = map.get(k) || []; if (!a.includes(d)) a.push(d); map.set(k, a); };
  for (const d of drivers) for (const n of [d.name, ...(d.aliases || [])]) { add(exact, normName(n), d); add(lax, loose(n), d); }
  const pick = list => { if (!list) return []; const here = list.filter(d => d.here); return here.length ? here : list; };

  const problems = [], seen = new Map(), teams = [];
  for (const c of cols) {
    const t = { name: c.name.slice(0, 60), custs: [] };
    if (teams.some(x => x.name.toLowerCase() === t.name.toLowerCase())) { problems.push({ team: t.name, text: t.name, why: "This team name is used twice." }); continue; }
    for (const e of c.entries) {
      const id = (/\((\d+)\)\s*$/.exec(e) || /^(\d+)$/.exec(e) || [])[1];
      let found = id ? (byId.has(Number(id)) ? [byId.get(Number(id))] : []) : pick(exact.get(normName(e)));
      if (!id && !found.length) found = pick(lax.get(loose(e)));
      if (!found.length) { problems.push({ team: t.name, text: e, why: id ? "No driver with that iRacing ID has raced in GLR yet." : "No driver by that name has raced in GLR. Check the spelling, or add their iRacing ID." }); continue; }
      if (found.length > 1) { problems.push({ team: t.name, text: e, why: `More than one driver has that name: ${found.map(d => `${d.name} (${d.cust_id})`).join(", ")}. Add the right iRacing ID.` }); continue; }
      const d = found[0];
      if (seen.has(d.cust_id) && seen.get(d.cust_id) !== t.name) { problems.push({ team: t.name, text: e, why: `${d.name} is already on ${seen.get(d.cust_id)}.` }); continue; }
      seen.set(d.cust_id, t.name);
      if (!t.custs.includes(d.cust_id)) t.custs.push(d.cust_id);
    }
    teams.push(t);
  }
  return { teams, problems };
}

// the teams as a CSV file, one row per driver, to edit and upload again
const csvCell = v => /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
export const teamsCsv = teams => ["Team,Driver,iRacing ID", ...teams.flatMap(t => t.members.map(m => [t.name, m.name, m.cust_id].map(csvCell).join(",")))].join("\r\n") + "\r\n";
