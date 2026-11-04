/*
 * Standings from a season's races and that season's rules. Pure: no database, no web, so it can be tested on its own.
 *
 * rules = {
 *   points:  { source: "iracing" | "table", table: [40, 35, ...], others: 0 }   others = points for places past the table
 *   bonus:   { win, pole, led, mostLed, fastLap }        added to every race (pole = best starting spot)
 *   drops:   0                                           worst races left out of the regular season total
 *   byClass: true                                        multi-class seasons get standings per class
 *   ties:    "share" | "wins"                            equal points share a place, or more wins (then better finishes) first
 *   skip:    [subsession ids]                            races that don't count
 *   playoffs: { enabled, regularRaces, minStarts, field, seedBonus: [5, 3, 1], winBonus,
 *               rounds: [{ name, races, drivers, reset, bonuses, winAdvances, missMustWin, finale }] }
 * }
 * Playoff rounds: the first round has `field` drivers. Each round's points start at `reset`, plus the driver's bonus
 * points when `bonuses` is on (seed bonus + winBonus for every win so far). When a round ends, the next round's
 * `drivers` go through: race winners first (winAdvances), then the most round points. A driver who missed a race in
 * the round can only go through by winning (missMustWin). In a `finale` round the best finisher is champion.
 *
 * events = [{ subsession_id, start_time, track, results: [race result rows from the database] }] in race order.
 * adjustments = [{ subsession_id, cust_id, points, reason }]  (penalties are negative)
 */

export const DEFAULT_RULES = {
  points: { source: "iracing", table: [], others: 0 },
  bonus: { win: 0, pole: 0, led: 0, mostLed: 0, fastLap: 0 },
  drops: 0, byClass: true, ties: "share", skip: [],
  playoffs: { enabled: false, regularRaces: 10, minStarts: 0, field: 12, seedBonus: [], winBonus: 0, rounds: [] },
};

export const GLR_PLAYOFFS = {
  enabled: true, regularRaces: 10, minStarts: 7, field: 12, seedBonus: [5, 3, 1], winBonus: 3,
  rounds: [
    { name: "Round of 12", races: 2, drivers: 12, reset: 1000, bonuses: true, winAdvances: true, missMustWin: true, finale: false },
    { name: "Round of 8", races: 2, drivers: 8, reset: 2000, bonuses: true, winAdvances: true, missMustWin: true, finale: false },
    { name: "Championship", races: 1, drivers: 4, reset: 3000, bonuses: false, winAdvances: true, missMustWin: true, finale: true },
  ],
};

const int = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };

// fill in anything missing and clamp numbers, so a half-filled form can't break the standings
export function cleanRules(r) {
  r = r || {};
  const p = r.points || {}, b = r.bonus || {}, po = r.playoffs || {};
  return {
    points: { source: p.source === "table" ? "table" : "iracing", table: (Array.isArray(p.table) ? p.table : []).map(x => int(x)).slice(0, 100), others: int(p.others) },
    bonus: { win: int(b.win), pole: int(b.pole), led: int(b.led), mostLed: int(b.mostLed), fastLap: int(b.fastLap) },
    drops: Math.max(0, int(r.drops)), byClass: r.byClass !== false, ties: r.ties === "wins" ? "wins" : "share",
    skip: (Array.isArray(r.skip) ? r.skip : []).map(x => int(x)).filter(Boolean),
    playoffs: {
      enabled: !!po.enabled, regularRaces: Math.max(1, int(po.regularRaces, 10)), minStarts: Math.max(0, int(po.minStarts)),
      field: Math.max(2, int(po.field, 12)), seedBonus: (Array.isArray(po.seedBonus) ? po.seedBonus : []).map(x => int(x)).slice(0, 50),
      winBonus: int(po.winBonus),
      rounds: (Array.isArray(po.rounds) ? po.rounds : []).filter(x => x && int(x.races) > 0).slice(0, 10).map((x, i) => ({
        name: String(x.name || `Round ${i + 1}`).slice(0, 40), races: Math.max(1, int(x.races)), drivers: Math.max(1, int(x.drivers)),
        reset: int(x.reset), bonuses: !!x.bonuses, winAdvances: x.winAdvances !== false, missMustWin: x.missMustWin !== false, finale: !!x.finale })),
    },
  };
}

