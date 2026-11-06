/*
 * Stewards' decisions applied to a race's results. Pure: give it the race rows and the decisions, get new rows.
 *
 * Decisions are kept apart from the iRacing results (so they survive the results file being uploaded again) and
 * applied whenever a race is read, so results pages, standings, stats and Discord posts all follow them.
 *
 *   kind      what it does to the results
 *   none      no action: on the stewards' report only
 *   warning   a warning: on the report only
 *   points    points taken off (or added): done through the series' penalties (adjustments), not here
 *   positions moved back `amount` places in their class; everyone they drop behind moves up one
 *   time      `amount` seconds added to the race time: re-sorted among cars on the same lap (never a lap down)
 *   dq        disqualified: last in their class, no league points and no bonuses
 *   drivethrough, stopgo, eol   given and served during the race (race control): on the report only
 *
 * Decisions from race control (source 'race control') can be withdrawn: they stay on the report, crossed out, and
 * don't change anything. Only active decisions are passed in here.
 *
 * The places don't change hands: in a multi-class race each class keeps the overall finishing places it had, and the
 * league points iRacing gave for a place go to whoever ends up in it.
 */

export const KINDS = {
  none: "No action",
  warning: "Warning",
  points: "Points penalty",
  positions: "Position penalty",
  time: "Time penalty",
  dq: "Disqualified",
  drivethrough: "Drive-through",
  stopgo: "Stop and go",
  eol: "End of line",
};
// how many: points, places or seconds (stop and go: how long it was)
export const AMOUNT = { points: "points", positions: "places", time: "seconds", stopgo: "seconds" };
export const CHANGES_ORDER = k => k === "positions" || k === "time" || k === "dq";

// how a decision reads on the report and on the results: "Moved back 3 places", "-10 points", "Disqualified"
export function decisionText(d) {
  const n = Math.abs(Number(d.amount) || 0);
  if (d.kind === "points") return `${Number(d.amount) > 0 ? "+" : "-"}${n} point${n === 1 ? "" : "s"}`;
  if (d.kind === "positions") return `Moved back ${n} place${n === 1 ? "" : "s"}`;
  if (d.kind === "time") return `+${n} second${n === 1 ? "" : "s"}`;
  if (d.kind === "stopgo" && n) return `Stop and go (${n} s)`;
  return KINDS[d.kind] || d.kind;
}

/**
 * rows: one race's result rows (session 'race'), any order. decisions: that race's decisions, oldest first.
 * Returns new row objects; untouched rows are copied as they are. A changed row gets orig_finish (its place before
 * the stewards) and stewards (["Moved back 3 places: reason", ...]); a disqualified one gets dq: true.
 */
export function applyDecisions(rows, decisions) {
  const acts = (decisions || []).filter(d => CHANGES_ORDER(d.kind) && (d.status || "active") === "active");
  const out = rows.map(r => ({ ...r }));
  if (!acts.length) return out;
  const byClass = new Map();
  for (const r of out) { const k = r.car_class || ""; if (!byClass.has(k)) byClass.set(k, []); byClass.get(k).push(r); }
  for (const field of byClass.values()) {
    if (!acts.some(d => field.some(r => r.cust_id === d.cust_id))) continue;
    field.sort((a, b) => (a.finish_pos || 999) - (b.finish_pos || 999));
    // the class's places as they were: overall finish, and iRacing's points for that place
    const slots = field.map(r => ({ finish: r.finish_pos, points: r.league_points }));
    let order = [...field];
    const dq = new Set();
    // time penalties first: seconds added to the gap, then each run of cars on the same lap re-sorted by it
    const extra = new Map();
    for (const d of acts.filter(d => d.kind === "time")) {
      const r = order.find(x => x.cust_id === d.cust_id);
      if (!r) continue;
      extra.set(r, (extra.get(r) || 0) + Math.max(0, Math.round(Number(d.amount) || 0)) * 1000);
      r.stewards = [...(r.stewards || []), `${decisionText(d)}${d.reason ? ": " + d.reason : ""}`];
      if (r.orig_finish == null) r.orig_finish = r.finish_pos;
    }
    if (extra.size) {
      const lapsOf = r => r.laps ?? null, gap = r => r.interval_ms == null || r.interval_ms < 0 ? null : r.interval_ms + (extra.get(r) || 0);
      const out = [];
      for (let i = 0; i < order.length;) {
        let j = i;
        while (j < order.length && lapsOf(order[j]) === lapsOf(order[i]) && gap(order[j]) != null) j++;
        if (j === i) { out.push(order[i]); i++; continue; }      // no time to compare: stays where it is
        out.push(...order.slice(i, j).sort((a, b) => gap(a) - gap(b)));
        i = j;
      }
      order = out;
    }
    for (const d of acts.filter(d => d.kind !== "time")) {
      const r = order.find(x => x.cust_id === d.cust_id);
      if (!r) continue;
      const why = `${decisionText(d)}${d.reason ? ": " + d.reason : ""}`;
      r.stewards = [...(r.stewards || []), why];
      if (r.orig_finish == null) r.orig_finish = r.finish_pos;
      if (d.kind === "dq") { dq.add(r.cust_id); continue; }
      const i = order.indexOf(r), to = Math.min(order.length - 1, i + Math.max(0, Math.round(Number(d.amount) || 0)));
      order.splice(i, 1); order.splice(to, 0, r);
    }
    // disqualified drivers go to the back, in the order they finished
    order = [...order.filter(r => !dq.has(r.cust_id)), ...order.filter(r => dq.has(r.cust_id))];
    order.forEach((r, i) => {
      r.finish_pos = slots[i].finish;
      r.class_pos = i + 1;
      if (dq.has(r.cust_id)) { r.dq = true; r.league_points = r.league_points == null ? null : 0; r.reason_out = "Disqualified"; }
      else if (r.league_points != null && slots[i].points != null) r.league_points = slots[i].points;
    });
  }
  return out;
}
