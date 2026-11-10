/*
 * VSPEED GLR league site (glrhub.app (and vspeedlivetiming.app/glr, which forwards)).
 *
 * Pages:  /glr                    every series with its latest race, then the latest races
 *         /<series>           one series (its short address, e.g. /arca): seasons and races
 *         /<series>/standings  standings for a season (?season=<id>, newest by default), by class when multi-class
 *         /<series>/schedule  the series' races: upcoming, and completed ones linked to their results
 *         /schedule           the league calendar: every series' upcoming races
 *         /<series>/stats     driver stats for a season or all seasons (?season=<id>|all)
 *         /<series>/drivers   everyone who has raced in the series, plus drivers its officials have added
 *         /drivers            the league driver list: every driver in every series
 *         /<series>/rules     the season's points and playoff rules; that series' officials can change them
 *         /<series>/penalties points penalties and adjustments, with reasons
 *         /<series>/edit      officials: the series' short name and address; admins: its Discord role
 *         /results/<session>  one race (iRacing subsession id), split by class in a multi-class race
 *         /results/<session>/stewards  the stewards' report: protests and decisions; drivers file protests here,
 *                                 stewards decide them
 *         /protests           signed in: stewards see open protests, drivers see their own
 *         /drivers/<cust id>  one driver: every name they've raced under, stats and races by series
 * Data:   /api/series, /api/series/<series>, /api/events, /api/results/<session>,
 *         /api/drivers/<cust id>, /api/standings/<series>?season=<id>   (the same, as JSON)
 *         /health
 *         /upload             officials upload iRacing result files (JSON or CSV)
 *         /keys               admins: overlay keys, for producers' overlays to send their race results
 *         /<series>/widget/standings|teams|schedule|results   small pages (teams: a series with team points) to embed on a website or use in OBS/vMix
 *                                 (?rows=10&bg=transparent|page&theme=glr|vspeed&class=GT3&refresh=60)
 *         /<series>/embed     the widgets with options, a preview and the code to paste
 *         /settings           admins: the site's theme, the league's short name and the race control role
 *         /theme/<file>       the themes' images (the GLR logo)
 *         /history            officials: who changed what (admins: every series; series officials: their own)
 *         /api/overlay/results  POST from an overlay (Authorization: Bearer <key>): provisional results
 *         /api/overlay/check    GET with the same header: is this key good?
 *         /api/overlay/calls/<session>  GET with the same header: race control's calls on a race (penalty box)
 *         /api/overlay/link, link/poll, signout  the overlay signs in with a producer's Discord account instead of a
 *                                   key (Authorization: Bearer vsov_...): glr/OVERLAY-SIGNIN.md
 *         /overlay/link?code=...    where a producer presses Allow for their overlay
 *         /api/rc/...           race control (Authorization: Bearer vsrc_...): link + link/poll to sign in, check,
 *                                   signout, races/<session> (PUT the race's calls, GET every call on it). See the plan
 *                                   doc, "Sending calls to the site (phase 5c)".
 *         /rc/link?code=...     where a steward presses Allow for race control on their PC
 *         /api/import         POST official iRacing results (the results JSON) with an import key, from the iRacing
 *                                 members site (CORS): for one-time backfills of past races
 *         /login, /auth/callback, /logout    Discord sign-in (auth.js)
 */
import { latestRelease } from "./release.js";
import { systemPrompt, cleanTurns, askClaude, HELP_PER_DAY } from "./help.js";
import { roundState, currentRound, liveRounds, saveRound, closeRound, holds, listSignups, activeOf, mineIn, signUp, withdraw, decide, release,
  changeNumber, raceFlags, entryCsv, newDriver } from "./signups.js";
import { teamStandings, parseTeams, teamsCsv } from "./teams.js";
import { listEvents, listSeries, getSeries, updateSeries, getEvent, getDriver, importEvent, seriesById, seasonsOf,
  getRules, saveRules, seasonEvents, listAdjustments, addAdjustment, deleteAdjustment,
  importOverlay, listKeys, createKey, revokeKey, checkKey, deleteEvent, listFixes, fixResult, FIX_FIELDS, markOfficial, setHook, HOOKS,
  logChange, listChanges, whoName, mergeDrivers, separateDriver, aliasesOf, findDrivers,
  seriesEvents, allSeriesEvents, listRoster, addRoster, removeRoster, listSchedule, upcoming, addSchedule, addScheduleLines, deleteSchedule,
  scheduleEntry, linkScheduleTo, getSetting, setSetting, editSchedule,
  linkDriver, unlinkDriver, setLink, linkedAccount, listAccounts, listClaims, decideClaim, getTeams, saveTeams, setSeriesTeams, listBlocks, setBlock, missedResults, announcerShow, addSeries, setSeriesHidden, setLogo, getLogo, logHelp, helpToday, listHelp, setEventSeason, saveProfile, PROFILE_FIELDS, driversForMatching, directorOf, listDirectors, setDirector, accountRoles, searchDrivers, normName, decisionsFor, fileProtest, listProtests, getProtest, setProtestStatus, listDecisions, addDecision, editDecision, deleteDecision,
  saveRaceCalls, raceCalls } from "./db.js";
import { KINDS, AMOUNT, CHANGES_ORDER, decisionText } from "./stewards.js";
import { resultsPost, standingsPost, teamStandingsPost, penaltyPost, fixPost, decisionPost, penaltyReportPost, enqueue, processQueue, queueFor, retryQueued, discardQueued, isRecent } from "./discord.js";
import { computeStandings, cleanRules, DEFAULT_RULES, GLR_PLAYOFFS } from "./standings.js";
import { computeStats, leaders, COLUMNS } from "./stats.js";
import { THEMES, themeOf } from "./themes.js";
import { ASSETS } from "./assets.js";
import { parseExport, parseOverlay } from "./parse.js";
import { configured, login, callback, currentUser, logout, canEdit, canSteward, cookies,
  raceControlUser, overlayUser, recheckRoles, BLOCK_MSG, PROGRAMS, linkStart, linkPoll, linkFind, linkAllow, programSignOut, listProgramSessions, revokeProgramSession } from "./auth.js";

// the site sits at the front of its own domain (glrhub.app, Nov 7 2026); it was vspeedlivetiming.app/glr before
const BASE = "";
export const SITE = "https://glrhub.app";
const OLD_HOST = "vspeedlivetiming.app", OLD_BASE = "/glr";
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

// what the header shows besides the usual links: set for each request before its page is made
const NAV = { signup: false };
const page = (title, body, { status = 200, user = null } = {}) => new Response(`<!doctype html><html lang="en"__THEME_MODE__><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>__THEME_FONTS__<style>
:root{__THEME_VARS__}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif}
header{border-bottom:1px solid var(--line);padding:12px 16px}header a{color:var(--text);text-decoration:none;font-weight:700;letter-spacing:.04em}
header a span{color:var(--accent)}main{max-width:1000px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 4px;border-left:4px solid var(--accent);padding-left:10px}h2{font-size:16px;margin:28px 0 8px}
.sub{color:var(--dim);margin:0 0 18px;padding-left:14px}a{color:var(--link)}.hint{color:var(--dim)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 10px;text-align:left;white-space:nowrap}
th{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--line)}
tr+tr td{border-top:1px solid var(--line)}
table.pin{border-collapse:separate;border-spacing:0}table.pin th:first-child,table.pin td:first-child{position:sticky;left:0;z-index:1;background:var(--card);box-shadow:1px 0 0 var(--line)}
table.pin td:first-child{max-width:46vw;overflow:hidden;text-overflow:ellipsis}
.wrap.pinwrap{max-height:85vh;overflow:auto}table.pin th{position:sticky;top:0;z-index:2;background:var(--card)}table.pin th:first-child{z-index:3}
header{display:flex;align-items:center;gap:14px}header .me{margin-left:auto;display:flex;gap:12px;align-items:center;font-size:14px}
header .me a{font-weight:400;letter-spacing:0;color:var(--link)}header form{margin:0}button.link{background:none;border:0;color:var(--link);font:inherit;cursor:pointer;padding:0}
.drop{border:2px dashed var(--line);border-radius:10px;padding:28px;text-align:center;background:var(--card)}.drop.on{border-color:var(--accent)}
.btn{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
.msg{margin:6px 0;padding:8px 12px;border-radius:6px;background:var(--card);border:1px solid var(--line)}.msg.bad{border-color:#a33}.msg.ok{border-color:#2a7}td.n,th.n{text-align:right}.stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:90px}
.stat b{display:block;font-size:20px}.stat small{color:var(--dim)}.tag{color:var(--dim);font-size:13px}
.crumb{font-size:13px;margin:0 0 6px;padding-left:14px}.crumb a{color:var(--dim)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;color:var(--text);text-decoration:none}
.card:hover{border-color:#44444c}.card b{display:block;font-size:18px;border-left:3px solid var(--accent);padding-left:8px;margin-bottom:2px}
.card .full{color:var(--dim);font-size:12px;padding-left:11px;margin-bottom:10px}
.shead{display:flex;align-items:center;gap:18px;margin-bottom:8px}.shead>div{min-width:0}.shlogo{height:96px;width:auto;flex:none}
@media (max-width:640px){.shead{gap:12px}.shlogo{height:64px}}
.card .slogo{height:120px;display:flex;align-items:center;justify-content:center;margin:2px 0 12px}.card .slogo img{max-height:120px;max-width:100%;object-fit:contain}.card .row{font-size:14px}.card .row span{color:var(--dim)}
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
label.up{margin:0 0 0 10px;display:inline;color:var(--link);font-size:13px;cursor:pointer;text-decoration:underline}.ups{font-size:13px;color:var(--dim)}.ups.bad{color:#ff8a8a}
.edrow td{background:var(--card)}.edf{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px 12px;padding:6px 0;white-space:normal}
.edf label{margin:0;display:flex;flex-direction:column;gap:3px}.edf input{width:100%}.edf .btn{align-self:end}
.grid-r td,.grid-r th{padding:5px 6px;text-align:center}.grid-r td.d{text-align:left;position:sticky;left:0;background:var(--card);z-index:1}
.grid-r .c{border-radius:4px;display:inline-block;min-width:26px;padding:1px 3px}.grid-r .w{background:#6b5313;color:#ffe08a;font-weight:700}
.grid-r .t5{background:#1f4630}.grid-r .t10{background:#1f3550}.grid-r .dnf{color:#ff8a8a}.grid-r .p{display:none}.grid-r.pts .p{display:inline}.grid-r.pts .f{display:none}
.seg2{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:0 0 10px}.seg2 button{background:none;border:0;color:var(--dim);padding:6px 12px;font:inherit;cursor:pointer}
.seg2 button.on{background:#2c2c32;color:var(--text)}time{white-space:nowrap}
.chg{font-size:12px;font-weight:600;width:42px}.chg .up{color:#1e9d46}.chg .dn{color:#d33}.bon{font-size:12px;color:var(--dim);white-space:normal;min-width:120px}
.protest{border:1px solid var(--line);border-radius:8px;padding:2px 14px 10px;margin:10px 0;background:var(--card)}.protest blockquote{margin:6px 0;padding:8px 12px;border-left:3px solid var(--line);color:var(--text);white-space:normal}
.protest details{margin-top:6px}.protest summary{cursor:pointer;color:var(--link);font-size:14px}.dec .grid select,.dec .grid input,.dec input[type=text]{width:100%}
.stw{margin:18px 0 4px;font-size:14px}tr.wd td b,tr.wd td:first-child{text-decoration:line-through;opacity:.6}textarea{width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
input.search{width:100%;max-width:360px;margin:0 0 12px;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
__THEME_CSS__</style></head><body><header><a class="brand" href="${BASE}/">__THEME_BRAND__</a>__THEME_SWITCH__<div class="me"><a href="${BASE}/">Series List</a><a href="${BASE}/schedule">Schedule</a><a href="${BASE}/drivers">Drivers</a>${NAV.signup ? `<a href="${BASE}/signup">Sign up</a>` : ""}${user
  ? `${user.cust ? `<a href="${BASE}/me">My races</a>` : ""}<a href="${BASE}/protests">Protests</a>${user.producer || usesRaceControl(user) ? `<a href="${BASE}/downloads">Downloads</a>` : ""}${user.official ? `<a href="${BASE}/history">History</a>${user.admin ? `<a href="${BASE}/accounts">Accounts</a>` : ""}${user.overlord ? `<a href="${BASE}/keys">Overlay keys</a><a href="${BASE}/settings">Settings</a>` : ""}<a href="${BASE}/upload">Upload results</a>` : ""}<span class="tag">${esc(user.name)}</span><form method="post" action="${BASE}/logout"><button class="link">Sign out</button></form>`
  : `<a href="${BASE}/login">Sign in</a>`}</div></header><main>${body}</main>${user && user.help && title !== "Help" ? helpWidget(user) : ""}</body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

// a hidden series is off the public lists (home, all-series Schedule and Drivers, Sign up) but works by its own link;
// admins and its directors still see it in the lists
const shown = (sr, user) => !sr.hidden || !!(user && (user.admin || (user.directs || []).includes(sr.id)));
// a series' logo: the uploaded one, else the one built into the site, else none
const logoUrl = sr => sr.logo_at ? `${BASE}/logo/${sr.id}?v=${encodeURIComponent(sr.logo_at)}` : ASSETS[`series-${sr.id}.png`] ? `${BASE}/theme/series-${sr.id}.png` : "";
const notFound = (what, user) => page("Not found", `<h1>Not found</h1><p class="sub">${esc(what)}</p>`, { status: 404, user });
const driverLink = (id, name) => `<a href="${BASE}/drivers/${id}">${esc(name)}</a>`;
const seriesLink = e => e.slug ? `<a href="${BASE}/${esc(e.slug)}">${esc(e.short_name)}</a>` : esc(e.series_name || "");
const crumb = e => e.slug ? `<p class="crumb"><a href="${BASE}/">GLR</a> › <a href="${BASE}/${esc(e.slug)}">${esc(e.short_name)}</a></p>` : "";
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
  const add = user && user.admin ? `<p><a class="btn" href="${BASE}/series/add" style="text-decoration:none;display:inline-block">Add series</a></p>` : "";
  if (!series.length) return page("VSPEED GLR", `<h1>Results</h1><p class="sub">No races uploaded yet.</p>${add}`, { user });
  let body = `<h1>Series</h1><p class="sub">${series.length} series</p><div class="cards">` +
    series.map(s => { const e = s.latestEvent, logo = logoUrl(s); return `<a class="card${logo ? " has-logo" : ""}" href="${BASE}/${esc(s.slug)}">${logo ? `<div class="slogo"><img src="${logo}" alt="${esc(s.short_name)} logo" loading="lazy"></div>` : ""}<b>${esc(s.short_name)}</b>${s.hidden ? ` <span class="cls">Hidden</span>` : ""}<div class="full">${esc(s.name)}</div>
      ${e ? `<div class="row"><span>Latest:</span> ${esc(e.track)}, ${day(e.start_time)}</div>
        <div class="row"><span>Won by</span> ${e.winners.map(w => (e.winners.length > 1 ? cls(w.carClass) : "") + esc(w.name)).join(" · ")}</div>` : ""}
      ${next.get(s.id) ? `<div class="row"><span>Next:</span> ${esc(next.get(s.id).track)}, ${when(next.get(s.id).starts_at)}</div>` : ""}
      <div class="row"><span>${s.races} race${s.races === 1 ? "" : "s"} uploaded</span></div></a>`; }).join("") + `</div>` + add;
  body += `<h2>Latest races</h2>` + raceTable(recent, { series: true });
  return page("VSPEED GLR results", body + LOCAL_JS, { user });
}

function seriesPage(sr, user) {
  let body = seriesTabs(sr, "results", [], null, user);
  if (!sr.seasons.length) body += `<p class="hint">No races uploaded yet.</p>`;
  for (const se of sr.seasons) body += `<h2>${esc(se.name)}</h2>` + (!se.id && canEdit(user, sr) ? `<p class="tag">Run outside a season in iRacing, so they don't count in the standings. Open a race and use <b>Add to a season</b> (Officials, at the bottom) to count it.</p>` : "") + raceTable(se.events);
  return page(`${sr.short_name} results`, body, { user });
}

const HOOK_LABEL = { results: "Results (when a race is official: podium, class winners, top 10)", standings: "Standings (after each official race)", teams: "Team standings (after each official race)", penalties: "Penalties and result fixes (when an official adds one)" };
// posts that can be sent again by hand for the latest official race (Send latest): a missed post, or one on demand
const LATEST = ["results", "standings", "teams"];
async function postLatest(db, sr, kind, origin) {
  const last = (await listEvents(db, { series: sr.id })).find(e => e.status === "official");
  if (!last) throw new Error("This series has no official race yet.");
  const ev = await getEvent(db, last.subsession_id);
  const season = { id: ev.season_id, name: ev.season_name || "" };
  if (kind === "results") await enqueue(db, sr.id, "results", "results", ev.subsession_id, resultsPost(ev, origin, await listFixes(db, ev.subsession_id)));
  else if (kind === "standings") await enqueue(db, sr.id, "standings", "standings", ev.subsession_id, standingsPost(sr, season, await seasonStandings(db, sr, season), ev, origin));
  else if (kind === "teams") {
    const teams = await getTeams(db, sr.id, ev.season_id);
    if (!teams.length) throw new Error("This season has no teams yet.");
    await enqueue(db, sr.id, "teams", "teams", ev.subsession_id, teamStandingsPost(sr, season, teamStandings(teams, await seasonStandings(db, sr, season)), ev, origin));
  } else throw new Error("That post can't be sent by hand.");
  return ev;
}

function hooksHtml(sr, queue, note) {
  const masked = u => { const m = /\/webhooks\/(\d+)\/([\w-]+)$/.exec(u || ""); return m ? `Saved (…${esc(m[2].slice(-4))})` : ""; };
  return `<h2 id="discord">Discord posts</h2>${note ? `<div class="msg ${/^(Saved|Removed|Test sent|Sent:)/.test(note) ? "ok" : "bad"}">${esc(note)}</div>` : ""}
  <p class="tag">Paste a webhook link for each channel to post to (in Discord: the channel's settings › Integrations › Webhooks › New Webhook › Copy Webhook URL). The same link can go in more than one box. Anyone with the link can post in that channel, so it's kept like a password and never shown again. Only races from the last 7 days post, so uploading an old season stays quiet.</p>
  ${HOOKS.filter(k => k !== "teams" || sr.teams).map(k => `<form method="post" action="#discord" class="hook"><input type="hidden" name="action" value="hook"><input type="hidden" name="kind" value="${k}">
    <label for="h_${k}">${HOOK_LABEL[k]}${sr[`hook_${k}`] ? ` · <b>${masked(sr[`hook_${k}`])}</b>` : ""}</label>
    <div class="row2"><input type="text" id="h_${k}" name="url" placeholder="${sr[`hook_${k}`] ? "Paste a new link to replace it" : "https://discord.com/api/webhooks/…"}" autocomplete="off" spellcheck="false">
    <button class="btn">Save</button>${sr[`hook_${k}`] ? `<button class="btn ghost" name="test" value="1">Send test</button>${LATEST.includes(k) ? `<button class="btn ghost" name="latest" value="1" onclick="return confirm('Post the ${k === "teams" ? "team standings" : k} for the latest official race to this channel now?')">Send latest</button>` : ""}<button class="btn ghost" name="clear" value="1" onclick="return confirm('Stop posting these?')">Remove</button>` : ""}</div></form>`).join("")}
  ${queue.length ? `<h2>Waiting to post</h2><div class="wrap"><table><tr><th>Post</th><th>Race</th><th>Problem</th><th></th></tr>` + queue.map(q => `<tr><td>${esc(q.kind)}</td>
    <td>${q.subsession_id ? `<a href="${BASE}/results/${q.subsession_id}">${q.subsession_id}</a>` : ""}</td><td style="white-space:normal">${esc(q.last_error || (q.attempts ? "" : "Sending…"))}${q.next_try > 8e15 ? " <b>(stopped)</b>" : ""}</td>
    <td><form method="post" action="#discord" style="display:inline"><input type="hidden" name="action" value="retry"><input type="hidden" name="id" value="${q.id}"><button class="link">Try again</button></form> ·
    <form method="post" action="#discord" style="display:inline"><input type="hidden" name="action" value="discard"><input type="hidden" name="id" value="${q.id}"><button class="link">Discard</button></form></td></tr>`).join("") + `</table></div>` : ""}`;
}

// the series edit page's directors list (admins), once the Series official role is set
const dirOpts = async (db, seriesId) => ({ officialRole: await getSetting(db, "official_role"), directors: (await listDirectors(db)).filter(d => d.series_id === seriesId) });

// what kind of image these bytes are, by their first bytes (not the file's name): PNG, JPG or WebP, else ""
function logoType(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return "";
}

function addSeriesPage(user, err = "", v = {}) {
  const val = k => esc(String(v[k] || ""));
  return page("Add series", `<p class="crumb"><a href="${BASE}/">GLR</a></p><h1>Add series</h1>
    <p class="sub">Add a series before its first race, so its directors, schedule, rules, signups and Discord posts can be set up. A series that has already raced can be added the same way: then upload its old results files.</p>
    ${err ? `<div class="msg bad">${esc(err)}</div>` : ""}
    <form method="post"><label for="lid">iRacing league ID</label><input type="number" id="lid" name="id" required min="1" value="${val("id")}" style="max-width:200px">
    <p class="tag">The number in the league's address on the iRacing members site. Each series is one iRacing league: results from the overlay, race control and uploaded files find the series by this number, so it has to be right. It can't be changed later.</p>
    <label for="sn">Short name (shown on the site)</label><input type="text" id="sn" name="short_name" maxlength="40" required placeholder="Trucks" value="${val("shortName")}">
    <label for="sl">Address: glrhub.app/…</label><input type="text" id="sl" name="slug" maxlength="40" placeholder="trucks" value="${val("slug")}">
    <p class="tag">Leave the address empty to make it from the short name.</p>
    <label for="fn">Full league name (optional)</label><input type="text" id="fn" name="name" maxlength="120" value="${val("name")}">
    <p class="tag">The first results file fills this in from iRacing.</p>
    <p><button class="btn">Add series</button></p></form>
    <p class="tag">Next, on the series' Edit page: its logo, Discord posts, and Hide from the Series List until it's ready. Assign its directors on Accounts.</p>`, { user });
}

function seriesEditPage(sr, user, err = "", queue = [], note = "", { officialRole = "", directors = [] } = {}) {
  return page(`Edit ${sr.short_name}`, `<p class="crumb"><a href="${BASE}/">GLR</a> › <a href="${BASE}/${esc(sr.slug)}">${esc(sr.short_name)}</a></p>
    <h1>Edit series</h1><p class="sub">${esc(sr.name)} · iRacing league ${sr.id}</p>${err ? `<div class="msg bad">${esc(err)}</div>` : ""}
    <form method="post"><label for="sn">Short name (shown on the site)</label><input type="text" id="sn" name="short_name" value="${esc(sr.short_name)}" maxlength="40" required>
    <label for="sl">Address: glrhub.app/…</label><input type="text" id="sl" name="slug" value="${esc(sr.slug)}" maxlength="40">
    <p class="tag">Changing the address breaks old links to this series. Race and driver links aren't affected.</p>
    ${user && user.admin ? `<input type="hidden" name="teams_form" value="1"><label class="chk"><input type="checkbox" name="teams"${sr.teams ? " checked" : ""}> Team points (the Warrior points system): a Teams tab with team standings</label>
    <label class="chk"><input type="checkbox" name="hidden"${sr.hidden ? " checked" : ""}> Hide from the Series List: off the home page, the all-series Schedule and Drivers pages and Sign up. It still works by its own link, results still arrive, and admins and its directors still see it.</label>` : ""}
    ${user && user.admin ? `<p class="stw"><b>Series directors:</b> ${directors.length ? directors.map(d => esc(d.name || d.discord_id)).join(", ") : "none yet"}. <a href="${BASE}/accounts">Assign on the Accounts page</a>.</p>
    <p class="tag">Directors need the Series official role in Discord too. They change only their series: its rules, penalties, results uploads and this page.</p>` : ""}
    <p><button class="btn">Save</button></p></form>
    <h2 id="logo">Logo</h2>${logoUrl(sr) ? `<p><img src="${logoUrl(sr)}" alt="${esc(sr.short_name)} logo" style="max-height:110px;max-width:320px"></p>` : `<p class="tag">No logo yet.</p>`}
    <form method="post" action="#logo" enctype="multipart/form-data"><input type="hidden" name="action" value="logo"><input type="file" name="file" accept="image/png,image/jpeg,image/webp" required> <button class="btn">Upload logo</button></form>
    <p class="tag">PNG, JPG or WebP, up to 500 KB. A wide logo with a clear background looks best. It shows on the Series List and at the top of the series' pages.</p>
    ${sr.logo_at ? `<form method="post" action="#logo"><input type="hidden" name="action" value="logo"><input type="hidden" name="remove" value="1"><button class="link">Remove this logo${ASSETS[`series-${sr.id}.png`] ? " (back to the built-in one)" : ""}</button></form>` : ""}
    ${hooksHtml(sr, queue, note)}`, { user });
}

function sessionTable(rows, race, inClass, score = null) {
  const sc = race && score;
  return `<div class="wrap"><table><tr><th class="n">Pos</th>${inClass ? `<th class="n">Overall</th>` : ""}<th>#</th><th>Driver</th>${race ? `<th class="n">Start</th><th class="n">Gap</th><th class="n">Laps</th><th class="n">Led</th>` : ""}
    <th class="n">Best lap</th>${race ? `<th class="n">Avg lap</th>` : ""}<th class="n">Inc</th>${race ? `<th>Status</th><th class="n">Pts</th>` : ""}${sc ? "<th>Bonus / penalty</th>" : ""}</tr>` +
    rows.map(r => `<tr><td class="n">${(inClass ? r.class_pos : r.finish_pos) ?? ""}</td>${inClass ? `<td class="n tag">${r.finish_pos ?? ""}</td>` : ""}
      <td>${esc(r.car_number)}</td><td>${driverLink(r.cust_id, r.name)}</td>
      ${race ? `<td class="n">${r.start_pos ?? ""}</td><td class="n">${gap(r, inClass)}</td><td class="n">${r.laps ?? ""}</td><td class="n">${r.laps_led || ""}</td>` : ""}
      <td class="n">${lap(r.best_lap_ms)}</td>${race ? `<td class="n">${lap(r.avg_lap_ms)}</td>` : ""}<td class="n">${r.incidents ?? ""}</td>
      ${race ? `<td>${esc(r.reason_out)}</td><td class="n">${sc ? `<b>${(score[r.cust_id] || {}).pts ?? ""}</b>` : r.league_points ?? ""}</td>` : ""}
      ${sc ? `<td class="bon">${[...((score[r.cust_id] || {}).bonusReasons || []), ...((score[r.cust_id] || {}).reasons || [])].map(esc).join("<br>")}</td>` : ""}</tr>`).join("") + `</table></div>`;
}

