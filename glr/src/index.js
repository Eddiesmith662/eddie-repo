/*
 * VSPEED GLR league site (vspeedlivetiming.app/glr).
 *
 * Pages:  /glr                    races, newest first
 *         /glr/results/<session>  one race (iRacing subsession id), with qualifying and practice when uploaded
 *         /glr/drivers/<cust id>  one driver: every name they've raced under, and their races
 * Data:   /glr/api/events, /glr/api/results/<session>, /glr/api/drivers/<cust id>   (the same, as JSON)
 *         /glr/health
 * Uploads stay switched off until officials can sign in.
 */
import { listEvents, getEvent, getDriver } from "./db.js";

const BASE = "/glr";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const lap = ms => { if (!ms) return ""; const s = ms / 1000, m = Math.floor(s / 60); return m ? `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}` : s.toFixed(3); };
const gap = r => r.laps_down ? `-${r.laps_down} L` : r.finish_pos === 1 ? "" : r.interval_ms != null ? `-${(r.interval_ms / 1000).toFixed(3)}` : "";
const day = t => { const d = new Date(t); return isNaN(d) ? esc(t) : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" }); };

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{--bg:#141416;--card:#1d1d21;--line:#2c2c32;--text:#eee;--dim:#9a9aa3;--accent:#FF0D40}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif}
header{border-bottom:1px solid var(--line);padding:12px 16px}header a{color:var(--text);text-decoration:none;font-weight:700;letter-spacing:.04em}
header a span{color:var(--accent)}main{max-width:1000px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 4px;border-left:4px solid var(--accent);padding-left:10px}h2{font-size:16px;margin:28px 0 8px}
.sub{color:var(--dim);margin:0 0 18px;padding-left:14px}a{color:#7fb6ff}.hint{color:var(--dim)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 10px;text-align:left;white-space:nowrap}
th{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--line)}
tr+tr td{border-top:1px solid var(--line)}td.n,th.n{text-align:right}.stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:90px}
.stat b{display:block;font-size:20px}.stat small{color:var(--dim)}.tag{color:var(--dim);font-size:13px}
</style></head><body><header><a href="${BASE}">VSPEED <span>GLR</span></a></header><main>${body}</main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const notFound = what => page("Not found", `<h1>Not found</h1><p class="sub">${esc(what)}</p>`, 404);
const driverLink = (id, name) => `<a href="${BASE}/drivers/${id}">${esc(name)}</a>`;

function homePage(events) {
  if (!events.length) return page("VSPEED GLR", `<h1>Results</h1><p class="sub">No races uploaded yet.</p>`);
  const bySeason = new Map();
  for (const e of events) { const k = e.season_name || e.series_name || "Other races"; if (!bySeason.has(k)) bySeason.set(k, []); bySeason.get(k).push(e); }
  let body = `<h1>Results</h1><p class="sub">${events.length} race${events.length === 1 ? "" : "s"}</p>`;
  for (const [season, list] of bySeason) {
    body += `<h2>${esc(season)}</h2><div class="wrap"><table><tr><th>Date</th><th>Track</th><th>Winner</th><th class="n">Starters</th><th class="n">Laps</th></tr>` +
      list.map(e => `<tr><td><a href="${BASE}/results/${e.subsession_id}">${day(e.start_time)}</a></td><td>${esc(e.track)}</td>
        <td>${e.winner_id ? driverLink(e.winner_id, e.winner) : ""}</td><td class="n">${e.starters}</td><td class="n">${e.laps ?? ""}</td></tr>`).join("") +
      `</table></div>`;
  }
  return page("VSPEED GLR results", body);
}

function sessionTable(rows, race) {
  return `<div class="wrap"><table><tr><th class="n">Pos</th><th>#</th><th>Driver</th>${race ? `<th class="n">Start</th><th class="n">Gap</th><th class="n">Laps</th><th class="n">Led</th>` : ""}
    <th class="n">Best lap</th>${race ? `<th class="n">Avg lap</th>` : ""}<th class="n">Inc</th>${race ? `<th>Status</th><th class="n">Pts</th>` : ""}</tr>` +
    rows.map(r => `<tr><td class="n">${r.finish_pos ?? ""}</td><td>${esc(r.car_number)}</td><td>${driverLink(r.cust_id, r.name)}</td>
      ${race ? `<td class="n">${r.start_pos ?? ""}</td><td class="n">${gap(r)}</td><td class="n">${r.laps ?? ""}</td><td class="n">${r.laps_led || ""}</td>` : ""}
      <td class="n">${lap(r.best_lap_ms)}</td>${race ? `<td class="n">${lap(r.avg_lap_ms)}</td>` : ""}<td class="n">${r.incidents ?? ""}</td>
      ${race ? `<td>${esc(r.reason_out)}</td><td class="n">${r.league_points ?? ""}</td>` : ""}</tr>`).join("") + `</table></div>`;
}

function resultPage(ev) {
  const facts = [ev.laps != null && `${ev.laps} laps`, ev.cautions != null && `${ev.cautions} caution${ev.cautions === 1 ? "" : "s"}${ev.caution_laps ? ` (${ev.caution_laps} laps)` : ""}`,
    ev.lead_changes != null && `${ev.lead_changes} lead changes`, ev.sof && `SOF ${ev.sof}`].filter(Boolean).join(" · ");
  let body = `<h1>${esc(ev.track)}</h1><p class="sub">${day(ev.start_time)}${ev.season_name ? " · " + esc(ev.season_name) : ""}${facts ? " · " + facts : ""}</p>`;
  const names = { race: "Race", qualify: "Qualifying", practice: "Practice", warmup: "Warmup" };
  for (const s of ["race", "qualify", "warmup", "practice", ...Object.keys(ev.sessions).filter(k => !names[k])])
    if (ev.sessions[s]) body += `<h2>${esc(names[s] || s)}</h2>` + sessionTable(ev.sessions[s], s === "race");
  body += `<p class="tag">iRacing session ${ev.subsession_id}</p>`;
  return page(`${ev.track} results`, body);
}

function driverPage(d) {
  const r = d.races, n = r.length, fin = r.filter(x => x.finish_pos);
  const avg = k => { const v = r.filter(x => x[k]); return v.length ? (v.reduce((s, x) => s + x[k], 0) / v.length).toFixed(1) : "–"; };
  const stats = [["Starts", n], ["Wins", fin.filter(x => x.finish_pos === 1).length], ["Top 5", fin.filter(x => x.finish_pos <= 5).length],
    ["Top 10", fin.filter(x => x.finish_pos <= 10).length], ["Avg finish", avg("finish_pos")], ["Avg start", avg("start_pos")],
    ["Laps led", r.reduce((s, x) => s + (x.laps_led || 0), 0)]];
  const other = d.names.filter(x => x.name !== d.name).map(x => esc(x.name));
  let body = `<h1>${esc(d.name)}</h1><p class="sub">iRacing ID ${d.cust_id}${other.length ? " · also raced as " + other.join(", ") : ""}</p>
    <div class="stats">${stats.map(([k, v]) => `<div class="stat"><b>${v}</b><small>${k}</small></div>`).join("")}</div>`;
  body += `<h2>Races</h2><div class="wrap"><table><tr><th>Date</th><th>Track</th><th class="n">Start</th><th class="n">Finish</th><th class="n">Laps</th>
    <th class="n">Led</th><th class="n">Inc</th><th>Status</th><th class="n">Pts</th></tr>` +
    r.map(x => `<tr><td><a href="${BASE}/results/${x.subsession_id}">${day(x.start_time)}</a></td><td>${esc(x.track)}</td><td class="n">${x.start_pos ?? ""}</td>
      <td class="n">${x.finish_pos ?? ""}${x.starters ? `<span class="tag"> / ${x.starters}</span>` : ""}</td><td class="n">${x.laps ?? ""}</td>
      <td class="n">${x.laps_led || ""}</td><td class="n">${x.incidents ?? ""}</td><td>${esc(x.reason_out)}</td><td class="n">${x.league_points ?? ""}</td></tr>`).join("") +
    `</table></div>`;
  return page(d.name, body);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const db = env.DB;
    try {
      if (path === `${BASE}/health`) {
        let state = "not connected";
        try { state = (await db.prepare("SELECT 1 AS ok").first()).ok === 1 ? "connected" : "unexpected answer"; } catch (e) { state = "error: " + e.message; }
        return json({ ok: state === "connected", db: state });
      }
      let m;
      if (path === `${BASE}/api/upload`) return json({ ok: false, error: "Uploads open once officials can sign in." }, 403);
      if (path === `${BASE}/api/events`) return json({ ok: true, events: await listEvents(db, { season: Number(url.searchParams.get("season")) || 0 }) });
      if ((m = path.match(/^\/glr\/api\/results\/(\d+)$/))) { const ev = await getEvent(db, Number(m[1])); return ev ? json({ ok: true, event: ev }) : json({ ok: false, error: "No such race" }, 404); }
      if ((m = path.match(/^\/glr\/api\/drivers\/(\d+)$/))) { const d = await getDriver(db, Number(m[1])); return d ? json({ ok: true, driver: d }) : json({ ok: false, error: "No such driver" }, 404); }
      if (path === BASE) return homePage(await listEvents(db));
      if ((m = path.match(/^\/glr\/results\/(\d+)$/))) { const ev = await getEvent(db, Number(m[1])); return ev ? resultPage(ev) : notFound("No race with that session number has been uploaded."); }
      if ((m = path.match(/^\/glr\/drivers\/(\d+)$/))) { const d = await getDriver(db, Number(m[1])); return d ? driverPage(d) : notFound("No driver with that iRacing ID has raced here yet."); }
      return notFound("Check the link.");
    } catch (e) {
      console.error(e);
      return path.startsWith(`${BASE}/api/`) ? json({ ok: false, error: "Something went wrong on the server." }, 500)
        : page("Error", `<h1>Something went wrong</h1><p class="sub">Try again in a minute.</p>`, 500);
    }
  },
};
