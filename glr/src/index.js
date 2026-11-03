/*
 * VSPEED GLR league site (vspeedlivetiming.app/glr).
 *
 * Pages:  /glr                    every series with its latest race, then the latest races
 *         /glr/<series>           one series (its short address, e.g. /glr/arca): seasons and races
 *         /glr/<series>/standings  standings for a season (?season=<id>, newest by default), by class when multi-class
 *         /glr/<series>/rules     the season's points and playoff rules; that series' officials can change them
 *         /glr/<series>/penalties points penalties and adjustments, with reasons
 *         /glr/<series>/edit      officials: the series' short name and address; admins: its Discord role
 *         /glr/results/<session>  one race (iRacing subsession id), split by class in a multi-class race
 *         /glr/drivers/<cust id>  one driver: every name they've raced under, stats and races by series
 * Data:   /glr/api/series, /glr/api/series/<series>, /glr/api/events, /glr/api/results/<session>,
 *         /glr/api/drivers/<cust id>, /glr/api/standings/<series>?season=<id>   (the same, as JSON)
 *         /glr/health
 *         /glr/upload             officials upload iRacing result files (JSON or CSV)
 *         /glr/login, /glr/auth/callback, /glr/logout    Discord sign-in (auth.js)
 */
import { listEvents, listSeries, getSeries, updateSeries, getEvent, getDriver, importEvent, setSeriesRole, seriesById, seasonsOf,
  getRules, saveRules, seasonEvents, listAdjustments, addAdjustment, deleteAdjustment } from "./db.js";
import { computeStandings, cleanRules, DEFAULT_RULES, GLR_PLAYOFFS } from "./standings.js";
import { parseExport } from "./parse.js";
import { configured, login, callback, currentUser, logout, canEdit } from "./auth.js";