// a session's rows, one table per class when there's more than one (classes in the order their best car finished)
function sessionTables(rows, race, label, score = null) {
  const classes = [...new Set(rows.map(r => r.car_class))];
  if (classes.length < 2) return `<h2>${esc(label)}</h2>` + sessionTable(rows, race, false, score);
  return classes.map(c => `<h2>${esc(label)} ${cls(c)}</h2>` + sessionTable(rows.filter(r => r.car_class === c), race, race, score)).join("");
}

function fixesHtml(fixes) {
  if (!fixes.length) return "";
  return `<h2>Corrections</h2><div class="wrap"><table><tr><th>Driver</th><th>Changed</th><th>Reason</th><th>When</th></tr>` +
    fixes.map(f => `<tr><td>${driverLink(f.cust_id, f.name || f.cust_id)}</td><td style="white-space:normal">${Object.entries(f.changes).map(([k, [a, b]]) => `${esc(FIX_FIELDS[k] || k)} ${esc(a ?? "–")} → <b>${esc(b)}</b>`).join(", ")}</td>
      <td style="white-space:normal">${esc(f.reason)}</td><td>${day(f.created_at)}</td></tr>`).join("") + `</table></div>`;
}

function officialsPanel(ev, msg, seasons = []) {
  const race = (ev.sessions.race || []).slice().sort((a, b) => a.finish_pos - b.finish_pos);
  if (!race.length) return "";
  const D = race.map(r => ({ id: r.cust_id, t: `P${r.finish_pos} #${r.car_number} ${r.name}`, pos: r.finish_pos, laps: r.laps, led: r.laps_led, inc: r.incidents, st: r.reason_out, pts: r.league_points }));
  const n = (name, label, extra = "") => `<label>${label}<br><input type="number" name="${name}" id="fx_${name}" ${extra}></label>`;
  return `<h2 id="fix">Officials</h2>${msg ? `<div class="msg ${/^(Fixed|Marked|Added)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>` : ""}
  ${ev.series_id && !ev.season_id && seasons.length ? `<fieldset><legend>Add to a season</legend><form method="post" action="#fix"><input type="hidden" name="action" value="season">
    <p class="tag">This race was run outside the series' season in iRacing, so it's listed under Other races and doesn't count in the standings. Add it to a season to count it like any other race. Uploading the results file again won't take it back out.</p>
    <label for="se_id">Season</label><select id="se_id" name="season">${seasons.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>
    <p><button class="btn">Add to season</button></p></form></fieldset>` : ""}
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

function resultPage(ev, user, { fixes = [], edit = false, msg = "", score = null, seasons = [] } = {}) {
  const facts = [ev.laps != null && `${ev.laps} laps`, ev.cautions != null && `${ev.cautions} caution${ev.cautions === 1 ? "" : "s"}${ev.caution_laps ? ` (${ev.caution_laps} laps)` : ""}`,
    ev.lead_changes != null && `${ev.lead_changes} lead changes`, ev.sof && `SOF ${ev.sof}`].filter(Boolean).join(" · ");
  let body = crumb(ev) + `<h1>${esc(ev.track)}${prov(ev)}</h1>${ev.status === "provisional" ? `<p class="hint" style="padding-left:14px">Provisional: sent by the broadcast overlay at the end of the race. It's replaced by the official iRacing results file when that's uploaded, which also adds league points, qualifying and practice.</p>` : ""}<p class="sub">${day(ev.start_time)}${ev.season_name ? " · " + esc(ev.season_name) : ""}${facts ? " · " + facts : ""}</p>`;
  const names = { race: "Race", qualify: "Qualifying", practice: "Practice", warmup: "Warmup" };
  for (const s of ["race", "qualify", "warmup", "practice", ...Object.keys(ev.sessions).filter(k => !names[k])])
    if (ev.sessions[s]) body += sessionTables(ev.sessions[s], s === "race", names[s] || s, s === "race" ? score && score.points : null)
      + (s === "race" && score && score.note ? `<p class="tag">${score.note}</p>` : "") + (s === "race" ? fixesHtml(fixes) : "");
  const nd = (ev.decisions || []).length;
  body += `<p class="stw"><a href="${BASE}/results/${ev.subsession_id}/stewards">Stewards' report</a>${nd ? ` · ${nd} decision${nd === 1 ? "" : "s"}` : ""} · drivers in this race can file a protest there</p>`;
  body += `<p class="tag">iRacing session ${ev.subsession_id}</p>`;
  if (edit) body += officialsPanel(ev, msg, seasons);
  return page(`${ev.track} results`, body, { user });
}

/* ---------- stewards: protests and decisions ---------- */

// penalties given during the race: was it served? (from race control)
const servedText = d => {
  if (!["drivethrough", "stopgo", "eol"].includes(d.kind)) return "";
  const sim = (d.info || {}).sim;
  if (!sim) return "";
  return sim.state === "served" ? ` <span class="st good">served${sim.servedLap != null ? " lap " + esc(sim.servedLap) : ""}</span>`
    : ["notTaken", "failed", "cleared"].includes(sim.state) ? ` <span class="st bad">not served</span>` : "";
};
const carName = (num, name) => `${num ? `#${esc(num)} ` : ""}${esc(name || "")}`;
const STATUS = { open: ["Open", ""], decided: ["Decided", "good"], withdrawn: ["Withdrawn", "bad"] };
const statusTag = p => `<span class="st ${STATUS[p.status]?.[1] || ""}">${STATUS[p.status]?.[0] || esc(p.status)}</span>`;
const who = p => `${carName(p.filer_number, p.filer_name)}${p.against_cust ? ` <span class="tag">protests</span> ${carName(p.against_number, p.against_name)}` : ""}`;

// a steward never decides about their own car or a protest they're in: the one who filed it, or the one it's against
// (as far as the site knows who they are: the driver they linked to their Discord account). Nov 7, 2026.
const involvedIn = (user, p) => !!(user && user.cust && p && (p.filer_cust === user.cust || p.against_cust === user.cust));
const OWN_PROTEST = "You're involved in this protest, so another steward decides it.";
const OWN_CAR = "That's your own car: another steward makes decisions about you.";

// change a decision after further review: penalty, amount and reason (the driver stays the same)
const editForm = d => `<form method="post" action="#top" class="dec"><input type="hidden" name="action" value="edit"><input type="hidden" name="id" value="${d.id}">
  <p><b>Change this decision</b> <span class="tag">(after further review)</span></p>
  <div class="grid"><label>Decision<br><select name="kind">${Object.entries(KINDS).map(([k, t]) => `<option value="${k}"${k === d.kind ? " selected" : ""}>${t}</option>`).join("")}</select></label>
  <label>Points / places / seconds<br><input type="number" name="amount" min="0" max="999" value="${AMOUNT[d.kind] ? Math.abs(d.amount) : ""}"></label></div>
  <label>Reason (public, on the report)</label><input type="text" name="reason" maxlength="300" required value="${esc(d.reason || "")}">
  <p><button class="btn">Save change</button> <button type="button" class="link" onclick="this.closest('tr').hidden=true">Cancel</button> <span class="tag">Results and standings update straight away. The report shows what it was.</span></p></form>`;

function decisionForm(ev, race, { protest = null, self = null } = {}) {
  const pre = protest && protest.against_cust;
  race = race.filter(r => r.cust_id !== self);           // never offered a decision about themselves
  return `<form method="post" action="#p${protest ? protest.id : "new"}" class="dec"><input type="hidden" name="action" value="decide">${protest ? `<input type="hidden" name="protest" value="${protest.id}">` : ""}
    <div class="grid"><label>Driver<br><select name="cust">${race.map(r => `<option value="${r.cust_id}"${r.cust_id === pre ? " selected" : ""}>P${r.finish_pos} ${carName(r.car_number, r.name)}</option>`).join("")}</select></label>
    <label>Decision<br><select name="kind">${Object.entries(KINDS).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select></label>
    <label>Points / places / seconds<br><input type="number" name="amount" min="0" max="999" placeholder="for points, places or seconds"></label></div>
    <label>Reason (public, on the report)</label><input type="text" name="reason" maxlength="300" required>
    <p><button class="btn">Save decision</button></p></form>`;
}

function stewardsPage(ev, user, { protests = [], steward = false, msg = "", report = null } = {}) {
  const race = (ev.sessions.race || []).slice().sort((a, b) => a.finish_pos - b.finish_pos);
  const decs = ev.decisions || [];
  const ok = /^(Protest filed|Decision saved|Linked|Removed|Withdrawn|Reopened|Closed|Sent)/.test(msg);
  let body = crumb(ev) + `<h1>Stewards: ${esc(ev.track)}</h1><p class="sub">${day(ev.start_time)}${ev.season_name ? " · " + esc(ev.season_name) : ""} · <a href="${BASE}/results/${ev.subsession_id}">Results</a></p>`
    + (msg ? `<div class="msg ${ok ? "ok" : "bad"}">${esc(msg)}</div>` : "");
  // the decisions: the report everyone sees
  if (steward) body += `<style>tr.editrow td{background:var(--card);white-space:normal}tr.editrow .grid{display:flex;gap:12px;flex-wrap:wrap}tr.editrow input[type=text]{max-width:640px}</style>`;
  body += `<h2>Decisions</h2>`;
  // the series' directors and admins: send this race's penalties to the penalties channel by hand
  if (report) body += report.hook
    ? `<form method="post" action="#top" style="margin:0 0 10px" onsubmit="return confirm('Send this race\\'s penalty report to the penalties Discord channel?')"><input type="hidden" name="action" value="report"><button class="btn">Send penalty report to Discord</button>
      <span class="tag">One post with every penalty on this race (warnings, race control's calls, points penalties). Withdrawn calls and no action are left out.</span></form>`
    : `<p class="tag">To send this race's penalty report to Discord, add a Penalties webhook on <a href="${BASE}/${report.slug}/edit">Edit series</a>.</p>`;
  body += (decs.length ? `<div class="wrap"><table><tr><th>Driver</th><th>Decision</th><th>Reason</th><th>When</th>${steward ? "<th></th>" : ""}</tr>` +
    decs.map(d => { const off = d.status === "withdrawn", rc = d.source === "race control", info = d.info || {};
      return `<tr${off ? ' class="wd"' : ""}><td>${driverLink(d.cust_id, `${d.car_number ? "#" + d.car_number + " " : ""}${d.name || d.cust_id}`)}</td>
      <td><b>${esc(decisionText(d))}</b>${servedText(d)}${rc ? ` <span class="tag">race control${info.lap != null ? `, lap ${esc(info.lap)}` : ""}</span>` : ""}</td>
      <td style="white-space:normal">${esc(d.reason)}${d.protest_id ? ` <span class="tag">(protest ${d.protest_id})</span>` : ""}${d.edited_at ? `<br><span class="tag">Changed ${day(d.edited_at)} by ${esc(whoName(d.edited_by))}, was ${esc(d.edited_from || "")}</span>` : ""}${off ? `<br><span class="tag">Withdrawn${d.withdrawn_reason ? ": " + esc(d.withdrawn_reason) : ""}</span>` : ""}</td><td>${day(d.made_at)}</td>
      ${steward ? `<td>${off || d.cust_id === (user && user.cust) || involvedIn(user, protests.find(p => p.id === d.protest_id)) ? "" : `<button type="button" class="link" onclick="const r=this.closest('tr').nextElementSibling;r.hidden=!r.hidden">Edit</button> `}${off || d.cust_id === (user && user.cust) || involvedIn(user, protests.find(p => p.id === d.protest_id)) ? "" : rc ? `<form method="post" action="#top" onsubmit="return confirm('Withdraw this race control call? It stays on the report, crossed out, and anything it changed goes back. Race control can\\'t bring it back.')"><input type="hidden" name="action" value="undo"><input type="hidden" name="id" value="${d.id}"><button class="link">Withdraw</button></form>`
        : `<form method="post" action="#top" onsubmit="return confirm('Take this decision back? Any points or places it changed go back too.')"><input type="hidden" name="action" value="undo"><input type="hidden" name="id" value="${d.id}"><button class="link">Take back</button></form>`}</td>` : ""}</tr>${steward && !(off || d.cust_id === (user && user.cust) || involvedIn(user, protests.find(p => p.id === d.protest_id))) ? `<tr class="editrow" hidden><td colspan="5">${editForm(d)}</td></tr>` : ""}`; }).join("") + `</table></div>`
    : `<p class="hint">No decisions for this race.</p>`);
  // the protests: who protested whom, and where it stands. What was written is for the stewards and the driver who filed it.
  body += `<h2>Protests</h2>`;
  if (!protests.length) body += `<p class="hint">No protests filed.</p>`;
  for (const p of protests) {
    const mine = user && user.cust && p.filer_cust === user.cust;
    const pd = decs.filter(d => d.protest_id === p.id);
    body += `<div class="protest" id="p${p.id}"><p><b>Protest ${p.id}</b> · ${who(p)}${p.lap ? ` · ${esc(p.lap)}` : ""} · ${statusTag(p)}${pd.length ? ` · ${pd.map(d => esc(`${d.name || ""}: ${decisionText(d)}`)).join("; ")}` : ""}</p>`;
    if (steward || mine) body += `<blockquote>${esc(p.what).replace(/\n/g, "<br>")}${p.video ? `<br><a href="${esc(p.video)}" target="_blank" rel="noopener noreferrer">Video</a>` : ""}</blockquote><p class="tag">Filed ${day(p.created_at)}${steward ? ` by ${esc(whoName(p.filed_by))}` : ""}</p>`;
    if (mine && p.status === "open") body += `<form method="post" action="#p${p.id}" onsubmit="return confirm('Withdraw your protest?')"><input type="hidden" name="action" value="withdraw"><input type="hidden" name="id" value="${p.id}"><button class="link">Withdraw</button></form>`;
    if (steward && involvedIn(user, p)) body += `<p class="tag">${OWN_PROTEST}</p>`;
    else if (steward && p.status === "open") body += `<details><summary>Decide this protest</summary>${decisionForm(ev, race, { protest: p, self: user.cust })}
      <form method="post" action="#p${p.id}"><input type="hidden" name="action" value="close"><input type="hidden" name="id" value="${p.id}"><p class="tag">Or close it without a decision (filed by mistake, a duplicate): <button class="link">Close</button></p></form></details>`;
    if (steward && p.status !== "open" && !involvedIn(user, p)) body += `<form method="post" action="#p${p.id}"><input type="hidden" name="action" value="reopen"><input type="hidden" name="id" value="${p.id}"><button class="link">Reopen</button></form>`;
    body += `</div>`;
  }
  // filing a protest
  body += `<h2 id="file">File a protest</h2>`;
  const inRace = user && user.cust && race.some(r => r.cust_id === user.cust);
  if (!user) body += `<p class="hint">Drivers in this race can file a protest. <a href="${BASE}/login?back=${encodeURIComponent(`${BASE}/results/${ev.subsession_id}/stewards#file`)}">Sign in with Discord</a> first.</p>`;
  else if (!user.cust) body += `<form method="post" action="#file"><input type="hidden" name="action" value="link">
    <p class="hint">First, which driver are you? You only do this once. It's how the stewards know who filed.</p>
    <label for="me">You are</label><select id="me" name="cust">${race.map(r => `<option value="${r.cust_id}">${carName(r.car_number, r.name)}</option>`).join("")}</select>
    <p><button class="btn ghost">That's me</button></p></form>`;
  else if (!inRace) body += `<p class="hint">You're signed in as ${esc(user.driverName || "a driver")}, who wasn't in this race. Only drivers in the race can protest it. <a href="${BASE}/protests">Not you?</a></p>`;
  else body += `<form method="post" action="#file"><input type="hidden" name="action" value="protest">
    <label for="vs">Driver you're protesting</label><select id="vs" name="against"><option value="">Nobody in particular (a general incident)</option>${race.filter(r => r.cust_id !== user.cust).map(r => `<option value="${r.cust_id}">${carName(r.car_number, r.name)}</option>`).join("")}</select>
    <label for="lap">Where (lap, turn)</label><input type="text" id="lap" name="lap" maxlength="40" placeholder="e.g. lap 42, turn 3">
    <label for="what">What happened</label><textarea id="what" name="what" rows="5" maxlength="2000" required></textarea>
    <label for="vid">Video link (optional: YouTube, Twitch clip, Streamable...)</label><input type="text" id="vid" name="video" maxlength="500" placeholder="https://">
    <p class="tag">The stewards see what you write. The report shows who protested whom and the decision.</p>
    <p><button class="btn">File protest</button></p></form>`;
  if (steward) body += `<h2 id="pnew">Stewards' decision</h2><p class="tag">A decision without a protest (something the stewards saw themselves). It shows on the report, changes the results for places and disqualifications, and goes on the series' penalties for points.</p>` + decisionForm(ev, race, { self: user.cust });
  return page(`Stewards: ${ev.track}`, body, { user });
}

const protestRow = p => `<tr><td><a href="${BASE}/results/${p.subsession_id}/stewards#p${p.id}">${p.id}</a></td><td>${esc(p.series || "")}</td><td><a href="${BASE}/results/${p.subsession_id}/stewards">${esc(p.track)}</a><br><span class="tag">${day(p.start_time)}</span></td>
    <td style="white-space:normal">${who(p)}${p.lap ? ` <span class="tag">· ${esc(p.lap)}</span>` : ""}</td><td>${statusTag(p)}</td><td>${day(p.created_at)}</td></tr>`;
const protestTable = list => `<div class="wrap"><table><tr><th>#</th><th>Series</th><th>Race</th><th>Protest</th><th>Status</th><th>Filed</th></tr>${list.map(protestRow).join("")}</table></div>`;

function protestsPage(user, { open = [], recent = [], mine = [], steward = false, msg = "" } = {}) {
  let body = `<h1>Protests</h1>${msg ? `<div class="msg bad">${esc(msg)}</div>` : ""}`;
  if (steward) body += `<h2>Open</h2>` + (open.length ? protestTable(open) : `<p class="hint">No open protests.</p>`) + (recent.length ? `<h2>Recently closed</h2>` + protestTable(recent) : "");
  body += `<h2>Yours</h2>`;
  if (user.cust) body += `<p class="sub">Signed in as driver ${driverLink(user.cust, user.driverName || user.cust)}. <a href="${BASE}/me/driver?back=${BASE}/protests">Not you?</a></p>`
    + (mine.length ? protestTable(mine) : `<p class="hint">You haven't filed any protests. To file one, open the race's results and go to its stewards' report.</p>`);
  else body += `<p class="hint">Only drivers can file protests. <a href="${BASE}/me/driver?back=${BASE}/protests">Which driver are you?</a></p>`;
  return page("Protests", body, { user });
}

// who can sign race control in: the race control role, a series director (role + an assigned series), an admin
const usesRaceControl = user => !!user && (user.steward || (user.directs || []).length > 0);

// the programs, for the accounts that use them: producers the broadcast overlay, stewards race control
function downloadsPage(user, rel) {
  const link = what => `<p><a class="btn" href="${esc(rel.url)}" rel="noopener">${what}</a> ${rel.tag ? `<span class="tag">${esc(rel.tag)} · from GitHub</span>` : `<span class="tag">the latest version, on GitHub</span>`}</p>`;
  const steps = (start, after, signin) => `<ol class="steps">
    <li>Download the zip. Right-click it &gt; <b>Properties</b> &gt; tick <b>Unblock</b> &gt; <b>OK</b> (otherwise Windows warns about every start file).</li>
    <li>Extract it to a folder that isn't synced by OneDrive, for example <code>C:\\VSPEED</code>.</li>
    <li>Double-click <b>${start}</b>. The first start sets itself up in about a minute; leave the window open.${after}</li>
    <li>${signin}</li></ol>`;
  let body = `<h1>Downloads</h1><p class="sub">One program with two start files: the broadcast overlay for producers, race control for stewards. Once it's installed, it keeps itself up to date.</p>`;
  if (user.producer) body += `<h2>Broadcast overlay</h2>` + link("Download the VSPEED broadcast overlay")
    + steps("start.bat", "", "In the control panel: <b>Setup &gt; League site upload &gt; Sign in with Discord</b>, then press Allow on this site.");
  if (usesRaceControl(user)) body += `<h2>Race control</h2>` + link("Download VSPEED race control")
    + steps("start-race-control.bat", " It also puts a <b>VSPEED Race Control</b> shortcut on your desktop: use that from then on.", "Press <b>Sign in</b> on race control's league site bar, then press Allow on this site.");
  body += `<p class="tag">The zip is the whole VSPEED project, so it also holds the code for this site and the announcer relay: you can ignore those folders.</p>`;
  return page("Downloads", body, { user });
}

// asked once after signing in: which driver are you? (or "I don't race")
function whichDriverPage(user, { q = "", found = [], back = "/", first = false, claims = [], msg = "" } = {}) {
  const b = `<input type="hidden" name="back" value="${esc(back)}">`;
  let body = `<h1>Which driver are you?</h1>`;
  if (msg) body += `<div class="msg bad">${esc(msg)}</div>`;
  body += `<p class="sub">${first ? "One quick question, only this once. " : ""}Linking your Discord account to your iRacing driver lets you file protests and see your races, protests and the stewards' decisions about you in one place.</p>`;
  if (user.cust) body += `<p class="hint">You're linked to ${driverLink(user.cust, user.driverName || user.cust)}. Pick another driver below only if that's wrong.</p>`;
  else if (user.noDriver) body += `<p class="hint">You said you don't race. If you do now, find yourself below.</p>`;
  for (const c of claims) body += `<div class="msg">Waiting for an admin: you said you're ${esc(c.driver || c.cust_id)}, who is linked to another Discord account. An admin will sort it out; nothing changes until then.</div>`;
  body += `<form method="get" class="dec"><input type="hidden" name="back" value="${esc(back)}"><label for="q">Your name in iRacing</label>
    <input type="text" id="q" name="q" value="${esc(q)}" maxlength="60" autocomplete="off" class="search"> <button class="btn ghost">Search</button></form>`;
  if (q && !found.length) body += `<p class="hint">No driver by that name has raced here. Try your last name, or your iRacing ID.</p>`;
  if (found.length) body += `<div class="wrap"><table><tr><th>Driver</th><th class="n">iRacing ID</th><th></th></tr>` + found.map(d => `<tr><td>${driverLink(d.cust_id, d.name)}${d.also ? ` <span class="tag">raced as ${esc(d.also)}</span>` : ""}</td>
      <td class="n">${d.cust_id}</td><td><form method="post">${b}<input type="hidden" name="cust" value="${d.cust_id}"><button class="btn ghost">${d.cust_id === user.cust ? "That's me (now)" : "That's me"}</button></form>${d.taken && d.cust_id !== user.cust ? ` <span class="tag">already linked: goes to an admin</span>` : ""}</td></tr>`).join("") + `</table></div>`;
  body += `<form method="post" style="margin-top:18px">${b}<input type="hidden" name="cust" value="0"><button class="btn ghost">I don't race</button>
    <a class="tag" style="margin-left:12px" href="${esc(back)}">Ask me later</a></form>`;
  return page("Which driver are you?", body, { user });
}

// a linked driver's own page: their races, protests by or about them, and the stewards' decisions about them
function myRacesPage(user, d, { protests = [], decisions = [] } = {}) {
  let body = `<h1>My races</h1><p class="sub">${driverLink(d.cust_id, d.name)} · iRacing ID ${d.cust_id} · <a href="${BASE}/drivers/${d.cust_id}/info">Edit my info</a> · <a href="${BASE}/me/driver?back=${BASE}/me">Not you?</a></p>`;
  const races = [...d.races].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));
  body += `<h2>Races</h2>` + (races.length ? statCards(races) + `<div class="wrap"><table><tr><th>Date</th><th>Series</th><th>Track</th><th class="n">Start</th><th class="n">Finish</th><th class="n">Inc</th><th class="n">Pts</th><th></th></tr>` +
    races.slice(0, 40).map(x => `<tr><td><a href="${BASE}/results/${x.subsession_id}">${day(x.start_time)}</a></td><td>${x.slug ? `<a href="${BASE}/${esc(x.slug)}">${esc(x.short_name)}</a>` : esc(x.series_name || "")}</td><td>${esc(x.track)}</td>
      <td class="n">${x.start_pos ?? ""}</td><td class="n">${x.class_count > 1 ? cls(x.car_class) : ""}${place(x) ?? ""}<span class="tag"> / ${x.class_count > 1 ? x.class_starters : x.starters}</span></td><td class="n">${x.incidents ?? ""}</td>
      <td class="n">${x.league_points ?? ""}</td><td><a class="tag" href="${BASE}/results/${x.subsession_id}/stewards">Stewards</a></td></tr>`).join("") + `</table></div>` +
    (races.length > 40 ? `<p class="hint">The 40 most recent. Every race is on your <a href="${BASE}/drivers/${d.cust_id}">driver page</a>.</p>` : "")
    : `<p class="hint">No races here yet.</p>`);
  body += `<h2>Protests</h2><p class="tag">Filed by you or against you.</p>` + (protests.length ? protestTable(protests) : `<p class="hint">None.</p>`);
  body += `<h2>Stewards' decisions</h2>` + (decisions.length ? `<div class="wrap"><table><tr><th>Race</th><th>Series</th><th>Decision</th><th>Reason</th><th>From</th></tr>` +
    decisions.map(x => `<tr class="${x.status === "withdrawn" ? "wd" : ""}"><td><a href="${BASE}/results/${x.subsession_id}/stewards">${esc(x.track)}</a><br><span class="tag">${day(x.start_time)}</span></td><td>${esc(x.series || "")}</td>
      <td><b>${esc(decisionText(x))}</b>${x.status === "withdrawn" ? ` <span class="tag">withdrawn</span>` : ""}</td><td style="white-space:normal">${esc(x.reason)}</td><td>${x.source === "race control" ? "Race control" : x.protest_id ? `Protest ${x.protest_id}` : "Stewards"}</td></tr>`).join("") + `</table></div>`
    : `<p class="hint">None.</p>`);
  return page("My races", body, { user });
}

