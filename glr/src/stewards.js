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
 *   dq        disqualified: last in their class, no league points and no bonuses
 *
 * The places don't change hands: in a multi-class race each class keeps the overall finishing places it had, and the
 * league points iRacing gave for a place go to whoever ends up in it.
 */

export const KINDS = {
  none: "No action",
  warning: "Warning",
  points: "Points penalty",
  positions: "Position penalty",
  dq: "Disqualified",
};

// how a decision reads on the report and on the results: "Moved back 3 places", "-10 points", "Disqualified"
export function decisionText(d) {
  const n = Math.abs(Number(d.amount) || 0);
  if (d.kind === "points") return `${Number(d.amount) > 0 ? "+" : "-"}${n} point${n === 1 ? "" : "s"}`;
  if (d.kind === "positions") return `Moved back ${n} place${n === 1 ? "" : "s"}`;
  return KINDS[d.kind] || d.kind;
}

/**
 * rows: one race's result rows (session 'race'), any order. decisions: that race's decisions, oldest first.
 * Returns new row objects; untouched rows are copied as they are. A changed row gets orig_finish (its place before
 * the stewards) and stewards (["Moved back 3 places: reason", ...]); a disqualified one gets dq: true.
 */
export function applyDecisions(rows, decisions) {
  const acts = (decisions || []).filter(d => d.kind === "positions" || d.kind === "dq");
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
    for (const d of acts) {
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