// one class's (or the whole field's) points for each race
function scoreRaces(rules, events, adj, inClass, cls) {
  const races = [];
  for (const ev of events) {
    const rows = ev.results.filter(r => !inClass || r.car_class === cls).sort((a, b) => (a.finish_pos || 999) - (b.finish_pos || 999));
    if (!rows.length) { races.push({ ev, by: new Map(), ran: false }); continue; }
    const pole = Math.min(...rows.map(r => r.start_pos || 999));
    const most = Math.max(...rows.map(r => r.laps_led || 0));
    const fast = Math.min(...rows.map(r => r.best_lap_ms || Infinity));
    const by = new Map();
    rows.forEach((r, i) => {
      const pos = inClass ? i + 1 : r.finish_pos || i + 1;
      const B = rules.bonus;
      const base = rules.points.source === "iracing" ? int(r.league_points) : (rules.points.table[pos - 1] ?? rules.points.others);
      const bonus = (pos === 1 ? B.win : 0) + (r.start_pos && r.start_pos === pole ? B.pole : 0) + ((r.laps_led || 0) > 0 ? B.led : 0) +
        (most > 0 && r.laps_led === most ? B.mostLed : 0) + (r.best_lap_ms && r.best_lap_ms === fast ? B.fastLap : 0);
      const pen = adj.filter(a => a.subsession_id === ev.subsession_id && a.cust_id === r.cust_id);
      const adjPts = pen.reduce((s, a) => s + int(a.points), 0);
      by.set(r.cust_id, { pos, pts: base + bonus + adjPts, base, bonus, adj: adjPts, adjReasons: pen.map(a => a.reason).filter(Boolean),
        lapsLed: r.laps_led || 0, row: r });
    });
    races.push({ ev, by, ran: true });
  }
  return races;
}

function driverStats(races, from, to, drops) {
  const d = new Map();
  for (let i = from; i < to && i < races.length; i++) {
    for (const [id, x] of races[i].by) {
      if (!d.has(id)) d.set(id, { custId: id, name: x.row.name, number: x.row.car_number, starts: 0, wins: 0, top5: 0, top10: 0, lapsLed: 0, pts: [], finishes: [] });
      const s = d.get(id);
      s.name = x.row.name; s.number = x.row.car_number;
      s.starts++; if (x.pos === 1) s.wins++; if (x.pos <= 5) s.top5++; if (x.pos <= 10) s.top10++; s.lapsLed += x.lapsLed;
      s.finishes.push(x.pos);
    }
  }
  const ran = races.slice(from, to).filter(r => r.ran);
  for (const s of d.values()) {
    const per = ran.map(r => (r.by.get(s.custId) || { pts: 0 }).pts);
    const k = per.length > drops ? drops : 0;
    const keep = [...per].sort((a, b) => a - b).slice(k);
    s.points = keep.reduce((a, b) => a + b, 0);
    s.dropped = per.reduce((a, b) => a + b, 0) - s.points;
  }
  return d;
}

// best finishes first: compare counts of 1sts, then 2nds, ...
const betterFinishes = (a, b) => { for (let p = 1; p <= 60; p++) { const x = a.finishes.filter(f => f === p).length, y = b.finishes.filter(f => f === p).length; if (x !== y) return y - x; } return 0; };

function rank(list, ties, key = "points") {
  list.sort((a, b) => b[key] - a[key] || (ties === "wins" ? b.wins - a.wins || betterFinishes(a, b) : 0) || a.name.localeCompare(b.name));
  list.forEach((s, i) => {
    const prev = list[i - 1];
    const same = prev && prev[key] === s[key] && (ties === "share" || (prev.wins === s.wins && betterFinishes(prev, s) === 0));
    s.pos = same ? prev.pos : i + 1;
  });
  const top = list.length ? list[0][key] : 0;
  for (const s of list) s.behind = top - s[key];
  return list;
}