// admins: every Discord account that has signed in, its driver, and claims on a driver someone else has
function accountsPage(user, { accounts = [], claims = [], all = [], msg = "", series = [], directors = [], roles = new Map(), officialRole = "", blocks = new Map() } = {}) {
  let body = `<h1>Accounts</h1><p class="sub">Everyone who has signed in to GLR HUB with Discord. Only officials can see which driver each person is.</p>`;
  if (msg) body += `<div class="msg ${/^(Linked|Unlinked|Approved|Rejected|Set)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  body += `<h2>Disputes</h2>` + (claims.length ? `<div class="wrap"><table><tr><th>Who</th><th>Says they're</th><th>Linked now to</th><th>Asked</th><th></th></tr>` + claims.map(c => `<tr>
      <td>${esc(c.discord_name || c.discord_id)}</td><td>${driverLink(c.cust_id, c.driver || c.cust_id)}</td><td>${esc(c.holder || "nobody now")}</td><td>${day(c.created_at)}</td>
      <td><form method="post" style="display:inline" onsubmit="return confirm('Give ${esc(String(c.driver || "").replace(/['"\\]/g, ""))} to ${esc(String(c.discord_name || "").replace(/['"\\]/g, ""))}?${c.holder ? " The account linked now is unlinked and asked again." : ""}')"><input type="hidden" name="claim" value="${c.id}"><input type="hidden" name="action" value="approve"><button class="link">Approve</button></form>
      <form method="post" style="display:inline;margin-left:10px"><input type="hidden" name="claim" value="${c.id}"><input type="hidden" name="action" value="reject"><button class="link">Reject</button></form></td></tr>`).join("") + `</table></div>`
    : `<p class="hint">None. If someone picks a driver who is already linked to another account, their request waits here for an admin to approve or reject.</p>`);
  const short = id => (series.find(x => x.id === id) || {}).short_name || id;
  // the series each account runs: assigned here, and active with the Series official role
  const directs = a => {
    if (!officialRole) return dirForm(a, directors.filter(d => d.discord_id === a.discord_id));
    const has = roles.has(a.discord_id) ? roles.get(a.discord_id).includes(officialRole) : null;
    const mine = directors.filter(d => d.discord_id === a.discord_id);
    return dirForm(a, mine) + (mine.length && has === false ? `<br><span class="tag" style="color:#d33">No Series official role when the site last checked${roles.seen && roles.seen.get(a.discord_id) ? ` (${when(new Date(roles.seen.get(a.discord_id)).toISOString())})` : ""}: not active.</span>
      <form method="post" style="display:inline"><input type="hidden" name="action" value="recheck"><input type="hidden" name="id" value="${esc(a.discord_id)}"><button class="link">Check now</button></form>
      <span class="tag">The site reads their roles again whenever they use it. Check now asks Discord straight away.</span>` : "");
  };
  const dirForm = (a, mine) => mine.map(d => `<form method="post" style="display:inline;margin-right:8px"><input type="hidden" name="action" value="undirect"><input type="hidden" name="id" value="${esc(a.discord_id)}"><input type="hidden" name="series" value="${d.series_id}">${esc(short(d.series_id))} <button class="link" title="Remove">×</button></form>`).join("")
    + (series.length > mine.length ? `<form method="post" style="display:inline"><input type="hidden" name="action" value="direct"><input type="hidden" name="id" value="${esc(a.discord_id)}"><select name="series" onchange="this.form.submit()"><option value="">Add series…</option>${series.filter(x => !mine.some(d => d.series_id === x.id)).map(x => `<option value="${x.id}">${esc(x.short_name)}</option>`).join("")}</select></form>` : "");
  // the overlay block switch: wins over the person's Discord roles until it's lifted
  const overlayCell = a => {
    const b = blocks.get(a.discord_id);
    if (b) return `<b style="color:#d33">Blocked</b><br><span class="tag">${day(b.blocked_at)} by ${esc(whoName(b.blocked_by))}</span><br><form method="post" style="display:inline"><input type="hidden" name="action" value="unblock"><input type="hidden" name="id" value="${esc(a.discord_id)}"><button class="link">Unblock</button></form>`;
    if (a.discord_id === user.id) return `<span class="tag">Allowed</span>`;
    return `<span class="tag">Allowed</span> <form method="post" style="display:inline" onsubmit="return confirm('Block ${esc(String(a.name || "").replace(/['"\\]/g, ""))} from the overlay? It works even if they have the Producer role, until you unblock them.')"><input type="hidden" name="action" value="block"><input type="hidden" name="id" value="${esc(a.discord_id)}"><button class="link">Block</button></form>`;
  };
  const linked = a => a.cust_id ? driverLink(a.cust_id, a.driver || a.cust_id) : a.cust_id === 0 ? `<span class="tag">I don't race</span>` : `<span class="tag">Not answered</span>`;
  body += `<h2>Accounts</h2><input class="search" placeholder="Find a name" data-rows="#acc tr.r">
    <div class="wrap"><table id="acc"><tr><th>Discord</th><th>Driver</th><th>Directs</th>${user.overlord ? "<th>Overlay</th>" : ""}<th>Last signed in</th><th>Change driver</th></tr>` + accounts.map(a => `<tr class="r">
      <td>${esc(a.name || "")}<br><span class="tag">${esc(a.discord_id)}</span></td><td>${linked(a)}</td><td style="white-space:normal">${directs(a)}</td>${user.overlord ? `<td style="white-space:normal">${overlayCell(a)}</td>` : ""}<td>${day(a.last_seen)}</td>
      <td style="white-space:normal"><form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="id" value="${esc(a.discord_id)}">
        <input type="text" name="driver" list="drl" placeholder="Driver name or iRacing ID" autocomplete="off" style="width:200px"> <button class="link">Set</button></form>
        ${a.cust_id != null ? `<form method="post" style="display:inline;margin-left:10px" onsubmit="return confirm('Unlink? They are asked which driver they are at their next sign-in.')"><input type="hidden" name="action" value="unlink"><input type="hidden" name="id" value="${esc(a.discord_id)}"><button class="link">Unlink</button></form>` : ""}</td></tr>`).join("") +
    `</table></div><datalist id="drl"><option value="I don't race">${all.map(x => `<option value="${esc(x.name)} (${x.cust_id})">`).join("")}</datalist>
    <ul class="tag">
      <li><b>Driver:</b> the iRacing driver this person is. To change it, type a driver's name or iRacing ID under <b>Change driver</b> and press <b>Set</b>. If someone else was linked to that driver, they're unlinked, and GLR HUB asks them "Which driver are you?" the next time they sign in.</li>
      <li><b>Directs:</b> the series this person is a director of. <b>Add series…</b> adds one; <b>×</b> removes it. ${officialRole ? "It only works if they also have the Series official role in Discord." : "<b>Not active yet:</b> the Series official role hasn't been saved on Site settings, so nobody is a director."}</li>
      ${user.overlord ? `      <li><b>Overlay:</b> anyone with the Producer role can use the broadcast overlay. <b>Block</b> turns it off for one person even if they have the role, until you unblock them: their overlay stops at its next start-up and they can't sign another PC in.</li>` : ""}
      <li>Every change on this page is recorded in History.</li></ul>` + SORT_JS;
  return page("Accounts", body, { user });
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

// who can change a driver's info: the driver (linked to them), an admin, or a director of a series they've raced in
const canEditDriver = (user, d) => !!user && (user.cust === d.cust_id || user.admin || d.races.some(x => (user.directs || []).includes(x.series_id)));

// what a driver says about themselves, at the top of their driver page
function profileHtml(d, user) {
  const p = d.profile, edit = canEditDriver(user, d) ? ` <a class="tag" href="${BASE}/drivers/${d.cust_id}/info">${user.cust === d.cust_id ? "Edit my info" : "Edit info"}</a>` : "";
  if (!p) return user && user.cust === d.cust_id ? `<p class="hint">Add a bio, your team, sponsor and hometown: <a href="${BASE}/drivers/${d.cust_id}/info">Edit my info</a>.</p>` : edit ? `<p>${edit}</p>` : "";
  const facts = [["Team", p.team], ["Sponsor", p.sponsor], ["Hometown", p.hometown]].filter(x => x[1]).map(([k, v]) => `<span><span class="tag">${k}</span> <b>${esc(v)}</b></span>`).join(" · ");
  return `<div class="profile">${facts ? `<p>${facts}</p>` : ""}${p.bio ? `<p style="white-space:pre-line">${esc(p.bio)}</p>` : ""}${edit ? `<p>${edit}</p>` : ""}</div>`;
}

// a driver's info, for the driver (or an admin / that series' director) to fill in
function profilePage(d, user, msg = "") {
  const p = d.profile || {}, mine = user.cust === d.cust_id, M = PROFILE_FIELDS;
  const field = (k, label, hint) => `<label for="${k}">${label}</label><input type="text" id="${k}" name="${k}" value="${esc(p[k] || "")}" maxlength="${M[k]}" autocomplete="off">${hint ? `<p class="tag">${hint}</p>` : ""}`;
  const body = `<h1>${mine ? "My info" : `${esc(d.name)}: driver info`}</h1>
    <p class="sub">${mine ? "What you write here" : "This"} shows on ${mine ? "your" : "their"} <a href="${BASE}/drivers/${d.cust_id}">driver page</a> for everyone, and broadcasts may use it. Leave anything blank to leave it out.</p>
    ${msg ? `<div class="msg ${/^Saved/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>` : ""}
    <form method="post" class="dec">
    ${field("team", "Team", mine ? "The team you race for, if any." : "The team they race for, if any.")}
    ${field("sponsor", "Sponsor", "")}
    ${field("hometown", "Hometown", "For example: Springfield, IL")}
    <label for="bio">Bio</label><textarea id="bio" name="bio" rows="6" maxlength="${M.bio}">${esc(p.bio || "")}</textarea>
    <p class="tag">Up to ${M.bio} characters. Plain text.</p>
    <p><button class="btn">Save</button> <a class="tag" style="margin-left:12px" href="${BASE}/drivers/${d.cust_id}">Back to the driver page</a></p></form>`;
  return page(mine ? "My info" : `${d.name}: driver info`, body, { user });
}

function driverPage(d, user, { aliases = [], all = [], msg = "", discord = null } = {}) {
  const other = d.names.filter(x => x.name !== d.name).map(x => esc(x.name));
  const bySeries = new Map();
  for (const x of d.races) { const k = x.series_id || 0; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(x); }
  let body = `<h1>${esc(d.name)}</h1><p class="sub">iRacing ID ${d.cust_id}${other.length ? " · also raced as " + other.join(", ") : ""}</p>`;
  body += profileHtml(d, user);
  if (user && user.official) body += `<p class="tag">Discord: ${discord ? esc(discord.name || discord.discord_id) : "not linked"}${user.admin ? ` · <a href="${BASE}/accounts">Accounts</a>` : ""} <span class="tag">(only officials see this)</span></p>`;
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

// a series' directors' home: what needs doing, and where everything they can change is
function directorPage(sr, seasons, user, { provisional = [], protests = [], queue = [], changes = [], missed = [], signup = null } = {}) {
  const S = `${BASE}/${esc(sr.slug)}`;
  let body = seriesTabs(sr, "director", seasons, null, user);
  body += `<p class="tag">Only this series' directors and admins see this tab.</p><h2>Needs attention</h2>`;
  const todo = [];
  if (missed.length) todo.push(`<li><b>${missed.length} scheduled race${missed.length === 1 ? " has" : "s have"} no results</b> on the site yet. Upload the iRacing results file (or, if the race didn't run, remove it from the <a href="${S}/schedule">schedule</a>):<ul>${missed.map(r =>
    `<li>${day(r.starts_at)} · ${esc(r.track)}</li>`).join("")}</ul></li>`);
  if (signup && signup.waiting) todo.push(`<li><b>${signup.waiting} signup${signup.waiting === 1 ? " is" : "s are"} waiting</b> for ${esc(signup.round.name)}. <a href="${S}/signups">Approve or decline</a>.</li>`);
  if (signup && signup.flags) todo.push(`<li><b>Car numbers in the last race</b> (${day(signup.flags.event.start_time)} · ${esc(signup.flags.event.track)}) don't match the signups. <a href="${S}/signups#flags">See who</a>.</li>`);
  if (provisional.length) todo.push(`<li><b>${provisional.length} race${provisional.length === 1 ? "" : "s"} still provisional</b> (from a broadcast overlay). Upload the iRacing results file, or open the race, check it and press Mark results official:<ul>${provisional.map(e =>
    `<li><a href="${BASE}/results/${e.subsession_id}">${day(e.start_time)} · ${esc(e.track)}</a></li>`).join("")}</ul></li>`);
  if (protests.length) todo.push(`<li><b>${protests.length} open protest${protests.length === 1 ? "" : "s"}</b>:<ul>${protests.map(p =>
    `<li><a href="${BASE}/results/${p.subsession_id}/stewards#p${p.id}">#${p.id} · ${esc(p.track)}, ${day(p.start_time)}</a></li>`).join("")}</ul></li>`);
  const stuck = queue.filter(q => q.attempts > 0 || q.next_try > 8e15);
  if (stuck.length) todo.push(`<li><b>${stuck.length} Discord post${stuck.length === 1 ? "" : "s"} didn't go out.</b> <a href="${S}/edit#discord">See Waiting to post</a> to try again or discard.</li>`);
  body += todo.length ? `<ul class="todo">${todo.join("")}</ul>` : `<p class="hint">Nothing waiting: every scheduled race has results, every race is official, no open protests, and every Discord post went out.</p>`;
  const L = [
    [`${BASE}/upload`, "Upload results", "the iRacing results file after each race (it makes the race official)"],
    [`${S}/schedule`, "Schedule", "add, change or remove races"],
    [`${S}/rules`, "Rules", "points, bonus points, drop weeks, playoffs (Change the rules)"],
    [`${S}/penalties`, "Penalties", "points penalties and adjustments"],
    [`${BASE}/protests`, "Protests", "open and recent protests; decide them on each race's stewards' report"],
    [`${S}/drivers`, "Drivers", "add a driver who hasn't raced yet"],
    [`${S}/signups`, "Signups and car numbers", "open season signups, approve drivers, change or release numbers, the entry list"],
    ...(sr.teams ? [[`${S}/teams`, "Teams", "upload the team list (CSV)"]] : []),
    [`${S}/edit`, "Edit series", "the series' name and web address"],
    [`${S}/edit#discord`, "Discord posts", "webhooks for results, standings and penalties; Send test, Send latest"],
    [`${S}/embed`, "Embed on a website", "standings, schedule and results widgets for a website, OBS or vMix"],
    [`${BASE}/history?series=${esc(sr.slug)}`, "History", "every change to this series, and who made it"],
  ];
  body += `<h2>Manage the series</h2><table class="manage">${L.map(([h, n, w]) => `<tr><td><a href="${h}"><b>${n}</b></a></td><td class="tag" style="white-space:normal">${w}</td></tr>`).join("")}</table>
    <p class="tag">Fixing one driver's result, and removing a race uploaded by mistake, are at the bottom of that race's page (Officials).</p>`;
  if (changes.length) body += `<h2>Recent changes</h2><div class="wrap"><table><tr><th>When</th><th>Who</th><th>What</th></tr>${changes.map(c =>
    `<tr><td>${day(c.at)}</td><td>${esc(whoName(c.by))}</td><td style="white-space:normal">${esc(c.summary)}</td></tr>`).join("")}</table></div><p><a class="tag" href="${BASE}/history?series=${esc(sr.slug)}">All of this series' History</a></p>`;
  return page(`${sr.short_name} director`, body, { user });
}

function seriesTabs(sr, on, seasons, seasonId, user) {
  const q = seasonId && seasonId !== "all" && seasons.length > 1 ? `?season=${seasonId}` : "";
  const t = (k, label, href) => `<a class="${on === k ? "on" : ""}" href="${BASE}/${esc(sr.slug)}${href}${["results", "drivers", "schedule", "director"].includes(k) ? "" : q}">${label}</a>`;
  const opts = on === "stats" && seasons.length > 1 ? [...seasons, { id: "all", name: "All seasons" }] : seasons;
  const pick = !["results", "drivers", "schedule", "director"].includes(on) && opts.length > 1 ? `<form class="season" method="get"><select name="season" onchange="this.form.submit()">${opts.map(se =>
    `<option value="${se.id}"${se.id === seasonId ? " selected" : ""}>${esc(se.name)}</option>`).join("")}</select></form>` : "";
  const logo = logoUrl(sr) ? `<img class="shlogo" src="${logoUrl(sr)}" alt="${esc(sr.short_name)} logo">` : "";
  return `<p class="crumb"><a href="${BASE}/">GLR</a></p><div class="shead">${logo}<div><h1>${esc(sr.short_name)}${sr.hidden ? ` <span class="cls">Hidden</span>` : ""}</h1><p class="sub">${esc(sr.name)}${canEdit(user, sr) ? ` · <a href="${BASE}/${esc(sr.slug)}/edit">Edit series</a> · <a href="${BASE}/${esc(sr.slug)}/embed">Embed on a website</a>` : ""}</p></div></div>
    <nav class="tabs">${t("results", "Results", "")}${t("schedule", "Schedule", "/schedule")}${t("standings", "Standings", "/standings")}${t("stats", "Stats", "/stats")}${t("drivers", "Drivers", "/drivers")}${sr.teams ? t("teams", "Teams", "/teams") : ""}${t("rules", "Rules", "/rules")}${t("penalties", "Penalties", "/penalties")}${canEdit(user, sr) ? t("director", "Director", "/director") : ""}${pick}</nav>`;
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
  if (msg) body += `<div class="msg ${/^(Added|Removed|Saved)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  const up = rows.filter(r => !r.subsession_id && Date.parse(r.starts_at) >= now);
  const done = rows.filter(r => !up.includes(r)).reverse();
  const et = iso => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
  const del = r => edit ? `<td><button class="link" type="button" onclick="const t=this.closest('tr').nextElementSibling;t.hidden=!t.hidden">Edit</button>
      <form method="post" style="display:inline;margin-left:10px" onsubmit="return confirm('Remove ${esc(String(r.track).replace(/['"\\]/g, ""))} from the schedule?')"><input type="hidden" name="remove" value="${r.id}"><button class="link">Remove</button></form></td>` : "";
  const edRow = (r, cols) => edit ? `<tr class="edrow" hidden><td colspan="${cols}"><form method="post" class="edf"><input type="hidden" name="edit" value="${r.id}">
      <label>Date<input type="date" name="date" value="${et(r.starts_at).date}" required></label><label>Start (Eastern)<input type="time" name="time" value="${et(r.starts_at).time}" required></label>
      <label>Track<input type="text" name="track" value="${esc(r.track)}" maxlength="100" required></label><label>Layout<input type="text" name="layout" value="${esc(r.layout)}" maxlength="60" placeholder="Oval, Road Course…"></label>
      <label>Length<input type="text" name="length" value="${esc(r.length)}" maxlength="40" placeholder="100 laps or 115 min"></label><label>Notes<input type="text" name="notes" value="${esc(r.notes)}" maxlength="120"></label>
      <button class="btn">Save</button></form></td></tr>` : "";
  const len = r => esc(r.length || (r.result_laps ? `${r.result_laps} laps` : ""));
  body += `<h2>Upcoming</h2>` + (up.length ? `<div class="wrap"><table><tr><th>When</th><th>Track</th><th>Layout</th><th>Length</th><th>Notes</th>${edit ? "<th></th>" : ""}</tr>` +
    up.map(r => `<tr><td>${when(r.starts_at)}</td><td>${esc(r.track)}</td><td>${esc(r.layout)}</td><td>${len(r)}</td><td style="white-space:normal">${esc(r.notes)}</td>${del(r)}</tr>${edRow(r, 6)}`).join("") + `</table></div>`
    : `<p class="hint">No upcoming races on the schedule.${edit ? " Add them below." : ""}</p>`);
  if (done.length) {
    const table = list => `<div class="wrap"><table><tr><th>When</th><th>Track</th><th>Layout</th><th>Length</th><th>Winner</th><th>Notes</th>${edit ? "<th></th>" : ""}</tr>` + list.map(r => `<tr>
      <td>${r.subsession_id ? `<a href="${BASE}/results/${r.subsession_id}">${when(r.starts_at)}</a>` : when(r.starts_at)}</td><td>${esc(r.track)}</td><td>${esc(r.layout)}</td><td>${len(r)}</td>
      <td>${r.subsession_id ? winnersHtml(winners.get(r.subsession_id) || []) + prov(r) : `<span class="tag">Results not in yet</span>${edit ? `
        <label class="up" title="The iRacing results file (JSON, or CSV with its original name)">Upload results<input type="file" accept=".json,.csv" data-sched="${r.id}" hidden></label><span class="ups"></span>` : ""}`}</td>
      <td style="white-space:normal">${esc(r.notes)}</td>${del(r)}</tr>${edRow(r, 7)}`).join("") + `</table></div>`;
    const recent = done.filter(r => Date.parse(r.starts_at) > Date.now() - 150 * 864e5), older = done.filter(r => !recent.includes(r));
    if (recent.length) body += `<h2>Completed</h2>` + table(recent);
    if (older.length) body += `<details><summary>Earlier races (${older.length})</summary>${table(older)}</details>`;
  }
  if (edit) body += `<h2>Add races</h2><form method="post"><div class="grid"><label>Date<br><input type="date" name="date" required></label>
      <label>Start (Eastern)<br><input type="time" name="time" value="20:00" required></label></div>
      <label for="st">Track</label><input type="text" id="st" name="track" maxlength="100" required>
      <div class="grid"><label>Layout (optional)<br><input type="text" name="layout" maxlength="60" placeholder="Oval, Road Course…"></label>
      <label>Length (optional)<br><input type="text" name="length" maxlength="40" placeholder="100 laps or 115 min"></label></div>
      <label for="sn2">Notes (optional, e.g. Playoffs: Round of 12)</label><input type="text" id="sn2" name="notes" maxlength="120">
      <p><button class="btn">Add race</button></p></form>
    <form method="post"><label for="bulk">Or paste a whole season, one race per line: date, start time (Eastern), track, then any of length and notes</label>
      <textarea id="bulk" name="bulk" rows="6" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit"
        placeholder="2026-11-10, 8:00 PM, Kansas Speedway - Oval, 100 laps or 115 min&#10;11/17/2026, 8:00 PM, Martinsville Speedway, 200 laps, Short track night&#10;2026-11-24, Phoenix Raceway, Playoffs: Round of 12"></textarea>
      <p class="tag">The time can be left out (8:00 PM Eastern). Write a layout after the track with a dash (Daytona - Road Course); lengths like "100 laps" or "115 min" are picked out by themselves. When a race's results are uploaded they join up with its date here.</p>
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
  body += `<div class="wrap pinwrap"><table class="sortable pin"><tr><th class="sort" data-dir="asc">Driver</th><th>#</th>${COLUMNS.map(([k, l, dir]) => `<th class="n sort${k === "wins" ? " on" : ""}" data-dir="${dir}">${l}</th>`).join("")}</tr>` +
    sorted.map(r => `<tr><td data-v="${esc(r.name)}">${multi ? cls(r.cls) : ""}${driverLink(r.custId, r.name)}</td><td>${esc(r.number)}</td>${COLUMNS.map(([k, , , dp]) =>
      `<td class="n" data-v="${r[k] ?? ""}">${fmt(r[k], dp)}</td>`).join("")}</tr>`).join("") + `</table></div>
    <p class="tag">Click a heading to sort. Pos. gained adds up start minus finish. Lead-lap: finished on the leader's lap. DNF: didn't finish running.</p>` + SORT_JS;
  return page(`${sr.short_name} stats`, body, { user });
}

