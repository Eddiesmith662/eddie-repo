/*
 * NASCAR-style driver stats from race results. Pure: give it races, get a row per driver.
 *
 * events = [{ subsession_id, start_time, track, results: [race result rows] }]
 * In a multi-class race, finishing and starting places count within the driver's class.
 */

export const COLUMNS = [
  // key, label, how to sort (desc = more is better), number format
  ["starts", "Starts", "desc"], ["wins", "Wins", "desc"], ["top5", "Top 5", "desc"], ["top10", "Top 10", "desc"], ["poles", "Poles", "desc"],
  ["avgStart", "Avg start", "asc", 1], ["avgFinish", "Avg finish", "asc", 1], ["best", "Best", "asc"],
  ["lapsLed", "Laps led", "desc"], ["racesLed", "Races led", "desc"], ["mostLed", "Most led", "desc"],
  ["laps", "Laps run", "desc"], ["leadLap", "Lead-lap", "desc"], ["dnf", "DNF", "asc"],
  ["gained", "Pos. gained", "desc"], ["fastLaps", "Fastest laps", "desc"], ["incPer", "Inc / race", "asc", 1],
];

const RUNNING = s => !s || /^running$/i.test(String(s).trim());

export function computeStats(events) {
  const by = new Map();
  for (const ev of events) {
    const rows = ev.results || [];
    const classes = [...new Set(rows.map(r => r.car_class || ""))];
    const multi = classes.length > 1;
    for (const cls of classes) {
      const field = rows.filter(r => (r.car_class || "") === cls).sort((a, b) => (a.finish_pos || 999) - (b.finish_pos || 999));
      if (!field.length) continue;
      const startOrder = [...field].filter(r => r.start_pos).sort((a, b) => a.start_pos - b.start_pos);
      const most = Math.max(...field.map(r => r.laps_led || 0));
      const fast = Math.min(...field.map(r => r.best_lap_ms || Infinity));
      field.forEach((r, i) => {
        const fin = multi ? i + 1 : r.finish_pos || i + 1;
        const st = r.start_pos ? (multi ? startOrder.indexOf(r) + 1 : r.start_pos) : null;
        if (!by.has(r.cust_id)) by.set(r.cust_id, { custId: r.cust_id, name: r.name, number: r.car_number, cls: r.car_class || "", starts: 0, wins: 0, top5: 0, top10: 0,
          poles: 0, startSum: 0, startN: 0, finSum: 0, best: null, lapsLed: 0, racesLed: 0, mostLed: 0, laps: 0, leadLap: 0, dnf: 0, gained: 0, fastLaps: 0, inc: 0, incN: 0, last: "", first: "" });
        const s = by.get(r.cust_id);
        if (!s.first || String(ev.start_time) < s.first) s.first = String(ev.start_time);
        if (String(ev.start_time) >= s.last) { s.last = String(ev.start_time); s.name = r.name; s.number = r.car_number; s.cls = r.car_class || ""; }
        s.starts++; s.finSum += fin; s.best = s.best == null ? fin : Math.min(s.best, fin);
        if (fin === 1) s.wins++; if (fin <= 5) s.top5++; if (fin <= 10) s.top10++;
        if (st) { s.startN++; s.startSum += st; s.gained += st - fin; if (st === 1) s.poles++; }
        s.lapsLed += r.laps_led || 0; if ((r.laps_led || 0) > 0) s.racesLed++; if (most > 0 && r.laps_led === most) s.mostLed++;
        s.laps += r.laps || 0;
        if (!(multi ? r.class_laps_down ?? r.laps_down : r.laps_down)) s.leadLap++;
        if (!RUNNING(r.reason_out)) s.dnf++;
        if (r.best_lap_ms && r.best_lap_ms === fast) s.fastLaps++;
        if (r.incidents != null) { s.inc += r.incidents; s.incN++; }
      });
    }
  }
  return [...by.values()].map(s => ({ ...s, avgStart: s.startN ? s.startSum / s.startN : null, avgFinish: s.starts ? s.finSum / s.starts : null,
    incPer: s.incN ? s.inc / s.incN : null }));
}

// leaders for the cards: counting stats need one, averages need a fair number of starts
export function leaders(rows, races) {
  const minStarts = Math.max(1, Math.ceil(races * 0.4));
  const top = (key, dir, filter = () => true) => {
    const list = rows.filter(r => r[key] != null && filter(r)).sort((a, b) => dir === "asc" ? a[key] - b[key] : b[key] - a[key]);
    return list.length && (dir === "asc" || list[0][key] > 0) ? { ...list[0], value: list[0][key] } : null;
  };
  return [
    ["Most wins", top("wins", "desc")], ["Most top 5s", top("top5", "desc")], ["Most poles", top("poles", "desc")], ["Most laps led", top("lapsLed", "desc")],
    ["Best avg finish", top("avgFinish", "asc", r => r.starts >= minStarts)], ["Most positions gained", top("gained", "desc")],
  ].filter(x => x[1]);
}
