/*
 * VSPEED GLR league site (vspeedlivetiming.app/glr).
 *
 * Pages:  /glr                    every series with its latest race, then the latest races
 *         /glr/<series>           one series (its short address, e.g. /glr/arca): seasons and races
 *         /glr/<series>/standings  standings for a season (?season=<id>, newest by default), by class when multi-class
 *         /glr/<series>/schedule  the series' races: upcoming, and completed ones linked to their results
 *         /glr/schedule           the league calendar: every series' upcoming races
 *         /glr/<series>/stats     driver stats for a season or all seasons (?season=<id>|all)
 *         /glr/<series>/drivers   everyone who has raced in the series, plus drivers its officials have added
 *         /glr/drivers            the league driver list: every driver in every series
 *         /glr/<series>/rules     the season's points and playoff rules; that series' officials can change them
 *         /glr/<series>/penalties points penalties and adjustments, with reasons
 *         /glr/<series>/edit      officials: the series' short name and address; admins: its Discord role
 *         /glr/results/<session>  one race (iRacing subsession id), split by class in a multi-class race
 *         /glr/drivers/<cust id>  one driver: every name they've raced under, stats and races by series
 * Data:   /glr/api/series, /glr/api/series/<series>, /glr/api/events, /glr/api/results/<session>,
 *         /glr/api/drivers/<cust id>, /glr/api/standings/<series>?season=<id>   (the same, as JSON)
 *         /glr/health
 *         /glr/upload             officials upload iRacing result files (JSON or CSV)
 *         /glr/keys               admins: overlay keys, for producers' overlays to send their race results
 *         /glr/history            officials: who changed what (admins: every series; series officials: their own)
 *         /glr/api/overlay/results  POST from an overlay (Authorization: Bearer <key>): provisional results
 *         /glr/api/overlay/check    GET with the same header: is this key good?
 *         /glr/api/import         POST official iRacing results (the results JSON) with an import key, from the iRacing
 *                                 members site (CORS): for one-time backfills of past races
 *         /glr/login, /glr/auth/callback, /glr/logout    Discord sign-in (auth.js)
 */
import { listEvents, listSeries, getSeries, updateSeries, getEvent, getDriver, importEvent, setSeriesRole, seriesById, seasonsOf,
  getRules, saveRules, seasonEvents, listAdjustments, addAdjustment, deleteAdjustment,
  importOverlay, listKeys, createKey, revokeKey, checkKey, deleteEvent, listFixes, fixResult, FIX_FIELDS, markOfficial, setHook, HOOKS,
  logChange, listChanges, whoName, mergeDrivers, separateDriver, aliasesOf, findDrivers,
  seriesEvents, allSeriesEvents, listRoster, addRoster, removeRoster, listSchedule, upcoming, addSchedule, addScheduleLines, deleteSchedule,
  scheduleEntry, linkScheduleTo } from "./db.js";