function seriesDriversPage(sr, rows, roster, user, msg = "", entry = null) {
  let body = seriesTabs(sr, "drivers", [], null, user);
  if (entry) body += entryList(sr, entry, user);
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
async function leagueDrivers(db, user = null) {
  const [series, bySeries, roster] = await Promise.all([listSeries(db), allSeriesEvents(db), listRoster(db)]);
  const sr = new Map(series.filter(s => shown(s, user)).map(s => [s.id, s])), out = new Map();
  const get = (id, name) => { if (!out.has(id)) out.set(id, { custId: id, name, series: [], starts: 0, wins: 0, last: "" }); return out.get(id); };
  for (const [sid, evs] of bySeries) {
    if (!sr.has(sid)) continue;                    // a hidden series: its races don't count here
    for (const r of computeStats(evs)) {
      const d = get(r.custId, r.name);
      d.starts += r.starts; d.wins += r.wins;
      if (r.last > d.last) { d.last = r.last; d.name = r.name; }
      if (sr.has(sid)) d.series.push({ slug: sr.get(sid).slug, short: sr.get(sid).short_name });
    }
  }
  for (const r of roster) { if (!sr.has(r.series_id)) continue; const d = get(r.cust_id, r.name); if (sr.has(r.series_id) && !d.series.some(s => s.slug === sr.get(r.series_id).slug)) d.series.push({ slug: sr.get(r.series_id).slug, short: sr.get(r.series_id).short_name }); }
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
  if (sr.teams && sr.hook_teams && ev.season_id) {        // team points (the Warrior series)
    const teams = await getTeams(db, sr.id, ev.season_id);
    if (teams.length) {
      const season = { id: ev.season_id, name: ev.season_name || "" };
      await enqueue(db, sr.id, "teams", "teams", sub, teamStandingsPost(sr, season, teamStandings(teams, await seasonStandings(db, sr, season)), ev, origin)); n++;
    }
  }
  return n;
}

// every penalty on a race, for its penalty report: active decisions (not "no action") and points penalties from the
// Penalties tab that no decision made
async function penaltyItems(db, ev) {
  const decs = (ev.decisions || []).filter(d => d.status !== "withdrawn" && d.kind !== "none");
  const car = cust => ((ev.sessions.race || []).find(r => r.cust_id === cust) || {}).car_number || "";
  const items = decs.map(d => ({ car: d.car_number || car(d.cust_id), name: d.name || String(d.cust_id), text: decisionText(d), reason: d.reason || "" }));
  const fromDecisions = new Set(decs.map(d => d.adj_id).filter(Boolean));
  const adj = (await db.prepare(`SELECT a.*, (SELECT name FROM results r WHERE r.subsession_id = a.subsession_id AND r.cust_id = a.cust_id AND r.session = 'race') AS name
    FROM adjustments a WHERE a.subsession_id = ? ORDER BY a.id`).bind(ev.subsession_id).all()).results;
  for (const a of adj) if (!fromDecisions.has(a.id) && !(ev.decisions || []).some(d => d.adj_id === a.id))
    items.push({ car: car(a.cust_id), name: a.name || String(a.cust_id), text: `${a.points > 0 ? "+" : "−"}${Math.abs(a.points)} point${Math.abs(a.points) === 1 ? "" : "s"}`, reason: a.reason || "" });
  return items;
}

// a correction to an official race: the posted results are edited (when they were posted)
async function updatePosted(db, sub, origin) {
  const ev = await getEvent(db, sub);
  if (!ev || ev.status !== "official") return;
  const sr = await seriesById(db, ev.series_id), msg = JSON.parse(ev.discord || "{}").results;
  if (sr.hook_results && msg) await enqueue(db, sr.id, "results", "results", sub, resultsPost(ev, origin, await listFixes(db, sub)), msg);
}

// one race's points under its season's rules: { custId: { pts, bonusReasons, reasons } } and a note on how it's scored
async function raceScore(db, ev) {
  if (!ev.season_id || !ev.sessions.race) return null;
  const info = await getRules(db, ev.season_id, ev.series_id);
  const rules = cleanRules(info.rules || DEFAULT_RULES);
  if (rules.skip.includes(ev.subsession_id)) return { points: null, note: "This race doesn't count for points (see the series' Rules)." };
  const adj = (await listAdjustments(db, ev.season_id)).filter(a => a.subsession_id === ev.subsession_id);
  const st = computeStandings(rules, [{ subsession_id: ev.subsession_id, start_time: ev.start_time, track: ev.track, results: ev.sessions.race }], adj, { noPrev: true });
  const points = {};
  for (const g of st.groups) for (const r of g.races) Object.assign(points, r.points);
  const how = rules.points.source === "iracing" ? "iRacing's league points" : rules.points.source === "field" ? "points by the size of the field" : "the series' points table";
  return { points, note: `Pts: this series' points for the race (${how}${Object.values(rules.bonus).some(Boolean) ? " plus bonuses" : ""}${adj.length ? ", after penalties" : ""}).` };
}

const num = v => (v > 0 ? `+${v}` : `${v}`);
// the regular season's cut line: the row after the last driver in on points (0 = none)
const cutRow = g => { const i = g.cutAfter == null ? -1 : g.regular.findIndex(s => s.custId === g.cutAfter); return i >= 0 && i < g.regular.length - 1 ? i + 1 : 0; };
const playoffTag = s => s.withdrawn ? `<span class="st bad" title="${esc(s.withdrawn)}">Out: ${esc(s.withdrawn)}</span>` : s.inByWin ? '<span class="st good">In (win)</span>'
  : s.inField ? '<span class="st good">In</span>' : s.needStarts ? `<span class="st">Needs ${s.needStarts} more start${s.needStarts === 1 ? "" : "s"}</span>` : "";
// places moved since the race before: ▲2 up, ▼1 down, nothing for no change or a driver's first race
const chgCell = c => `<td class="n chg">${c > 0 ? `<span class="up">▲${c}</span>` : c < 0 ? `<span class="dn">▼${-c}</span>` : ""}</td>`;

function regularTable(list, rules, { cutAfter = 0, playoffNote = false } = {}) {
  const drops = rules.drops > 0;
  return `<div class="wrap"><table><tr><th class="n">Pos</th><th class="n" title="Places moved since the previous race">+/–</th><th>#</th><th>Driver</th><th class="n">Pts</th><th class="n">Behind</th>${drops ? `<th class="n">Dropped</th>` : ""}
    <th class="n">Starts</th><th class="n">Wins</th><th class="n">Top 5</th><th class="n">Top 10</th><th class="n">Led</th>${playoffNote ? "<th>Playoffs</th>" : ""}</tr>` +
    list.map((s, i) => `<tr${cutAfter && i === cutAfter ? ' class="cut"' : ""}><td class="n">${s.pos}</td>${chgCell(s.chg)}<td>${esc(s.number)}</td><td>${driverLink(s.custId, s.name)}</td>
      <td class="n"><b>${s.points}</b></td><td class="n">${s.behind ? -s.behind : ""}</td>${drops ? `<td class="n tag">${s.dropped || ""}</td>` : ""}
      <td class="n">${s.starts}</td><td class="n">${s.wins || ""}</td><td class="n">${s.top5 || ""}</td><td class="n">${s.top10 || ""}</td><td class="n">${s.lapsLed || ""}</td>
      ${playoffNote ? `<td>${playoffTag(s)}</td>` : ""}</tr>`).join("") + `</table></div>`;
}

function roundTable(rd) {
  const statusCls = t => /Advanced|Champion/.test(t) ? "good" : /Out/.test(t) ? "bad" : "";
  let cutIdx = 0;
  if (!rd.finale && rd.spots < rd.rows.length) cutIdx = rd.rows.findIndex(r => !r.through);
  return `<div class="wrap"><table><tr><th class="n">Pos</th><th class="n" title="Places moved since the previous race in this round">+/–</th><th>#</th><th>Driver</th><th class="n">Pts</th><th class="n">${rd.finale ? "Behind" : "To cut"}</th><th class="n">Bonus</th>
    <th class="n">Wins</th><th class="n">Starts</th><th>Status</th></tr>` +
    rd.rows.map((r, i) => `<tr${cutIdx > 0 && i === cutIdx ? ' class="cut"' : ""}><td class="n">${r.pos}</td>${chgCell(r.chg)}<td>${esc(r.number)}</td><td>${driverLink(r.custId, r.name)}</td>
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
      const cutAfter = po.enabled ? cutRow(g) : 0;
      body += `<h2>${po.enabled ? "Regular season" : "Standings"} · ${g.regularRan} of ${po.enabled ? g.regularRaces : g.races.length} race${g.regularRan === 1 ? "" : "s"}</h2>`;
      if (po.enabled) body += `<p class="tag">${po.field} make the playoffs${po.minStarts ? ` (at least ${po.minStarts} starts)` : ""}: ${po.winIn ? "every regular-season winner, then the best of the rest on points" : "the top on points"}${g.regularComplete ? "" : ", as things stand"}.</p>`;
      body += regularTable(g.regular, rules, { cutAfter: cutAfter > 0 ? cutAfter : 0, playoffNote: po.enabled });
      body += raceGrid(g, g.regular);
    }
  }
  if (st.adj.length) body += `<p class="tag">Includes ${st.adj.length} penalt${st.adj.length === 1 ? "y or adjustment" : "ies or adjustments"} — see Penalties.</p>`;
  return body;
}

// team points (the Warrior points system): team standings for a season, each team's drivers, and the editor
const teamNum = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
function teamsPage(sr, seasons, season, user, { teams = [], ts = null, problems = [], msg = "" } = {}) {
  let body = seriesTabs(sr, "teams", seasons, season && season.id, user);
  if (!season) return page(`${sr.short_name} teams`, body + `<p class="hint">No races uploaded yet.</p>`, { user });
  body += `<p class="tag">${esc(season.name)} · Team points: in each race, a team scores its drivers' finishing points added together, divided by how many of its drivers raced. The season total is every race added up.</p>`;
  if (msg) body += `<div class="msg ${/^Saved/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  if (ts && ts.teams.length) {
    body += `<div class="wrap"><table class="std"><tr><th class="n">Pos</th><th>Team</th><th class="n">Points</th>${ts.races.map(r => `<th class="n" title="${esc(r.track)}"><a href="${BASE}/results/${r.subsession_id}">${day(r.start_time)}</a></th>`).join("")}</tr>` +
      ts.teams.map(t => `<tr><td class="n">${t.pos}</td><td><a href="#team${t.id}">${esc(t.name)}</a></td><td class="n"><b>${teamNum(t.total)}</b></td>${t.races.map(x =>
        `<td class="n" title="${x.raced ? `${teamNum(x.sum)} points from ${x.raced} of ${x.of} drivers` : "No drivers raced"}">${x.raced ? teamNum(x.score) + `<br><span class="tag">${x.raced} of ${x.of}</span>` : `<span class="tag">–</span>`}</td>`).join("")}</tr>`).join("") + `</table></div>`;
    if (!ts.races.length) body += `<p class="hint">No races counted in this season yet.</p>`;
    body += `<h2>Teams</h2><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px 24px">` + ts.teams.map(t => `<div id="team${t.id}"><h3>${esc(t.name)}</h3><table style="width:100%">${[...t.drivers.values()].map(d =>
      `<tr><td>${driverLink(d.cust_id, d.name)}</td><td class="n">${teamNum(d.points)} <span class="tag">pts · ${d.races} race${d.races === 1 ? "" : "s"}</span></td></tr>`).join("") || `<tr><td class="tag">No drivers</td></tr>`}</table></div>`).join("") + `</div>`;
  } else body += `<p class="hint">No teams for this season yet.</p>`;
  if (canEdit(user, sr)) {
    body += `<h2 id="edit">Set the teams</h2>`;
    if (problems.length) body += `<div class="msg bad">Nothing was saved. Fix these in the file, then upload it again:<ul>${problems.map(p => `<li><b>${esc(p.team)}:</b> "${esc(p.text)}": ${esc(p.why)}</li>`).join("")}</ul></div>`;
    body += `<p class="tag">Upload a CSV file with one row per driver and the columns <b>Team</b>, <b>Driver</b> and <b>iRacing ID</b>. The iRacing ID is only needed when the name doesn't match the results (iRacing sometimes adds a number to a name). A team grid saved as CSV (team names across the top, drivers below) works too. Uploading replaces this season's teams.</p>
    <p><a class="tag" href="${BASE}/${esc(sr.slug)}/teams?csv=1${seasons.length > 1 ? `&season=${season.id}` : ""}">Download ${teams.length ? "the teams" : "a blank file"} as CSV</a> to edit in Excel or Google Sheets.</p>
    <form method="post" action="#edit" enctype="multipart/form-data"><input type="file" name="file" accept=".csv,text/csv" required> <button class="btn">Upload teams</button></form>
    ${teams.length ? `<form method="post" action="#edit" style="margin-top:12px" onsubmit="return confirm('Remove all of this season\\'s teams?')"><input type="hidden" name="action" value="clear"><button class="link">Remove all teams</button></form>` : ""}`;
  }
  return page(`${sr.short_name} teams`, body, { user });
}

function standingsPage(sr, seasons, season, st, user) {
  let body = seriesTabs(sr, "standings", seasons, season && season.id, user);
  body += season ? `<p class="tag">${esc(season.name)}</p>` + standingsBody(st) : `<p class="hint">No races uploaded yet.</p>`;
  return page(`${sr.short_name} standings`, body, { user });
}

function rulesSummary(rules, events) {
  const p = rules.points, b = rules.bonus, po = rules.playoffs;
  const bon = [["win", b.win], ["pole", b.pole], ["leading a lap", b.led], ["most laps led", b.mostLed], ["fastest lap", b.fastLap]].filter(x => x[1]).map(([k, v]) => `${num(v)} for ${k}`);
  let h = `<div class="rules"><p><b>Points:</b> ${p.source === "iracing" ? "iRacing's league points for each race." : p.source === "field" ? "One point per car that completed a lap for 1st, one less for each place after, down to 1 for the last of them; a car with 0 laps scores nothing (the more cars, the more 1st is worth)." : `by finishing position: ${p.table.map((v, i) => `P${i + 1} ${v}`).join(", ")}${p.others ? `; every other finisher ${p.others}` : ""}${p.zeroLaps ? "; a car with 0 laps scores nothing" : ""}.`}</p>`;
  if (bon.length) h += `<p><b>Bonus points:</b> ${bon.join(", ")}.</p>`;
  h += `<p><b>Positions:</b> ${rules.byClass ? "by class in multi-class races" : "overall"}. <b>Ties:</b> ${rules.ties === "wins" ? "more wins, then better finishes" : "drivers level on points share the position"}.</p>`;
  if (rules.drops) h += `<p><b>Drop weeks:</b> each driver's ${rules.drops} worst race${rules.drops === 1 ? "" : "s"} ${po.enabled ? "of the regular season " : ""}don't count.</p>`;
  const skipped = events.filter(e => rules.skip.includes(e.subsession_id));
  if (skipped.length) h += `<p><b>Not counted:</b> ${skipped.map(e => `${esc(e.track)} (${day(e.start_time)})`).join(", ")}.</p>`;
  if (po.enabled) {
    h += `<p><b>Playoffs:</b> after ${po.regularRaces} regular-season races, ${po.field} drivers${po.minStarts ? ` with at least ${po.minStarts} starts` : ""} go into the playoffs: ${po.winIn ? "every regular-season winner, then the best of the rest on points" : "the top on points"}.`;
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
    <label class="chk"><input type="radio" name="source" value="field"${p.source === "field" ? " checked" : ""}> By the size of the field: one point per car that completed a lap for 1st, one less for each place after, down to 1 for the last of them; a car with 0 laps scores nothing (the Warrior way)</label>
    <label for="tbl">Points for 1st, 2nd, 3rd… (commas)</label><input type="text" id="tbl" name="table" value="${esc(p.table.join(", "))}" style="max-width:100%">
    <div class="grid">${n("others", p.others, "Every other finisher")}</div>
    <label class="chk"><input type="checkbox" name="zero_laps"${p.zeroLaps ? " checked" : ""}> A car with 0 laps scores nothing (as iRacing does: a car that never started)</label>
    <p class="tag">With our own table, every race is scored as soon as its results arrive, from the overlay, race control or an uploaded file. The overlay reads this table for its live points.</p>
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
    <label class="chk"><input type="checkbox" name="winIn"${po.winIn ? " checked" : ""}> A regular-season win gets a driver in (if they have the minimum starts)</label>
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
  s('po',1);s('regularRaces',G.regularRaces);s('minStarts',G.minStarts);s('field',G.field);s('winBonus',G.winBonus);s('seedBonus',G.seedBonus.join(', '));s('winIn',G.winIn);
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
    points: { source: f.get("source"), table: list(f.get("table")), others: f.get("others"), zeroLaps: !!f.get("zero_laps") },
    bonus: { win: f.get("b_win"), pole: f.get("b_pole"), led: f.get("b_led"), mostLed: f.get("b_mostLed"), fastLap: f.get("b_fastLap") },
    drops: f.get("drops"), byClass: !!f.get("byClass"), ties: f.get("ties"),
    skip: events.filter(e => !counted.has(e.subsession_id)).map(e => e.subsession_id),
    playoffs: { enabled: !!f.get("po"), regularRaces: f.get("regularRaces"), minStarts: f.get("minStarts"), field: f.get("field"),
      seedBonus: list(f.get("seedBonus")), winBonus: f.get("winBonus"), winIn: !!f.get("winIn"), rounds },
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

function outList(rules, events, edit) {
  const names = new Map();
  for (const e of events) for (const r of e.results) names.set(r.cust_id, `${r.car_number ? "#" + r.car_number + " " : ""}${r.name}`);
  const out = rules.playoffs.out;
  let h = `<h2 id="out">Not in the playoffs</h2>`;
  h += out.length ? `<div class="wrap"><table><tr><th>Driver</th><th>Why</th>${edit ? "<th></th>" : ""}</tr>` + out.map(o => `<tr><td>${driverLink(o.cust, names.get(o.cust) || o.cust)}</td>
    <td style="white-space:normal">${esc(o.reason)}</td>${edit ? `<td><form method="post" action="#out"><input type="hidden" name="action" value="out_remove"><input type="hidden" name="cust" value="${o.cust}"><button class="link">Put back</button></form></td>` : ""}</tr>`).join("") + `</table></div>`
    : `<p class="hint">Nobody. Every driver with enough starts can make the playoffs.</p>`;
  if (edit) h += `<form method="post" action="#out"><input type="hidden" name="action" value="out_add">
    <p class="tag">For a driver who withdrew or isn't allowed in. They're skipped when the field is filled and the next driver takes the spot; their points and wins stay.</p>
    <div class="grid"><label>Driver<br><select name="cust">${[...names].sort((a, b) => a[1].localeCompare(b[1])).filter(([c]) => !out.some(o => o.cust === c)).map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("")}</select></label>
</div><label for="outwhy">Why (shown on the standings)</label><input type="text" id="outwhy" name="reason" maxlength="120" placeholder="Withdrew from the playoffs" required style="width:100%;max-width:520px">
    <p><button class="btn ghost">Take out of the playoffs</button></p></form>`;
  return h;
}

function rulesPage(sr, seasons, season, info, rules, events, user, msg = "") {
  let body = seriesTabs(sr, "rules", seasons, season && season.id, user);
  if (!season) return page(`${sr.short_name} rules`, body + `<p class="hint">No races uploaded yet.</p>`, { user });
  body += `<p class="tag">${esc(season.name)}${info.own && info.updatedAt ? ` · last changed ${day(info.updatedAt)}` : ""}</p>`;
  if (!info.rules) body += `<p class="hint">No rules set for this season yet, so standings use iRacing's league points.</p>`;
  else if (!info.own) body += `<p class="hint">Carried over from ${esc(info.from)}. Saving below makes them this season's own.</p>`;
  if (msg) body += `<div class="msg ${/^(Saved|Taken out|Put back)/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>`;
  body += rulesSummary(rules, events);
  if (rules.playoffs.enabled) body += outList(rules, events, canEdit(user, sr));
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
  if (!user.admin && !canEdit(user, sr)) return json({ ok: false, error: sr ? `You can't upload ${sr.short_name} results. Ask an admin to assign you that series.` : "Only admins can upload the first race of a new series." }, 403);
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

const KIND = { signup: "Signup", upload: "Upload", overlay: "Overlay", official: "Official", fix: "Fix", remove: "Removed", penalty: "Penalty", unpenalty: "Penalty removed",
  rules: "Rules", series: "Series", roster: "Drivers", schedule: "Schedule", webhook: "Discord", key: "Overlay key", merge: "Merge", separate: "Separate", note: "" };
function historyPage(rows, user, only = null, choices = []) {
  const when = t => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"; };
  let body = `<h1>History${only ? `: ${esc(only.short_name)}` : ""}</h1><p class="sub">Who changed what on the site, newest first${only ? `, for ${esc(only.short_name)} only` : user.overlord ? "" : user.admin ? " (every series)" : " (your series)"}.</p>`;
  if (choices.length > 1) body += `<form method="get" class="season"><select name="series" onchange="this.form.submit()"><option value="">All ${user.admin ? "" : "your "}series</option>${choices.map(x =>
    `<option value="${esc(x.slug)}"${only && only.id === x.id ? " selected" : ""}>${esc(x.short_name)}</option>`).join("")}</select></form>`;
  body += rows.length ? `<div class="wrap"><table><tr><th>When</th><th>Who</th><th>Series</th><th>What</th></tr>` + rows.map(c => `<tr><td>${when(c.at)}</td><td>${esc(whoName(c.by))}</td>
    <td>${c.slug ? `<a href="${BASE}/${esc(c.slug)}">${esc(c.short_name)}</a>` : ""}</td>
    <td style="white-space:normal">${KIND[c.kind] ? `<span class="cls">${esc(KIND[c.kind])}</span>` : ""}${c.subsession_id && c.track ? `<a href="${BASE}/results/${c.subsession_id}">${esc(c.summary)}</a>` : esc(c.summary)}</td></tr>`).join("") + `</table></div>`
    : `<p class="hint">Nothing yet.</p>`;
  return page("History", body, { user });
}

function settingsPage(cur, short, user, msg = "", stewardRole = "", producerRole = "", officialRole = "", help = { on: true, key: false }) {
  let body = `<h1>Site settings</h1><p class="sub">How the site looks for everyone.</p>${msg ? `<div class="msg ${/^Saved/.test(msg) ? "ok" : "bad"}">${esc(msg)}</div>` : ""}
  <form method="post"><fieldset><legend>Theme</legend>${Object.entries(THEMES).map(([k, t]) => `<label class="chk"><input type="radio" name="theme" value="${k}"${k === cur ? " checked" : ""}>
    <span><b>${esc(t.label)}</b> <span class="tag">${esc(t.note)}</span> <a href="${BASE}?theme=${k}" target="_blank">Preview</a></span></label>`).join("")}</fieldset>
  <label for="ls">League short name (in the VSPEED theme's header, e.g. GLR)</label><input type="text" id="ls" name="short" value="${esc(short)}" maxlength="20">
  <label for="sr">Race control role (Discord role ID; its members are stewards for every series)</label><input type="text" id="sr" name="steward_role" value="${esc(stewardRole)}" maxlength="25" inputmode="numeric">
  <p class="tag">Stewards review protests and make decisions on each race's stewards' report. Each series' officials can steward their own series too. In Discord: Server Settings › Roles › right-click the role › Copy Role ID.</p>
  <label for="pr">Producer role (Discord role ID; its members can sign a broadcast overlay in to the site)</label><input type="text" id="pr" name="producer_role" value="${esc(producerRole)}" maxlength="25" inputmode="numeric">
  <p class="tag">A signed-in overlay sends race results and shows race control's calls in the penalty box, as that producer. Admins count as producers. Overlay keys still work too.</p>
  <label for="so">Series official role (Discord role ID; its members run the series an admin assigns them)</label><input type="text" id="so" name="official_role" value="${esc(officialRole)}" maxlength="25" inputmode="numeric">
  <p class="tag">Assign each director their series on the <a href="${BASE}/accounts">Accounts</a> page. ${officialRole ? "" : "<b>Until this is saved, nobody is a series director.</b> "}Taking the role away in Discord removes all their series within 15 minutes.</p>
  <fieldset><legend>Help chat</legend><label class="chk"><input type="checkbox" name="help_on" value="1"${help.on ? " checked" : ""}>
    <span><b>Help</b> (the bubble in the bottom-right corner) for series directors, race control and admins: an AI helper that answers questions about using the site (it can't see or change anything). <a href="${BASE}/help/log">What people asked</a></span></label>
    ${help.key ? "" : `<p class="tag"><b>Not working yet:</b> the Anthropic API key isn't in Cloudflare (the ANTHROPIC_API_KEY secret), so Help stays hidden.</p>`}</fieldset>
  <p><button class="btn">Save</button></p></form>
  ${user.ownerSet ? `<p class="tag"><b>Overlord only.</b> Only you see this page, Overlay keys, the Help chat's question log, the Overlay block column on Accounts, and History for accounts, settings and keys. Admins keep everything else. You're the overlord because your Discord user ID is the OVERLORD_ID secret in Cloudflare.</p>` : ""}`;
  return page("Site settings", body, { user });
}

// fill in a page's theme: the chosen theme, or ?theme= to preview another
let themeCache = null;                  // read from the database at most once a minute (and only for that database)
async function siteTheme(db, url) {
  if (!themeCache || themeCache.db !== db || Date.now() - themeCache.t > 60000) {
    let theme = "", short = "";
    try { [theme, short] = await Promise.all([getSetting(db, "theme"), getSetting(db, "league_short")]); } catch (e) { console.error(e); }
    themeCache = { db, t: Date.now(), theme: themeOf(theme || "glr"), short: short || "GLR" };
  }
  const want = url.searchParams.get("theme");
  return { t: themeCache.t, short: themeCache.short, theme: want && THEMES[want] ? want : themeCache.theme };
}
// the dark mode switch in the header (themes with a dark mode): flips the page and remembers the choice in a cookie for a year
const SUN = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>`;
const MOON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`;
const MODE_SWITCH = `<button type="button" class="mode" id="modeSw" role="switch" aria-checked="false" aria-label="Dark mode" title="Dark mode">
<span class="knob">${SUN}${MOON}</span></button><script>(()=>{const b=document.getElementById("modeSw"),h=document.documentElement,
show=()=>b.setAttribute("aria-checked",h.classList.contains("dark"));show();b.onclick=()=>{const d=h.classList.toggle("dark");show();
try{document.cookie="glr_mode="+(d?"dark":"light")+";path=/;max-age=31536000;samesite=lax"}catch(e){}}})()</script>`;
async function applyTheme(res, db, url, request) {
  if (!(res.headers.get("content-type") || "").startsWith("text/html")) return res;
  const { theme, short } = await siteTheme(db, url), t = THEMES[theme];
  const dark = !!t.dark && request && cookies(request).glr_mode === "dark";
  const html = (await res.text())
    .replace("__THEME_MODE__", dark ? ` class="dark"` : "")
    .replace("__THEME_VARS__", t.vars)
    .replace("__THEME_FONTS__", t.fonts ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${t.fonts}">` : "")
    .replace("__THEME_CSS__", t.css + (t.dark || ""))
    .replace("__THEME_SWITCH__", t.dark ? MODE_SWITCH : "")
    .replace("__THEME_BRAND__", t.brand(esc(short)))
    // a named site (the GLR theme is GLR HUB): its name after each page's title; the home page is just the name
    .replace(/<title>([^<]*)<\/title>/, (m, x) => !t.name ? m : `<title>${/^VSPEED GLR/.test(x) ? t.name : `${x} · ${t.name}`}</title>`);
  return new Response(html, { status: res.status, headers: res.headers });
}

/* ---------- widgets: small pages for other websites (in an iframe) and OBS/vMix ---------- */