function standingsFor(rules, races) {
  const po = rules.playoffs;
  const R = po.enabled ? po.regularRaces : races.length;
  const regRan = races.slice(0, R).filter(r => r.ran).length;
  const regular = rank([...driverStats(races, 0, R, rules.drops).values()], rules.ties);
  const all = driverStats(races, 0, races.length, rules.drops);
  for (const s of regular) { s.eligible = s.starts >= po.minStarts; s.needStarts = Math.max(0, po.minStarts - s.starts); }
  const out = { regular, regularRaces: R, regularRan: regRan, playoffs: null };
  if (!po.enabled || !po.rounds.length) { out.regularComplete = regRan >= R; return out; }

  // the playoff field (projected until the regular season is over)
  const regularDone = regRan >= R;
  const field = regular.filter(s => s.eligible).slice(0, po.field);
  const fieldIds = new Set(field.map(s => s.custId));
  regular.forEach(s => { s.inField = fieldIds.has(s.custId); });
  if (!regularDone) { out.regularComplete = false; out.playoffs = { started: false, projected: true }; return out; }

  const bonus = new Map(field.map((s, i) => [s.custId, (po.seedBonus[i] || 0) + po.winBonus * s.wins]));
  let inRound = field.map(s => s.custId), idx = R;
  const rounds = [], eliminated = [];
  for (let k = 0; k < po.rounds.length; k++) {
    const rd = po.rounds[k], next = po.rounds[k + 1];
    const evs = races.slice(idx, idx + rd.races), ran = evs.filter(r => r.ran);
    const rows = inRound.map(id => {
      const reg = all.get(id) || regular.find(s => s.custId === id);
      const pts = ran.map(r => (r.by.get(id) || { pts: 0 }).pts).reduce((a, b) => a + b, 0);
      const started = ran.filter(r => r.by.has(id)).length;
      const won = ran.some(r => (r.by.get(id) || {}).pos === 1);
      const fin = ran.map(r => (r.by.get(id) || {}).pos).filter(Boolean);
      return { custId: id, name: reg.name, number: reg.number, wins: (all.get(id) || reg).wins, starts: (all.get(id) || reg).starts,
        top5: (all.get(id) || reg).top5, top10: (all.get(id) || reg).top10, lapsLed: (all.get(id) || reg).lapsLed, finishes: (all.get(id) || reg).finishes,
        bonus: rd.bonuses ? bonus.get(id) || 0 : 0, roundPts: pts, points: rd.reset + (rd.bonuses ? bonus.get(id) || 0 : 0) + pts,
        won, missed: started < ran.length, best: fin.length ? Math.min(...fin) : 999 };
    });
    const complete = ran.length >= rd.races;
    // wins in this round count toward later rounds' bonus
    for (const r of ran) for (const [id, x] of r.by) if (x.pos === 1 && bonus.has(id)) bonus.set(id, bonus.get(id) + po.winBonus);
    if (rd.finale) {
      rows.sort((a, b) => complete ? a.best - b.best || b.points - a.points : b.points - a.points || a.name.localeCompare(b.name));
      rows.forEach((r, i) => { r.pos = i + 1; r.status = complete ? (i === 0 ? "Champion" : "") : ""; });
      const top = rows.length ? rows[0].points : 0; rows.forEach(r => { r.behind = top - r.points; });
      rounds.push({ ...rd, index: k, rows, ran: ran.length, complete, events: evs.map(r => r.ev.subsession_id) });
      break;
    }
    rank(rows, rules.ties);
    const spots = next ? next.drivers : rows.length;
    const locked = rows.filter(r => rd.winAdvances && r.won);
    const open = rows.filter(r => !locked.includes(r) && !(rd.missMustWin && r.missed));
    const through = new Set([...locked, ...open.slice(0, Math.max(0, spots - locked.length))].map(r => r.custId));
    const cutRow = open[Math.max(0, spots - locked.length) - 1];
    for (const r of rows) {
      r.through = through.has(r.custId);
      r.status = r.won && rd.winAdvances ? "Advanced (win)" : rd.missMustWin && r.missed ? (complete ? "Out (missed a race)" : "Must win") : "";
      r.toCut = cutRow ? r.points - cutRow.points : null;
      // level on points across the cut line: shown as a tie for officials to settle, not decided by name
      if (ran.length && cutRow && !r.status && open.includes(r) && r.points === cutRow.points && open.some(o => o !== r && o.points === r.points && through.has(o.custId) !== through.has(r.custId)))
        r.status = "Tied at the cut";
    }
    rd.tieAtCut = rows.some(r => r.status === "Tied at the cut");
    rounds.push({ ...rd, index: k, rows, ran: ran.length, complete, spots, events: evs.map(r => r.ev.subsession_id) });
    if (!complete) break;
    eliminated.unshift(...rows.filter(r => !r.through).map(r => ({ ...r, outIn: rd.name })));
    inRound = rows.filter(r => r.through).map(r => r.custId);
    idx += rd.races;
  }
  const others = [...all.values()].filter(s => !fieldIds.has(s.custId));
  out.regularComplete = true;
  out.playoffs = { started: true, rounds, current: rounds[rounds.length - 1], eliminated, others: rank(others, rules.ties) };
  return out;
}

// the whole season: standings per class (or one set), plus each race's points
export function computeStandings(rawRules, events, adjustments = []) {
  const rules = cleanRules(rawRules);
  const skip = new Set(rules.skip);
  const counted = events.filter(e => !skip.has(e.subsession_id)).sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  const classes = [...new Set(counted.flatMap(e => e.results.map(r => r.car_class || "")))];
  const perClass = rules.byClass && classes.length > 1;
  const groups = (perClass ? classes : [""]).map(cls => {
    const races = scoreRaces(rules, counted, adjustments, perClass, cls);
    return { carClass: cls, ...standingsFor(rules, races), races: races.map(r => ({ subsession_id: r.ev.subsession_id, start_time: r.ev.start_time, track: r.ev.track,
      points: Object.fromEntries([...r.by].map(([id, x]) => [id, { pos: x.pos, pts: x.pts, bonus: x.bonus, adj: x.adj, reasons: x.adjReasons, out: x.row.reason_out || "" }])) })) };
  });
  return { rules, counted: counted.length, skipped: events.length - counted.length, groups };
}