const BASE = "/glr";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const lap = ms => { if (!ms) return ""; const s = ms / 1000, m = Math.floor(s / 60); return m ? `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}` : s.toFixed(3); };
// gap to the leader; in a multi-class race, to the class leader
const gap = (r, inClass) => {
  const pos = inClass ? r.class_pos ?? r.finish_pos : r.finish_pos;
  const down = inClass ? r.class_laps_down ?? r.laps_down : r.laps_down, iv = inClass ? r.class_interval_ms : r.interval_ms;
  return down ? `-${down} L` : pos === 1 ? "" : iv != null ? `-${(iv / 1000).toFixed(3)}` : "";
};
const day = t => { const d = new Date(t); return isNaN(d) ? esc(t) : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" }); };

const page = (title, body, { status = 200, user = null } = {}) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
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
tr+tr td{border-top:1px solid var(--line)}header{display:flex;align-items:center;gap:14px}header .me{margin-left:auto;display:flex;gap:12px;align-items:center;font-size:14px}
header .me a{font-weight:400;letter-spacing:0;color:#7fb6ff}header form{margin:0}button.link{background:none;border:0;color:#7fb6ff;font:inherit;cursor:pointer;padding:0}
.drop{border:2px dashed var(--line);border-radius:10px;padding:28px;text-align:center;background:var(--card)}.drop.on{border-color:var(--accent)}
.btn{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
.msg{margin:6px 0;padding:8px 12px;border-radius:6px;background:var(--card);border:1px solid var(--line)}.msg.bad{border-color:#a33}.msg.ok{border-color:#2a7}td.n,th.n{text-align:right}.stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:90px}
.stat b{display:block;font-size:20px}.stat small{color:var(--dim)}.tag{color:var(--dim);font-size:13px}
.crumb{font-size:13px;margin:0 0 6px;padding-left:14px}.crumb a{color:var(--dim)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;color:var(--text);text-decoration:none}
.card:hover{border-color:#44444c}.card b{display:block;font-size:18px;border-left:3px solid var(--accent);padding-left:8px;margin-bottom:2px}
.card .full{color:var(--dim);font-size:12px;padding-left:11px;margin-bottom:10px}.card .row{font-size:14px}.card .row span{color:var(--dim)}
.cls{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;background:#2c2c32;color:#ddd;margin-right:4px}
label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px}
.tabs{display:flex;gap:4px;margin:0 0 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}.tabs a{padding:8px 14px;color:var(--dim);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.on{color:var(--text);border-bottom-color:var(--accent)}.tabs .season{margin-left:auto;align-self:center}
select,input[type=number]{padding:7px 9px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
input[type=number]{width:90px}tr.cut td{border-top:2px solid var(--accent)!important}.st{font-size:12px;font-weight:600;color:#ffb84d}.st.good{color:#4fd18b}.st.bad{color:#ff6b6b}
fieldset{min-width:0;border:1px solid var(--line);border-radius:8px;margin:16px 0;padding:6px 16px 14px}legend{padding:0 6px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px 16px}.chk{display:flex;gap:8px;align-items:center;margin:8px 0;color:var(--text);font-size:14px}
.rules p{margin:6px 0}details{margin:14px 0}summary{cursor:pointer;color:var(--dim)}.btn.ghost{background:#2c2c32}input[type=text]{width:100%;max-width:360px;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
</style></head><body><header><a href="${BASE}">VSPEED <span>GLR</span></a><div class="me">${user
  ? `<a href="${BASE}/upload">Upload results</a><span class="tag">${esc(user.name)}</span><form method="post" action="${BASE}/logout"><button class="link">Sign out</button></form>`
  : `<a href="${BASE}/login">Official sign-in</a>`}</div></header><main>${body}</main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const notFound = (what, user) => page("Not found", `<h1>Not found</h1><p class="sub">${esc(what)}</p>`, { status: 404, user });
const driverLink = (id, name) => `<a href="${BASE}/drivers/${id}">${esc(name)}</a>`;
const seriesLink = e => e.slug ? `<a href="${BASE}/${esc(e.slug)}">${esc(e.short_name)}</a>` : esc(e.series_name || "");
const crumb = e => e.slug ? `<p class="crumb"><a href="${BASE}">GLR</a> › <a href="${BASE}/${esc(e.slug)}">${esc(e.short_name)}</a></p>` : "";
const cls = c => c ? `<span class="cls">${esc(c)}</span>` : "";
// "Name" for one winner; "[LMP2] Name · [GT3] Name" for a multi-class race
const winnersHtml = ws => ws.map(w => (ws.length > 1 ? cls(w.carClass) : "") + driverLink(w.custId, w.name)).join(" · ");

function raceTable(events, { series = false } = {}) {
  return `<div class="wrap"><table><tr><th>Date</th>${series ? "<th>Series</th>" : ""}<th>Track</th><th>Winner</th><th class="n">Starters</th><th class="n">Laps</th></tr>` +
    events.map(e => `<tr><td><a href="${BASE}/results/${e.subsession_id}">${day(e.start_time)}</a></td>${series ? `<td>${seriesLink(e)}</td>` : ""}
      <td>${esc(e.track)}</td><td>${winnersHtml(e.winners)}</td><td class="n">${e.starters}</td><td class="n">${e.laps ?? ""}</td></tr>`).join("") + `</table></div>`;
}

function homePage(series, recent, user) {
  if (!series.length) return page("VSPEED GLR", `<h1>Results</h1><p class="sub">No races uploaded yet.</p>`, { user });
  let body = `<h1>Series</h1><p class="sub">${series.length} series</p><div class="cards">` +
    series.map(s => { const e = s.latestEvent; return `<a class="card" href="${BASE}/${esc(s.slug)}"><b>${esc(s.short_name)}</b><div class="full">${esc(s.name)}</div>
      ${e ? `<div class="row"><span>Latest:</span> ${esc(e.track)}, ${day(e.start_time)}</div>
        <div class="row"><span>Won by</span> ${e.winners.map(w => (e.winners.length > 1 ? cls(w.carClass) : "") + esc(w.name)).join(" · ")}</div>` : ""}
      <div class="row"><span>${s.races} race${s.races === 1 ? "" : "s"} uploaded</span></div></a>`; }).join("") + `</div>`;
  body += `<h2>Latest races</h2>` + raceTable(recent, { series: true });
  return page("VSPEED GLR results", body, { user });
}

function seriesPage(sr, user) {
  let body = seriesTabs(sr, "results", [], null, user);
  if (!sr.seasons.length) body += `<p class="hint">No races uploaded yet.</p>`;
  for (const se of sr.seasons) body += `<h2>${esc(se.name)}</h2>` + raceTable(se.events);
  return page(`${sr.short_name} results`, body, { user });
}

function seriesEditPage(sr, user, err = "") {
  return page(`Edit ${sr.short_name}`, `<p class="crumb"><a href="${BASE}">GLR</a> › <a href="${BASE}/${esc(sr.slug)}">${esc(sr.short_name)}</a></p>
    <h1>Edit series</h1><p class="sub">${esc(sr.name)} · iRacing league ${sr.id}</p>${err ? `<div class="msg bad">${esc(err)}</div>` : ""}
    <form method="post"><label for="sn">Short name (shown on the site)</label><input type="text" id="sn" name="short_name" value="${esc(sr.short_name)}" maxlength="40" required>
    <label for="sl">Address: vspeedlivetiming.app/glr/…</label><input type="text" id="sl" name="slug" value="${esc(sr.slug)}" maxlength="40">
    <p class="tag">Changing the address breaks old links to this series. Race and driver links aren't affected.</p>
    ${user && user.admin ? `<label for="rl">Discord role for this series' officials (role ID; leave empty for admins only)</label>
    <input type="text" id="rl" name="role_id" value="${esc(sr.role_id || "")}" maxlength="25" inputmode="numeric">
    <p class="tag">People with this role can sign in and change only this series: its rules, penalties, results uploads and this page. In Discord: Server Settings › Roles › right-click the role › Copy Role ID.</p>` : ""}
    <p><button class="btn">Save</button></p></form>`, { user });
}

function sessionTable(rows, race, inClass) {
  return `<div class="wrap"><table><tr><th class="n">Pos</th>${inClass ? `<th class="n">Overall</th>` : ""}<th>#</th><th>Driver</th>${race ? `<th class="n">Start</th><th class="n">Gap</th><th class="n">Laps</th><th class="n">Led</th>` : ""}
    <th class="n">Best lap</th>${race ? `<th class="n">Avg lap</th>` : ""}<th class="n">Inc</th>${race ? `<th>Status</th><th class="n">Pts</th>` : ""}</tr>` +
    rows.map(r => `<tr><td class="n">${(inClass ? r.class_pos : r.finish_pos) ?? ""}</td>${inClass ? `<td class="n tag">${r.finish_pos ?? ""}</td>` : ""}
      <td>${esc(r.car_number)}</td><td>${driverLink(r.cust_id, r.name)}</td>
      ${race ? `<td class="n">${r.start_pos ?? ""}</td><td class="n">${gap(r, inClass)}</td><td class="n">${r.laps ?? ""}</td><td class="n">${r.laps_led || ""}</td>` : ""}
      <td class="n">${lap(r.best_lap_ms)}</td>${race ? `<td class="n">${lap(r.avg_lap_ms)}</td>` : ""}<td class="n">${r.incidents ?? ""}</td>
      ${race ? `<td>${esc(r.reason_out)}</td><td class="n">${r.league_points ?? ""}</td>` : ""}</tr>`).join("") + `</table></div>`;
}

// a session's rows, one table per class when there's more than one (classes in the order their best car finished)
function sessionTables(rows, race, label) {
  const classes = [...new Set(rows.map(r => r.car_class))];
  if (classes.length < 2) return `<h2>${esc(label)}</h2>` + sessionTable(rows, race, false);
  return classes.map(c => `<h2>${esc(label)} ${cls(c)}</h2>` + sessionTable(rows.filter(r => r.car_class === c), race, race)).join("");
}

function resultPage(ev, user) {
  const facts = [ev.laps != null && `${ev.laps} laps`, ev.cautions != null && `${ev.cautions} caution${ev.cautions === 1 ? "" : "s"}${ev.caution_laps ? ` (${ev.caution_laps} laps)` : ""}`,
    ev.lead_changes != null && `${ev.lead_changes} lead changes`, ev.sof && `SOF ${ev.sof}`].filter(Boolean).join(" · ");
  let body = crumb(ev) + `<h1>${esc(ev.track)}</h1><p class="sub">${day(ev.start_time)}${ev.season_name ? " · " + esc(ev.season_name) : ""}${facts ? " · " + facts : ""}</p>`;
  const names = { race: "Race", qualify: "Qualifying", practice: "Practice", warmup: "Warmup" };
  for (const s of ["race", "qualify", "warmup", "practice", ...Object.keys(ev.sessions).filter(k => !names[k])])
    if (ev.sessions[s]) body += sessionTables(ev.sessions[s], s === "race", names[s] || s);
  body += `<p class="tag">iRacing session ${ev.subsession_id}</p>`;
  return page(`${ev.track} results`, body, { user });
}

// in a multi-class race a driver's finish is their place in class
const place = x => x.class_count > 1 ? x.class_pos ?? x.finish_pos : x.finish_pos;
function statCards(r) {
  const fin = r.filter(x => place(x));
  const avg = f => { const v = r.map(f).filter(Boolean); return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : "–"; };
  return `<div class="stats">${[["Starts", r.length], ["Wins", fin.filter(x => place(x) === 1).length], ["Top 5", fin.filter(x => place(x) <= 5).length],
    ["Top 10", fin.filter(x => place(x) <= 10).length], ["Avg finish", avg(place)], ["Avg start", avg(x => x.start_pos)],
    ["Laps led", r.reduce((s, x) => s + (x.laps_led || 0), 0)]].map(([k, v]) => `<div class="stat"><b>${v}</b><small>${k}</small></div>`).join("")}</div>`;
}

function driverPage(d, user) {
  const other = d.names.filter(x => x.name !== d.name).map(x => esc(x.name));
  const bySeries = new Map();
  for (const x of d.races) { const k = x.series_id || 0; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(x); }
  let body = `<h1>${esc(d.name)}</h1><p class="sub">iRacing ID ${d.cust_id}${other.length ? " · also raced as " + other.join(", ") : ""}</p>`;
  if (bySeries.size > 1) body += `<h2>Career</h2>` + statCards(d.races);
  for (const races of bySeries.values()) {
    const x0 = races[0];
    body += `<h2>${x0.slug ? `<a href="${BASE}/${esc(x0.slug)}">${esc(x0.short_name)}</a>` : esc(x0.series_name || "Other races")}</h2>` + statCards(races) +
      `<div class="wrap"><table><tr><th>Date</th><th>Track</th><th class="n">Start</th><th class="n">Finish</th><th class="n">Laps</th>
      <th class="n">Led</th><th class="n">Inc</th><th>Status</th><th class="n">Pts</th></tr>` +
      races.map(x => { const multi = x.class_count > 1; return `<tr><td><a href="${BASE}/results/${x.subsession_id}">${day(x.start_time)}</a></td><td>${esc(x.track)}</td>
        <td class="n">${x.start_pos ?? ""}</td><td class="n">${multi ? cls(x.car_class) : ""}${place(x) ?? ""}<span class="tag"> / ${multi ? x.class_starters : x.starters}</span></td>
        <td class="n">${x.laps ?? ""}</td><td class="n">${x.laps_led || ""}</td><td class="n">${x.incidents ?? ""}</td><td>${esc(x.reason_out)}</td>
        <td class="n">${x.league_points ?? ""}</td></tr>`; }).join("") + `</table></div>`;
  }
  return page(d.name, body, { user });
}

function seriesTabs(sr, on, seasons, seasonId, user) {
  const q = seasonId && seasons.length > 1 ? `?season=${seasonId}` : "";
  const t = (k, label, href) => `<a class="${on === k ? "on" : ""}" href="${BASE}/${esc(sr.slug)}${href}${k === "results" ? "" : q}">${label}</a>`;
  const pick = on !== "results" && seasons.length > 1 ? `<form class="season" method="get"><select name="season" onchange="this.form.submit()">${seasons.map(se =>
    `<option value="${se.id}"${se.id === seasonId ? " selected" : ""}>${esc(se.name)}</option>`).join("")}</select></form>` : "";
  return `<p class="crumb"><a href="${BASE}">GLR</a></p><h1>${esc(sr.short_name)}</h1><p class="sub">${esc(sr.name)}${canEdit(user, sr) ? ` · <a href="${BASE}/${esc(sr.slug)}/edit">Edit series</a>` : ""}</p>
    <nav class="tabs">${t("results", "Results", "")}${t("standings", "Standings", "/standings")}${t("rules", "Rules", "/rules")}${t("penalties", "Penalties", "/penalties")}${pick}</nav>`;
}

const pickSeason = (seasons, url) => { const want = Number(url.searchParams.get("season")); return seasons.find(se => se.id === want) || seasons[0] || null; };

async function seasonStandings(db, sr, season) {
  const r = await getRules(db, season.id, sr.id);
  const rules = cleanRules(r.rules || DEFAULT_RULES);
  const [events, adj] = await Promise.all([seasonEvents(db, season.id), listAdjustments(db, season.id)]);
  return { info: r, rules, adj, events, ...computeStandings(rules, events, adj) };
}

const num = v => (v > 0 ? `+${v}` : `${v}`);
function regularTable(list, rules, { cutAfter = 0, playoffNote = false } = {}) {
  const drops = rules.drops > 0;
  return `<div class="wrap"><table><tr><th class="n">Pos</th><th>#</th><th>Driver</th><th class="n">Pts</th><th class="n">Behind</th>${drops ? `<th class="n">Dropped</th>` : ""}
    <th class="n">Starts</th><th class="n">Wins</th><th class="n">Top 5</th><th class="n">Top 10</th><th class="n">Led</th>${playoffNote ? "<th>Playoffs</th>" : ""}</tr>` +
    list.map((s, i) => `<tr${cutAfter && i === cutAfter ? ' class="cut"' : ""}><td class="n">${s.pos}</td><td>${esc(s.number)}</td><td>${driverLink(s.custId, s.name)}</td>
      <td class="n"><b>${s.points}</b></td><td class="n">${s.behind ? -s.behind : ""}</td>${drops ? `<td class="n tag">${s.dropped || ""}</td>` : ""}
      <td class="n">${s.starts}</td><td class="n">${s.wins || ""}</td><td class="n">${s.top5 || ""}</td><td class="n">${s.top10 || ""}</td><td class="n">${s.lapsLed || ""}</td>
      ${playoffNote ? `<td>${s.inField ? '<span class="st good">In</span>' : s.needStarts ? `<span class="st">Needs ${s.needStarts} more start${s.needStarts === 1 ? "" : "s"}</span>` : ""}</td>` : ""}</tr>`).join("") + `</table></div>`;
}

function roundTable(rd) {
  const statusCls = t => /Advanced|Champion/.test(t) ? "good" : /Out/.test(t) ? "bad" : "";
  let cutIdx = 0;
  if (!rd.finale && rd.spots < rd.rows.length) cutIdx = rd.rows.findIndex(r => !r.through);
  return `<div class="wrap"><table><tr><th class="n">Pos</th><th>#</th><th>Driver</th><th class="n">Pts</th><th class="n">${rd.finale ? "Behind" : "To cut"}</th><th class="n">Bonus</th>
    <th class="n">Wins</th><th class="n">Starts</th><th>Status</th></tr>` +
    rd.rows.map((r, i) => `<tr${cutIdx > 0 && i === cutIdx ? ' class="cut"' : ""}><td class="n">${r.pos}</td><td>${esc(r.number)}</td><td>${driverLink(r.custId, r.name)}</td>
      <td class="n"><b>${r.points}</b></td><td class="n">${rd.finale ? (r.behind ? -r.behind : "") : r.toCut != null && !/win/.test(r.status) ? num(r.toCut) : ""}</td>
      <td class="n tag">${r.bonus || ""}</td><td class="n">${r.wins || ""}</td><td class="n">${r.starts}</td>
      <td>${r.status ? `<span class="st ${statusCls(r.status)}">${esc(r.status)}</span>` : ""}</td></tr>`).join("") + `</table></div>`;
}

function standingsBody(st) {
  const { rules } = st, po = rules.playoffs;
  let body = "";
  if (!st.info.rules) body += `<p class="hint">Using iRacing's league points. This series' officials can set its own rules on the Rules tab.</p>`;
  else if (!st.info.own) body += `<p class="hint">Using the rules from ${esc(st.info.from)}.</p>`;
  if (!st.events.length) return body + `<p class="hint">No races uploaded for this season yet.</p>`;
  if (st.skipped) body += `<p class="tag">${st.skipped} race${st.skipped === 1 ? "" : "s"} not counted (see Rules).</p>`;
  for (const g of st.groups) {
    if (st.groups.length > 1) body += `<h2 style="margin-top:30px">${cls(g.carClass)} class</h2>`;
    const p = g.playoffs;
    if (po.enabled && p && p.started) {
      const cur = p.current;
      const champ = cur.finale && cur.complete;
      body += `<h2>${esc(cur.name)}${champ ? " (final)" : ` · race ${Math.min(cur.ran + (cur.complete ? 0 : 1), cur.races)} of ${cur.races}`}</h2>`;
      if (!cur.finale) body += `<p class="tag">${cur.spots} go through to the next round${cur.winAdvances ? "; a win in this round guarantees a spot" : ""}${cur.missMustWin ? "; a driver who misses a race must win to go through" : ""}.${cur.tieAtCut ? " <b>Drivers are tied on points at the cut</b> — officials settle it." : ""}</p>`;
      body += roundTable(cur);
      for (const rd of [...p.rounds].reverse().slice(1)) {
        const out = p.eliminated.filter(x => x.outIn === rd.name);
        if (out.length) body += `<h2>Out in the ${esc(rd.name)}</h2>` + roundTable({ ...rd, rows: out, spots: 99 });
      }
      if (p.others.length) body += `<h2>Rest of the field</h2>` + regularTable(p.others, rules);
      body += `<details><summary>Regular season</summary>${regularTable(g.regular, rules, { playoffNote: true })}</details>`;
    } else {
      const inField = g.regular.filter(s => s.inField).length;
      const cutAfter = po.enabled ? g.regular.findIndex((s, i) => i > 0 && !s.inField && g.regular.slice(0, i).filter(x => x.inField).length === inField) : 0;
      body += `<h2>${po.enabled ? "Regular season" : "Standings"} · ${g.regularRan} of ${po.enabled ? g.regularRaces : g.races.length} race${g.regularRan === 1 ? "" : "s"}</h2>`;
      if (po.enabled) body += `<p class="tag">Top ${po.field}${po.minStarts ? ` with at least ${po.minStarts} starts` : ""} make the playoffs${g.regularComplete ? "" : " (as things stand)"}.</p>`;
      body += regularTable(g.regular, rules, { cutAfter: cutAfter > 0 ? cutAfter : 0, playoffNote: po.enabled });
    }
  }
  if (st.adj.length) body += `<p class="tag">Includes ${st.adj.length} penalt${st.adj.length === 1 ? "y or adjustment" : "ies or adjustments"} — see Penalties.</p>`;
  return body;
}

function standingsPage(sr, seasons, season, st, user) {
  let body = seriesTabs(sr, "standings", seasons, season && season.id, user);
  body += season ? `<p class="tag">${esc(season.name)}</p>` + standingsBody(st) : `<p class="hint">No races uploaded yet.</p>`;
  return page(`${sr.short_name} standings`, body, { user });
}

function rulesSummary(rules, events) {
  const p = rules.points, b = rules.bonus, po = rules.playoffs;
  const bon = [["win", b.win], ["pole", b.pole], ["leading a lap", b.led], ["most laps led", b.mostLed], ["fastest lap", b.fastLap]].filter(x => x[1]).map(([k, v]) => `${num(v)} for ${k}`);
  let h = `<div class="rules"><p><b>Points:</b> ${p.source === "iracing" ? "iRacing's league points for each race." : `by finishing position: ${p.table.map((v, i) => `P${i + 1} ${v}`).join(", ")}${p.others ? `; every other finisher ${p.others}` : ""}.`}</p>`;
  if (bon.length) h += `<p><b>Bonus points:</b> ${bon.join(", ")}.</p>`;
  h += `<p><b>Positions:</b> ${rules.byClass ? "by class in multi-class races" : "overall"}. <b>Ties:</b> ${rules.ties === "wins" ? "more wins, then better finishes" : "drivers level on points share the position"}.</p>`;
  if (rules.drops) h += `<p><b>Drop weeks:</b> each driver's ${rules.drops} worst race${rules.drops === 1 ? "" : "s"} ${po.enabled ? "of the regular season " : ""}don't count.</p>`;
  const skipped = events.filter(e => rules.skip.includes(e.subsession_id));
  if (skipped.length) h += `<p><b>Not counted:</b> ${skipped.map(e => `${esc(e.track)} (${day(e.start_time)})`).join(", ")}.</p>`;
  if (po.enabled) {
    h += `<p><b>Playoffs:</b> after ${po.regularRaces} regular-season races, the top ${po.field}${po.minStarts ? ` with at least ${po.minStarts} starts` : ""} go into the playoffs.`;
    if (po.seedBonus.length || po.winBonus) h += ` Bonus points: ${[po.seedBonus.length && `${po.seedBonus.join("/")} for finishing ${po.seedBonus.map((_, i) => i + 1).join("/")} in the regular season`, po.winBonus && `${po.winBonus} per win`].filter(Boolean).join(", ")}.`;
    h += `</p><div class="wrap"><table><tr><th>Round</th><th class="n">Races</th><th class="n">Drivers</th><th class="n">Points reset to</th><th>Bonuses</th><th>Notes</th></tr>` +
      po.rounds.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${r.races}</td><td class="n">${r.drivers}</td><td class="n">${r.reset}</td><td>${r.bonuses ? "Added" : "None"}</td>
        <td>${[r.finale && "Best finisher is champion", !r.finale && r.winAdvances && "A win goes through", r.missMustWin && "Miss a race: must win"].filter(Boolean).join(" · ")}</td></tr>`).join("") + `</table></div>`;
  }
  return h + `</div>`;
}

function rulesForm(rules, events) {
  const p = rules.points, b = rules.bonus, po = rules.playoffs;
  const n = (name, v, label) => `<label>${label}<br><input type="number" name="${name}" value="${esc(v)}"></label>`;
  const rounds = [...po.rounds]; while (rounds.length < 5) rounds.push({ name: "", races: "", drivers: "", reset: "", bonuses: false, winAdvances: true, missMustWin: true, finale: false });
  return `<form method="post" id="rf">
  <fieldset><legend>Points</legend>
    <label class="chk"><input type="radio" name="source" value="iracing"${p.source === "iracing" ? " checked" : ""}> iRacing's league points (as set in the iRacing league)</label>
    <label class="chk"><input type="radio" name="source" value="table"${p.source === "table" ? " checked" : ""}> Our own points table</label>
    <label for="tbl">Points for 1st, 2nd, 3rd… (commas)</label><input type="text" id="tbl" name="table" value="${esc(p.table.join(", "))}" style="max-width:100%">
    <div class="grid">${n("others", p.others, "Every other finisher")}</div>
  </fieldset>
  <fieldset><legend>Bonus points (each race)</legend><div class="grid">${n("b_win", b.win, "Win")}${n("b_pole", b.pole, "Pole (best start)")}${n("b_led", b.led, "Led a lap")}${n("b_mostLed", b.mostLed, "Most laps led")}${n("b_fastLap", b.fastLap, "Fastest lap")}</div>
    <p class="tag">If iRacing's league points already include bonuses, leave these at 0.</p></fieldset>
  <fieldset><legend>Season</legend><div class="grid">${n("drops", rules.drops, "Drop worst races")}</div>
    <label class="chk"><input type="checkbox" name="byClass"${rules.byClass ? " checked" : ""}> Multi-class races: standings per class</label>
    <label for="ties">Ties</label><select id="ties" name="ties"><option value="share"${rules.ties === "share" ? " selected" : ""}>Share the position</option><option value="wins"${rules.ties === "wins" ? " selected" : ""}>More wins, then better finishes</option></select>
    ${events.length ? `<label>Races that count</label>${events.map(e => `<label class="chk"><input type="checkbox" name="count" value="${e.subsession_id}"${rules.skip.includes(e.subsession_id) ? "" : " checked"}> ${day(e.start_time)} · ${esc(e.track)}</label>`).join("")}` : ""}
  </fieldset>
  <fieldset><legend>Playoffs</legend>
    <label class="chk"><input type="checkbox" name="po" id="po"${po.enabled ? " checked" : ""}> This season has playoffs</label>
    <p><button type="button" class="btn ghost" id="glr">Fill in the GLR playoff format</button></p>
    <div class="grid">${n("regularRaces", po.regularRaces, "Regular season races")}${n("minStarts", po.minStarts, "Minimum starts")}${n("field", po.field, "Drivers in")}${n("winBonus", po.winBonus, "Bonus per win")}</div>
    <label for="seed">Bonus for regular-season 1st, 2nd, 3rd… (commas)</label><input type="text" id="seed" name="seedBonus" value="${esc(po.seedBonus.join(", "))}">
    <div class="wrap" style="margin-top:12px"><table><tr><th>Round name</th><th>Races</th><th>Drivers</th><th>Reset to</th><th>Add bonuses</th><th>Win goes through</th><th>Miss = must win</th><th>Final</th></tr>
    ${rounds.map((r, i) => `<tr><td><input type="text" name="r${i}_name" value="${esc(r.name)}" style="width:150px"></td><td><input type="number" name="r${i}_races" value="${esc(r.races)}" style="width:64px"></td>
      <td><input type="number" name="r${i}_drivers" value="${esc(r.drivers)}" style="width:64px"></td><td><input type="number" name="r${i}_reset" value="${esc(r.reset)}"></td>
      <td><input type="checkbox" name="r${i}_bonuses"${r.bonuses ? " checked" : ""}></td><td><input type="checkbox" name="r${i}_win"${r.winAdvances ? " checked" : ""}></td>
      <td><input type="checkbox" name="r${i}_miss"${r.missMustWin ? " checked" : ""}></td><td><input type="checkbox" name="r${i}_final"${r.finale ? " checked" : ""}></td></tr>`).join("")}
    </table></div><p class="tag">Leave a round's name and races empty to not use it. "Drivers" is how many start the round.</p>
  </fieldset>
  <p><button class="btn">Save rules</button></p></form>
<script>
const G=${JSON.stringify(GLR_PLAYOFFS)},F=document.getElementById('rf');
document.getElementById('glr').onclick=()=>{const s=(k,v)=>{const e=F.elements[k];if(e.type==='checkbox')e.checked=!!v;else e.value=v;};
  s('po',1);s('regularRaces',G.regularRaces);s('minStarts',G.minStarts);s('field',G.field);s('winBonus',G.winBonus);s('seedBonus',G.seedBonus.join(', '));s('drops',0);
  for(let i=0;i<5;i++){const r=G.rounds[i]||{name:'',races:'',drivers:'',reset:'',bonuses:0,winAdvances:1,missMustWin:1,finale:0};
    s('r'+i+'_name',r.name);s('r'+i+'_races',r.races);s('r'+i+'_drivers',r.drivers);s('r'+i+'_reset',r.reset);s('r'+i+'_bonuses',r.bonuses);s('r'+i+'_win',r.winAdvances);s('r'+i+'_miss',r.missMustWin);s('r'+i+'_final',r.finale);}};
</script>`;
}

function rulesFromForm(f, events) {
  const list = v => String(v || "").split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  const counted = new Set(f.getAll("count").map(Number));
  const rounds = [];
  for (let i = 0; i < 5; i++) if (String(f.get(`r${i}_name`) || "").trim() || Number(f.get(`r${i}_races`)) > 0)
    rounds.push({ name: f.get(`r${i}_name`), races: f.get(`r${i}_races`), drivers: f.get(`r${i}_drivers`), reset: f.get(`r${i}_reset`),
      bonuses: !!f.get(`r${i}_bonuses`), winAdvances: !!f.get(`r${i}_win`), missMustWin: !!f.get(`r${i}_miss`), finale: !!f.get(`r${i}_final`) });
  return cleanRules({
    points: { source: f.get("source"), table: list(f.get("table")), others: f.get("others") },
    bonus: { win: f.get("b_win"), pole: f.get("b_pole"), led: f.get("b_led"), mostLed: f.get("b_mostLed"), fastLap: f.get("b_fastLap") },
    drops: f.get("drops"), byClass: !!f.get("byClass"), ties: f.get("ties"),
    skip: events.filter(e => !counted.has(e.subsession_id)).map(e => e.subsession_id),
    playoffs: { enabled: !!f.get("po"), regularRaces: f.get("regularRaces"), minStarts: f.get("minStarts"), field: f.get("field"),
      seedBonus: list(f.get("seedBonus")), winBonus: f.get("winBonus"), rounds },
  });
}

function rulesProblems(r) {
  const out = [];
  if (r.points.source === "table" && !r.points.table.length) out.push("Our own points table is chosen but no points were entered.");
  const po = r.playoffs;
  if (po.enabled) {
    if (!po.rounds.length) out.push("Playoffs are on but no rounds were entered.");
    if (po.rounds.length && po.rounds[0].drivers !== po.field) out.push(`The first round has ${po.rounds[0].drivers} drivers but ${po.field} make the playoffs.`);
    po.rounds.forEach((x, i) => { const nx = po.rounds[i + 1]; if (nx && nx.drivers > x.drivers) out.push(`${nx.name} has more drivers than ${x.name}.`); });
    if (po.rounds.slice(0, -1).some(x => x.finale)) out.push("Only the last round can be the final.");
  }
  return out;
}

function rulesPage(sr, seasons, season, info, rules, events, user, msg = "") {
  let body = seriesTabs(sr, "rules", seasons, season && season.id, user);
  if (!season) return page(`${sr.short_name} rules`, body + `<p class="hint">No races uploaded yet.</p>`, { user });
  body += `<p class="tag">${esc(season.name)}${info.own && info.updatedAt ? ` · last changed ${day(info.updatedAt)}` : ""}</p>`;
  if (!info.rules) body += `<p class="hint">No rules set for this season yet, so standings use iRacing's league points.</p>`;
  else if (!info.own) body += `<p class="hint">Carried over from ${esc(info.from)}. Saving below makes them this season's own.</p>`;
  if (msg) body += `<div class="msg ${/^Saved/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  body += rulesSummary(rules, events);
  if (canEdit(user, sr)) body += `<h2>Change the rules</h2>` + rulesForm(rules, events);
  return page(`${sr.short_name} rules`, body, { user });
}

function penaltiesPage(sr, seasons, season, list, events, user, msg = "") {
  let body = seriesTabs(sr, "penalties", seasons, season && season.id, user);
  if (!season) return page(`${sr.short_name} penalties`, body + `<p class="hint">No races uploaded yet.</p>`, { user });
  const edit = canEdit(user, sr);
  body += `<p class="tag">${esc(season.name)}</p>`;
  if (msg) body += `<div class="msg bad">${esc(msg)}</div>`;
  body += list.length ? `<div class="wrap"><table><tr><th>Race</th><th>Driver</th><th class="n">Points</th><th>Reason</th>${edit ? "<th></th>" : ""}</tr>` +
    list.map(a => `<tr><td><a href="${BASE}/results/${a.subsession_id}">${day(a.start_time)}</a> · ${esc(a.track)}</td><td>${driverLink(a.cust_id, a.name || a.cust_id)}</td>
      <td class="n"><b>${num(a.points)}</b></td><td style="white-space:normal">${esc(a.reason)}</td>
      ${edit ? `<td><form method="post"><input type="hidden" name="delete" value="${a.id}"><button class="link" onclick="return confirm('Remove this?')">Remove</button></form></td>` : ""}</tr>`).join("") + `</table></div>`
    : `<p class="hint">No penalties or adjustments this season.</p>`;
  if (edit && events.length) {
    const drivers = Object.fromEntries(events.map(e => [e.subsession_id, e.results.sort((a, b) => a.finish_pos - b.finish_pos).map(r => [r.cust_id, `P${r.finish_pos} #${r.car_number} ${r.name}`])]));
    body += `<h2>Add a penalty or adjustment</h2><form method="post" id="pf">
      <label for="race">Race</label><select id="race" name="sub">${[...events].reverse().map(e => `<option value="${e.subsession_id}">${day(e.start_time)} · ${esc(e.track)}</option>`).join("")}</select>
      <label for="drv">Driver</label><select id="drv" name="cust"></select>
      <label for="pts">Points (negative for a penalty)</label><input type="number" id="pts" name="points" placeholder="-25" required>
      <label for="why">Reason (shown to drivers)</label><input type="text" id="why" name="reason" maxlength="200" required>
      <p><button class="btn">Add</button></p></form>
<script>const D=${JSON.stringify(drivers).replace(/</g, "\\u003c")},R=document.getElementById('race'),V=document.getElementById('drv');
const fill=()=>{V.innerHTML='';for(const [id,t] of D[R.value]||[]){const o=document.createElement('option');o.value=id;o.textContent=t;V.append(o);}};R.onchange=fill;fill();</script>`;
  }
  return page(`${sr.short_name} penalties`, body, { user });
}

function uploadPage(user) {
  return page("Upload results", `<h1>Upload results</h1><p class="sub">The results file from the iRacing members site: League > Results > the race > Export.
    JSON is best (it also has qualifying, practice and cautions). CSV works too if you keep its original file name. Uploading the same race again replaces it.</p>
    <form id="f" class="drop"><p>Drop files here, or</p><input type="file" id="file" accept=".json,.csv" multiple><p><button class="btn">Upload</button></p></form>
    <div id="out"></div>
<script>
const f=document.getElementById('f'),inp=document.getElementById('file'),out=document.getElementById('out');
const say=(t,cls,href)=>{const d=document.createElement('div');d.className='msg '+cls;d.textContent=t;if(href){const a=document.createElement('a');a.href=href;a.textContent=' Open';d.append(' ',a);}out.prepend(d);};
async function send(files){for(const file of files){const fd=new FormData();fd.append('file',file);
  try{const r=await fetch('${BASE}/api/upload',{method:'POST',body:fd});const j=await r.json();
    if(j.ok)say(file.name+': '+j.track+', '+j.results+' drivers'+(j.replaced?' (replaced the earlier upload)':''),'ok','${BASE}/results/'+j.subsessionId);
    else say(file.name+': '+j.error,'bad');}catch(e){say(file.name+': upload failed, check your connection','bad');}}}
f.onsubmit=e=>{e.preventDefault();if(inp.files.length)send([...inp.files]);};
f.ondragover=e=>{e.preventDefault();f.classList.add('on');};f.ondragleave=()=>f.classList.remove('on');
f.ondrop=e=>{e.preventDefault();f.classList.remove('on');send([...e.dataTransfer.files]);};
</script>`, { user });
}

async function upload(request, env, user) {
  const form = await request.formData().catch(() => null), file = form && form.get("file");
  if (!file || typeof file === "string") return json({ ok: false, error: "No file was sent." }, 400);
  if (file.size > 5e6) return json({ ok: false, error: "That file is too big to be a results export." }, 400);
  let ev;
  try { ev = parseExport(await file.text(), file.name || ""); } catch (e) { return json({ ok: false, error: e.message }, 400); }
  const sr = ev.league.id ? await seriesById(env.DB, ev.league.id) : null;
  if (!user.admin && !canEdit(user, sr)) return json({ ok: false, error: sr ? `You can't upload ${sr.short_name} results. Ask an admin for that series' role.` : "Only admins can upload the first race of a new series." }, 403);
  const had = await getEvent(env.DB, ev.subsessionId || 0);
  try {
    const r = await importEvent(env.DB, ev, `discord:${user.id}:${user.name}`);
    return json({ ok: true, ...r, track: ev.track, replaced: !!had });
  } catch (e) { return json({ ok: false, error: e.message }, 400); }
}

const sameOrigin = (request, url) => request.headers.get("origin") === url.origin;

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
      if (path === `${BASE}/login`) {
        if (!configured(env)) return page("Sign in", `<h1>Sign in</h1><p class="sub">Discord sign-in isn't set up yet.</p>`);
        return login(env, url, url.searchParams.get("back") || BASE);
      }
      if (path === `${BASE}/auth/callback`) {
        if (!configured(env)) return notFound("Discord sign-in isn't set up yet.");
        const r = await callback(request, env, url);
        return r.response || page("Sign in", `<h1>Couldn't sign you in</h1><p class="sub">${r.name ? `Signed in to Discord as ${esc(r.name)}. ` : ""}${esc(r.error)}</p>
          <p><a href="${BASE}/login">Try again</a></p>`, { status: 403 });
      }
      if (path === `${BASE}/logout` && request.method === "POST" && sameOrigin(request, url)) return logout(request, env);
      const user = await currentUser(request, env);
      if (path === `${BASE}/upload`) return user ? uploadPage(user) : Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/upload`, 302);
      if (path === `${BASE}/api/upload`) {
        if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
        if (!user) return json({ ok: false, error: "Sign in as an official first." }, 401);
        if (!sameOrigin(request, url)) return json({ ok: false, error: "Upload from the site's upload page." }, 403);
        return upload(request, env, user);
      }
      if (path === `${BASE}/api/me`) return json({ ok: true, user, signIn: configured(env) });
      if (path === `${BASE}/api/events`) return json({ ok: true, events: await listEvents(db, { season: Number(url.searchParams.get("season")) || 0 }) });
      if (path === `${BASE}/api/series`) return json({ ok: true, series: await listSeries(db) });
      if ((m = path.match(/^\/glr\/api\/series\/([a-z0-9-]+)$/))) { const sr = await getSeries(db, m[1]); return sr ? json({ ok: true, series: sr }) : json({ ok: false, error: "No such series" }, 404); }
      if ((m = path.match(/^\/glr\/api\/results\/(\d+)$/))) { const ev = await getEvent(db, Number(m[1])); return ev ? json({ ok: true, event: ev }) : json({ ok: false, error: "No such race" }, 404); }
      if ((m = path.match(/^\/glr\/api\/drivers\/(\d+)$/))) { const d = await getDriver(db, Number(m[1])); return d ? json({ ok: true, driver: d }) : json({ ok: false, error: "No such driver" }, 404); }
      if (path === BASE) return homePage(await listSeries(db), await listEvents(db, { limit: 15 }), user);
      if ((m = path.match(/^\/glr\/results\/(\d+)$/))) { const ev = await getEvent(db, Number(m[1])); return ev ? resultPage(ev, user) : notFound("No race with that session number has been uploaded.", user); }
      if ((m = path.match(/^\/glr\/drivers\/(\d+)$/))) { const d = await getDriver(db, Number(m[1])); return d ? driverPage(d, user) : notFound("No driver with that iRacing ID has raced here yet.", user); }
      if ((m = path.match(/^\/glr\/api\/standings\/([a-z0-9-]+)$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return json({ ok: false, error: "No such series" }, 404);
        const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url);
        if (!season) return json({ ok: true, series: sr.short_name, season: null, groups: [] });
        const st = await seasonStandings(db, sr, season);
        return json({ ok: true, series: sr.short_name, season: { id: season.id, name: season.name }, rules: st.rules, groups: st.groups, adjustments: st.adj });
      }
      if ((m = path.match(/^\/glr\/([a-z0-9-]+)\/(standings|rules|penalties)$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No series at that address.", user);
        const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url);
        const back = () => Response.redirect(`${url.origin}${path}${seasons.length > 1 ? `?season=${season.id}` : ""}`, 303);
        if (request.method === "POST" && (!season || !canEdit(user, sr) || !sameOrigin(request, url))) return notFound("You can't change this series.", user);
        if (m[2] === "standings") return standingsPage(sr, seasons, season, season && await seasonStandings(db, sr, season), user);
        if (m[2] === "rules") {
          const info = season ? await getRules(db, season.id, sr.id) : {};
          const events = season ? await seasonEvents(db, season.id) : [];
          let rules = cleanRules(info.rules || DEFAULT_RULES);
          if (request.method === "POST") {
            rules = rulesFromForm(await request.formData(), events);
            const bad = rulesProblems(rules);
            if (bad.length) return rulesPage(sr, seasons, season, info, rules, events, user, "Not saved: " + bad.join(" "));
            await saveRules(db, season.id, rules, `discord:${user.id}:${user.name}`);
            return rulesPage(sr, seasons, season, { rules, own: true, updatedAt: new Date().toISOString() }, rules, events, user, "Saved. Standings use these rules now.");
          }
          return rulesPage(sr, seasons, season, info, rules, events, user);
        }
        const events = season ? await seasonEvents(db, season.id) : [];
        if (request.method === "POST") {
          const f = await request.formData();
          try {
            if (f.get("delete")) await deleteAdjustment(db, season.id, Number(f.get("delete")));
            else await addAdjustment(db, season.id, { sub: Number(f.get("sub")), cust: Number(f.get("cust")), points: f.get("points"), reason: f.get("reason") }, `discord:${user.id}:${user.name}`);
            return back();
          } catch (e) { return penaltiesPage(sr, seasons, season, await listAdjustments(db, season.id), events, user, e.message); }
        }
        return penaltiesPage(sr, seasons, season, season ? await listAdjustments(db, season.id) : [], events, user);
      }
      if ((m = path.match(/^\/glr\/([a-z0-9-]+)\/edit$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No series at that address.", user);
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(path)}`, 302);
        if (!canEdit(user, sr)) return notFound("You can't change this series.", user);
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return seriesEditPage(sr, user, "Save from this page.");
          const f = await request.formData();
          try {
            if (user.admin && f.has("role_id")) await setSeriesRole(db, sr.id, f.get("role_id"));
            const r = await updateSeries(db, sr.id, { shortName: f.get("short_name"), slug: f.get("slug") }); return Response.redirect(`${url.origin}${BASE}/${r.slug}`, 303); }
          catch (e) { return seriesEditPage({ ...sr, short_name: f.get("short_name") || sr.short_name, slug: f.get("slug") || sr.slug }, user, e.message); }
        }
        return seriesEditPage(sr, user);
      }
      if ((m = path.match(/^\/glr\/([a-z0-9-]+)$/))) { const sr = await getSeries(db, m[1]); if (sr) return seriesPage(sr, user); }
      return notFound("Check the link.", user);
    } catch (e) {
      console.error(e);
      return path.startsWith(`${BASE}/api/`) ? json({ ok: false, error: "Something went wrong on the server." }, 500)
        : page("Error", `<h1>Something went wrong</h1><p class="sub">Try again in a minute.</p>`, { status: 500 });
    }
  },
};