const ORIGIN = SITE;     // widget links and the embed code: the site's own address (glrhub.app since Nov 7 2026)
const widgetPage = (title, body, { bg = "transparent", refresh = 0 } = {}) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>__THEME_FONTS__<style>
:root{__THEME_VARS__}*{box-sizing:border-box}body{margin:0;color:var(--text);font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.wt{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:0 0 6px}
.wt b{font-size:17px;text-transform:uppercase}.wt span{color:var(--dim);font-size:12px}.box{border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 9px;text-align:left;white-space:nowrap}td.n,th.n{text-align:right}
th{font-size:11px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--line)}
tr+tr td{border-top:1px solid var(--line)}tr.cut td{border-top:2px solid var(--accent)!important}td.nm{white-space:normal}.tag{color:var(--dim);font-size:12px}
.st{font-size:11px;font-weight:700;color:#c47a00}.st.good{color:#1e9d46}.st.bad{color:#d33}.more{display:block;text-align:right;font-size:12px;margin-top:6px}
.cls{display:inline-block;font-size:10px;font-weight:700;padding:0 5px;border-radius:3px;background:#7774;margin-right:4px}.empty{padding:14px;color:var(--dim)}
.chg{font-size:11px;font-weight:600;padding-left:0;padding-right:2px}.chg .up{color:#1e9d46}.chg .dn{color:#d33}
__THEME_CSS__
html,body{background:${bg === "page" ? "var(--bg)" : "transparent"}!important}main,header{all:unset}body{padding:2px}
th{background:transparent}
</style></head><body>${body}
<script>(function(){var last=0;function send(){var h=document.documentElement.scrollHeight;if(h!==last){last=h;parent.postMessage({glrWidget:true,h:h},"*");}}
addEventListener("load",send);addEventListener("resize",send);setInterval(send,1000);
document.querySelectorAll('time[datetime]').forEach(function(t){try{var d=new Date(t.getAttribute('datetime'));t.textContent=d.toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});}catch(e){}});
${refresh ? `setTimeout(function(){location.reload();},${refresh * 1000});` : ""}})();</script></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });

const wLink = (path, label) => `<a href="${ORIGIN}${path}" target="_blank" rel="noopener">${label}</a>`;
const wDriver = (id, name) => wLink(`${BASE}/drivers/${id}`, esc(name));

function standingsWidget(sr, season, st, rows, cls) {
  let body = `<div class="wt"><b>${esc(sr.short_name)} standings</b><span>${season ? esc(season.name) : ""}</span></div>`;
  if (!st || !st.events.length) return body + `<div class="box empty">No races yet this season.</div>`;
  const groups = cls ? st.groups.filter(g => g.carClass.toLowerCase() === cls.toLowerCase()) : st.groups;
  const po = st.rules.playoffs;
  for (const g of groups.length ? groups : st.groups) {
    if (st.groups.length > 1) body += `<div class="wt" style="margin-top:8px"><b style="font-size:14px">${esc(g.carClass)}</b></div>`;
    const p = g.playoffs;
    if (po.enabled && p && p.started) {
      const cur = p.current, cutAt = !cur.finale && cur.spots < cur.rows.length ? cur.rows.findIndex(r => !r.through) : -1;
      body += `<div class="tag" style="margin:-2px 0 6px">${esc(cur.name)}${cur.finale && cur.complete ? " · final" : ` · race ${Math.min(cur.ran + (cur.complete ? 0 : 1), cur.races)} of ${cur.races}`}</div>`;
      body += `<div class="box"><table><tr><th class="n">Pos</th><th></th><th>Driver</th><th class="n">Pts</th><th class="n">${cur.finale ? "Behind" : "To cut"}</th><th></th></tr>` +
        cur.rows.slice(0, rows).map((r, i) => `<tr${i === cutAt ? ' class="cut"' : ""}><td class="n">${r.pos}</td>${chgCell(r.chg)}<td class="nm">${r.number ? `<span class="tag">#${esc(r.number)}</span> ` : ""}${wDriver(r.custId, r.name)}</td>
          <td class="n"><b>${r.points}</b></td><td class="n">${cur.finale ? (r.behind ? -r.behind : "") : r.toCut != null && !/win/.test(r.status) ? (r.toCut > 0 ? "+" : "") + r.toCut : ""}</td>
          <td>${r.status ? `<span class="st ${/Advanced|Champion/.test(r.status) ? "good" : /Out/.test(r.status) ? "bad" : ""}">${esc(r.status)}</span>` : ""}</td></tr>`).join("") + `</table></div>`;
    } else {
      const cut = po.enabled ? cutRow(g) : 0;
      body += `<div class="box"><table><tr><th class="n">Pos</th><th></th><th>Driver</th><th class="n">Pts</th><th class="n">Behind</th><th class="n">Wins</th></tr>` +
        g.regular.slice(0, rows).map((s, i) => `<tr${cut && i === cut ? ' class="cut"' : ""}>
          <td class="n">${s.pos}</td>${chgCell(s.chg)}<td class="nm">${s.number ? `<span class="tag">#${esc(s.number)}</span> ` : ""}${wDriver(s.custId, s.name)}</td>
          <td class="n"><b>${s.points}</b></td><td class="n">${s.behind ? -s.behind : ""}</td><td class="n">${s.wins || ""}</td></tr>`).join("") + `</table></div>`;
    }
  }
  return body + wLink(`${BASE}/${sr.slug}/standings`, "Full standings ›").replace("<a ", '<a class="more" ');
}

// team standings (a series with team points, the Warrior series)
function teamsWidget(sr, season, ts, rows) {
  let body = `<div class="wt"><b>${esc(sr.short_name)} team standings</b><span>${season ? esc(season.name) : ""}</span></div>`;
  if (!ts || !ts.teams.length) return body + `<div class="box empty">No teams yet this season.</div>`;
  const top = ts.teams[0].total;
  body += `<div class="box"><table><tr><th class="n">Pos</th><th>Team</th><th class="n">Pts</th><th class="n">Behind</th></tr>` +
    ts.teams.slice(0, rows).map(t => `<tr><td class="n">${t.pos}</td><td class="nm">${esc(t.name)}</td><td class="n"><b>${teamNum(t.total)}</b></td>
      <td class="n">${t.total < top ? "-" + teamNum(Math.round((top - t.total) * 1000) / 1000) : ""}</td></tr>`).join("") + `</table></div>`;
  return body + wLink(`${BASE}/${sr.slug}/teams`, "Full team standings ›").replace("<a ", '<a class="more" ');
}

function scheduleWidget(sr, rows, n) {
  const up = rows.filter(r => !r.subsession_id && Date.parse(r.starts_at) >= Date.now() - 4 * 3600e3).slice(0, n);
  let body = `<div class="wt"><b>${esc(sr.short_name)} schedule</b><span>Upcoming races</span></div>`;
  body += up.length ? `<div class="box"><table>` + up.map(r => `<tr><td>${when(r.starts_at)}</td><td class="nm"><b>${esc(r.track)}</b>${r.layout ? ` <span class="tag">${esc(r.layout)}</span>` : ""}
    ${[r.length, r.notes].filter(Boolean).length ? `<br><span class="tag">${[r.length, r.notes].filter(Boolean).map(esc).join(" · ")}</span>` : ""}</td></tr>`).join("") + `</table></div>`
    : `<div class="box empty">No upcoming races on the schedule.</div>`;
  return body + wLink(`${BASE}/${sr.slug}/schedule`, "Full schedule ›").replace("<a ", '<a class="more" ');
}

function resultsWidget(sr, ev, n) {
  if (!ev) return `<div class="wt"><b>${esc(sr.short_name)} results</b></div><div class="box empty">No races yet.</div>`;
  const race = (ev.sessions.race || []).slice().sort((a, b) => a.finish_pos - b.finish_pos);
  const classes = [...new Set(race.map(r => r.car_class || ""))], multi = classes.length > 1;
  let body = `<div class="wt"><b>${esc(sr.short_name)}: ${esc(ev.track)}</b><span>${day(ev.start_time)}${ev.status === "provisional" ? " · provisional" : ""}</span></div>`;
  for (const c of classes) {
    const list = race.filter(r => (r.car_class || "") === c);
    if (multi) body += `<div class="wt" style="margin-top:8px"><b style="font-size:14px">${esc(c)}</b></div>`;
    body += `<div class="box"><table><tr><th class="n">Pos</th><th>Driver</th><th class="n">Gap</th><th class="n">Led</th></tr>` + list.slice(0, n).map(r => `<tr>
      <td class="n">${multi ? r.class_pos ?? "" : r.finish_pos}</td><td class="nm">${r.car_number ? `<span class="tag">#${esc(r.car_number)}</span> ` : ""}${wDriver(r.cust_id, r.name)}</td>
      <td class="n">${gap(r, multi)}</td><td class="n">${r.laps_led || ""}</td></tr>`).join("") + `</table></div>`;
  }
  return body + wLink(`${BASE}/results/${ev.subsession_id}`, "Full results ›").replace("<a ", '<a class="more" ');
}

function embedPage(sr, user, classes) {
  const W = [["standings", "Standings", 10], ...(sr.teams ? [["teams", "Team standings", 12]] : []), ["schedule", "Schedule", 5], ["results", "Latest results", 10]];
  let body = seriesTabs(sr, "embed", [], null, user).replace(/<nav class="tabs">[\s\S]*<\/nav>/, "");
  body += `<h2>Embed on a website</h2><p class="hint">Pick a widget, set it up, then copy the code. On a WordPress/Elementor page: Edit with Elementor › drag an <b>HTML</b> element onto the page › paste the code › Update.
    The widget keeps itself up to date and sizes itself to fit. The same link (without the code around it) works as a browser source in OBS or vMix.</p>
  <div class="grid" style="margin:10px 0"><label>Widget<br><select id="ew">${W.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
    <label>Rows<br><input type="number" id="er" min="1" max="60" value="10"></label>
    <label>Look<br><select id="et"><option value="">Site theme</option>${Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join("")}</select></label>
    <label>Background<br><select id="eb"><option value="transparent">See-through</option><option value="page">Theme background</option></select></label>
    ${classes.length > 1 ? `<label>Class<br><select id="ec"><option value="">All classes</option>${classes.map(c => `<option>${esc(c)}</option>`).join("")}</select></label>` : ""}
    <label>Reload (OBS)<br><select id="ef"><option value="">Off (websites)</option><option value="60">Every minute</option><option value="300">Every 5 minutes</option></select></label></div>
  <label>Code for a website</label><textarea id="ecode" rows="5" readonly style="width:100%;font:12px monospace;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text)"></textarea>
  <p><button class="btn" type="button" id="ecopy">Copy code</button> <button class="btn ghost" type="button" id="ecopy2">Copy link only (OBS / vMix)</button></p>
  <h2>Preview</h2><div style="border:1px dashed var(--line);border-radius:6px;padding:12px;max-width:640px"><iframe id="eprev" data-glr-widget style="width:100%;border:0;height:300px" title="Preview"></iframe></div>
<script>
const O=${JSON.stringify(ORIGIN)},S=${JSON.stringify(`${BASE}/${sr.slug}/widget/`)},D=${JSON.stringify(Object.fromEntries(W.map(([k, , r]) => [k, r])))};
const $=id=>document.getElementById(id);
function url(){const w=$('ew').value,q=new URLSearchParams();q.set('rows',$('er').value||D[w]);if($('et').value)q.set('theme',$('et').value);if($('eb').value!=='transparent')q.set('bg',$('eb').value);
  if($('ec')&&$('ec').value)q.set('class',$('ec').value);if($('ef').value)q.set('refresh',$('ef').value);return O+S+w+'?'+q.toString();}
function code(u){return '<iframe src="'+u+'" title="${esc(sr.short_name)}" data-glr-widget style="width:100%;border:0;overflow:hidden;min-height:120px" scrolling="no" loading="lazy"></iframe>\\n'+
 '<script>window.addEventListener("message",function(e){if(e.origin!=="'+O+'"||!e.data||!e.data.glrWidget)return;document.querySelectorAll("iframe[data-glr-widget]").forEach(function(f){if(f.contentWindow===e.source)f.style.height=e.data.h+"px";});});<\\/script>';}
function upd(){const u=url();$('ecode').value=code(u);$('eprev').src=u.replace(O,'');}
['ew','er','et','eb','ec','ef'].forEach(i=>{if($(i))$(i).onchange=()=>{if(i==='ew')$('er').value=D[$('ew').value];upd();};});$('er').oninput=upd;
const cp=t=>{navigator.clipboard.writeText(t).then(()=>alert('Copied'),()=>{$('ecode').select();document.execCommand('copy');});};
$('ecopy').onclick=()=>cp($('ecode').value);$('ecopy2').onclick=()=>cp(url());
window.addEventListener('message',e=>{if(e.data&&e.data.glrWidget&&e.source===$('eprev').contentWindow)$('eprev').style.height=e.data.h+'px';});upd();
</script>`;
  return page(`${sr.short_name} embed`, body, { user });
}

// series as the public sees them: never the webhook links
// what the public series API sends: only the fields named here. Nov 9 2026: the old version removed three webhook
// fields by name, so hook_teams (added later) went out to everyone. A new column is private until it's added here.
const PUB_SERIES = ["id", "name", "short_name", "slug", "teams", "hidden", "races", "latest", "latestEvent"];
const pub = sr => Object.fromEntries(PUB_SERIES.filter(k => k in sr).map(k => [k, sr[k]]));
const sameOrigin = (request, url) => request.headers.get("origin") === url.origin;
const bearer = request => (/^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "") || [])[1] || "";

function keysPage(keys, user, { newKey = "", newKind = "overlay", msg = "", rc = [], ov = [] } = {}) {
  let body = `<h1>Overlay keys</h1><p class="sub">A key lets a producer's overlay send its race results here when a race ends. They arrive as Provisional and the official iRacing results file replaces them when it's uploaded. A key can only send results: it can't change rules, penalties or anything else.</p>`;
  if (newKey) body += `<div class="msg ok"><b>New key, shown only this once.</b> ${newKind === "import" ? "Use it for the backfill, then turn it off below." : "Paste it into the overlay: control panel › Setup › League site upload."}<code class="key">${esc(newKey)}</code></div>`;
  if (msg) body += `<div class="msg bad">${esc(msg)}</div>`;
  body += `<form method="post"><label for="kn">Name (whose overlay is it?)</label><input type="text" id="kn" name="name" maxlength="60" required>
    <label class="chk"><input type="checkbox" name="import"> Import key instead: official iRacing results from the iRacing members site, for a one-time backfill of past races. Turn it off when the backfill is done.</label>
    <p><button class="btn">Make a key</button></p></form>`;
  body += keys.length ? `<h2>Keys</h2><div class="wrap"><table><tr><th>Name</th><th>Made</th><th>Last used</th><th class="n">Races sent</th><th></th></tr>` +
    keys.map(k => `<tr><td>${esc(k.name)}${k.kind === "import" ? ` <span class="cls">Import</span>` : ""}${k.revoked ? ` <span class="tag">(turned off)</span>` : ""}</td><td>${day(k.created_at)}</td><td>${k.last_used ? day(k.last_used) : "Never"}</td>
      <td class="n">${k.uses}</td><td>${k.revoked ? "" : `<form method="post"><input type="hidden" name="revoke" value="${k.id}"><button class="link" onclick="return confirm('Turn this key off? That overlay stops sending results until it gets a new key.')">Turn off</button></form>`}</td></tr>`).join("") + `</table></div>` : "";
  const signedIn = (list, who, prog) => list.length ? `<div class="wrap"><table><tr><th>${who}</th><th>PC</th><th>Signed in</th><th>Last used</th><th></th></tr>` + list.map(r => `<tr><td>${esc(r.name)}</td><td><code>${esc(r.label || "")}</code></td>
      <td>${day(new Date(r.created).toISOString())}</td><td>${r.last_used ? day(new Date(r.last_used).toISOString()) : ""}</td>
      <td><form method="post"><input type="hidden" name="rc_revoke" value="${esc(r.id)}"><button class="link" onclick="return confirm('Sign this PC out of ${prog}?')">Sign out</button></form></td></tr>`).join("") + `</table></div>`
      : `<p class="hint">None yet.</p>`;
  body += `<h2>Overlay sign-ins</h2><p class="sub">Producers' PCs whose broadcast overlay is signed in with Discord (instead of an overlay key). Each acts as that producer, with their Discord roles. They sign in from the overlay; turn one off here if a PC is lost or shouldn't send results any more.</p>`
    + signedIn(ov, "Producer", "the overlay");
  body += `<h2>Race control sign-ins</h2><p class="sub">Stewards' PCs signed in to race control. Each acts as that steward, with their Discord roles. They sign in from race control; turn one off here if a PC is lost or shouldn't send calls any more.</p>`
    + signedIn(rc, "Steward", "race control");
  return page("Overlay keys", body, { user });
}

// the page a person opens from race control or the broadcast overlay to let it act as them
const LINK_TEXT = {
  rc: { title: "Race control sign-in", what: "<b>Race control</b> (stewarding, not the broadcast overlay) on a PC is asking to send calls to this site as you",
    keep: "the race control role in the league's Discord, or the Series official role there with a series an admin has assigned you", where: "race control" },
  ov: { title: "Broadcast overlay sign-in", what: "The <b>broadcast overlay</b> (the graphics program a producer runs, not race control) on a PC is asking to send race results to this site and read race control's calls, as you",
    keep: "the Producer role in the league's Discord", where: "the overlay" },
};
function linkPage(kind, code, user, { done = false, msg = "" } = {}) {   // msg: a problem, so no Allow button
  const t = LINK_TEXT[kind];
  let body = `<h1>${t.title}</h1>`;
  if (msg) body += `<div class="msg bad">${esc(msg)}</div>`;
  if (done) return page(t.title, body + `<div class="msg ok">Done. ${kind === "ov" ? "The broadcast overlay" : "Race control"} on that PC is signed in as ${esc(user.name)}. You can close this page.</div>`, { user });
  if (msg) return page(t.title, body, { user });
  body += `<p class="sub">${t.what}, <b>${esc(user.name)}</b>.</p>
    <p>Check this code matches the one ${t.where} shows:</p><p style="font:700 28px/1.2 'JetBrains Mono',monospace;letter-spacing:.08em">${esc(code)}</p>
    <form method="post"><input type="hidden" name="code" value="${esc(code)}"><p><button class="btn">Allow</button> <a href="${BASE}/">Cancel</a></p></form>
    <p class="tag">It keeps working while you have ${t.keep}. Sign it out in ${t.where}, or on the Keys page.</p>`;
  return page(t.title, body, { user });
}

/**
 * Who is calling an overlay endpoint: an overlay key, a producer's overlay sign-in (vsov_), or race control's
 * sign-in (vsrc_, for results from a race with no broadcast, and the calls). -> { key } or { error, status }.
 * key: { id, name, via: "key" | "ov" | "rc", user? }. count: a race sent (adds to the key's "races sent").
 */
// the announcer relay's producer-code signature, exactly as relay/src/index.js signature(): base64url of
// HMAC-SHA256(CHANNEL_SECRET, "producer:" + show), first 32 characters. Change both together or links break.
async function relaySignature(secret, show) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let b = "";
  for (const x of new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("producer:" + show)))) b += String.fromCharCode(x);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

// who is calling an overlay endpoint: an overlay key, a producer's sign-in, or race control's sign-in.
// fresh: read the producer's Discord roles now (the start-up check).
async function overlayCaller(request, env, db, count, fresh = false) {
  const k = await checkKey(db, bearer(request), "overlay", count);
  if (k) return { key: { ...k, via: "key" } };
  const prod = await overlayUser(request, env, fresh);
  if (prod) {
    if (prod.overlayBlock) return { error: BLOCK_MSG, status: 403, blocked: true };
    if (!prod.producer) return { error: "You don't have the Producer role in the league's Discord any more. Ask an admin.", status: 403 };
    return { key: { id: 0, name: `overlay (${prod.name})`, via: "ov", user: prod } };
  }
  const rcu = await raceControlUser(request, env);
  if (rcu) {
    if (rcu.overlayBlock) return { error: BLOCK_MSG, status: 403, blocked: true };
    return { key: { id: 0, name: `race control (${rcu.name})`, via: "rc", user: rcu } };
  }
  return { error: "The site doesn't recognise this key or sign-in. Sign the overlay in again, or make a new key on the site's Overlay keys page.", status: 401 };
}

// the Help chat's browser script, shared by the Help page and the corner bubble (they're never on one page together).
// The conversation is kept for this browser tab only, so it carries on across pages.
const HELP_JS = `  const chat=document.getElementById('chat'),q=document.getElementById('q'),go=document.getElementById('go'),leftEl=document.getElementById('left');let turns=[];const KEY='glrhelp';const save=()=>{try{sessionStorage.setItem(KEY,JSON.stringify(turns.slice(-12)))}catch(e){}};
  const esc=t=>t.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  // the answer is plain text with a little markdown: bold, bullets, and site paths become links
  const fmt=t=>esc(t).replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/(^|[\\s(])((?:https:\\/\\/glrhub\\.app)?\\/[a-z0-9][a-z0-9\\/_-]*)/gi,(m,a,p)=>a+'<a href="'+p.replace(/^https:\\/\\/glrhub\\.app/,'')+'">'+p+'</a>').replace(/^\\s*[-*] /gm,'• ').replace(/\\n/g,'<br>');
  const add=(cls,html)=>{const d=document.createElement('div');d.className='m '+cls;d.innerHTML=html;chat.appendChild(d);d.scrollIntoView({block:'nearest'});return d;};
  document.getElementById('clear').onclick=()=>{turns=[];chat.innerHTML='';save();q.focus();};
  try{for(const t of JSON.parse(sessionStorage.getItem(KEY)||'[]'))if(t&&t.content){turns.push(t);add(t.role==='user'?'u':'a',t.role==='user'?esc(t.content).replace(/\\n/g,'<br>'):fmt(t.content));}}catch(e){}
  q.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('ask').requestSubmit();}});
  document.getElementById('ask').onsubmit=async e=>{e.preventDefault();const text=q.value.trim();if(!text||go.disabled)return;
    add('u',esc(text).replace(/\\n/g,'<br>'));turns.push({role:'user',content:text});save();q.value='';go.disabled=true;const wait=add('a','<span class="tag">Thinking…</span>');
    try{const r=await fetch('${BASE}/api/help',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:turns})});const j=await r.json();
      if(j.ok){wait.innerHTML=fmt(j.answer);turns.push({role:'assistant',content:j.answer});save();}else{wait.className='m a e';wait.textContent=j.error||'Something went wrong.';turns.pop();save();}
      if(typeof j.left==='number')leftEl.textContent=j.left>0?j.left+' questions left today':'No questions left today';
    }catch(err){wait.className='m a e';wait.textContent="Couldn't reach the site. Check your connection and try again.";turns.pop();save();}
    go.disabled=false;q.focus();};
`;
// the Help bubble in the bottom-right corner of every page, for directors, race control and admins: opens a small chat panel
function helpWidget(user) {
  return `<button type="button" id="hc-open" class="hc-open" aria-expanded="false" aria-controls="hc-panel" title="Ask how to do something on GLR HUB"><b>?</b> Help</button>
<section id="hc-panel" class="hc-panel" hidden aria-label="Help chat"><div class="hc-top"><b>Help</b><span class="tag">Answers from the site's guides. It can't see or change anything, and it can be wrong.</span><button type="button" class="link" id="hc-close" aria-label="Close help">×</button></div>
<div id="chat" class="help" aria-live="polite"><div class="m a">Ask how to do something on GLR HUB, like "How do I make a race official?"</div></div>
<form id="ask" class="helpask"><textarea id="q" rows="2" maxlength="2000" placeholder="Type your question" required></textarea>
<div class="hc-row"><button class="btn" id="go">Ask</button><button type="button" class="link" id="clear">Start over</button><span class="tag" id="left"></span>${user.overlord ? `<a class="tag" href="${BASE}/help/log">What people asked</a>` : ""}</div></form></section>
<style>.hc-open{position:fixed;right:18px;bottom:18px;z-index:50;display:flex;align-items:center;gap:8px;padding:9px 16px 9px 10px;border-radius:999px;border:0;background:var(--accent);color:#fff;font:inherit;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.hc-open b{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.25)}.hc-open[aria-expanded=true]{display:none}
.hc-panel{position:fixed;right:18px;bottom:18px;z-index:51;width:min(390px,calc(100vw - 24px));height:min(560px,calc(100vh - 36px));display:flex;flex-direction:column;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:hidden}
.hc-panel[hidden]{display:none}.hc-top{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.hc-top .tag{flex:1;font-size:12px;white-space:normal}.hc-top button{font-size:24px;line-height:1;padding:0 2px}
.hc-panel .help{flex:1;overflow-y:auto;margin:0;padding:10px 12px}.hc-panel .help .m{font-size:14px}.hc-panel .helpask{padding:8px 12px 10px;border-top:1px solid var(--line);margin:0}
.hc-panel textarea{font-size:14px;resize:none}.hc-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
.help{display:flex;flex-direction:column;gap:10px}.help .m{padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);white-space:normal;line-height:1.45}
.help .u{align-self:flex-end;max-width:85%;background:transparent}.help .a{max-width:95%}.help .e{border-color:#d33}</style>
<script>${HELP_JS}</script>
<script>(()=>{const o=document.getElementById('hc-open'),p=document.getElementById('hc-panel'),c=document.getElementById('chat');
const show=v=>{p.hidden=!v;o.setAttribute('aria-expanded',v);try{sessionStorage.setItem('glrhelp-open',v?'1':'')}catch(e){}if(v){c.scrollTop=c.scrollHeight;document.getElementById('q').focus();}};
o.onclick=()=>show(true);document.getElementById('hc-close').onclick=()=>show(false);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!p.hidden)show(false);});
try{if(sessionStorage.getItem('glrhelp-open'))show(true);}catch(e){}})();</script>`;
}

// ---- Season signups and car numbers (Nov 2026; the rules are in signups.js) ----
const etParts = iso => { const d = new Date(iso); if (isNaN(d)) return { date: "", time: "" };
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
const SIGNUP_CSS = `<style>.su{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 16px;margin:12px 0}.su h2{margin:0 0 2px;font-size:18px}.su p{margin:6px 0}
.su .pick{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.su input[type=text]{width:90px}.su .nums{white-space:normal;line-height:1.7}
.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;border:1px solid var(--line)}.pill.ok{border-color:#2a7;color:#2a7}.pill.wait{border-color:#b80;color:#b80}.pill.no{border-color:#a33;color:#d55}</style>`;
const windowLine = (round, state) => state === "soon" ? `Signups start ${when(round.keep_at)}.`
  : state === "keep" ? `<b>Keep-your-number week.</b> Drivers who raced last season can keep their number. Signups open to everyone ${when(round.open_at)}.`
  : state === "open" ? `<b>Open to everyone:</b> first come, first served.` : `Signups are closed.`;
const takenLine = list => { const a = activeOf(list); return a.length ? `<p class="tag nums">Taken (${a.length}): ${a.map(x => `#${esc(x.number)}`).join(", ")}</p>` : `<p class="tag">No numbers taken yet.</p>`; };

// the entry list at the top of a series' Drivers tab
function entryList(sr, { round, list }, user) {
  const state = roundState(round);
  let h = SIGNUP_CSS + `<h2>${esc(round.name)} entry list</h2><p class="tag">${list.length} driver${list.length === 1 ? "" : "s"} signed up. ${windowLine(round, state)}${state === "keep" || state === "open" ? ` <a href="${BASE}/signup">Sign up</a>` : ""}${canEdit(user, sr) ? ` · <a href="${BASE}/${esc(sr.slug)}/signups">Manage signups</a>` : ""}</p>`;
  if (list.length) h += `<div class="wrap" style="margin-bottom:18px"><table><tr><th class="n">#</th><th>Driver</th><th>Signup</th></tr>${list.map(x =>
    `<tr><td class="n"><b>${esc(x.number)}</b></td><td>${esc(x.name)}</td><td>${x.status === "approved" ? `<span class="pill ok">Approved</span>` : `<span class="pill wait">Waiting for the director</span>`}</td></tr>`).join("")}</table></div>`;
  return h + `<h2>Everyone who has raced</h2>`;
}

// the Sign up page: every series taking signups on one form
function signupPage(user, cards, { msgs = [], same = "" } = {}) {
  let body = SIGNUP_CSS + `<h1>Sign up</h1><p class="sub">Sign up for the series you want to race in next season and pick your car number in each. Numbers are separate for each series. Every signup is checked by the series director before it's final.</p>`;
  for (const m of msgs) body += `<div class="msg ${m.ok ? "ok" : "bad"}">${esc(m.text)}</div>`;
  if (!cards.length) return page("Sign up", body + `<p class="hint">No series is taking signups right now.</p>`, { user });
  if (!user) body += `<p class="hint"><a href="${BASE}/login?back=${BASE}/signup">Sign in with Discord</a> to sign up.</p>`;
  else if (!user.cust) body += `<div class="su"><h2>First: which driver are you?</h2>
    <p>If you've raced in GLR before, <a href="${BASE}/me/driver?back=${BASE}/signup"><b>pick yourself from the list</b></a>.</p>
    <p>If you haven't raced in GLR yet, tell us who you are:</p>
    <form method="post"><input type="hidden" name="action" value="newdriver"><div class="grid"><label>Your iRacing ID<br><input type="number" name="cust" required min="1"></label>
    <label>Your name, as in iRacing<br><input type="text" name="name" maxlength="60" required></label></div>
    <p class="tag">Your iRacing ID is the customer ID number on your iRacing account page.</p><p><button class="btn">That's me</button></p></form></div>`;
  const can = !!(user && user.cust), anyOpen = cards.some(c => c.state === "open" && !(c.mine && c.mine.status === "approved"));
  let form = "", pickable = 0;
  if (can && anyOpen) form += `<div class="su"><div class="pick"><label for="same" style="margin:0"><b>Same number in every series I tick:</b></label>
    <input type="text" id="same" name="same" inputmode="numeric" maxlength="4" value="${esc(same)}" placeholder="24">
    <span class="tag">Used wherever it's free and a series' own box is empty. Where it's taken, you'll be asked for another.</span></div></div>`;
  for (const c of cards) {
    const { round: r, state, list, hold, mine } = c, active = mine && (mine.status === "pending" || mine.status === "approved");
    let h = `<div class="su"><h2><a href="${BASE}/${esc(r.slug)}/drivers">${esc(r.short_name)}</a> · ${esc(r.name)}</h2><p class="tag">${windowLine(r, state)}</p>`;
    if (active) h += `<p><b>#${esc(mine.number)}</b> ${mine.status === "approved" ? `<span class="pill ok">Approved</span> <span class="tag">To change it, ask the series director.</span>`
      : `<span class="pill wait">Waiting for the director</span> <button class="link" form="wd" name="withdraw" value="${r.id}">Withdraw</button>`}</p>`;
    else if (mine && mine.status === "declined") h += `<p><span class="pill no">Declined</span> #${esc(mine.number)}: ${esc(mine.note)} <span class="tag">You can sign up again.</span></p>`;
    else if (mine && mine.status === "released") h += `<p><span class="pill no">Released</span> The director released your #${esc(mine.number)}. <span class="tag">You can sign up again.</span></p>`;
    if (can && !(mine && mine.status === "approved")) {
      if (state === "keep" && !active) {
        if (hold && hold.mine) { pickable++; h += `<label class="chk"><input type="checkbox" name="s_${r.id}" value="1" checked> <span>Keep <b>#${esc(hold.number)}</b>, my number last season</span></label>`; }
        else h += `<p class="tag">${hold ? `Last season you and ${esc(hold.holder)} both ran #${esc(hold.number)}, and it's held for ${esc(hold.holder)}, who ran it in more races.` : `You didn't race in ${esc(r.short_name)} last season, so there's no number to keep.`} You can pick a number when signups open to everyone.</p>`;
      } else if (state === "open") {
        pickable++;
        h += `<div class="pick"><label class="chk" style="margin:0"><input type="checkbox" name="s_${r.id}" value="1"${c.ticked ? " checked" : ""}> <span>${active ? "Change my number to" : "Sign me up, with number"}</span></label>
          <input type="text" name="n_${r.id}" inputmode="numeric" maxlength="4" value="${esc(c.value || "")}" placeholder="${active ? esc(mine.number) : "#"}"></div>`;
      }
    }
    if (state !== "soon") h += takenLine(list);
    form += h + `</div>`;
  }
  body += `<form method="post" id="wd"><input type="hidden" name="action" value="withdraw"></form><form method="post"><input type="hidden" name="action" value="signup">${form}${pickable ? `<p><button class="btn">Sign up</button> <span class="tag">A number is 1 to 3 digits. 7, 07 and 007 are different numbers, as in iRacing.</span></p>` : ""}</form>`;
  return page("Sign up", body, { user });
}

// a series' signups, for its directors and admins: open them, approve, change, release, add
function signupsAdminPage(sr, user, { round, list = [], held = null, flags = null, msg = "" } = {}) {
  const S = `${BASE}/${esc(sr.slug)}`, state = roundState(round), hid = (a, id) => `<input type="hidden" name="action" value="${a}">${id ? `<input type="hidden" name="id" value="${id}">` : ""}`;
  let body = seriesTabs(sr, "director", [], null, user) + SIGNUP_CSS + `<p class="crumb"><a href="${S}/director">Director</a> › Signups and car numbers</p>`;
  if (msg) body += `<div class="msg ${/^(Saved|Opened|Closed|Reopened|Approved|Declined|Released|Changed|Added)/.test(msg) ? "ok" : "bad"}" id="top">${esc(msg)}</div>`;
  const k = round && state !== "closed" ? etParts(round.keep_at) : { date: "", time: "12:00" }, o = round && state !== "closed" ? etParts(round.open_at) : { date: "", time: "12:00" };
  body += `<h2>${!round ? "Open signups" : state === "closed" ? "Open signups for a new season" : esc(round.name)}</h2>`;
  if (round) body += `<p class="tag">${state === "closed" ? `${esc(round.name)}: signups are closed.` : windowLine(round, state)} ${state === "closed"
    ? `<form method="post" style="display:inline">${hid("reopen")}<button class="link">Reopen them</button></form>`
    : `<form method="post" style="display:inline" onsubmit="return confirm('Close signups? Drivers can\\'t sign up or change after this. You still can.')">${hid("close")}<button class="link">Close signups</button></form>`}</p>`;
  body += `<form method="post">${hid("round")}<label for="rn">Season name</label><input type="text" id="rn" name="name" maxlength="60" required placeholder="2027 Season 1" value="${round && state !== "closed" ? esc(round.name) : ""}">
    <div class="grid"><label>Keep-your-number week starts<br><input type="date" name="keep_date" required value="${k.date}"> <input type="time" name="keep_time" value="${k.time}" style="width:120px"></label>
    <label>Opens to everyone<br><input type="date" name="open_date" required value="${o.date}"> <input type="time" name="open_time" value="${o.time}" style="width:120px"></label></div>
    <p class="tag">Times are Eastern. In the first window, drivers who raced last season can keep their number and nobody else can take it. After that, every number not kept is first come, first served. Every signup waits for your approval.</p>
    <p><button class="btn">${round && state !== "closed" ? "Save" : "Open signups"}</button></p></form>`;
  if (!round) return page(`${sr.short_name} signups`, body, { user });

  if (flags) body += `<h2 id="flags">Car numbers in the last race</h2><p class="tag"><a href="${BASE}/results/${flags.event.subsession_id}">${day(flags.event.start_time)} · ${esc(flags.event.track)}</a>. Nothing is blocked: this is for you to follow up.</p><ul class="todo">
    ${flags.different.map(x => `<li><b>${esc(x.name)}</b> ran #${esc(x.ran)}, signed up as #${esc(x.signed)}.</li>`).join("")}
    ${flags.unsigned.map(x => `<li><b>${esc(x.name)}</b> raced${x.ran ? ` as #${esc(x.ran)}` : ""} ${x.waiting ? "with a signup still waiting for approval" : "without signing up"}.</li>`).join("")}</ul>`;

  const waiting = list.filter(x => x.status === "pending"), active = activeOf(list);
  body += `<h2>Waiting for you (${waiting.length})</h2>`;
  body += waiting.length ? `<div class="wrap"><table><tr><th class="n">#</th><th>Driver</th><th>Signed up</th><th></th></tr>${waiting.map(x => `<tr><td class="n"><b>${esc(x.number)}</b></td>
    <td>${driverLink(x.cust_id, x.name)}${x.kept ? ` <span class="tag">kept from last season</span>` : ""}</td><td>${when(x.created_at)}</td>
    <td style="white-space:normal"><form method="post" style="display:inline">${hid("approve", x.id)}<button class="btn">Approve</button></form>
      <form method="post" style="display:inline-flex;gap:6px;margin-left:10px">${hid("decline", x.id)}<input type="text" name="reason" maxlength="200" placeholder="Reason (the driver sees it)" required style="width:220px"><button class="link">Decline</button></form></td></tr>`).join("")}</table></div>`
    : `<p class="hint">No signups waiting.</p>`;

  body += `<h2>Entry list (${active.length})</h2><p class="tag"><a href="${S}/signups.csv">Download as CSV</a> to enter the numbers in the iRacing league: the site can't set them there. A number is only freed when you decline or release it.</p>`;
  if (active.length) body += `<div class="wrap"><table><tr><th class="n">#</th><th>Driver</th><th class="n">iRacing ID</th><th>Signup</th><th>Change number</th><th></th></tr>${active.map(x => `<tr><td class="n"><b>${esc(x.number)}</b></td>
    <td>${driverLink(x.cust_id, x.name)}</td><td class="n tag">${x.cust_id}</td><td>${x.status === "approved" ? `<span class="pill ok">Approved</span>` : `<span class="pill wait">Waiting</span>`}</td>
    <td><form method="post" style="display:inline-flex;gap:6px">${hid("number", x.id)}<input type="text" name="number" inputmode="numeric" maxlength="4" required style="width:70px"><button class="link">Change</button></form></td>
    <td><form method="post" onsubmit="return confirm('Release #${esc(x.number)}? ${esc(String(x.name).replace(/['"\\]/g, ""))} comes off the entry list and the number is free.')">${hid("release", x.id)}<button class="link">Release</button></form></td></tr>`).join("")}</table></div>`;
  if (held && held.length) body += `<p class="tag nums"><b>Held for last season's drivers until ${when(round.open_at)}:</b> ${held.map(x => `#${esc(x.number)} ${esc(x.name)}`).join(", ")}</p>`;

  body += `<h2>Sign a driver up yourself</h2><form method="post">${hid("add")}<div class="grid"><label>iRacing ID<br><input type="number" name="cust" required min="1"></label>
    <label>Car number<br><input type="text" name="number" inputmode="numeric" maxlength="4" required style="width:90px"></label></div>
    <label for="an">Name</label><input type="text" id="an" name="name" maxlength="80">
    <p class="tag">Approved straight away. Leave the name empty for a driver the site already knows. If they're already signed up, this changes their number.</p><p><button class="btn">Sign up</button></p></form>`;
  const gone = list.filter(x => x.status === "declined" || x.status === "released" || x.status === "withdrawn").sort((a, b) => b.id - a.id).slice(0, 30);
  if (gone.length) body += `<h2>No longer signed up</h2><div class="wrap"><table><tr><th class="n">#</th><th>Driver</th><th>What happened</th></tr>${gone.map(x => `<tr><td class="n">${esc(x.number)}</td><td>${esc(x.name)}</td>
    <td style="white-space:normal">${x.status === "declined" ? `Declined by ${esc(whoName(x.decided_by))}: ${esc(x.note)}` : x.status === "released" ? `Released by ${esc(whoName(x.decided_by))}` : "Withdrawn by the driver"} · ${day(x.decided_at)}</td></tr>`).join("")}</table></div>`;
  return page(`${sr.short_name} signups`, body, { user });
}

// the routes for /signup and /<series>/signups[.csv]; null when the path is something else
async function signupRoutes(request, env, db, url, path, user) {
  let m;
  if (path === `${BASE}/signup`) {
    const rounds = (await liveRounds(db)).filter(r => shown({ hidden: r.hidden, id: r.series_id }, user)), msgs = [], vals = new Map();
    let same = "";
    if (request.method === "POST") {
      if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/signup`, 302);
      if (!sameOrigin(request, url)) return notFound("Sign up from the Sign up page.", user);
      const f = await request.formData(), by = `discord:${user.id}:${user.name}`, wd = Number(f.get("withdraw")) || 0;
      if (f.get("action") === "newdriver" && !user.cust) {
        try {
          const d = await newDriver(db, f.get("cust"), f.get("name"));
          if (d.existed) msgs.push({ text: "That iRacing ID is already on GLR HUB. Use \"pick yourself from the list\" instead." });
          else {
            const r = await linkDriver(db, user.id, user.name, d.cust);
            if (r.claim) msgs.push({ text: "That iRacing ID is linked to another account. An admin has to sort that out." });
            else { user.cust = d.cust; user.driverName = d.name; user.noDriver = false;
              await logChange(db, { by, kind: "account", summary: `${user.name} joined as a new driver: ${d.name} (${d.cust})` });
              msgs.push({ ok: true, text: `Welcome, ${d.name}. Now pick your series and numbers.` }); }
          }
        } catch (e) { msgs.push({ text: e.message }); }
      } else if (!user.cust) msgs.push({ text: "First tell the site which driver you are." });
      else if (wd) {
        const r = rounds.find(x => x.id === wd);
        try { if (!r) throw new Error("Signups aren't open for that series."); const s = await withdraw(db, r, user.cust); msgs.push({ ok: true, text: `${r.short_name}: your signup for #${s.number} is withdrawn.` }); }
        catch (e) { msgs.push({ text: e.message }); }
      } else {
        same = String(f.get("same") || "").trim();
        const h = new Map();
        for (const r of rounds) {
          if (!f.get(`s_${r.id}`)) continue;
          const state = roundState(r);
          let num = String(f.get(`n_${r.id}`) || "").trim() || same;
          try {
            if (state === "keep") { if (!h.has(r.id)) h.set(r.id, await holds(db, r)); const mine = h.get(r.id).byCust.get(user.cust); num = mine && mine.mine ? mine.number : ""; }
            if (!num) throw new Error("pick a number.");
            const res = await signUp(db, r, { cust: user.cust, discordId: user.id, name: user.driverName || user.name, number: num, by });
            msgs.push({ ok: true, text: `${r.short_name}: #${res.number} is ${res.changed ? "your number now" : "yours"}${res.status === "approved" ? "." : ", waiting for the director's approval."}` });
          } catch (e) { msgs.push({ text: `${r.short_name}: ${e.message}` }); vals.set(r.id, String(f.get(`n_${r.id}`) || "").trim()); }
        }
        if (!msgs.length) msgs.push({ text: "Tick the series you want to sign up for." });
      }
    }
    const cards = [];
    for (const r of rounds) {
      const state = roundState(r), list = await listSignups(db, r.id);
      const hold = user && user.cust && state === "keep" ? (await holds(db, r)).byCust.get(user.cust) || null : null;
      cards.push({ round: r, state, list, hold, mine: user && user.cust ? mineIn(list, user.cust) : null, ticked: vals.has(r.id), value: vals.get(r.id) || "" });
    }
    return signupPage(user, cards, { msgs, same });
  }
  if ((m = path.match(/^\/([a-z0-9-]+)\/signups(\.csv)?$/))) {
    const sr = await getSeries(db, m[1]);
    if (!sr) return null;
    if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/${sr.slug}/signups`, 302);
    if (!canEdit(user, sr)) return notFound("Only this series' directors and admins manage its signups. The entry list is on the Drivers tab.", user);
    let round = await currentRound(db, sr.id), msg = "";
    if (m[2]) return new Response(entryCsv(round ? await listSignups(db, round.id) : []), { headers: {
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${sr.slug}-entry-list.csv"`, "cache-control": "no-store" } });
    if (request.method === "POST") {
      if (!sameOrigin(request, url)) return notFound("You can't change this series.", user);
      const f = await request.formData(), a = f.get("action"), id = Number(f.get("id")) || 0, by = `discord:${user.id}:${user.name}`;
      const log = summary => logChange(db, { by, seriesId: sr.id, kind: "signup", summary });
      try {
        if (a === "round") {
          const r = await saveRound(db, sr.id, { name: f.get("name"), keepDate: f.get("keep_date"), keepTime: f.get("keep_time"), openDate: f.get("open_date"), openTime: f.get("open_time") }, by);
          await log(`${r.created ? "Signups opened" : "Signup dates changed"} for ${r.name}: keep-your-number from ${day(r.keep)}, open to everyone from ${day(r.open)}`);
          msg = r.created ? `Opened signups for ${r.name}.` : "Saved.";
        } else if (!round) throw new Error("Open signups first.");
        else if (a === "close" || a === "reopen") { await closeRound(db, round.id, a === "close"); await log(`Signups ${a === "close" ? "closed" : "reopened"} for ${round.name}`); msg = a === "close" ? "Closed signups." : "Reopened signups."; }
        else if (a === "approve" || a === "decline") {
          const s = await decide(db, sr.id, id, a === "approve", f.get("reason"), by);
          await log(a === "approve" ? `Signup approved: ${s.name} #${s.number} (${round.name})` : `Signup declined: ${s.name} #${s.number} (${round.name}): ${String(f.get("reason")).trim()}`);
          msg = a === "approve" ? `Approved ${s.name}, #${s.number}.` : `Declined ${s.name}. #${s.number} is free.`;
        } else if (a === "release") { const s = await release(db, sr.id, id, by); await log(`Number released: #${s.number}, ${s.name} (${round.name})`); msg = `Released #${s.number}. ${s.name} is off the entry list.`; }
        else if (a === "number") { const s = await changeNumber(db, sr.id, id, f.get("number"), by); await log(`Car number changed: ${s.name} #${s.number} → #${s.to} (${round.name})`); msg = `Changed ${s.name} to #${s.to}.`; }
        else if (a === "add") {
          const cust = Number(f.get("cust")) || 0, known = cust ? await getDriver(db, cust) : null, name = String(f.get("name") || "").trim() || (known && known.name) || "";
          if (!cust) throw new Error("Enter the driver's iRacing ID.");
          if (!name) throw new Error("Enter the driver's name: the site doesn't know that iRacing ID yet.");
          const r = await signUp(db, round, { cust, name, number: f.get("number"), by, director: true });
          await log(`${r.changed ? `Car number changed: ${name} #${r.was} → #${r.number}` : `Driver signed up by an official: ${name} #${r.number}`} (${round.name})`);
          msg = `Added ${name}, #${r.number}.`;
        }
      } catch (e) { msg = e.message; }
      round = await currentRound(db, sr.id);
    }
    const list = round ? await listSignups(db, round.id) : [], state = roundState(round);
    let held = null;
    if (round && (state === "soon" || state === "keep")) { const have = new Set(activeOf(list).map(x => x.number));
      held = [...(await holds(db, round)).byNumber].filter(([n]) => !have.has(n)).map(([number, x]) => ({ number, name: x.name })).sort((a, b) => Number(a.number) - Number(b.number)); }
    return signupsAdminPage(sr, user, { round, list, held, flags: await raceFlags(db, round), msg });
  }
  return null;
}