import { resultsPost, standingsPost, penaltyPost, fixPost, enqueue, processQueue, queueFor, retryQueued, discardQueued, isRecent } from "./discord.js";
import { computeStandings, cleanRules, DEFAULT_RULES, GLR_PLAYOFFS } from "./standings.js";
import { computeStats, leaders, COLUMNS } from "./stats.js";
import { parseExport, parseOverlay } from "./parse.js";
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
.row2{display:flex;gap:8px;flex-wrap:wrap}.row2 input{flex:1 1 260px;max-width:none}form.hook{margin:0 0 6px}
.prov{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;background:#4a3a12;color:#ffcf66;margin-left:6px;vertical-align:1px}
code.key{display:block;padding:10px 12px;background:#000;border:1px solid var(--line);border-radius:6px;word-break:break-all;font-size:14px;margin:8px 0}
.cls{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;background:#2c2c32;color:#ddd;margin-right:4px}
label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px}
.tabs{display:flex;gap:4px;margin:0 0 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}.tabs a{padding:8px 14px;color:var(--dim);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.on{color:var(--text);border-bottom-color:var(--accent)}.tabs .season{margin-left:auto;align-self:center}
select,input[type=number],input[type=date],input[type=time]{color-scheme:dark;padding:7px 9px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
input[type=number]{width:90px}tr.cut td{border-top:2px solid var(--accent)!important}.st{font-size:12px;font-weight:600;color:#ffb84d}.st.good{color:#4fd18b}.st.bad{color:#ff6b6b}
fieldset{min-width:0;border:1px solid var(--line);border-radius:8px;margin:16px 0;padding:6px 16px 14px}legend{padding:0 6px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px 16px}.chk{display:flex;gap:8px;align-items:center;margin:8px 0;color:var(--text);font-size:14px}
.rules p{margin:6px 0}details{margin:14px 0}summary{cursor:pointer;color:var(--dim)}.btn.ghost{background:#2c2c32}input[type=text]{width:100%;max-width:360px;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
header{flex-wrap:wrap;row-gap:6px}header .me{flex-wrap:wrap;justify-content:flex-end;column-gap:12px;row-gap:4px}
.lead{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:0 0 18px}.lead div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.lead small{display:block;color:var(--dim);font-size:12px}.lead b{font-size:18px}.lead span{display:block;font-size:14px}
th.sort{cursor:pointer;user-select:none}th.sort:hover{color:var(--text)}th.sort.on{color:var(--text)}th.sort.on::after{content:" ▾"}th.sort.on.asc::after{content:" ▴"}
label.up{margin:0 0 0 10px;display:inline;color:#7fb6ff;font-size:13px;cursor:pointer;text-decoration:underline}.ups{font-size:13px;color:var(--dim)}.ups.bad{color:#ff8a8a}
.grid-r td,.grid-r th{padding:5px 6px;text-align:center}.grid-r td.d{text-align:left;position:sticky;left:0;background:var(--card);z-index:1}
.grid-r .c{border-radius:4px;display:inline-block;min-width:26px;padding:1px 3px}.grid-r .w{background:#6b5313;color:#ffe08a;font-weight:700}
.grid-r .t5{background:#1f4630}.grid-r .t10{background:#1f3550}.grid-r .dnf{color:#ff8a8a}.grid-r .p{display:none}.grid-r.pts .p{display:inline}.grid-r.pts .f{display:none}
.seg2{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:0 0 10px}.seg2 button{background:none;border:0;color:var(--dim);padding:6px 12px;font:inherit;cursor:pointer}
.seg2 button.on{background:#2c2c32;color:var(--text)}time{white-space:nowrap}
input.search{width:100%;max-width:360px;margin:0 0 12px;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
</style></head><body><header><a href="${BASE}">VSPEED <span>GLR</span></a><div class="me"><a href="${BASE}/schedule">Schedule</a><a href="${BASE}/drivers">Drivers</a>${user
  ? `<a href="${BASE}/history">History</a>${user.admin ? `<a href="${BASE}/keys">Overlay keys</a>` : ""}<a href="${BASE}/upload">Upload results</a><span class="tag">${esc(user.name)}</span><form method="post" action="${BASE}/logout"><button class="link">Sign out</button></form>`
  : `<a href="${BASE}/login">Official sign-in</a>`}</div></header><main>${body}</main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const notFound = (what, user) => page("Not found", `<h1>Not found</h1><p class="sub">${esc(what)}</p>`, { status: 404, user });
const driverLink = (id, name) => `<a href="${BASE}/drivers/${id}">${esc(name)}</a>`;
const seriesLink = e => e.slug ? `<a href="${BASE}/${esc(e.slug)}">${esc(e.short_name)}</a>` : esc(e.series_name || "");
const crumb = e => e.slug ? `<p class="crumb"><a href="${BASE}">GLR</a> › <a href="${BASE}/${esc(e.slug)}">${esc(e.short_name)}</a></p>` : "";
const cls = c => c ? `<span class="cls">${esc(c)}</span>` : "";
const prov = e => e.status === "provisional" ? `<span class="prov" title="Sent by a producer's overlay. Replaced by the iRacing results file when it's uploaded.">Provisional</span>` : "";
// "Name" for one winner; "[LMP2] Name · [GT3] Name" for a multi-class race
const winnersHtml = ws => ws.map(w => (ws.length > 1 ? cls(w.carClass) : "") + driverLink(w.custId, w.name)).join(" · ");

function raceTable(events, { series = false } = {}) {
  return `<div class="wrap"><table><tr><th>Date</th>${series ? "<th>Series</th>" : ""}<th>Track</th><th>Winner</th><th class="n">Starters</th><th class="n">Laps</th></tr>` +
    events.map(e => `<tr><td><a href="${BASE}/results/${e.subsession_id}">${day(e.start_time)}</a>${prov(e)}</td>${series ? `<td>${seriesLink(e)}</td>` : ""}
      <td>${esc(e.track)}</td><td>${winnersHtml(e.winners)}</td><td class="n">${e.starters}</td><td class="n">${e.laps ?? ""}</td></tr>`).join("") + `</table></div>`;
}

// a time in the viewer's own time zone (Eastern until the page's script runs)
const when = (iso, withDay = true) => { const d = new Date(iso); if (isNaN(d)) return "";
  const et = d.toLocaleString("en-US", { ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
  return `<time datetime="${d.toISOString()}" data-day="${withDay ? 1 : 0}">${et}</time>`; };
const LOCAL_JS = `<script>document.querySelectorAll('time[datetime]').forEach(t=>{try{const d=new Date(t.getAttribute('datetime'));
t.textContent=d.toLocaleString(undefined,Object.assign(t.dataset.day==='1'?{weekday:'short',month:'short',day:'numeric'}:{},{hour:'numeric',minute:'2-digit',timeZoneName:'short'}));}catch(e){}});</script>`;

function homePage(series, recent, user, next = new Map()) {
  if (!series.length) return page("VSPEED GLR", `<h1>Results</h1><p class="sub">No races uploaded yet.</p>`, { user });
  let body = `<h1>Series</h1><p class="sub">${series.length} series</p><div class="cards">` +
    series.map(s => { const e = s.latestEvent; return `<a class="card" href="${BASE}/${esc(s.slug)}"><b>${esc(s.short_name)}</b><div class="full">${esc(s.name)}</div>
      ${e ? `<div class="row"><span>Latest:</span> ${esc(e.track)}, ${day(e.start_time)}</div>
        <div class="row"><span>Won by</span> ${e.winners.map(w => (e.winners.length > 1 ? cls(w.carClass) : "") + esc(w.name)).join(" · ")}</div>` : ""}
      ${next.get(s.id) ? `<div class="row"><span>Next:</span> ${esc(next.get(s.id).track)}, ${when(next.get(s.id).starts_at)}</div>` : ""}
      <div class="row"><span>${s.races} race${s.races === 1 ? "" : "s"} uploaded</span></div></a>`; }).join("") + `</div>`;
  body += `<h2>Latest races</h2>` + raceTable(recent, { series: true });
  return page("VSPEED GLR results", body + LOCAL_JS, { user });
}

function seriesPage(sr, user) {
  let body = seriesTabs(sr, "results", [], null, user);
  if (!sr.seasons.length) body += `<p class="hint">No races uploaded yet.</p>`;
  for (const se of sr.seasons) body += `<h2>${esc(se.name)}</h2>` + raceTable(se.events);
  return page(`${sr.short_name} results`, body, { user });
}

const HOOK_LABEL = { results: "Results (when a race is official: podium, class winners, top 10)", standings: "Standings (after each official race)", penalties: "Penalties and result fixes (when an official adds one)" };
function hooksHtml(sr, queue, note) {
  const masked = u => { const m = /\/webhooks\/(\d+)\/([\w-]+)$/.exec(u || ""); return m ? `Saved (…${esc(m[2].slice(-4))})` : ""; };
  return `<h2 id="discord">Discord posts</h2>${note ? `<div class="msg ${/^(Saved|Removed|Test sent)/.test(note) ? "ok" : "bad"}">${esc(note)}</div>` : ""}
  <p class="tag">Paste a webhook link for each channel to post to (in Discord: the channel's settings › Integrations › Webhooks › New Webhook › Copy Webhook URL). The same link can go in more than one box. Anyone with the link can post in that channel, so it's kept like a password and never shown again. Only races from the last 7 days post, so uploading an old season stays quiet.</p>
  ${HOOKS.map(k => `<form method="post" action="#discord" class="hook"><input type="hidden" name="action" value="hook"><input type="hidden" name="kind" value="${k}">
    <label for="h_${k}">${HOOK_LABEL[k]}${sr[`hook_${k}`] ? ` · <b>${masked(sr[`hook_${k}`])}</b>` : ""}</label>
    <div class="row2"><input type="text" id="h_${k}" name="url" placeholder="${sr[`hook_${k}`] ? "Paste a new link to replace it" : "https://discord.com/api/webhooks/…"}" autocomplete="off" spellcheck="false">
    <button class="btn">Save</button>${sr[`hook_${k}`] ? `<button class="btn ghost" name="test" value="1">Send test</button><button class="btn ghost" name="clear" value="1" onclick="return confirm('Stop posting these?')">Remove</button>` : ""}</div></form>`).join("")}
  ${queue.length ? `<h2>Waiting to post</h2><div class="wrap"><table><tr><th>Post</th><th>Race</th><th>Problem</th><th></th></tr>` + queue.map(q => `<tr><td>${esc(q.kind)}</td>
    <td>${q.subsession_id ? `<a href="${BASE}/results/${q.subsession_id}">${q.subsession_id}</a>` : ""}</td><td style="white-space:normal">${esc(q.last_error || (q.attempts ? "" : "Sending…"))}${q.next_try > 8e15 ? " <b>(stopped)</b>" : ""}</td>
    <td><form method="post" action="#discord" style="display:inline"><input type="hidden" name="action" value="retry"><input type="hidden" name="id" value="${q.id}"><button class="link">Try again</button></form> ·
    <form method="post" action="#discord" style="display:inline"><input type="hidden" name="action" value="discard"><input type="hidden" name="id" value="${q.id}"><button class="link">Discard</button></form></td></tr>`).join("") + `</table></div>` : ""}`;
}

function seriesEditPage(sr, user, err = "", queue = [], note = "") {
  return page(`Edit ${sr.short_name}`, `<p class="crumb"><a href="${BASE}">GLR</a> › <a href="${BASE}/${esc(sr.slug)}">${esc(sr.short_name)}</a></p>
    <h1>Edit series</h1><p class="sub">${esc(sr.name)} · iRacing league ${sr.id}</p>${err ? `<div class="msg bad">${esc(err)}</div>` : ""}
    <form method="post"><label for="sn">Short name (shown on the site)</label><input type="text" id="sn" name="short_name" value="${esc(sr.short_name)}" maxlength="40" required>
    <label for="sl">Address: vspeedlivetiming.app/glr/…</label><input type="text" id="sl" name="slug" value="${esc(sr.slug)}" maxlength="40">
    <p class="tag">Changing the address breaks old links to this series. Race and driver links aren't affected.</p>
    ${user && user.admin ? `<label for="rl">Discord role for this series' officials (role ID; leave empty for admins only)</label>
    <input type="text" id="rl" name="role_id" value="${esc(sr.role_id || "")}" maxlength="25" inputmode="numeric">
    <p class="tag">People with this role can sign in and change only this series: its rules, penalties, results uploads and this page. In Discord: Server Settings › Roles › right-click the role › Copy Role ID.</p>` : ""}
    <p><button class="btn">Save</button></p></form>${hooksHtml(sr, queue, note)}`, { user });
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

function fixesHtml(fixes) {
  if (!fixes.length) return "";
  return `<h2>Corrections</h2><div class="wrap"><table><tr><th>Driver</th><th>Changed</th><th>Reason</th><th>When</th></tr>` +
    fixes.map(f => `<tr><td>${driverLink(f.cust_id, f.name || f.cust_id)}</td><td style="white-space:normal">${Object.entries(f.changes).map(([k, [a, b]]) => `${esc(FIX_FIELDS[k] || k)} ${esc(a ?? "–")} → <b>${esc(b)}</b>`).join(", ")}</td>
      <td style="white-space:normal">${esc(f.reason)}</td><td>${day(f.created_at)}</td></tr>`).join("") + `</table></div>`;
}

function officialsPanel(ev, msg) {
  const race = (ev.sessions.race || []).slice().sort((a, b) => a.finish_pos - b.finish_pos);
  if (!race.length) return "";
  const D = race.map(r => ({ id: r.cust_id, t: `P${r.finish_pos} #${r.car_number} ${r.name}`, pos: r.finish_pos, laps: r.laps, led: r.laps_led, inc: r.incidents, st: r.reason_out, pts: r.league_points }));
  const n = (name, label, extra = "") => `<label>${label}<br><input type="number" name="${name}" id="fx_${name}" ${extra}></label>`;
  return `<h2 id="fix">Officials</h2>${msg ? `<div class="msg ${/^(Fixed|Marked)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>` : ""}
  ${ev.status === "provisional" ? `<fieldset><legend>Official results</legend><form method="post" action="#fix"><input type="hidden" name="action" value="official">
    <p class="tag">These results came from the broadcast overlay. Check them (fix anything below first), then mark them official. That posts them to the series' Discord channels if they're set up. Uploading the iRacing results file also makes them official.</p>
    <p><button class="btn">Mark results official</button></p></form></fieldset>` : ""}
  <fieldset><legend>Fix a result</legend>
  <form method="post" action="#fix"><input type="hidden" name="action" value="fix">
    <label for="fx_d">Driver</label><select id="fx_d" name="cust">${D.map(d => `<option value="${d.id}">${esc(d.t)}</option>`).join("")}</select>
    <div class="grid">${n("finish_pos", "Finish", `min="1" max="${race.length}"`)}${n("laps", "Laps")}${n("laps_led", "Laps led")}${n("incidents", "Incidents")}${n("league_points", "League points")}</div>
    <label for="fx_reason_out">Status</label><input type="text" id="fx_reason_out" name="reason_out" list="fx_sts" maxlength="40">
    <datalist id="fx_sts"><option value="Running"><option value="Disqualified"><option value="Disconnected"><option value="Retired"></datalist>
    <label for="fx_why">Reason (shown on this page)</label><input type="text" id="fx_why" name="reason" maxlength="200" required>
    <p class="tag">Change only what's wrong. A new finish moves the other drivers up or down to make room. To disqualify, set the status to Disqualified and the finish to ${race.length} (last). Re-uploading the iRacing file replaces the results and these fixes.</p>
    <p><button class="btn">Save fix</button></p></form></fieldset>
  <fieldset><legend>Remove this race</legend>
  <form method="post" onsubmit="return confirm('Remove this race from the site? Its results, penalties and fixes are deleted and the standings recalculate. You can upload it again later.')">
    <input type="hidden" name="action" value="delete"><p class="tag">For a race uploaded by mistake or to the wrong series. Its results, penalties and fixes are deleted; you can upload it again later.</p>
    <p><button class="btn ghost">Remove this race</button></p></form></fieldset>
<script>const D=${JSON.stringify(D).replace(/</g, "\\u003c")},S=document.getElementById('fx_d');
const fill=()=>{const d=D.find(x=>String(x.id)===S.value)||D[0];for(const [k,v] of [['finish_pos',d.pos],['laps',d.laps],['laps_led',d.led],['incidents',d.inc],['league_points',d.pts],['reason_out',d.st]]){const e=document.getElementById('fx_'+k);e.value=v??'';}};
S.onchange=fill;fill();</script>`;
}

function resultPage(ev, user, { fixes = [], edit = false, msg = "" } = {}) {
  const facts = [ev.laps != null && `${ev.laps} laps`, ev.cautions != null && `${ev.cautions} caution${ev.cautions === 1 ? "" : "s"}${ev.caution_laps ? ` (${ev.caution_laps} laps)` : ""}`,
    ev.lead_changes != null && `${ev.lead_changes} lead changes`, ev.sof && `SOF ${ev.sof}`].filter(Boolean).join(" · ");
  let body = crumb(ev) + `<h1>${esc(ev.track)}${prov(ev)}</h1>${ev.status === "provisional" ? `<p class="hint" style="padding-left:14px">Provisional: sent by the broadcast overlay at the end of the race. It's replaced by the official iRacing results file when that's uploaded, which also adds league points, qualifying and practice.</p>` : ""}<p class="sub">${day(ev.start_time)}${ev.season_name ? " · " + esc(ev.season_name) : ""}${facts ? " · " + facts : ""}</p>`;
  const names = { race: "Race", qualify: "Qualifying", practice: "Practice", warmup: "Warmup" };
  for (const s of ["race", "qualify", "warmup", "practice", ...Object.keys(ev.sessions).filter(k => !names[k])])
    if (ev.sessions[s]) body += sessionTables(ev.sessions[s], s === "race", names[s] || s) + (s === "race" ? fixesHtml(fixes) : "");
  body += `<p class="tag">iRacing session ${ev.subsession_id}</p>`;
  if (edit) body += officialsPanel(ev, msg);
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

function mergePanel(d, aliases, all, msg) {
  let h = `<h2 id="merge">Merge drivers</h2>${msg ? `<div class="msg ${/^(Merged|Separated)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>` : ""}`;
  if (aliases.length) h += `<div class="wrap"><table><tr><th>Merged into this driver</th><th>When</th><th></th></tr>` + aliases.map(a => `<tr><td>${esc(a.name || "")} <span class="tag">iRacing ID ${a.from_cust}</span></td>
    <td>${day(a.merged_at)}</td><td><form method="post" action="#merge" onsubmit="return confirm('Separate them again? That driver gets their own races back.')"><input type="hidden" name="action" value="separate">
    <input type="hidden" name="from" value="${a.from_cust}"><button class="link">Separate again</button></form></td></tr>`).join("") + `</table></div>`;
  h += `<form method="post" action="#merge" onsubmit="return confirm('Merge that driver into ${esc(String(d.name).replace(/['"\\]/g, ""))}? Their races, penalties and names move here, and later uploads under their iRacing ID land here too. You can separate them again.')">
    <input type="hidden" name="action" value="merge"><label for="mg">Another record of this same person (name or iRacing ID)</label>
    <input type="text" id="mg" name="other" list="mgl" autocomplete="off"><datalist id="mgl">${all.filter(x => x.cust_id !== d.cust_id).map(x => `<option value="${esc(x.name)} (${x.cust_id})">`).join("")}</datalist>
    <p class="tag">Only for one person with two records, for example after a new iRacing account. The site already joins different names under the same iRacing ID by itself.</p>
    <p><button class="btn ghost">Merge into this driver</button></p></form>`;
  return h;
}

function driverPage(d, user, { aliases = [], all = [], msg = "" } = {}) {
  const other = d.names.filter(x => x.name !== d.name).map(x => esc(x.name));
  const bySeries = new Map();
  for (const x of d.races) { const k = x.series_id || 0; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(x); }
  let body = `<h1>${esc(d.name)}</h1><p class="sub">iRacing ID ${d.cust_id}${other.length ? " · also raced as " + other.join(", ") : ""}</p>`;
  if (!d.races.length) body += `<p class="hint">Hasn't raced yet. Added to a series' driver list by its officials.</p>`;
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
  if (user && user.admin) body += mergePanel(d, aliases, all, msg);
  return page(d.name, body, { user });
}

function seriesTabs(sr, on, seasons, seasonId, user) {
  const q = seasonId && seasonId !== "all" && seasons.length > 1 ? `?season=${seasonId}` : "";
  const t = (k, label, href) => `<a class="${on === k ? "on" : ""}" href="${BASE}/${esc(sr.slug)}${href}${["results", "drivers", "schedule"].includes(k) ? "" : q}">${label}</a>`;
  const opts = on === "stats" && seasons.length > 1 ? [...seasons, { id: "all", name: "All seasons" }] : seasons;
  const pick = !["results", "drivers", "schedule"].includes(on) && opts.length > 1 ? `<form class="season" method="get"><select name="season" onchange="this.form.submit()">${opts.map(se =>
    `<option value="${se.id}"${se.id === seasonId ? " selected" : ""}>${esc(se.name)}</option>`).join("")}</select></form>` : "";
  return `<p class="crumb"><a href="${BASE}">GLR</a></p><h1>${esc(sr.short_name)}</h1><p class="sub">${esc(sr.name)}${canEdit(user, sr) ? ` · <a href="${BASE}/${esc(sr.slug)}/edit">Edit series</a>` : ""}</p>
    <nav class="tabs">${t("results", "Results", "")}${t("schedule", "Schedule", "/schedule")}${t("standings", "Standings", "/standings")}${t("stats", "Stats", "/stats")}${t("drivers", "Drivers", "/drivers")}${t("rules", "Rules", "/rules")}${t("penalties", "Penalties", "/penalties")}${pick}</nav>`;
}

// a table whose columns sort when their heading is clicked (numbers from data-v)
const SORT_JS = `<script>document.querySelectorAll('table.sortable').forEach(t=>{const hs=[...t.querySelectorAll('th.sort')];
hs.forEach(h=>h.onclick=()=>{const i=[...h.parentNode.children].indexOf(h),asc=h.classList.contains('on')?!h.classList.contains('asc'):h.dataset.dir==='asc';
hs.forEach(x=>x.classList.remove('on','asc'));h.classList.add('on');if(asc)h.classList.add('asc');
const rows=[...t.querySelectorAll('tr')].slice(1),v=r=>{const c=r.children[i],d=c&&c.dataset.v;return d===undefined||d===''?null:isNaN(+d)?d.toLowerCase():+d;};
rows.sort((a,b)=>{const x=v(a),y=v(b);if(x===null)return 1;if(y===null)return -1;return (x<y?-1:x>y?1:0)*(asc?1:-1);});rows.forEach(r=>t.appendChild(r));});});
document.querySelectorAll('input.search').forEach(s=>s.oninput=()=>{const q=s.value.trim().toLowerCase();document.querySelectorAll(s.dataset.rows).forEach(r=>r.hidden=q&&!r.textContent.toLowerCase().includes(q));});</script>`;

function schedulePage(sr, rows, winners, user, msg = "") {
  let body = seriesTabs(sr, "schedule", [], null, user);
  const edit = canEdit(user, sr), now = Date.now() - 4 * 3600e3;
  if (msg) body += `<div class="msg ${/^(Added|Removed)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  const up = rows.filter(r => !r.subsession_id && Date.parse(r.starts_at) >= now);
  const done = rows.filter(r => !up.includes(r)).reverse();
  const del = r => edit ? `<td><form method="post" onsubmit="return confirm('Remove ${esc(String(r.track).replace(/['"\\]/g, ""))} from the schedule?')"><input type="hidden" name="remove" value="${r.id}"><button class="link">Remove</button></form></td>` : "";
  body += `<h2>Upcoming</h2>` + (up.length ? `<div class="wrap"><table><tr><th>When</th><th>Track</th><th>Notes</th>${edit ? "<th></th>" : ""}</tr>` +
    up.map(r => `<tr><td>${when(r.starts_at)}</td><td>${esc(r.track)}</td><td style="white-space:normal">${esc(r.notes)}</td>${del(r)}</tr>`).join("") + `</table></div>`
    : `<p class="hint">No upcoming races on the schedule.${edit ? " Add them below." : ""}</p>`);
  if (done.length) {
    const table = list => `<div class="wrap"><table><tr><th>When</th><th>Track</th><th>Winner</th><th>Notes</th>${edit ? "<th></th>" : ""}</tr>` + list.map(r => `<tr>
      <td>${r.subsession_id ? `<a href="${BASE}/results/${r.subsession_id}">${when(r.starts_at)}</a>` : when(r.starts_at)}</td><td>${esc(r.track)}</td>
      <td>${r.subsession_id ? winnersHtml(winners.get(r.subsession_id) || []) + prov(r) : `<span class="tag">Results not in yet</span>${edit ? `
        <label class="up" title="The iRacing results file (JSON, or CSV with its original name)">Upload results<input type="file" accept=".json,.csv" data-sched="${r.id}" hidden></label><span class="ups"></span>` : ""}`}</td>
      <td style="white-space:normal">${esc(r.notes)}</td>${del(r)}</tr>`).join("") + `</table></div>`;
    const recent = done.filter(r => Date.parse(r.starts_at) > Date.now() - 150 * 864e5), older = done.filter(r => !recent.includes(r));
    if (recent.length) body += `<h2>Completed</h2>` + table(recent);
    if (older.length) body += `<details><summary>Earlier races (${older.length})</summary>${table(older)}</details>`;
  }
  if (edit) body += `<h2>Add races</h2><form method="post"><div class="grid"><label>Date<br><input type="date" name="date" required></label>
      <label>Start (Eastern)<br><input type="time" name="time" value="20:00" required></label></div>
      <label for="st">Track</label><input type="text" id="st" name="track" maxlength="100" required>
      <label for="sn2">Notes (optional, e.g. Playoffs: Round of 12)</label><input type="text" id="sn2" name="notes" maxlength="120">
      <p><button class="btn">Add race</button></p></form>
    <form method="post"><label for="bulk">Or paste a whole season, one race per line: date, start time (Eastern), track, notes</label>
      <textarea id="bulk" name="bulk" rows="6" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit"
        placeholder="2026-11-10, 8:00 PM, Kansas Speedway&#10;11/17/2026, 8:00 PM, Martinsville Speedway, Short track night&#10;2026-11-24, Phoenix Raceway, Playoffs: Round of 12"></textarea>
      <p class="tag">The time can be left out (8:00 PM Eastern). When a race's results are uploaded they join up with its date here.</p>
      <p><button class="btn">Add these races</button></p></form>`;
  if (edit) body += `<script>document.querySelectorAll('input[data-sched]').forEach(i=>i.onchange=async()=>{const f=i.files[0];if(!f)return;
  const s=i.closest('td').querySelector('.ups'),fd=new FormData();fd.append('file',f);fd.append('schedule',i.dataset.sched);s.textContent=' Uploading…';
  try{const j=await(await fetch('${BASE}/api/upload',{method:'POST',body:fd})).json();
    if(!j.ok){s.textContent=' '+j.error;s.className='ups bad';i.value='';return;}
    if(j.linked&&!j.linked.ok){s.textContent=' Uploaded, but '+j.linked.error;s.className='ups bad';return;}
    s.textContent=' Uploaded ('+j.results+' drivers)';location.reload();}catch(e){s.textContent=' Upload failed, check your connection';s.className='ups bad';}});</script>`;
  return page(`${sr.short_name} schedule`, body + LOCAL_JS, { user });
}

function leagueSchedulePage(rows, user) {
  let body = `<h1>Schedule</h1><p class="sub">Upcoming races in every GLR series, in your time zone.</p>`;
  if (!rows.length) return page("GLR schedule", body + `<p class="hint">No upcoming races on the schedule yet.</p>`, { user });
  body += `<div class="wrap"><table><tr><th>When</th><th>Series</th><th>Track</th><th>Notes</th></tr>` + rows.map(r => `<tr><td>${when(r.starts_at)}</td>
    <td><a href="${BASE}/${esc(r.slug)}/schedule">${esc(r.short_name)}</a></td><td>${esc(r.track)}</td><td style="white-space:normal">${esc(r.notes)}</td></tr>`).join("") + `</table></div>`;
  return page("GLR schedule", body + LOCAL_JS, { user });
}

// each driver's finish and points in every race of the season, in the order the standings show them
function raceGrid(g, order) {
  if (!g.races.length) return "";
  const rows = order.filter(o => g.races.some(r => r.points[o.custId]));
  const short = t => String(t || "").replace(/\s*-\s*.*$/, "").replace(/\b(Speedway|Raceway|International|Motor|Superspeedway|Circuit)\b/gi, "").replace(/\s+/g, " ").trim().slice(0, 10);
  const cell = x => { if (!x) return `<td class="tag">–</td>`;
    const c = x.pos === 1 ? "w" : x.pos <= 5 ? "t5" : x.pos <= 10 ? "t10" : "", dnf = x.out && !/^running$/i.test(x.out);
    const tip = `P${x.pos} · ${x.pts} pts${x.bonus ? ` (incl. ${x.bonus} bonus)` : ""}${x.adj ? ` · ${x.adj > 0 ? "+" : ""}${x.adj} ${x.reasons.join("; ")}` : ""}${dnf ? ` · ${x.out}` : ""}`;
    return `<td title="${esc(tip)}"><span class="c ${c}${dnf ? " dnf" : ""}"><span class="f">${x.pos}</span><span class="p">${x.pts}</span></span>${x.adj ? "*" : ""}</td>`; };
  return `<h2>Race by race</h2><div class="seg2" onclick="const b=event.target.closest('button');if(!b)return;this.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));this.nextElementSibling.querySelector('table').classList.toggle('pts',b.dataset.v==='p')">
    <button class="on" data-v="f">Finish</button><button data-v="p">Points</button></div>
    <div class="wrap"><table class="grid-r"><tr><th class="d" style="text-align:left">Driver</th>${g.races.map((r, i) => `<th title="${esc(r.track)}, ${day(r.start_time)}"><a href="${BASE}/results/${r.subsession_id}">${i + 1}</a><br><span class="tag">${esc(short(r.track))}</span></th>`).join("")}
    <th>Race pts</th></tr>` + rows.map(o => `<tr><td class="d">${driverLink(o.custId, o.name)}</td>${g.races.map(r => cell(r.points[o.custId])).join("")}
    <td><b>${g.races.reduce((s, r) => s + ((r.points[o.custId] || {}).pts || 0), 0)}</b></td></tr>`).join("") + `</table></div>
    <p class="tag">Gold: win · green: top 5 · blue: top 10 · red number: didn't finish · *: penalty or adjustment. Hover a result for its points. Race pts adds up every race (before drop weeks and playoff resets).</p>`;
}

const fmt = (v, dp) => v == null ? "–" : dp ? v.toFixed(dp) : String(v);

function statsPage(sr, seasons, seasonId, rows, races, user) {
  let body = seriesTabs(sr, "stats", seasons, seasonId, user);
  const label = seasonId === "all" ? "All seasons" : (seasons.find(s => s.id === seasonId) || {}).name || "";
  body += `<p class="tag">${esc(label)} · ${races} race${races === 1 ? "" : "s"}</p>`;
  if (!rows.length) return page(`${sr.short_name} stats`, body + `<p class="hint">No races uploaded yet.</p>`, { user });
  const multi = new Set(rows.map(r => r.cls)).size > 1;
  body += `<div class="lead">${leaders(rows, races).map(([t, r]) => `<div><small>${esc(t)}</small><b>${fmt(r.value, t.includes("avg") ? 1 : 0)}</b>
    <span>${driverLink(r.custId, r.name)}</span></div>`).join("")}</div>`;
  if (multi) body += `<p class="tag">Multi-class: finishes, poles and wins count within each driver's class.</p>`;
  const sorted = [...rows].sort((a, b) => b.wins - a.wins || b.top5 - a.top5 || (a.avgFinish ?? 99) - (b.avgFinish ?? 99));
  body += `<div class="wrap"><table class="sortable"><tr><th class="sort" data-dir="asc">Driver</th><th>#</th>${COLUMNS.map(([k, l, dir]) => `<th class="n sort${k === "wins" ? " on" : ""}" data-dir="${dir}">${l}</th>`).join("")}</tr>` +
    sorted.map(r => `<tr><td data-v="${esc(r.name)}">${multi ? cls(r.cls) : ""}${driverLink(r.custId, r.name)}</td><td>${esc(r.number)}</td>${COLUMNS.map(([k, , , dp]) =>
      `<td class="n" data-v="${r[k] ?? ""}">${fmt(r[k], dp)}</td>`).join("")}</tr>`).join("") + `</table></div>
    <p class="tag">Click a heading to sort. Pos. gained adds up start minus finish. Lead-lap: finished on the leader's lap. DNF: didn't finish running.</p>` + SORT_JS;
  return page(`${sr.short_name} stats`, body, { user });
}

function seriesDriversPage(sr, rows, roster, user, msg = "") {
  let body = seriesTabs(sr, "drivers", [], null, user);
  const edit = canEdit(user, sr), raced = new Set(rows.map(r => r.custId)), mine = new Set(roster.map(r => r.cust_id));
  const list = [...rows.map(r => ({ ...r, added: mine.has(r.custId) })),
    ...roster.filter(r => !raced.has(r.cust_id)).map(r => ({ custId: r.cust_id, name: r.name, number: r.car_number, starts: 0, wins: 0, first: "", last: "", added: true }))]
    .sort((a, b) => b.starts - a.starts || a.name.localeCompare(b.name));
  body += `<p class="tag">${list.length} driver${list.length === 1 ? "" : "s"}: everyone who has raced in ${esc(sr.short_name)}${roster.length ? ", plus drivers the officials have added" : ""}.</p>`;
  if (msg) body += `<div class="msg ${/^(Added|Removed)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  body += `<input type="search" class="search" placeholder="Find a driver" data-rows="#dl tr.d">`;
  body += `<div class="wrap"><table class="sortable" id="dl"><tr><th class="n sort" data-dir="asc">#</th><th class="sort" data-dir="asc">Driver</th><th class="n">iRacing ID</th>
    <th class="n sort on" data-dir="desc">Starts</th><th class="n sort" data-dir="desc">Wins</th><th class="sort" data-dir="asc">First race</th><th class="sort" data-dir="desc">Last race</th>${edit ? "<th></th>" : ""}</tr>` +
    list.map(r => `<tr class="d"><td class="n" data-v="${esc(r.number) === "" ? "" : Number(r.number)}">${esc(r.number)}</td><td data-v="${esc(r.name)}">${r.starts ? driverLink(r.custId, r.name) : esc(r.name)}</td>
      <td class="n tag">${r.custId}</td><td class="n" data-v="${r.starts}">${r.starts || `<span class="tag">Hasn't raced yet</span>`}</td><td class="n" data-v="${r.wins}">${r.wins || ""}</td>
      <td data-v="${esc(r.first)}">${r.first ? day(r.first) : ""}</td><td data-v="${esc(r.last)}">${r.last ? day(r.last) : ""}</td>
      ${edit ? `<td>${r.added ? `<form method="post"><input type="hidden" name="remove" value="${r.custId}"><button class="link" title="Added by an official">Remove</button></form>` : ""}</td>` : ""}</tr>`).join("") + `</table></div>`;
  if (edit) body += `<h2>Add a driver</h2><form method="post"><div class="grid"><label>iRacing ID<br><input type="number" name="cust" required></label>
    <label>Car number<br><input type="text" name="number" maxlength="4" style="width:90px"></label></div>
    <label for="dn">Name</label><input type="text" id="dn" name="name" maxlength="80">
    <p class="tag">For drivers who haven't raced yet, like new sign-ups. Once they race, their results join up by iRacing ID. Leave the name empty for a driver the site already knows.</p>
    <p><button class="btn">Add driver</button></p></form>`;
  return page(`${sr.short_name} drivers`, body + SORT_JS, { user });
}

function leagueDriversPage(list, user) {
  let body = `<h1>Drivers</h1><p class="sub">${list.length} drivers across every GLR series. Click a heading to sort.</p>
    <input type="search" class="search" placeholder="Find a driver or iRacing ID" data-rows="#ld tr.d">`;
  body += `<div class="wrap"><table class="sortable" id="ld"><tr><th class="sort" data-dir="asc">Driver</th><th class="n">iRacing ID</th><th>Series</th>
    <th class="n sort on" data-dir="desc">Starts</th><th class="n sort" data-dir="desc">Wins</th><th class="sort" data-dir="desc">Last race</th></tr>` +
    list.map(d => `<tr class="d"><td data-v="${esc(d.name)}">${d.starts ? driverLink(d.custId, d.name) : esc(d.name)}</td><td class="n tag">${d.custId}</td>
      <td>${d.series.map(s => `<a href="${BASE}/${esc(s.slug)}/drivers"><span class="cls">${esc(s.short)}</span></a>`).join("")}</td>
      <td class="n" data-v="${d.starts}">${d.starts || `<span class="tag">Hasn't raced yet</span>`}</td><td class="n" data-v="${d.wins}">${d.wins || ""}</td>
      <td data-v="${esc(d.last)}">${d.last ? day(d.last) : ""}</td></tr>`).join("") + `</table></div>`;
  return page("GLR drivers", body + SORT_JS, { user });
}

// the league list: every driver, the series they've run (or been added to), starts and wins across all of them
async function leagueDrivers(db) {
  const [series, bySeries, roster] = await Promise.all([listSeries(db), allSeriesEvents(db), listRoster(db)]);
  const sr = new Map(series.map(s => [s.id, s])), out = new Map();
  const get = (id, name) => { if (!out.has(id)) out.set(id, { custId: id, name, series: [], starts: 0, wins: 0, last: "" }); return out.get(id); };
  for (const [sid, evs] of bySeries) {
    for (const r of computeStats(evs)) {
      const d = get(r.custId, r.name);
      d.starts += r.starts; d.wins += r.wins;
      if (r.last > d.last) { d.last = r.last; d.name = r.name; }
      if (sr.has(sid)) d.series.push({ slug: sr.get(sid).slug, short: sr.get(sid).short_name });
    }
  }
  for (const r of roster) { const d = get(r.cust_id, r.name); if (sr.has(r.series_id) && !d.series.some(s => s.slug === sr.get(r.series_id).slug)) d.series.push({ slug: sr.get(r.series_id).slug, short: sr.get(r.series_id).short_name }); }
  return [...out.values()].sort((a, b) => b.starts - a.starts || a.name.localeCompare(b.name));
}

const pickSeason = (seasons, url) => { const want = Number(url.searchParams.get("season")); return seasons.find(se => se.id === want) || seasons[0] || null; };

async function seasonStandings(db, sr, season) {
  const r = await getRules(db, season.id, sr.id);
  const rules = cleanRules(r.rules || DEFAULT_RULES);
  const [events, adj] = await Promise.all([seasonEvents(db, season.id), listAdjustments(db, season.id)]);
  return { info: r, rules, adj, events, ...computeStandings(rules, events, adj) };
}

// a race just became official: its results and the standings go to the series' Discord channels (recent races only)
async function postOfficial(db, sub, origin) {
  const ev = await getEvent(db, sub);
  if (!ev || ev.status !== "official" || !isRecent(ev)) return 0;
  const sr = await seriesById(db, ev.series_id);
  let n = 0;
  if (sr.hook_results) { await enqueue(db, sr.id, "results", "results", sub, resultsPost(ev, origin, await listFixes(db, sub)), JSON.parse(ev.discord || "{}").results || null); n++; }
  if (sr.hook_standings && ev.season_id) {
    const season = { id: ev.season_id, name: ev.season_name || "" };
    await enqueue(db, sr.id, "standings", "standings", sub, standingsPost(sr, season, await seasonStandings(db, sr, season), ev, origin)); n++;
  }
  return n;
}

// a correction to an official race: the posted results are edited (when they were posted)
async function updatePosted(db, sub, origin) {
  const ev = await getEvent(db, sub);
  if (!ev || ev.status !== "official") return;
  const sr = await seriesById(db, ev.series_id), msg = JSON.parse(ev.discord || "{}").results;
  if (sr.hook_results && msg) await enqueue(db, sr.id, "results", "results", sub, resultsPost(ev, origin, await listFixes(db, sub)), msg);
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
      body += raceGrid(g, [...cur.rows, ...p.eliminated, ...p.others]);
    } else {
      const inField = g.regular.filter(s => s.inField).length;
      const cutAfter = po.enabled ? g.regular.findIndex((s, i) => i > 0 && !s.inField && g.regular.slice(0, i).filter(x => x.inField).length === inField) : 0;
      body += `<h2>${po.enabled ? "Regular season" : "Standings"} · ${g.regularRan} of ${po.enabled ? g.regularRaces : g.races.length} race${g.regularRan === 1 ? "" : "s"}</h2>`;
      if (po.enabled) body += `<p class="tag">Top ${po.field}${po.minStarts ? ` with at least ${po.minStarts} starts` : ""} make the playoffs${g.regularComplete ? "" : " (as things stand)"}.</p>`;
      body += regularTable(g.regular, rules, { cutAfter: cutAfter > 0 ? cutAfter : 0, playoffNote: po.enabled });
      body += raceGrid(g, g.regular);
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
    if(j.ok)say(file.name+': '+j.track+', '+j.results+' drivers'+(j.replaced?' (replaced the earlier upload'+(j.fixesCleared?', and its '+j.fixesCleared+' result fix'+(j.fixesCleared===1?'':'es')+': redo any that still apply':'')+')':''),j.fixesCleared?'bad':'ok','${BASE}/results/'+j.subsessionId);
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
  // uploaded from a schedule line: it must be that series' race
  const sched = form.get("schedule") ? await scheduleEntry(env.DB, Number(form.get("schedule"))) : null;
  if (form.get("schedule") && !sched) return json({ ok: false, error: "That schedule line isn't there any more. Reload the page." }, 404);
  if (sched && sched.series_id !== ev.league.id) {
    const want = await seriesById(env.DB, sched.series_id);
    return json({ ok: false, error: `That file is ${sr ? `a ${sr.short_name} race` : `from iRacing league ${ev.league.id}`}, not ${want ? want.short_name : "this series"}. Nothing was uploaded.` }, 400);
  }
  if (!user.admin && !canEdit(user, sr)) return json({ ok: false, error: sr ? `You can't upload ${sr.short_name} results. Ask an admin for that series' role.` : "Only admins can upload the first race of a new series." }, 403);
  const had = await getEvent(env.DB, ev.subsessionId || 0);
  try {
    const r = await importEvent(env.DB, ev, `discord:${user.id}:${user.name}`);
    await logChange(env.DB, { by: `discord:${user.id}:${user.name}`, seriesId: ev.league.id, sub: r.subsessionId, kind: "upload",
      summary: `Results uploaded: ${ev.track}${had ? " (replaced the earlier upload)" : ""}${r.fixesCleared ? `, ${r.fixesCleared} fix${r.fixesCleared === 1 ? "" : "es"} cleared` : ""}` });
    const origin = new URL(request.url).origin;
    const posts = r.nowOfficial ? await postOfficial(env.DB, r.subsessionId, origin) : 0;
    if (r.wasOfficial) await updatePosted(env.DB, r.subsessionId, origin);
    let linked = null;
    if (sched) {
      linked = await linkScheduleTo(env.DB, sched.id, r.subsessionId);
      if (linked.ok) await logChange(env.DB, { by: `discord:${user.id}:${user.name}`, seriesId: sched.series_id, sub: r.subsessionId, kind: "schedule",
        summary: `Results attached to the schedule: ${sched.track}, ${day(sched.starts_at)}` });
    }
    return json({ ok: true, ...r, track: ev.track, replaced: !!had, posts, linked });
  } catch (e) { return json({ ok: false, error: e.message }, 400); }
}

const KIND = { upload: "Upload", overlay: "Overlay", official: "Official", fix: "Fix", remove: "Removed", penalty: "Penalty", unpenalty: "Penalty removed",
  rules: "Rules", series: "Series", roster: "Drivers", schedule: "Schedule", webhook: "Discord", key: "Overlay key", merge: "Merge", separate: "Separate", note: "" };
function historyPage(rows, user) {
  const when = t => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"; };
  let body = `<h1>History</h1><p class="sub">Who changed what on the site, newest first${user.admin ? "" : " (your series)"}.</p>`;
  body += rows.length ? `<div class="wrap"><table><tr><th>When</th><th>Who</th><th>Series</th><th>What</th></tr>` + rows.map(c => `<tr><td>${when(c.at)}</td><td>${esc(whoName(c.by))}</td>
    <td>${c.slug ? `<a href="${BASE}/${esc(c.slug)}">${esc(c.short_name)}</a>` : ""}</td>
    <td style="white-space:normal">${KIND[c.kind] ? `<span class="cls">${esc(KIND[c.kind])}</span>` : ""}${c.subsession_id && c.track ? `<a href="${BASE}/results/${c.subsession_id}">${esc(c.summary)}</a>` : esc(c.summary)}</td></tr>`).join("") + `</table></div>`
    : `<p class="hint">Nothing yet.</p>`;
  return page("History", body, { user });
}

// series as the public sees them: never the webhook links
const pub = ({ hook_results, hook_standings, hook_penalties, ...rest }) => rest;
const sameOrigin = (request, url) => request.headers.get("origin") === url.origin;
const bearer = request => (/^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "") || [])[1] || "";

function keysPage(keys, user, { newKey = "", newKind = "overlay", msg = "" } = {}) {
  let body = `<h1>Overlay keys</h1><p class="sub">A key lets a producer's overlay send its race results here when a race ends. They arrive as Provisional and the official iRacing results file replaces them when it's uploaded. A key can only send results: it can't change rules, penalties or anything else.</p>`;
  if (newKey) body += `<div class="msg ok"><b>New key, shown only this once.</b> ${newKind === "import" ? "Use it for the backfill, then turn it off below." : "Paste it into the overlay: control panel › Setup › League site upload."}<code class="key">${esc(newKey)}</code></div>`;
  if (msg) body += `<div class="msg bad">${esc(msg)}</div>`;
  body += `<form method="post"><label for="kn">Name (whose overlay is it?)</label><input type="text" id="kn" name="name" maxlength="60" required>
    <label class="chk"><input type="checkbox" name="import"> Import key instead: official iRacing results from the iRacing members site, for a one-time backfill of past races. Turn it off when the backfill is done.</label>
    <p><button class="btn">Make a key</button></p></form>`;
  body += keys.length ? `<h2>Keys</h2><div class="wrap"><table><tr><th>Name</th><th>Made</th><th>Last used</th><th class="n">Races sent</th><th></th></tr>` +
    keys.map(k => `<tr><td>${esc(k.name)}${k.kind === "import" ? ` <span class="cls">Import</span>` : ""}${k.revoked ? ` <span class="tag">(turned off)</span>` : ""}</td><td>${day(k.created_at)}</td><td>${k.last_used ? day(k.last_used) : "Never"}</td>
      <td class="n">${k.uses}</td><td>${k.revoked ? "" : `<form method="post"><input type="hidden" name="revoke" value="${k.id}"><button class="link" onclick="return confirm('Turn this key off? That overlay stops sending results until it gets a new key.')">Turn off</button></form>`}</td></tr>`).join("") + `</table></div>` : "";
  return page("Overlay keys", body, { user });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueue(env.DB));       // retry Discord posts that are waiting
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const kick = () => { if (ctx) ctx.waitUntil(processQueue(env.DB).catch(e => console.error(e))); };
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
        const res = await upload(request, env, user);
        kick();
        return res;
      }
      if (path === `${BASE}/api/import`) {
        const cors = { "access-control-allow-origin": "https://members-ng.iracing.com", "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST, OPTIONS", "access-control-max-age": "600", vary: "origin" };
        const cj = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        if (request.method !== "POST") return cj({ ok: false, error: "Use POST." }, 405);
        const key = await checkKey(db, bearer(request), "import");
        if (!key) return cj({ ok: false, error: "That isn't a working import key." }, 401);
        let ev;
        try { ev = parseExport(await request.text(), ""); } catch (e) { return cj({ ok: false, error: e.message }, 400); }
        const had = await getEvent(db, ev.subsessionId || 0);
        try {
          const by = `import:${key.id}:${key.name}`, r = await importEvent(db, ev, by);
          await logChange(db, { by, seriesId: ev.league.id, sub: r.subsessionId, kind: "upload", summary: `Results imported from iRacing: ${ev.track}${had ? " (replaced the earlier copy)" : ""}` });
          return cj({ ok: true, subsessionId: r.subsessionId, track: ev.track, drivers: r.results, replaced: !!had });
        } catch (e) { return cj({ ok: false, error: e.message }, 400); }
      }
      if (path === `${BASE}/api/overlay/check` || path === `${BASE}/api/overlay/results`) {
        const key = await checkKey(db, bearer(request));
        if (!key) return json({ ok: false, error: "The site doesn't recognise this key. Make a new one on the site's Overlay keys page." }, 401);
        if (path.endsWith("/check")) return json({ ok: true, name: key.name });
        if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
        let ev;
        try { ev = parseOverlay(await request.json()); } catch (e) { return json({ ok: false, error: e.message }, 400); }
        const r = await importOverlay(db, ev, `overlay:${key.id}:${key.name}`);
        if (r.ok && !r.skipped) await logChange(db, { by: `overlay:${key.id}:${key.name}`, seriesId: ev.league.id, sub: ev.subsessionId, kind: "overlay",
          summary: `Provisional results from the overlay: ${ev.track}${r.replaced ? " (updated)" : ""}` });
        return json(r, r.status || 200);
      }
      if (path === `${BASE}/keys`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/keys`, 302);
        if (!user.admin) return notFound("Only admins can manage overlay keys.", user);
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return keysPage(await listKeys(db), user, { msg: "Do this from this page." });
          const f = await request.formData();
          const who = `discord:${user.id}:${user.name}`;
          if (f.get("revoke")) {
            const k = (await listKeys(db)).find(x => x.id === Number(f.get("revoke")));
            await revokeKey(db, Number(f.get("revoke")));
            await logChange(db, { by: who, kind: "key", summary: `Overlay key turned off: ${k ? k.name : f.get("revoke")}` });
            return Response.redirect(`${url.origin}${BASE}/keys`, 303);
          }
          try {
            const kind = f.get("import") ? "import" : "overlay";
            const k = await createKey(db, f.get("name"), who, kind);
            await logChange(db, { by: who, kind: "key", summary: `${kind === "import" ? "Import" : "Overlay"} key made: ${String(f.get("name")).trim()}` });
            return keysPage(await listKeys(db), user, { newKey: k, newKind: kind });
          }
          catch (e) { return keysPage(await listKeys(db), user, { msg: e.message }); }
        }
        return keysPage(await listKeys(db), user);
      }
      if (path === `${BASE}/api/me`) return json({ ok: true, user, signIn: configured(env) });
      if (path === `${BASE}/api/events`) return json({ ok: true, events: await listEvents(db, { season: Number(url.searchParams.get("season")) || 0 }) });
      if (path === `${BASE}/api/series`) return json({ ok: true, series: (await listSeries(db)).map(pub) });
      if ((m = path.match(/^\/glr\/api\/series\/([a-z0-9-]+)$/))) { const sr = await getSeries(db, m[1]); return sr ? json({ ok: true, series: pub(sr) }) : json({ ok: false, error: "No such series" }, 404); }
      if ((m = path.match(/^\/glr\/api\/results\/(\d+)$/))) { const ev = await getEvent(db, Number(m[1])); return ev ? json({ ok: true, event: ev }) : json({ ok: false, error: "No such race" }, 404); }
      if ((m = path.match(/^\/glr\/api\/drivers\/(\d+)$/))) { const d = await getDriver(db, Number(m[1])); return d ? json({ ok: true, driver: d }) : json({ ok: false, error: "No such driver" }, 404); }
      if (path === BASE) {
        const next = new Map();
        for (const r of await upcoming(db, 120)) if (!next.has(r.series_id)) next.set(r.series_id, r);
        return homePage(await listSeries(db), await listEvents(db, { limit: 15 }), user, next);
      }
      if ((m = path.match(/^\/glr\/results\/(\d+)$/))) {
        const sub = Number(m[1]);
        let ev = await getEvent(db, sub);
        if (!ev) return notFound("No race with that session number has been uploaded.", user);
        const edit = canEdit(user, await seriesById(db, ev.series_id));
        let msg = "";
        if (request.method === "POST") {
          if (!edit || !sameOrigin(request, url)) return notFound("You can't change this race.", user);
          const f = await request.formData(), who = `discord:${user.id}:${user.name}`;
          if (f.get("action") === "delete") {
            await logChange(db, { by: who, seriesId: ev.series_id, kind: "remove", summary: `Race removed: ${ev.track}, ${day(ev.start_time)} (iRacing session ${sub})` });
            await deleteEvent(db, sub);
            return Response.redirect(`${url.origin}${BASE}/${ev.slug || ""}`, 303);
          }
          if (f.get("action") === "official") {
            if (await markOfficial(db, sub, who)) {
              await logChange(db, { by: who, seriesId: ev.series_id, sub, kind: "official", summary: `Results marked official: ${ev.track}` });
              const n = await postOfficial(db, sub, url.origin);
              msg = "Marked official." + (n ? " Posting to Discord." : "");
              kick();
            }
            ev = await getEvent(db, sub);
            return resultPage(ev, user, { fixes: await listFixes(db, sub), edit, msg });
          }
          try {
            const cust = Number(f.get("cust")), change = await fixResult(db, sub, cust, { finish_pos: f.get("finish_pos"), laps: f.get("laps"), laps_led: f.get("laps_led"),
              incidents: f.get("incidents"), league_points: f.get("league_points"), reason_out: f.get("reason_out") }, f.get("reason"), who);
            msg = "Fixed: " + change;
            ev = await getEvent(db, sub);
            await logChange(db, { by: who, seriesId: ev.series_id, sub, kind: "fix",
              summary: `Result fixed: ${(ev.sessions.race.find(r => r.cust_id === cust) || {}).name || cust}: ${change} (${String(f.get("reason")).trim()})` });
            if (ev.status === "official") {
              const sr = await seriesById(db, ev.series_id), name = (ev.sessions.race.find(r => r.cust_id === cust) || {}).name || "";
              if (sr.hook_penalties) await enqueue(db, sr.id, "penalties", "fix", sub, fixPost(sr, ev, name, change, f.get("reason"), url.origin));
              await updatePosted(db, sub, url.origin);
              kick();
            }
          } catch (e) { msg = e.message; }
        }
        return resultPage(ev, user, { fixes: await listFixes(db, sub), edit, msg });
      }
      if (path === `${BASE}/history`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/history`, 302);
        const mine = user.admin ? null : (await listSeries(db)).filter(x => x.role_id && user.roles.includes(x.role_id)).map(x => x.id);
        return historyPage(await listChanges(db, { seriesIds: mine }), user);
      }
      if ((m = path.match(/^\/glr\/drivers\/(\d+)$/))) {
        const cust = Number(m[1]);
        let msg = "";
        if (request.method === "POST") {
          if (!user || !user.admin || !sameOrigin(request, url)) return notFound("Only admins can merge drivers.", user);
          const f = await request.formData(), who = `discord:${user.id}:${user.name}`;
          try {
            if (f.get("action") === "separate") {
              const from = Number(f.get("from")), n = await separateDriver(db, cust, from);
              const [ka, kb] = await Promise.all([getDriver(db, cust), getDriver(db, from)]);
              await logChange(db, { by: who, kind: "separate", summary: `Drivers separated again: ${kb ? kb.name : ""} (${from}) got ${n} race${n === 1 ? "" : "s"} back from ${ka ? ka.name : ""} (${cust})` });
              msg = `Separated: iRacing ID ${from} has its ${n} race${n === 1 ? "" : "s"} back.`;
            } else {
              const other = Number((/(\d{3,})\)?\s*$/.exec(String(f.get("other") || "")) || [])[1]);
              const r = await mergeDrivers(db, cust, other, who);
              await logChange(db, { by: who, kind: "merge", summary: `Drivers merged: ${r.merged} (${other}) into ${r.kept} (${cust})` });
              msg = `Merged: ${r.merged}'s races are now on this driver.`;
            }
          } catch (e) { msg = e.message; }
        }
        let d = await getDriver(db, cust);
        if (!d) {
          const added = (await listRoster(db)).filter(r => r.cust_id === cust);
          if (!added.length) return notFound("No driver with that iRacing ID has raced here yet.", user);
          d = { cust_id: cust, name: added[0].name, names: [], races: [] };
        }
        return driverPage(d, user, user && user.admin ? { aliases: await aliasesOf(db, cust), all: await findDrivers(db), msg } : {});
      }
      if ((m = path.match(/^\/glr\/api\/standings\/([a-z0-9-]+)$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return json({ ok: false, error: "No such series" }, 404);
        const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url);
        if (!season) return json({ ok: true, series: sr.short_name, season: null, groups: [] });
        const st = await seasonStandings(db, sr, season);
        return json({ ok: true, series: sr.short_name, season: { id: season.id, name: season.name }, rules: st.rules, groups: st.groups, adjustments: st.adj });
      }
      if (path === `${BASE}/schedule`) return leagueSchedulePage(await upcoming(db), user);
      if (path === `${BASE}/api/schedule`) return json({ ok: true, races: (await upcoming(db)).map(r => ({ series: r.short_name, slug: r.slug, startsAt: r.starts_at, track: r.track, notes: r.notes })) });
      if ((m = path.match(/^\/glr\/(?:api\/series\/)?([a-z0-9-]+)\/schedule$/))) {
        const sr = await getSeries(db, m[1]), api = path.startsWith(`${BASE}/api/`);
        if (!sr) return api ? json({ ok: false, error: "No such series" }, 404) : notFound("No series at that address.", user);
        let msg = "";
        if (request.method === "POST" && !api) {
          if (!canEdit(user, sr) || !sameOrigin(request, url)) return notFound("You can't change this series.", user);
          const f = await request.formData(), who = `discord:${user.id}:${user.name}`;
          try {
            if (f.get("remove")) {
              const r = await deleteSchedule(db, sr.id, Number(f.get("remove")));
              if (r) await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `Removed from the schedule: ${r.track}, ${day(r.starts_at)}` });
              msg = "Removed.";
            } else if (f.has("bulk")) {
              const n = await addScheduleLines(db, sr.id, f.get("bulk"), who);
              await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `${n} race${n === 1 ? "" : "s"} added to the schedule` });
              msg = `Added ${n} race${n === 1 ? "" : "s"}.`;
            } else {
              const r = await addSchedule(db, sr.id, { date: f.get("date"), time: f.get("time"), track: f.get("track"), notes: f.get("notes") }, who);
              await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `Added to the schedule: ${r.track}, ${day(r.at)}` });
              msg = `Added ${r.track}.`;
            }
          } catch (e) { msg = e.message; }
        }
        const rows = await listSchedule(db, sr.id);
        if (api) return json({ ok: true, series: sr.short_name, races: rows.map(r => ({ startsAt: r.starts_at, track: r.track, notes: r.notes, subsessionId: r.subsession_id || null })) });
        const w = new Map((await listEvents(db, { series: sr.id })).map(e => [e.subsession_id, e.winners]));
        return schedulePage(sr, rows, w, user, msg);
      }
      if (path === `${BASE}/drivers`) return leagueDriversPage(await leagueDrivers(db), user);
      if (path === `${BASE}/api/drivers`) return json({ ok: true, drivers: await leagueDrivers(db) });
      if ((m = path.match(/^\/glr\/(?:api\/series\/)?([a-z0-9-]+)\/(stats|drivers)$/))) {
        const sr = await getSeries(db, m[1]), api = path.startsWith(`${BASE}/api/`);
        if (!sr) return api ? json({ ok: false, error: "No such series" }, 404) : notFound("No series at that address.", user);
        if (m[2] === "stats") {
          const seasons = await seasonsOf(db, sr.id), all = url.searchParams.get("season") === "all";
          const season = all ? null : pickSeason(seasons, url);
          const evs = await seriesEvents(db, sr.id, all ? null : season && season.id);
          const rows = season || all ? computeStats(evs) : [];
          if (api) return json({ ok: true, series: sr.short_name, season: all ? "all" : season && { id: season.id, name: season.name }, races: evs.length, drivers: rows });
          return statsPage(sr, seasons, all ? "all" : season && season.id, rows, evs.length, user);
        }
        let msg = "";
        if (request.method === "POST" && !api) {
          if (!canEdit(user, sr) || !sameOrigin(request, url)) return notFound("You can't change this series.", user);
          const f = await request.formData(), who = `discord:${user.id}:${user.name}`;
          try {
            if (f.get("remove")) {
              const n = await removeRoster(db, sr.id, Number(f.get("remove")));
              await logChange(db, { by: who, seriesId: sr.id, kind: "roster", summary: `Driver removed from the list: ${n || f.get("remove")}` });
              msg = `Removed ${n || "the driver"} from the list.`;
            } else {
              const r = await addRoster(db, sr.id, { cust: f.get("cust"), name: f.get("name"), number: f.get("number") }, who);
              await logChange(db, { by: who, seriesId: sr.id, kind: "roster", summary: `Driver added to the list: ${r.name} (${r.cust})${r.number ? ` #${r.number}` : ""}` });
              msg = `Added ${r.name}.`;
            }
          } catch (e) { msg = e.message; }
        }
        const [rows, roster] = await Promise.all([seriesEvents(db, sr.id).then(computeStats), listRoster(db, sr.id)]);
        if (api) return json({ ok: true, series: sr.short_name, drivers: rows.map(r => ({ custId: r.custId, name: r.name, number: r.number, starts: r.starts, wins: r.wins, first: r.first, last: r.last })),
          added: roster.map(r => ({ custId: r.cust_id, name: r.name, number: r.car_number })) });
        return seriesDriversPage(sr, rows, roster, user, msg);
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
            await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "rules", summary: `Rules saved for ${season.name}` });
            return rulesPage(sr, seasons, season, { rules, own: true, updatedAt: new Date().toISOString() }, rules, events, user, "Saved. Standings use these rules now.");
          }
          return rulesPage(sr, seasons, season, info, rules, events, user);
        }
        const events = season ? await seasonEvents(db, season.id) : [];
        if (request.method === "POST") {
          const f = await request.formData();
          try {
            const who = `discord:${user.id}:${user.name}`;
            if (f.get("delete")) {
              const a = (await listAdjustments(db, season.id)).find(x => x.id === Number(f.get("delete")));
              await deleteAdjustment(db, season.id, Number(f.get("delete")));
              if (a) await logChange(db, { by: who, seriesId: sr.id, sub: a.subsession_id, kind: "unpenalty", summary: `Penalty removed: ${a.name || a.cust_id} ${a.points} points at ${a.track} (${a.reason})` });
            } else {
              await addAdjustment(db, season.id, { sub: Number(f.get("sub")), cust: Number(f.get("cust")), points: f.get("points"), reason: f.get("reason") }, `discord:${user.id}:${user.name}`);
              if (sr.hook_penalties) {
                const a = await db.prepare(`SELECT a.*, r.name, r.car_number FROM adjustments a JOIN results r ON r.subsession_id = a.subsession_id AND r.cust_id = a.cust_id
                    AND r.session = 'race' WHERE a.subsession_id = ? ORDER BY a.id DESC LIMIT 1`).bind(Number(f.get("sub"))).first();
                const ev = await getEvent(db, Number(f.get("sub")));
                if (a && ev) { await enqueue(db, sr.id, "penalties", "penalty", ev.subsession_id, penaltyPost(sr, ev, a, url.origin)); kick(); }
              }
              const ev2 = await getEvent(db, Number(f.get("sub"))), who2 = ev2 && (ev2.sessions.race || []).find(r => r.cust_id === Number(f.get("cust")));
              await logChange(db, { by: who, seriesId: sr.id, sub: Number(f.get("sub")), kind: "penalty",
                summary: `Penalty: ${who2 ? who2.name : f.get("cust")} ${Number(f.get("points")) > 0 ? "+" : ""}${Math.round(Number(f.get("points")))} points at ${ev2 ? ev2.track : ""} (${String(f.get("reason")).trim()})` });
            }
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
          const f = await request.formData(), act = f.get("action");
          if (act === "hook" || act === "retry" || act === "discard") {
            let note = "";
            try {
              const kind = String(f.get("kind") || "");
              if (act === "retry") { await retryQueued(db, sr.id, Number(f.get("id"))); await processQueue(db); }
              else if (act === "discard") await discardQueued(db, sr.id, Number(f.get("id")));
              else if (f.get("clear")) { await setHook(db, sr.id, kind, ""); note = "Removed.";
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "webhook", summary: `Discord ${kind} posts switched off` }); }
              else if (f.get("test")) {
                await enqueue(db, sr.id, kind, "test", null, { embeds: [{ title: `${sr.short_name}: test post`, color: 0xFF0D40,
                  description: `This channel will get the ${sr.short_name} ${kind} posts from the VSPEED GLR site.`, url: `${url.origin}${BASE}/${sr.slug}` }] });
                const out = await processQueue(db);
                note = out.includes("sent") ? "Test sent. Check the channel." : "The test didn't go through; see Waiting to post below.";
              } else {
                const u = String(f.get("url") || "").trim();
                if (!u) throw new Error("Paste the webhook link first.");
                await setHook(db, sr.id, kind, u); note = "Saved. Press Send test to check it.";
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "webhook", summary: `Discord ${kind} webhook ${sr[`hook_${kind}`] ? "replaced" : "set"}` });
              }
            } catch (e) { note = e.message; }
            return seriesEditPage(await getSeries(db, sr.slug), user, "", await queueFor(db, sr.id), note);
          }
          try {
            const who = `discord:${user.id}:${user.name}`;
            if (user.admin && f.has("role_id") && String(f.get("role_id")).trim() !== (sr.role_id || "")) {
              await setSeriesRole(db, sr.id, f.get("role_id"));
              await logChange(db, { by: who, seriesId: sr.id, kind: "series", summary: String(f.get("role_id")).trim() ? `Officials' Discord role set (${String(f.get("role_id")).trim()})` : "Officials' Discord role removed" });
            }
            const r = await updateSeries(db, sr.id, { shortName: f.get("short_name"), slug: f.get("slug") });
            if (r.shortName !== sr.short_name || r.slug !== sr.slug)
              await logChange(db, { by: who, seriesId: sr.id, kind: "series", summary: `Name or address changed: ${sr.short_name} (/${sr.slug}) → ${r.shortName} (/${r.slug})` });
            return Response.redirect(`${url.origin}${BASE}/${r.slug}`, 303); }
          catch (e) { return seriesEditPage({ ...sr, short_name: f.get("short_name") || sr.short_name, slug: f.get("slug") || sr.slug }, user, e.message, await queueFor(db, sr.id)); }
        }
        return seriesEditPage(sr, user, "", await queueFor(db, sr.id));
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
