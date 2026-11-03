/*
 * VSPEED GLR league site (vspeedlivetiming.app/glr).
 *
 * Pages:  /glr                    every series with its latest race, then the latest races
 *         /glr/<series>           one series (its short address, e.g. /glr/arca): seasons and races
 *         /glr/<series>/edit      officials: the series' short name and address
 *         /glr/results/<session>  one race (iRacing subsession id), split by class in a multi-class race
 *         /glr/drivers/<cust id>  one driver: every name they've raced under, stats and races by series
 * Data:   /glr/api/series, /glr/api/series/<series>, /glr/api/events, /glr/api/results/<session>,
 *         /glr/api/drivers/<cust id>   (the same, as JSON)
 *         /glr/health
 *         /glr/upload             officials upload iRacing result files (JSON or CSV)
 *         /glr/login, /glr/auth/callback, /glr/logout    Discord sign-in (auth.js)
 */
import { listEvents, listSeries, getSeries, updateSeries, getEvent, getDriver, importEvent } from "./db.js";
import { parseExport } from "./parse.js";
import { configured, login, callback, currentUser, logout } from "./auth.js";

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
label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px}input[type=text]{width:100%;max-width:360px;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
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
  let body = `<p class="crumb"><a href="${BASE}">GLR</a></p><h1>${esc(sr.short_name)}</h1><p class="sub">${esc(sr.name)}${user ? ` · <a href="${BASE}/${esc(sr.slug)}/edit">Edit</a>` : ""}</p>`;
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
      if ((m = path.match(/^\/glr\/([a-z0-9-]+)\/edit$/))) {
        const sr = await getSeries(db, m[1]);
        if (!sr) return notFound("No series at that address.", user);
        if (!user) return Response.redirect(`${url.origin}${BASE}/login?back=${encodeURIComponent(path)}`, 302);
        if (request.method === "POST") {
          if (!sameOrigin(request, url)) return seriesEditPage(sr, user, "Save from this page.");
          const f = await request.formData();
          try { const r = await updateSeries(db, sr.id, { shortName: f.get("short_name"), slug: f.get("slug") }); return Response.redirect(`${url.origin}${BASE}/${r.slug}`, 303); }
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