// The Help chat (directors and admins): the page, the question endpoint, and the admins' log of questions
async function helpRoute(request, env, db, url, path, user) {
  if (path === `${BASE}/help/log`) {
    if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/help/log`, 302);
    if (!user.overlord) return notFound("Check the link.", user);            // overlord only
    return helpLogPage(user, await listHelp(db));
  }
  if (path === `${BASE}/help`) {
    if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/help`, 302);
    if (!user.help) return notFound(user.official || user.steward ? "The Help chat is switched off right now." : "Help is for series directors, race control and admins.", user);
    return helpPage(user, HELP_PER_DAY - await helpToday(db, user.id));
  }
  // POST /api/help {messages: [{role, content}]}: the question is the last user message
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  if (!sameOrigin(request, url)) return json({ ok: false, error: "Ask from the Help page." }, 403);
  if (!user) return json({ ok: false, error: "Sign in again." }, 401);
  if (!user.help) return json({ ok: false, error: user.official || user.steward ? "The Help chat is switched off right now." : "Help is for series directors, race control and admins." }, 403);
  let body = null;
  try { body = await request.json(); } catch (e) { /* handled below */ }
  const turns = cleanTurns(body && body.messages);
  if (!turns) return json({ ok: false, error: "Type a question first." }, 400);
  const used = await helpToday(db, user.id);
  if (used >= HELP_PER_DAY) return json({ ok: false, error: `That's today's ${HELP_PER_DAY} questions. Ask again tomorrow, or ask an admin in the GLR Discord.`, left: 0 }, 429);
  const names = user.admin ? [] : (await listSeries(db)).filter(x => (user.directs || []).includes(x.id)).map(x => x.name);
  const question = turns[turns.length - 1].content;
  let answer;
  try { answer = await askClaude(env, systemPrompt(user, names), turns); }
  catch (e) { await logHelp(db, { id: user.id, name: user.name, question, answer: "(no answer: " + e.message + ")" }); return json({ ok: false, error: e.message, left: HELP_PER_DAY - used - 1 }, 502); }
  await logHelp(db, { id: user.id, name: user.name, question, answer });
  return json({ ok: true, answer, left: HELP_PER_DAY - used - 1 });
}

function helpPage(user, left) {
  const body = `<h1>Help</h1><p class="sub">Ask how to do something on GLR HUB, like "How do I make a race official?" or "Why are my standings wrong?". The helper knows the site's guides. It can't see your series' data or change anything, and it can be wrong: if something doesn't look right, ask an admin in the GLR Discord.</p>
  <div id="chat" class="help" aria-live="polite"></div>
  <form id="ask" class="helpask"><textarea id="q" rows="3" maxlength="2000" placeholder="Type your question" required></textarea>
  <p><button class="btn" id="go">Ask</button> <button type="button" class="link" id="clear">Start over</button> <span class="tag" id="left">${left > 0 ? `${left} questions left today` : "No questions left today"}</span>${user.overlord ? ` · <a href="${BASE}/help/log">What people asked</a>` : ""}</p></form>
  <style>.help{display:flex;flex-direction:column;gap:10px;margin:14px 0}.help .m{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);white-space:normal;line-height:1.45}
  .help .u{align-self:flex-end;max-width:85%;background:transparent}.help .a{max-width:95%}.help .e{border-color:#d33}.helpask textarea{max-width:900px}</style>
  <script>${HELP_JS}</script>`;
  return page("Help", body, { user });
}

function helpLogPage(user, rows) {
  const body = `<h1>What people asked the helper</h1><p class="sub">The latest ${rows.length} questions to the Help chat, newest first. Questions that come up often are a sign a page or guide needs to be clearer. Only admins see this.</p>
  ${rows.length ? `<table><tr><th>When</th><th>Who</th><th>Question</th><th>Answer</th></tr>${rows.map(r => `<tr class="r"><td>${day(r.at)}</td><td>${esc(r.name || r.discord_id)}</td>
    <td style="white-space:pre-wrap;min-width:220px">${esc(r.question)}</td><td style="white-space:pre-wrap;min-width:320px;font-size:14px">${esc(r.answer || "")}</td></tr>`).join("")}</table>` : `<p class="hint">Nobody has asked anything yet.</p>`}`;
  return page("Help questions", body, { user });
}

const site = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueue(env.DB));       // retry Discord posts that are waiting
  },

  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    if (u.hostname === OLD_HOST) {
      if (u.pathname !== OLD_BASE && !u.pathname.startsWith(OLD_BASE + "/")) return new Response("Not found", { status: 404 });
      const rest = u.pathname.slice(OLD_BASE.length) || "/";
      // overlays and race control already out there send to vspeedlivetiming.app/glr/api/...: a program can't follow a
      // forward with what it sent, so these are answered here, as if they came to glrhub.app
      if (rest.startsWith("/api/")) {
        request = new Request(SITE + rest + u.search, request);
        return applyTheme(await site.route(request, env, ctx), env.DB, new URL(request.url), request);
      }
      return Response.redirect(SITE + rest + u.search, 301);     // pages, widgets, sign-in: the same page on glrhub.app
    }
    return applyTheme(await site.route(request, env, ctx), env.DB, new URL(request.url), request);
  },

  async route(request, env, ctx) {
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
        return login(env, url, url.searchParams.get("back") || "/");
      }
      if (path === `${BASE}/auth/callback`) {
        if (!configured(env)) return notFound("Discord sign-in isn't set up yet.");
        const r = await callback(request, env, url);
        return r.response || page("Sign in", `<h1>Couldn't sign you in</h1><p class="sub">${r.name ? `Signed in to Discord as ${esc(r.name)}. ` : ""}${esc(r.error)}</p>
          <p><a href="${BASE}/login">Try again</a></p>`, { status: 403 });
      }
      if (path === `${BASE}/logout` && request.method === "POST" && sameOrigin(request, url)) return logout(request, env);
      let user = await currentUser(request, env);
      // "Sign up" in the header while any series is taking season signups (pages only, not the API or widgets)
      NAV.signup = !/\/(api|widget)\//.test(path) && (await liveRounds(db)).some(r => shown({ hidden: r.hidden, id: r.series_id }, user));
      const hiddenIds = path === `${BASE}/api/schedule` ? new Set((await listSeries(db)).filter(x => x.hidden).map(x => x.id)) : new Set();
      // the Help chat: directors, race control and admins, once the API key is in Cloudflare and an admin hasn't switched it off
      if (user && (user.official || user.steward) && env.ANTHROPIC_API_KEY && await getSetting(db, "help_off") !== "1") user.help = true;
      if (path === `${BASE}/help` || path === `${BASE}/api/help` || path === `${BASE}/help/log`) {
        const r = await helpRoute(request, env, db, url, path, user);
        if (r) return r;
      }
      if (path === `${BASE}/signup` || /\/signups(\.csv)?$/.test(path)) {
        const r = await signupRoutes(request, env, db, url, path, user);
        if (r) return r;
      }
      if (path === `${BASE}/upload`) return !user ? Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/upload`, 302) : user.official ? uploadPage(user) : notFound("Only series officials can upload results.", user);
      if (path === `${BASE}/api/upload`) {
        if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
        if (!user) return json({ ok: false, error: "Sign in as an official first." }, 401);
        if (!user.official) return json({ ok: false, error: "Only series officials can upload results." }, 403);
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
      // the broadcast overlay reads race control's calls for the race it's showing (for the penalty box). Same as race
      // control's GET, without the stewards' names.
      if ((m = path.match(/^\/api\/overlay\/calls\/(\d+)$/))) {
        const who = await overlayCaller(request, env, db, false);
        if (who.error) return json({ ok: false, error: who.error, ...(who.blocked ? { blocked: true } : {}) }, who.status);
        const calls = (await raceCalls(db, Number(m[1]))).map(({ madeBy, withdrawnBy, ...c }) => c);
        return json({ ok: true, subsessionId: Number(m[1]), calls });
      }
      // POST /api/overlay/announcer {"show": "<the overlay's current show, or empty>"}: this producer's announcer show and
      // producer code for the relay (Nov 2026). Only a producer's own overlay sign-in; the code is a key: it goes to that
      // producer only, and is never logged or shown on a page.
      if (path === `${BASE}/api/overlay/announcer`) {
        if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
        const who = await overlayCaller(request, env, db, false);
        if (who.error) return json({ ok: false, error: who.error, ...(who.blocked ? { blocked: true } : {}) }, who.status);
        if (who.key.via !== "ov") return json({ ok: false, error: "Sign the overlay in with Discord (Setup tab) to get an announcer link. Overlay keys and race control can't." }, 403);
        if (!env.CHANNEL_SECRET) return json({ ok: false, error: "The announcer relay isn't set up on GLR HUB yet" }, 503);
        let body = {};
        try { body = await request.json(); } catch (e) { /* no body: make a show from their name */ }
        const u = who.key.user;
        const show = await announcerShow(db, u.id, String((body && body.show) || "").trim().toLowerCase(), u.name);
        return json({ ok: true, show, code: `https://vspeedlivetiming.app/k/${show}.${await relaySignature(env.CHANNEL_SECRET, show)}` });
      }
      if (path === `${BASE}/api/overlay/check` || path === `${BASE}/api/overlay/results`) {
        const check = path.endsWith("/check");
        // the start-up check reads the producer's roles from Discord now; overlay keys are counted as before
        const who = await overlayCaller(request, env, db, true, check);
        if (who.error) return json({ ok: false, error: who.error, ...(who.blocked ? { blocked: true } : {}) }, who.status);
        const key = who.key;
        // perms: what this sign-in may do (a Discord sign-in only; an overlay key answers as before and can't open the overlay)
        if (check) return json({ ok: true, name: key.name, ...(key.user ? { user: { id: key.user.id, name: key.user.name } } : {}), ...(key.via === "ov" ? { perms: key.user.perms } : {}) });
        if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
        let ev;
        try { ev = parseOverlay(await request.json()); } catch (e) { return json({ ok: false, error: e.message }, 400); }
        if (key.via === "rc" && !canSteward(key.user, await seriesById(db, ev.league.id)))
          return json({ ok: false, error: "You're not a steward for this series." }, 403);
        const r = await importOverlay(db, ev, key.user ? `discord:${key.user.id}:${key.user.name}` : `overlay:${key.id}:${key.name}`);
        if (r.ok && !r.skipped) await logChange(db, { by: key.user ? `discord:${key.user.id}:${key.user.name}` : `overlay:${key.id}:${key.name}`, seriesId: ev.league.id, sub: ev.subsessionId, kind: "overlay",
          summary: `Provisional results from the overlay: ${ev.track}${r.replaced ? " (updated)" : ""}` });
        return json(r, r.status || 200);
      }
      // a program signing in (race control: /api/rc/..., the overlay: /api/overlay/...): a code, Allow, a token
      if ((m = path.match(/^\/api\/(rc|overlay)\/link(\/poll)?$/)) && request.method === "POST") {
        const kind = m[1] === "rc" ? "rc" : "ov";
        let body = {};
        try { body = (await request.json()) || {}; } catch (e) { /* no body is fine */ }
        return json({ ok: true, ...(m[2] ? await linkPoll(env, body.poll || "", kind) : await linkStart(env, url, body.pc || "", kind)) });
      }
      if (path === `${BASE}/api/overlay/signout` && request.method === "POST") return json({ ok: await programSignOut(request, env, "ov") });
      if ((m = path.match(/^\/(rc|overlay)\/link$/))) {
        const kind = m[1] === "rc" ? "rc" : "ov", t = LINK_TEXT[kind];
        const code = String(url.searchParams.get("code") || "").toUpperCase();
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(`${PROGRAMS[kind].page}?code=${code}`)}`, 302);
        const l = await linkFind(env, code);
        if (!l || l.kind !== kind) return linkPage(kind, code, user, { msg: `That code has expired or was already used. Press Sign in in ${t.where} again.` });
        if (kind === "ov" && user.overlayBlock) return linkPage(kind, code, user, { msg: BLOCK_MSG });
        const allowed = kind === "ov" ? user.producer : (await listSeries(db)).some(x => canSteward(user, x));
        if (!allowed) return linkPage(kind, code, user, { msg: kind === "ov"
          ? "The overlay needs the Producer role in the league's Discord. Ask an admin."
          : "Race control needs the race control role, or the Series official role with a series assigned to you. Ask an admin." });
        if (request.method === "POST" && sameOrigin(request, url)) {
          const f = await request.formData();
          if (!await linkAllow(request, env, String(f.get("code") || ""), user)) return linkPage(kind, code, user, { msg: `That code has expired. Press Sign in in ${t.where} again.` });
          await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "key", summary: `${kind === "ov" ? "Broadcast overlay" : "Race control"} signed in on PC ${l.pc || "(unnamed)"}` });
          return linkPage(kind, code, user, { done: true });
        }
        return linkPage(kind, code, user);
      }
      if (path.startsWith(`${BASE}/api/rc/`)) {
        if (path === `${BASE}/api/rc/signout` && request.method === "POST") return json({ ok: await programSignOut(request, env, "rc") });
        const rcu = await raceControlUser(request, env);
        if (!rcu) return json({ ok: false, error: "Race control isn't signed in to the site (or the sign-in was turned off). Sign in again from race control." }, 401);
        const all = await listSeries(db), mine = all.filter(x => canSteward(rcu, x));
        if (path === `${BASE}/api/rc/check`) {
          if (!mine.length) return json({ ok: false, error: "You can't steward any series now: no race control role, and no series assigned to you with the Series official role. Ask an admin." }, 403);
          return json({ ok: true, user: { id: rcu.id, name: rcu.name }, series: rcu.steward ? "all" : mine.map(x => x.id) });
        }
        if ((m = path.match(/^\/api\/rc\/races\/(\d+)$/))) {
          const sub = Number(m[1]), by = `discord:${rcu.id}:${rcu.name}`;
          if (request.method === "PUT") {
            let file;
            try { file = await request.json(); } catch (e) { return json({ ok: false, error: "The race file isn't valid JSON." }, 400); }
            if (!file || file.type !== "vspeed_race_control") return json({ ok: false, error: "That isn't a race control file." }, 400);
            if (Number(file.subsessionId) !== sub) return json({ ok: false, error: "The race file is for another session." }, 400);
            const sr = all.find(x => x.id === Number(file.leagueId));
            if (!sr) return json({ ok: false, error: `iRacing league ${file.leagueId} isn't a GLR series on this site.` }, 404);
            if (!canSteward(rcu, sr)) return json({ ok: false, error: `You're not a steward for ${sr.short_name}.` }, 403);
            const ev0 = await db.prepare(`SELECT series_id FROM events WHERE subsession_id = ?`).bind(sub).first();
            if (ev0 && ev0.series_id !== sr.id) return json({ ok: false, error: "That session belongs to another series on the site." }, 400);
            let r;
            try { r = await saveRaceCalls(db, sub, file, by); } catch (e) { return json({ ok: false, error: e.message }, 400); }
            if (r.added.length || r.changed.length) {
              await logChange(db, { by, seriesId: sr.id, sub, kind: "decision", summary: `Race control: ${r.added.length} new call${r.added.length === 1 ? "" : "s"}${r.changed.length ? `, ${r.changed.length} changing the order` : ""}, ${String(file.track || "")}` });
              const ev = await getEvent(db, sub);
              if (ev && ev.status === "official") {           // the site's rule: Discord posts once the race is official
                for (const a of r.added) {
                  const d = ev.decisions.find(x => x.rc_uid === a.uid);
                  if (d && d.kind !== "none" && sr.hook_penalties) await enqueue(db, sr.id, "penalties", "decision", sub, decisionPost(sr, ev, { ...d, text: decisionText(d) }, url.origin));
                }
                if (r.changed.length) await updatePosted(db, sub, url.origin);
                kick();
              }
            }
            return json({ ok: true, decisions: await raceCalls(db, sub) });
          }
          // the race's series: from its results, or (before they're in) from the calls already sent
          const ev0 = await db.prepare(`SELECT series_id FROM events WHERE subsession_id = ? UNION ALL SELECT series_id FROM decisions WHERE subsession_id = ? LIMIT 1`).bind(sub, sub).first();
          if (ev0 && !canSteward(rcu, all.find(x => x.id === ev0.series_id))) return json({ ok: false, error: "You're not a steward for that series." }, 403);
          return json({ ok: true, subsessionId: sub, decisions: await raceCalls(db, sub) });
        }
        return json({ ok: false, error: "Unknown race control request." }, 404);
      }
      if (path === `${BASE}/keys`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/keys`, 302);
        if (!user.overlord) return notFound("Check the link.", user);        // overlord only: to anyone else it isn't there
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return keysPage(await listKeys(db), user, { msg: "Do this from this page." });
          const f = await request.formData();
          const who = `discord:${user.id}:${user.name}`;
          if (f.get("rc_revoke")) {
            const r = await revokeProgramSession(env, f.get("rc_revoke"));
            if (r) await logChange(db, { by: who, kind: "key", summary: `${r.kind === "ov" ? "Overlay" : "Race control"} signed out: ${r.name}` });
            return Response.redirect(`${url.origin}${BASE}/keys`, 303);
          }
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
            return keysPage(await listKeys(db), user, { newKey: k, newKind: kind, rc: await listProgramSessions(env, "rc"), ov: await listProgramSessions(env, "ov") });
          }
          catch (e) { return keysPage(await listKeys(db), user, { msg: e.message, rc: await listProgramSessions(env, "rc"), ov: await listProgramSessions(env, "ov") }); }
        }
        return keysPage(await listKeys(db), user, { rc: await listProgramSessions(env, "rc"), ov: await listProgramSessions(env, "ov") });
      }
      if (path === `${BASE}/api/me`) return json({ ok: true, user, signIn: configured(env) });
      if (path === `${BASE}/api/events`) return json({ ok: true, events: await listEvents(db, { season: Number(url.searchParams.get("season")) || 0 }) });
      if (path === `${BASE}/api/series`) return json({ ok: true, series: (await listSeries(db)).map(pub) });
      if ((m = path.match(/^\/api\/series\/([a-z0-9-]+)$/))) { const sr = await getSeries(db, m[1]); return sr ? json({ ok: true, series: pub(sr) }) : json({ ok: false, error: "No such series" }, 404); }
      if ((m = path.match(/^\/api\/results\/(\d+)$/))) { const ev = await getEvent(db, Number(m[1])); if (ev) ev.decisions = ev.decisions.map(({ made_by, adj_id, ...d }) => d); return ev ? json({ ok: true, event: ev }) : json({ ok: false, error: "No such race" }, 404); }
      if ((m = path.match(/^\/api\/drivers\/(\d+)$/))) { const d = await getDriver(db, Number(m[1])); return d ? json({ ok: true, driver: d }) : json({ ok: false, error: "No such driver" }, 404); }
      if (path === "/") {
        const next = new Map();
        for (const r of await upcoming(db, 120)) if (!next.has(r.series_id)) next.set(r.series_id, r);
        const all = await listSeries(db), off = new Set(all.filter(x => !shown(x, user)).map(x => x.id));
        return homePage(all.filter(x => !off.has(x.id)), (await listEvents(db, { limit: 15 + (off.size ? 40 : 0) })).filter(e => !off.has(e.series_id)).slice(0, 15), user, next);
      }
      if ((m = path.match(/^\/results\/(\d+)\/stewards$/))) {
        const sub = Number(m[1]);
        let ev = await getEvent(db, sub);
        if (!ev) return notFound("No race with that session number has been uploaded.", user);
        const sr = await seriesById(db, ev.series_id), steward = canSteward(user, sr);
        let msg = "";
        if (request.method === "POST") {
          if (!user || !sameOrigin(request, url)) return notFound("Sign in first.", user);
          const f = await request.formData(), a = f.get("action"), by = `discord:${user.id}:${user.name}`;
          const pid = Number(f.get("id")) || 0, p = pid ? await getProtest(db, pid) : null;
          try {
            if (a === "link") {
              const r = await linkDriver(db, user.id, user.name, Number(f.get("cust")));
              if (r.claim) {
                const dn = ev.sessions.race.find(x => x.cust_id === Number(f.get("cust")));
                await logChange(db, { by, kind: "account", summary: `${user.name} says they're ${dn ? dn.name : f.get("cust")}, who is linked to ${r.holder}: waiting for an admin` });
                throw new Error("That driver is already linked to another Discord account, so an admin will check it. You can file your protest once they've sorted it out.");
              }
              user = await currentUser(request, env);
              await logChange(db, { by, kind: "account", summary: `${user.name} linked to driver ${user.driverName}` });
              msg = `Linked: you're ${user.driverName}. Now fill in your protest.`;
            } else if (a === "protest") {
              if (!user.cust) throw new Error("First pick which driver you are (below).");
              const id = await fileProtest(db, { sub, filedBy: by, filer: user.cust, against: f.get("against"), lap: f.get("lap"), what: f.get("what"), video: f.get("video") });
              const vs = ev.sessions.race.find(r => r.cust_id === Number(f.get("against")));
              await logChange(db, { by, seriesId: ev.series_id, sub, kind: "protest", summary: `Protest ${id} filed: ${ev.track}${vs ? `, against ${vs.name}` : ""}` });
              msg = `Protest filed (number ${id}). The stewards will review it; check back here for their decision.`;
            } else if (a === "withdraw" && p && p.subsession_id === sub && p.filer_cust === user.cust && p.status === "open") {
              await setProtestStatus(db, pid, "withdrawn", by);
              await logChange(db, { by, seriesId: ev.series_id, sub, kind: "protest", summary: `Protest ${pid} withdrawn: ${ev.track}` });
              msg = "Withdrawn.";
            } else if (!steward) {
              return notFound("Only stewards can do that.", user);
            } else if (a === "decide") {
              const forP = Number(f.get("protest")) ? await getProtest(db, Number(f.get("protest"))) : null;
              if (involvedIn(user, forP)) throw new Error(OWN_PROTEST);
              if (user.cust && Number(f.get("cust")) === user.cust) throw new Error(OWN_CAR);
              const r = await addDecision(db, { sub, protestId: Number(f.get("protest")) || null, cust: Number(f.get("cust")), kind: String(f.get("kind")), amount: f.get("amount"), reason: f.get("reason") }, by);
              ev = await getEvent(db, sub);
              const d = ev.decisions.find(x => x.id === r.id);
              await logChange(db, { by, seriesId: ev.series_id, sub, kind: "decision", summary: `Stewards: ${d.name}: ${r.text} (${d.reason})${d.protest_id ? `, protest ${d.protest_id}` : ""}` });
              if (ev.status === "official" && d.kind !== "none") {
                if (sr.hook_penalties) await enqueue(db, sr.id, "penalties", "decision", sub, decisionPost(sr, ev, { ...d, text: r.text }, url.origin));
                if (CHANGES_ORDER(d.kind)) await updatePosted(db, sub, url.origin);
                kick();
              }
              msg = `Decision saved: ${d.name}: ${r.text}.`;
            } else if (a === "edit") {
              const was = ev.decisions.find(x => x.id === Number(f.get("id")));
              if (!was) throw new Error("That decision isn't on this race any more.");
              if (user.cust && was.cust_id === user.cust) throw new Error(OWN_CAR);
              if (was.protest_id && involvedIn(user, await getProtest(db, was.protest_id))) throw new Error(OWN_PROTEST);
              const r = await editDecision(db, sub, was.id, { kind: String(f.get("kind")), amount: f.get("amount"), reason: f.get("reason") }, by);
              await logChange(db, { by, seriesId: ev.series_id, sub, kind: "decision", summary: `Stewards changed a decision: ${was.name}: ${r.before.text} (${r.before.reason}) → ${r.after.text} (${r.after.reason})${was.source === "race control" ? ", a race control call" : ""}` });
              ev = await getEvent(db, sub);
              if (ev.status === "official" && (CHANGES_ORDER(r.before.kind) || CHANGES_ORDER(r.after.kind))) { await updatePosted(db, sub, url.origin); kick(); }
              msg = `Decision saved: ${was.name}: now ${r.after.text}.`;
            } else if (a === "undo") {
              const was = ev.decisions.find(x => x.id === Number(f.get("id")));
              if (was && user.cust && was.cust_id === user.cust) throw new Error(OWN_CAR);
              if (was && was.protest_id && involvedIn(user, await getProtest(db, was.protest_id))) throw new Error(OWN_PROTEST);
              const d = await deleteDecision(db, sub, Number(f.get("id")), by, "Withdrawn on the site");
              if (d) {
                await logChange(db, { by, seriesId: ev.series_id, sub, kind: "decision", summary: `Stewards ${d.withdrawn ? "withdrew a race control call" : "took back a decision"}: ${decisionText(d)} (${d.reason})` });
                ev = await getEvent(db, sub);
                if (ev.status === "official" && CHANGES_ORDER(d.kind)) { await updatePosted(db, sub, url.origin); kick(); }
              }
              msg = d && d.withdrawn ? "Withdrawn." : "Removed.";
            } else if (a === "report") {
              if (!canEdit(user, sr)) throw new Error("Only the series' directors and admins can send the penalty report.");
              if (!sr.hook_penalties) throw new Error("Add a Penalties webhook on Edit series first.");
              const items = await penaltyItems(db, ev);
              if (!items.length) throw new Error("No penalties to send for this race.");
              await enqueue(db, sr.id, "penalties", "report", sub, penaltyReportPost(sr, ev, items, url.origin));
              const out = await processQueue(db);
              await logChange(db, { by, seriesId: sr.id, sub, kind: "webhook", summary: `Penalty report for ${ev.track} posted to Discord by hand (${items.length})` });
              msg = out.includes("sent") ? `Sent: the penalty report (${items.length} penalt${items.length === 1 ? "y" : "ies"}). Check the channel.` : "It didn't go through; see Waiting to post on Edit series.";
            } else if ((a === "close" || a === "reopen") && p && p.subsession_id === sub) {
              if (involvedIn(user, p)) throw new Error(OWN_PROTEST);
              await setProtestStatus(db, pid, a === "close" ? "withdrawn" : "open", by);
              await logChange(db, { by, seriesId: ev.series_id, sub, kind: "protest", summary: `Protest ${pid} ${a === "close" ? "closed without a decision" : "reopened"}: ${ev.track}` });
              msg = a === "close" ? "Closed." : "Reopened.";
            }
          } catch (e) { msg = e.message; }
          ev = await getEvent(db, sub);
        }
        return stewardsPage(ev, user, { protests: await listProtests(db, { sub }), steward, msg, report: canEdit(user, sr) ? { hook: !!sr.hook_penalties, slug: sr.slug } : null });
      }
      if (path === `${BASE}/downloads`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/downloads`, 302);
        if (!user.producer && !usesRaceControl(user)) return notFound("Downloads are for producers and race control.", user);
        return downloadsPage(user, await latestRelease(db));
      }
      if (path === `${BASE}/me/driver`) {
        // which driver are you? Asked once after signing in; open any time from My races or Protests ("Not you?")
        const back0 = url.searchParams.get("back") || "/";
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(`${BASE}/me/driver?back=${encodeURIComponent(back0)}`)}`, 302);
        let msg = "", back = back0;
        if (request.method === "POST" && sameOrigin(request, url)) {
          const f = await request.formData(), cust = Number(f.get("cust")) || 0, by = `discord:${user.id}:${user.name}`;
          back = String(f.get("back") || "/");
          try {
            const r = await linkDriver(db, user.id, user.name, cust);
            const dn = cust ? (await getDriver(db, cust) || {}).name || String(cust) : "";
            if (r.claim) {
              await logChange(db, { by, kind: "account", summary: `${user.name} says they're ${dn}, who is linked to ${r.holder}: waiting for an admin` });
            } else {
              await logChange(db, { by, kind: "account", summary: cust ? `${user.name} linked to driver ${dn}` : `${user.name} said they don't race` });
              return Response.redirect(`${url.origin}${/^\/(?!\/)/.test(back) ? back : "/"}`, 303);
            }
          } catch (e) { msg = e.message; }
        }
        const claims = await listClaims(db, { discordId: user.id });
        const q = url.searchParams.has("q") ? url.searchParams.get("q") : (user.cust || user.noDriver || claims.length ? "" : normName(user.name));
        let found = q ? await searchDrivers(db, q) : [];
        if (!found.length && q && /^\d+$/.test(q.trim())) { const d = await getDriver(db, Number(q)); if (d) found = [{ cust_id: d.cust_id, name: d.name, also: "", taken: !!await linkedAccount(db, d.cust_id) }]; }
        return whichDriverPage(user, { q, found, back: /^\/(?!\/)/.test(back) ? back : "/", first: url.searchParams.has("first"), claims, msg });
      }
      if (path === `${BASE}/me`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/me`, 302);
        const d = user.cust ? await getDriver(db, user.cust) : null;
        if (!d) return Response.redirect(`${url.origin}${BASE}/me/driver?back=${BASE}/me`, 302);
        return myRacesPage(user, d, { protests: await listProtests(db, { involving: user.cust, limit: 50 }), decisions: await decisionsFor(db, user.cust) });
      }
      if (path === `${BASE}/accounts`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/accounts`, 302);
        if (!user.admin) return notFound("Only admins can see accounts.", user);
        let msg = "";
        if (request.method === "POST" && sameOrigin(request, url)) {
          const f = await request.formData(), a = f.get("action"), by = `discord:${user.id}:${user.name}`;
          const nameOf = async id => ((await listAccounts(db)).find(x => x.discord_id === id) || {}).name || id;
          try {
            if (a === "approve" || a === "reject") {
              const c = await decideClaim(db, Number(f.get("claim")), a === "approve", by);
              if (c) {
                await logChange(db, { by, kind: "account", summary: a === "approve" ? `Admin gave driver ${c.driver} to ${c.discord_name}${c.moved_from ? ` (was linked to ${c.moved_from})` : ""}` : `Admin turned down ${c.discord_name}'s claim to be ${c.driver}` });
                msg = a === "approve" ? `Approved: ${c.discord_name} is now ${c.driver}.` : `Rejected: ${c.discord_name} isn't linked to ${c.driver}.`;
              }
            } else if (a === "direct" || a === "undirect") {
              const id = String(f.get("id")), nm = await nameOf(id), sr = await seriesById(db, Number(f.get("series")));
              if (!sr) throw new Error("Pick a series.");
              await setDirector(db, id, sr.id, a === "direct", by);
              await logChange(db, { by, seriesId: sr.id, kind: "account", summary: a === "direct" ? `Admin made ${nm} a director of ${sr.short_name}` : `Admin removed ${nm} as a director of ${sr.short_name}` });
              msg = a === "direct" ? `Set: ${nm} directs ${sr.short_name}.` : `Set: ${nm} no longer directs ${sr.short_name}.`;
            } else if (a === "recheck") {
              const id = String(f.get("id")), nm = await nameOf(id), r = await recheckRoles(env, request, id), so = await getSetting(db, "official_role");
              msg = r.status === "ok" ? (r.roles.includes(so) ? `Set: Discord says ${nm} has the Series official role now.` : `${nm} doesn't have the Series official role in Discord right now. Check the role in Discord, and the role ID on Site settings.`)
                : r.status === "none" ? `${nm} isn't signed in to the site right now, so it can't ask Discord about them. It checks when they next sign in.`
                : r.status === "left" ? `${nm} isn't in the league's Discord server any more.`
                : r.status === "revoked" ? `${nm} disconnected GLR HUB in Discord. They need to sign in again.`
                : "Discord didn't answer. Try again in a minute.";
            } else if (a === "block" || a === "unblock") {
              if (!user.overlord) throw new Error("You can't change that.");
              const id = String(f.get("id")), nm = await nameOf(id);
              if (id === user.id) throw new Error("You can't block yourself.");
              await setBlock(db, id, a === "block", by);
              await logChange(db, { by, kind: "account", summary: a === "block" ? `Admin blocked ${nm} from the broadcast overlay` : `Admin unblocked ${nm}: overlay access follows their Discord roles again` });
              msg = a === "block" ? `Set: ${nm} is blocked from the overlay.` : `Set: ${nm} is unblocked.`;
            } else if (a === "unlink") {
              const id = String(f.get("id")), nm = await nameOf(id);
              await unlinkDriver(db, id);
              await logChange(db, { by, kind: "account", summary: `Admin unlinked ${nm} from their driver` });
              msg = `Unlinked ${nm}. They're asked which driver they are at their next sign-in.`;
            } else if (a === "set") {
              const id = String(f.get("id")), txt = String(f.get("driver") || "").trim(), nm = await nameOf(id);
              let cust = null;
              if (/^i don.?t race$/i.test(txt)) cust = 0;
              else if (/\((\d+)\)\s*$/.test(txt) || /^\d+$/.test(txt)) cust = Number((txt.match(/(\d+)\)?\s*$/) || [])[1]);
              else { const hit = await searchDrivers(db, txt, 2); if (hit.length === 1 || (hit.length && hit[0].score === 0)) cust = hit[0].cust_id; }
              if (cust === null) throw new Error(`Couldn't tell which driver "${txt}" is. Pick one from the list, or type their iRacing ID.`);
              const was = await setLink(db, id, cust);
              const dn = cust ? (await getDriver(db, cust) || {}).name || cust : "";
              await logChange(db, { by, kind: "account", summary: cust ? `Admin linked ${nm} to driver ${dn}${was ? ` (was linked to ${was})` : ""}` : `Admin set ${nm} as not a driver` });
              msg = cust ? `Set: ${nm} is ${dn}.${was ? ` ${was} was unlinked.` : ""}` : `Set: ${nm} doesn't race.`;
            }
          } catch (e) { msg = e.message; }
        }
        return accountsPage(user, { accounts: await listAccounts(db), claims: await listClaims(db), all: await findDrivers(db), msg,
          series: await listSeries(db), directors: await listDirectors(db), roles: await accountRoles(db), officialRole: await getSetting(db, "official_role"), blocks: await listBlocks(db) });
      }
      if (path === `${BASE}/protests`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/protests`, 302);
        const msg = "";
        const all = await listSeries(db), mineSeries = user.steward ? null : all.filter(x => canSteward(user, x)).map(x => x.id);
        const steward = user.steward || (mineSeries && mineSeries.length > 0);
        const list = steward ? await listProtests(db, { seriesIds: mineSeries, limit: 80 }) : [];
        return protestsPage(user, { steward, msg, open: list.filter(p => p.status === "open"), recent: list.filter(p => p.status !== "open").slice(0, 30),
          mine: user.cust ? await listProtests(db, { filer: user.cust, limit: 50 }) : [] });
      }
      if ((m = path.match(/^\/results\/(\d+)$/))) {
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
          if (f.get("action") === "season") {
            try {
              const name = await setEventSeason(db, sub, Number(f.get("season")));
              await logChange(db, { by: who, seriesId: ev.series_id, sub, kind: "series", summary: `Race added to ${name}: ${ev.track}, ${day(ev.start_time)} (run outside the season in iRacing)` });
              msg = `Added to ${name}. It counts in the standings now.`;
            } catch (e) { msg = e.message; }
            ev = await getEvent(db, sub);
            return resultPage(ev, user, { fixes: await listFixes(db, sub), edit, msg, score: await raceScore(db, ev), seasons: edit && ev.series_id && !ev.season_id ? await seasonsOf(db, ev.series_id) : [] });
          }
          if (f.get("action") === "official") {
            if (await markOfficial(db, sub, who)) {
              await logChange(db, { by: who, seriesId: ev.series_id, sub, kind: "official", summary: `Results marked official: ${ev.track}` });
              const n = await postOfficial(db, sub, url.origin);
              msg = "Marked official." + (n ? " Posting to Discord." : "");
              kick();
            }
            ev = await getEvent(db, sub);
            return resultPage(ev, user, { fixes: await listFixes(db, sub), edit, msg, score: await raceScore(db, ev), seasons: edit && ev.series_id && !ev.season_id ? await seasonsOf(db, ev.series_id) : [] });
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
        return resultPage(ev, user, { fixes: await listFixes(db, sub), edit, msg, score: await raceScore(db, ev), seasons: edit && ev.series_id && !ev.season_id ? await seasonsOf(db, ev.series_id) : [] });
      }
      if ((m = path.match(/^\/logo\/(\d+)$/))) {
        const a = await getLogo(db, Number(m[1]));
        if (!a) return new Response("Not found", { status: 404 });
        return new Response(Uint8Array.from(atob(a.data), c => c.charCodeAt(0)), { headers: { "content-type": a.mime, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
      }
      // Add series (admins): a series by its iRacing league ID, before its first race
      if (path === `${BASE}/series/add`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/series/add`, 302);
        if (!user.admin) return notFound("Only admins can add a series.", user);
        let err = "", v = {};
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return notFound("Add the series from this page.", user);
          const f = await request.formData();
          v = { id: f.get("id"), shortName: f.get("short_name"), slug: f.get("slug"), name: f.get("name") };
          try {
            const r = await addSeries(db, v);
            await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: r.id, kind: "series", summary: `Series added: ${r.shortName} (/${r.slug}), iRacing league ${r.id}` });
            return Response.redirect(`${url.origin}${BASE}/${r.slug}/edit`, 303);
          } catch (e) { err = e.message; }
        }
        return addSeriesPage(user, err, v);
      }
      if ((m = path.match(/^\/theme\/([\w.-]+)$/))) {
        const a = ASSETS[m[1]];
        if (!a) return new Response("Not found", { status: 404 });
        return new Response(Uint8Array.from(atob(a.data), c => c.charCodeAt(0)), { headers: { "content-type": a.type, "cache-control": "public, max-age=86400" } });
      }
      if (path === `${BASE}/settings`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/settings`, 302);
        if (!user.overlord) return notFound("Check the link.", user);        // overlord only
        let msg = "";
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return notFound("Save from this page.", user);
          const f = await request.formData(), theme = String(f.get("theme") || ""), short = String(f.get("short") || "").trim().slice(0, 20);
          const rc = String(f.get("steward_role") || "").trim(), pr = String(f.get("producer_role") || "").trim(), so = String(f.get("official_role") || "").trim();
          if (!THEMES[theme]) msg = "Pick a theme.";
          else if (rc && !/^\d{5,25}$/.test(rc)) msg = "The race control role should be a Discord role ID (numbers only), or empty.";
          else if (pr && !/^\d{5,25}$/.test(pr)) msg = "The producer role should be a Discord role ID (numbers only), or empty.";
          else if (so && !/^\d{5,25}$/.test(so)) msg = "The series official role should be a Discord role ID (numbers only), or empty.";
          else {
            await setSetting(db, "theme", theme); await setSetting(db, "league_short", short || "GLR");
            if (rc !== await getSetting(db, "steward_role")) {
              await setSetting(db, "steward_role", rc);
              await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "series", summary: rc ? `Race control role set to ${rc}` : "Race control role removed" });
            }
            if (pr !== (await getSetting(db, "producer_role") || "")) {
              await setSetting(db, "producer_role", pr);
              await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "series", summary: pr ? `Producer role set to ${pr}` : "Producer role removed" });
            }
            if (so !== (await getSetting(db, "official_role") || "")) {
              await setSetting(db, "official_role", so);
              await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "series", summary: so ? `Series official role set to ${so}: directors are now assigned on the Accounts page` : "Series official role removed: each series' own role is used again" });
            }
            const helpOff = f.get("help_on") ? "" : "1";
            if (helpOff !== (await getSetting(db, "help_off") || "")) {
              await setSetting(db, "help_off", helpOff);
              await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "series", summary: helpOff ? "Help chat turned off" : "Help chat turned on" });
            }
            themeCache = null;
            await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "series", summary: `Site theme set to ${THEMES[theme].label}${short ? `, short name ${short}` : ""}` });
            msg = "Saved.";
          }
        }
        const cur = await siteTheme(db, new URL(url.origin + BASE));
        return settingsPage(cur.theme, cur.short, user, msg, await getSetting(db, "steward_role"), await getSetting(db, "producer_role"), await getSetting(db, "official_role"),
          { on: await getSetting(db, "help_off") !== "1", key: !!env.ANTHROPIC_API_KEY });
      }
      if (path === `${BASE}/history`) {
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${BASE}/history`, 302);
        if (!user.official) return notFound("History is for series officials.", user);
        // the overlord sees everything; admins see every series' changes (not accounts, settings or keys); directors their series
        const every = await listSeries(db), mine = user.overlord ? null : user.admin ? every.map(x => x.id) : user.directs;
        const choices = every.filter(x => !mine || mine.includes(x.id));
        const only = url.searchParams.get("series") ? choices.find(x => x.slug === url.searchParams.get("series")) || null : null;   // one series (the Director tab's link)
        return historyPage(await listChanges(db, { seriesIds: only ? [only.id] : mine }), user, only, choices);
      }
      if ((m = path.match(/^\/drivers\/(\d+)\/info$/))) {
        const d = await getDriver(db, Number(m[1]));
        if (!d) return notFound("No such driver.", user);
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(path)}`, 302);
        if (!canEditDriver(user, d)) return notFound("Only the driver (signed in and linked to this driver), an admin or their series' director can change this.", user);
        let msg = "";
        if (request.method === "POST" && sameOrigin(request, url)) {
          const f = await request.formData();
          const changed = await saveProfile(db, d.cust_id, Object.fromEntries(Object.keys(PROFILE_FIELDS).map(k => [k, f.get(k)])), `discord:${user.id}:${user.name}`);
          if (changed.length) await logChange(db, { by: `discord:${user.id}:${user.name}`, kind: "driver", summary: `${user.cust === d.cust_id ? `${d.name} updated their` : `${user.name} updated ${d.name}'s`} driver info (${changed.join(", ")})` });
          msg = changed.length ? "Saved. It's on the driver page now." : "Saved. Nothing had changed.";
          d.profile = (await getDriver(db, d.cust_id)).profile;
        }
        return profilePage(d, user, msg);
      }
      if ((m = path.match(/^\/drivers\/(\d+)$/))) {
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
        const discord = user && user.official ? await linkedAccount(db, cust) : null;
        return driverPage(d, user, user && user.admin ? { aliases: await aliasesOf(db, cust), all: await findDrivers(db), msg, discord } : { discord });
      }
      if ((m = path.match(/^\/api\/standings\/([a-z0-9-]+)$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return json({ ok: false, error: "No such series" }, 404);
        const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url);
        if (!season) return json({ ok: true, series: sr.short_name, season: null, groups: [] });
        const st = await seasonStandings(db, sr, season);
        return json({ ok: true, series: sr.short_name, season: { id: season.id, name: season.name }, rules: st.rules, groups: st.groups, adjustments: st.adj });
      }
      if (path === `${BASE}/schedule`) { const off = new Set((await listSeries(db)).filter(x => !shown(x, user)).map(x => x.id));
        return leagueSchedulePage((await upcoming(db)).filter(r => !off.has(r.series_id)), user); }
      if (path === `${BASE}/api/schedule`) return json({ ok: true, races: (await upcoming(db)).filter(r => !hiddenIds.has(r.series_id)).map(r => ({ series: r.short_name, slug: r.slug, startsAt: r.starts_at, track: r.track, notes: r.notes })) });
      if ((m = path.match(/^\/(?:api\/series\/)?([a-z0-9-]+)\/schedule$/))) {
        const sr = await getSeries(db, m[1]), api = path.startsWith(`${BASE}/api/`);
        if (!sr) return api ? json({ ok: false, error: "No such series" }, 404) : notFound("No series at that address.", user);
        let msg = "";
        if (request.method === "POST" && !api) {
          if (!canEdit(user, sr) || !sameOrigin(request, url)) return notFound("You can't change this series.", user);
          const f = await request.formData(), who = `discord:${user.id}:${user.name}`;
          try {
            if (f.get("edit")) {
              const r = await editSchedule(db, sr.id, Number(f.get("edit")), { date: f.get("date"), time: f.get("time"), track: f.get("track"), layout: f.get("layout"), length: f.get("length"), notes: f.get("notes") });
              await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `Schedule line changed: ${r.track}, ${day(r.at)}` });
              msg = `Saved ${r.track}.`;
            } else if (f.get("remove")) {
              const r = await deleteSchedule(db, sr.id, Number(f.get("remove")));
              if (r) await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `Removed from the schedule: ${r.track}, ${day(r.starts_at)}` });
              msg = "Removed.";
            } else if (f.has("bulk")) {
              const n = await addScheduleLines(db, sr.id, f.get("bulk"), who);
              await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `${n} race${n === 1 ? "" : "s"} added to the schedule` });
              msg = `Added ${n} race${n === 1 ? "" : "s"}.`;
            } else {
              const r = await addSchedule(db, sr.id, { date: f.get("date"), time: f.get("time"), track: f.get("track"), layout: f.get("layout"), length: f.get("length"), notes: f.get("notes") }, who);
              await logChange(db, { by: who, seriesId: sr.id, kind: "schedule", summary: `Added to the schedule: ${r.track}, ${day(r.at)}` });
              msg = `Added ${r.track}.`;
            }
          } catch (e) { msg = e.message; }
        }
        const rows = await listSchedule(db, sr.id);
        if (api) return json({ ok: true, series: sr.short_name, races: rows.map(r => ({ startsAt: r.starts_at, track: r.track, layout: r.layout, length: r.length, notes: r.notes, subsessionId: r.subsession_id || null })) });
        const w = new Map((await listEvents(db, { series: sr.id })).map(e => [e.subsession_id, e.winners]));
        return schedulePage(sr, rows, w, user, msg);
      }
      if ((m = path.match(/^\/([a-z0-9-]+)\/widget\/(standings|teams|schedule|results)$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return new Response("No such series", { status: 404 });
        const rows = Math.max(1, Math.min(60, Number(url.searchParams.get("rows")) || 10));
        const opts = { bg: url.searchParams.get("bg") === "page" ? "page" : "transparent", refresh: Math.max(0, Math.min(3600, Number(url.searchParams.get("refresh")) || 0)) };
        if (opts.refresh && opts.refresh < 30) opts.refresh = 30;
        if (m[2] === "standings") {
          const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url);
          return widgetPage(`${sr.short_name} standings`, standingsWidget(sr, season, season && await seasonStandings(db, sr, season), rows, url.searchParams.get("class") || ""), opts);
        }
        if (m[2] === "teams") {
          if (!sr.teams) return new Response("This series doesn't have team points", { status: 404 });
          const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url), teams = season ? await getTeams(db, sr.id, season.id) : [];
          return widgetPage(`${sr.short_name} team standings`, teamsWidget(sr, season, teams.length ? teamStandings(teams, await seasonStandings(db, sr, season)) : null, rows), opts);
        }
        if (m[2] === "schedule") return widgetPage(`${sr.short_name} schedule`, scheduleWidget(sr, await listSchedule(db, sr.id), rows), opts);
        const last = (await listEvents(db, { series: sr.id, limit: 1 }))[0];
        return widgetPage(`${sr.short_name} results`, resultsWidget(sr, last && await getEvent(db, last.subsession_id), rows), opts);
      }
      if ((m = path.match(/^\/([a-z0-9-]+)\/director$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No such series.", user);
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(path)}`, 302);
        if (!canEdit(user, sr)) return notFound("This page is for the series' directors.", user);
        return directorPage(sr, await seasonsOf(db, sr.id), user, {
          provisional: (await listEvents(db, { series: sr.id })).filter(e => e.status !== "official"),
          protests: await listProtests(db, { seriesIds: [sr.id], open: true }),
          queue: await queueFor(db, sr.id),
          changes: await listChanges(db, { seriesIds: [sr.id], limit: 10 }),
          missed: await missedResults(db, sr.id),
          signup: await (async () => { const round = await currentRound(db, sr.id); if (!round) return null;
            return { round, waiting: (await listSignups(db, round.id)).filter(x => x.status === "pending").length, flags: await raceFlags(db, round) }; })(),
        });
      }
      if ((m = path.match(/^\/([a-z0-9-]+)\/embed$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No series at that address.", user);
        const classes = [...new Set((await seriesEvents(db, sr.id)).slice(-3).flatMap(e => e.results.map(r => r.car_class || "")))].filter(Boolean);
        return embedPage(sr, user, classes);
      }
      if (path === `${BASE}/drivers`) return leagueDriversPage(await leagueDrivers(db, user), user);
      if (path === `${BASE}/api/drivers`) return json({ ok: true, drivers: await leagueDrivers(db, null) });
      // GET /api/series/<series>/points: the season's points rules, for the overlay's live points (Nov 2026).
      // source "iracing" means iRacing's league points: the site has no table to give, so the overlay keeps its own.
      if ((m = path.match(/^\/api\/series\/([a-z0-9-]+)\/points$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return json({ ok: false, error: "No such series" }, 404);
        const season = pickSeason(await seasonsOf(db, sr.id), url);
        const rules = cleanRules((season && (await getRules(db, season.id, sr.id)).rules) || DEFAULT_RULES);
        return json({ ok: true, series: sr.short_name, season: season && { id: season.id, name: season.name },
          source: rules.points.source, table: rules.points.table, others: rules.points.others, zeroLaps: rules.points.zeroLaps, bonus: rules.bonus });
      }
      if ((m = path.match(/^\/(?:api\/series\/)?([a-z0-9-]+)\/(stats|drivers)$/))) {
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
        const round = await currentRound(db, sr.id);
        return seriesDriversPage(sr, rows, roster, user, msg, round ? { round, list: activeOf(await listSignups(db, round.id)) } : null);
      }
      if ((m = path.match(/^\/([a-z0-9-]+)\/(standings|rules|penalties|teams)$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No series at that address.", user);
        const seasons = await seasonsOf(db, sr.id), season = pickSeason(seasons, url);
        const back = () => Response.redirect(`${url.origin}${path}${seasons.length > 1 ? `?season=${season.id}` : ""}`, 303);
        if (request.method === "POST" && (!season || !canEdit(user, sr) || !sameOrigin(request, url))) return notFound("You can't change this series.", user);
        if (m[2] === "standings") return standingsPage(sr, seasons, season, season && await seasonStandings(db, sr, season), user);
        if (m[2] === "teams") {
          if (!sr.teams) return notFound("This series doesn't have team points.", user);
          if (!season) return teamsPage(sr, seasons, null, user);
          if (url.searchParams.has("csv")) return new Response(teamsCsv(await getTeams(db, sr.id, season.id)), { headers: {
            "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${sr.slug}-teams.csv"`, "cache-control": "no-store" } });
          let problems = [], msg = "";
          if (request.method === "POST") {
            const f = await request.formData(), file = f.get("file");
            let r = null;
            if (f.get("action") === "clear") r = { teams: [], problems: [] };
            else if (!file || typeof file === "string" || !file.size) msg = "Pick a CSV file to upload.";
            else if (file.size > 200000) msg = "That file is too big to be a team list.";
            else r = parseTeams(await file.text(), await driversForMatching(db, sr.id));
            if (r) {
              problems = r.problems;
              if (!problems.length) {
                await saveTeams(db, sr.id, season.id, r.teams);
                const n = r.teams.reduce((a, t) => a + t.custs.length, 0);
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "series", summary: r.teams.length ? `Teams for ${season.name} saved: ${r.teams.length} teams, ${n} drivers` : `Teams for ${season.name} removed` });
                msg = r.teams.length ? `Saved: ${r.teams.length} teams, ${n} drivers.` : "Saved: this season has no teams now.";
              }
            }
          }
          const teams = await getTeams(db, sr.id, season.id);
          const ts = teams.length ? teamStandings(teams, (await seasonStandings(db, sr, season))) : null;
          return teamsPage(sr, seasons, season, user, { teams, ts, problems, msg });
        }
        if (m[2] === "rules") {
          const info = season ? await getRules(db, season.id, sr.id) : {};
          const events = season ? await seasonEvents(db, season.id) : [];
          let rules = cleanRules(info.rules || DEFAULT_RULES);
          if (request.method === "POST") {
            const f = await request.formData(), by = `discord:${user.id}:${user.name}`, a = f.get("action");
            if (a === "out_add" || a === "out_remove") {
              const cust = Number(f.get("cust")), reason = String(f.get("reason") || "").trim().slice(0, 120);
              const name = (events.flatMap(e => e.results).find(r => r.cust_id === cust) || {}).name || String(cust);
              let note;
              if (a === "out_add") {
                if (!cust || !reason) return rulesPage(sr, seasons, season, info, rules, events, user, "Pick the driver and say why.");
                rules = cleanRules({ ...rules, playoffs: { ...rules.playoffs, out: [...rules.playoffs.out.filter(o => o.cust !== cust), { cust, reason }] } });
                note = `Taken out of the playoffs: ${name} (${reason})`;
              } else {
                rules = cleanRules({ ...rules, playoffs: { ...rules.playoffs, out: rules.playoffs.out.filter(o => o.cust !== cust) } });
                note = `Put back in the playoff picture: ${name}`;
              }
              await saveRules(db, season.id, rules, by);
              await logChange(db, { by, seriesId: sr.id, kind: "rules", summary: `${note}, ${season.name}` });
              return rulesPage(sr, seasons, season, { rules, own: true, updatedAt: new Date().toISOString() }, rules, events, user, note + ".");
            }
            const keepOut = rules.playoffs.out;               // the form doesn't carry the not-in-the-playoffs list: keep it
            rules = rulesFromForm(f, events);
            rules.playoffs.out = keepOut;
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
      if ((m = path.match(/^\/([a-z0-9-]+)\/edit$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No series at that address.", user);
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(path)}`, 302);
        if (!canEdit(user, sr)) return notFound("You can't change this series.", user);
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return seriesEditPage(sr, user, "Save from this page.");
          const f = await request.formData(), act = f.get("action");
          if (act === "logo") {
            let err = "";
            try {
              if (f.get("remove")) { await setLogo(db, sr.id, "", ""); await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "series", summary: "Logo removed" }); }
              else {
                const file = f.get("file"), bytes = file && typeof file.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0);
                const mime = logoType(bytes);
                if (!bytes.length) throw new Error("Choose an image file first.");
                if (!mime) throw new Error("That isn't a PNG, JPG or WebP image.");
                if (bytes.length > 500 * 1024) throw new Error(`That image is ${Math.round(bytes.length / 1024)} KB. Use one under 500 KB.`);
                let b = ""; for (let i = 0; i < bytes.length; i += 8192) b += String.fromCharCode(...bytes.subarray(i, i + 8192));
                await setLogo(db, sr.id, mime, btoa(b));
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "series", summary: "Logo uploaded" });
              }
            } catch (e) { err = e.message; }
            return seriesEditPage(await getSeries(db, sr.slug), user, err, await queueFor(db, sr.id), "", await dirOpts(db, sr.id));
          }
          if (act === "hook" || act === "retry" || act === "discard") {
            let note = "";
            try {
              const kind = String(f.get("kind") || "");
              if (act === "retry") { await retryQueued(db, sr.id, Number(f.get("id"))); await processQueue(db); }
              else if (act === "discard") await discardQueued(db, sr.id, Number(f.get("id")));
              else if (f.get("clear")) { await setHook(db, sr.id, kind, ""); note = "Removed.";
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "webhook", summary: `Discord ${kind} posts switched off` }); }
              else if (f.get("latest")) {
                const ev = await postLatest(db, sr, kind, url.origin);
                const out = await processQueue(db);
                const what = kind === "teams" ? "Team standings" : kind[0].toUpperCase() + kind.slice(1);
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, sub: ev.subsession_id, kind: "webhook", summary: `${what} for ${ev.track} posted to Discord by hand` });
                note = out.includes("sent") ? `Sent: ${what.toLowerCase()} for ${ev.track}, ${day(ev.start_time)}. Check the channel.` : "It didn't go through; see Waiting to post below.";
              }
              else if (f.get("test")) {
                await enqueue(db, sr.id, kind, "test", null, { embeds: [{ title: `${sr.short_name}: test post`, color: 0xFF0D40,
                  description: `This channel will get the ${sr.short_name} ${kind === "teams" ? "team standings" : kind} posts from GLR HUB.`, url: `${url.origin}${BASE}/${sr.slug}` }] });
                const out = await processQueue(db);
                note = out.includes("sent") ? "Test sent. Check the channel." : "The test didn't go through; see Waiting to post below.";
              } else {
                const u = String(f.get("url") || "").trim();
                if (!u) throw new Error("Paste the webhook link first.");
                await setHook(db, sr.id, kind, u); note = "Saved. Press Send test to check it.";
                await logChange(db, { by: `discord:${user.id}:${user.name}`, seriesId: sr.id, kind: "webhook", summary: `Discord ${kind} webhook ${sr[`hook_${kind}`] ? "replaced" : "set"}` });
              }
            } catch (e) { note = e.message; }
            return seriesEditPage(await getSeries(db, sr.slug), user, "", await queueFor(db, sr.id), note, await dirOpts(db, sr.id));
          }
          try {
            const who = `discord:${user.id}:${user.name}`;
            if (user.admin && f.has("teams_form") && f.has("hidden") !== !!sr.hidden) {
              await setSeriesHidden(db, sr.id, f.has("hidden"));
              await logChange(db, { by: who, seriesId: sr.id, kind: "series", summary: f.has("hidden") ? "Hidden from the Series List" : "Shown on the Series List again" });
            }
            if (user.admin && f.has("teams_form") && f.has("teams") !== !!sr.teams) {
              await setSeriesTeams(db, sr.id, f.has("teams"));
              await logChange(db, { by: who, seriesId: sr.id, kind: "series", summary: f.has("teams") ? "Team points turned on (Teams tab)" : "Team points turned off" });
            }
            const r = await updateSeries(db, sr.id, { shortName: f.get("short_name"), slug: f.get("slug") });
            if (r.shortName !== sr.short_name || r.slug !== sr.slug)
              await logChange(db, { by: who, seriesId: sr.id, kind: "series", summary: `Name or address changed: ${sr.short_name} (/${sr.slug}) → ${r.shortName} (/${r.slug})` });
            return Response.redirect(`${url.origin}${BASE}/${r.slug}`, 303); }
          catch (e) { return seriesEditPage({ ...sr, short_name: f.get("short_name") || sr.short_name, slug: f.get("slug") || sr.slug }, user, e.message, await queueFor(db, sr.id), "", await dirOpts(db, sr.id)); }
        }
        return seriesEditPage(sr, user, "", await queueFor(db, sr.id), "", await dirOpts(db, sr.id));
      }
      if ((m = path.match(/^\/([a-z0-9-]+)$/))) { const sr = await getSeries(db, m[1]); if (sr) return seriesPage(sr, user); }
      return notFound("Check the link.", user);
    } catch (e) {
      console.error(e);
      return path.startsWith(`${BASE}/api/`) ? json({ ok: false, error: "Something went wrong on the server." }, 500)
        : page("Error", `<h1>Something went wrong</h1><p class="sub">Try again in a minute.</p>`, { status: 500 });
    }
  },
};

export default site;
