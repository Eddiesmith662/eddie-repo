/*
 * Discord posts through each series' webhooks (set on the series' Edit page): results and standings when a race
 * becomes official, penalties and result fixes when an official adds them, and stewards' decisions.
 *
 * Posts wait in the discord_queue table and are sent straight away, then retried every few minutes (the cron
 * trigger) if Discord is down or asks us to slow down. A correction to a race that's already posted edits the
 * original results post instead of adding another. Only races from the last RECENT_DAYS days post, so uploading an
 * old season fills the archive without flooding the channels.
 */
import { ensureSchema } from "./db.js";

const COLOR = 0xFF0D40, RECENT_DAYS = 7, GIVE_UP = 12;
const MEDAL = ["🥇", "🥈", "🥉"];
const md = s => String(s ?? "").replace(/([\\*_~`|>])/g, "\\$1");          // names as plain text in Discord (no stray bold/italics)
const day = t => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }); };
const car = r => (r.car_number ? `#${md(r.car_number)} ` : "");
const gap = r => r.laps_down ? `−${r.laps_down} L` : r.finish_pos === 1 ? "" : r.interval_ms != null ? `−${(r.interval_ms / 1000).toFixed(3)}` : "";

export const isRecent = ev => { const t = Date.parse(ev.start_time); return !isNaN(t) && Date.now() - t < RECENT_DAYS * 864e5 && t - Date.now() < 864e5; };

export function resultsPost(ev, origin, fixes = []) {
  const race = (ev.sessions.race || []).slice().sort((a, b) => a.finish_pos - b.finish_pos);
  const classes = [...new Set(race.map(r => r.car_class || ""))];
  const multi = classes.length > 1;
  const pos = r => (multi ? r.class_pos ?? r.finish_pos : r.finish_pos);
  let desc = `${day(ev.start_time)}${ev.season_name ? ` · ${md(ev.season_name)}` : ""}\n\n`;
  for (const c of classes) {
    const rows = race.filter(r => (r.car_class || "") === c).sort((a, b) => pos(a) - pos(b));
    if (multi) desc += `**${md(c)}**\n`;
    desc += rows.slice(0, 3).map((r, i) => `${MEDAL[i]} ${car(r)}**${md(r.name)}**${r.laps_led ? ` · led ${r.laps_led}` : ""}`).join("\n") + "\n\n";
  }
  const facts = [ev.laps != null && `${ev.laps} laps`, ev.cautions != null && `${ev.cautions} caution${ev.cautions === 1 ? "" : "s"}`,
    ev.lead_changes != null && `${ev.lead_changes} lead changes`, `${race.length} starters`].filter(Boolean).join(" · ");
  const fields = [];
  if (!multi) fields.push({ name: "Top 10", value: race.slice(0, 10).map(r => `${r.finish_pos}. ${car(r)}${md(r.name)}${gap(r) ? ` (${gap(r)})` : ""}`).join("\n").slice(0, 1024) });
  const led = race.filter(r => r.laps_led > 0).sort((a, b) => b.laps_led - a.laps_led)[0];
  if (led) fields.push({ name: "Most laps led", value: `${car(led)}${md(led.name)} (${led.laps_led})`, inline: true });
  const fast = race.filter(r => r.best_lap_ms > 0).sort((a, b) => a.best_lap_ms - b.best_lap_ms)[0];
  if (fast) fields.push({ name: "Fastest lap", value: `${car(fast)}${md(fast.name)} (${(fast.best_lap_ms / 1000).toFixed(3)})`, inline: true });
  if (fixes.length) fields.push({ name: "Corrected", value: fixes.map(f => `${md(f.name)}: ${md(f.reason)}`).join("\n").slice(0, 1024) });
  return { embeds: [{ title: `${ev.short_name || "Results"}: ${ev.track}`, url: `${origin}/results/${ev.subsession_id}`, color: COLOR,
    description: (desc + facts).slice(0, 4000), fields, footer: { text: "Official results · GLR HUB" } }] };
}

// standings after a race: the current playoff round with its cut line, or the top of the regular season
export function standingsPost(sr, season, st, ev, origin) {
  const url = `${origin}/${sr.slug}/standings`;
  const embeds = st.groups.slice(0, 9).map(g => {
    const p = g.playoffs, po = st.rules.playoffs;
    let title, lines;
    if (po.enabled && p && p.started) {
      const cur = p.current;
      title = `${cur.name}${cur.finale && cur.complete ? " · final" : ` · after race ${cur.ran} of ${cur.races}`}`;
      const cutAt = !cur.finale && cur.spots < cur.rows.length ? cur.rows.findIndex(r => !r.through) : -1;
      lines = [];
      cur.rows.forEach((r, i) => {
        if (i === cutAt) lines.push("── cut line ──");
        const tag = r.status === "Champion" ? " 🏆 Champion" : /win/.test(r.status) ? " ✅ advanced (win)" : r.status === "Must win" ? " ⚠️ must win" : r.status ? ` · ${r.status.toLowerCase()}` : "";
        lines.push(`${r.pos}. ${r.number ? `#${md(r.number)} ` : ""}${md(r.name)}: **${r.points}**${!cur.finale && r.toCut != null && !/win/.test(r.status) ? ` (${r.toCut > 0 ? "+" : ""}${r.toCut})` : ""}${tag}`);
      });
    } else {
      title = `${po.enabled ? "Regular season" : "Standings"} · ${g.regularRan} race${g.regularRan === 1 ? "" : "s"}`;
      const ci = g.cutAfter == null ? -1 : g.regular.findIndex(s => s.custId === g.cutAfter);
      lines = [];
      g.regular.slice(0, 15).forEach((s, i) => {
        if (po.enabled && ci >= 0 && i === ci + 1) lines.push("── playoff cut ──");
        lines.push(`${s.pos}. ${s.number ? `#${md(s.number)} ` : ""}${md(s.name)}: **${s.points}**${s.behind ? ` (−${s.behind})` : ""}${po.enabled && s.inByWin ? " ✅ in on a win" : ""}${po.enabled && s.withdrawn ? " · out of the playoffs" : ""}`);
      });
      if (g.regular.length > 15) lines.push(`…and ${g.regular.length - 15} more`);
    }
    return { title: `${sr.short_name}${g.carClass && st.groups.length > 1 ? ` ${g.carClass}` : ""} · ${title}`, url, color: COLOR,
      description: lines.join("\n").slice(0, 4000), footer: { text: `${season.name} · after ${ev.track}` } };
  });
  return { embeds, card: `${origin}/${sr.slug}/standings/card?season=${season.id}` };
}

// team standings after a race (a series with team points, the Warrior series): ts from teams.js teamStandings
export function teamStandingsPost(sr, season, ts, ev, origin) {
  const pts = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
  const top = ts.teams[0] ? ts.teams[0].total : 0;
  const lines = ts.teams.slice(0, 20).map(t => `${t.pos}. ${md(t.name)}: **${pts(t.total)}**${t.total < top ? ` (−${pts(Math.round((top - t.total) * 1000) / 1000)})` : ""}`);
  if (ts.teams.length > 20) lines.push(`…and ${ts.teams.length - 20} more`);
  return { embeds: [{ title: `${sr.short_name} · Team standings · ${ts.races.length} race${ts.races.length === 1 ? "" : "s"}`, url: `${origin}/${sr.slug}/teams`, color: COLOR,
    description: lines.join("\n").slice(0, 4000), footer: { text: `${season.name} · after ${ev.track}` } }],
    card: `${origin}/${sr.slug}/teams/card?season=${season.id}` };
}

/*
 * Standings as a picture (Nov 2026). A standings post carries "card": the address of a small page on the site with
 * the standings laid out like the standings page. If the two Cloudflare secrets are set (CF_ACCOUNT_ID and
 * BROWSER_TOKEN, an API token with the Browser Run - Edit permission), Cloudflare's Browser Run takes a picture of
 * that page and the post goes out as the picture. Anything wrong (no secrets, Browser Run down or over its daily
 * allowance) and the post goes out as text, as before: a standings post is never lost for want of a picture.
 * -> { png } | { busy: true } (asked to slow down: try again shortly) | null
 */
const SHOT_MS = 25000;
export async function cardPicture(env, cardUrl) {
  if (!env || !env.CF_ACCOUNT_ID || !env.BROWSER_TOKEN || !cardUrl) return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), SHOT_MS);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-run/screenshot`, { method: "POST", signal: ctl.signal,
      headers: { authorization: `Bearer ${env.BROWSER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ url: cardUrl, selector: "#card", viewport: { width: 1000, height: 800, deviceScaleFactor: 2 }, gotoOptions: { waitUntil: "networkidle0", timeout: 15000 } }) });
    if (res.status === 429) { console.log("discord: standings picture: Browser Run asked to slow down"); return { busy: true }; }
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("image/")) { console.log(`discord: standings picture failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`); return null; }
    const png = await res.arrayBuffer();
    if (png.byteLength < 1000 || png.byteLength > 7e6) { console.log(`discord: standings picture is an odd size (${png.byteLength} bytes)`); return null; }
    return { png };
  } catch (e) { console.log(`discord: standings picture failed: ${e && e.message}`); return null; }
  finally { clearTimeout(timer); }
}

export function penaltyPost(sr, ev, a, origin) {
  return { embeds: [{ title: `${sr.short_name}: ${a.points < 0 ? "penalty" : "points adjustment"}`, url: `${origin}/${sr.slug}/penalties`, color: COLOR,
    description: `${a.car_number ? `#${md(a.car_number)} ` : ""}**${md(a.name)}**: ${a.points > 0 ? "+" : "−"}${Math.abs(a.points)} points\n${md(ev.track)}, ${day(ev.start_time)}\n\n${md(a.reason)}`,
    footer: { text: "GLR HUB" } }] };
}

// a stewards' decision (warnings and penalties; "no action" isn't posted)
export function decisionPost(sr, ev, d, origin) {
  return { embeds: [{ title: `${sr.short_name}: stewards' decision`, url: `${origin}/results/${ev.subsession_id}/stewards`, color: COLOR,
    description: `${d.car_number ? `#${md(d.car_number)} ` : ""}**${md(d.name)}**: ${md(d.text)}\n${md(ev.track)}, ${day(ev.start_time)}\n\n${md(d.reason)}`,
    footer: { text: "GLR HUB stewards" } }] };
}

// a race's penalty report, sent by hand from its stewards' report: every penalty on the race in one post
export function penaltyReportPost(sr, ev, items, origin) {
  const lines = items.map(x => `${x.car ? `#${md(x.car)} ` : ""}**${md(x.name)}**: ${md(x.text)}${x.reason ? ` · ${md(x.reason)}` : ""}`);
  let desc = `${md(ev.track)}, ${day(ev.start_time)}${ev.status === "official" ? "" : " (results still provisional)"}\n\n`;
  for (const l of lines) { if (desc.length + l.length > 3900) { desc += `…and more on the site`; break; } desc += l + "\n"; }
  return { embeds: [{ title: `${sr.short_name}: penalty report`, url: `${origin}/results/${ev.subsession_id}/stewards`, color: COLOR,
    description: desc.trim(), footer: { text: `GLR HUB stewards · ${items.length} penalt${items.length === 1 ? "y" : "ies"}` } }] };
}

export function fixPost(sr, ev, name, change, reason, origin) {
  return { embeds: [{ title: `${sr.short_name}: result corrected`, url: `${origin}/results/${ev.subsession_id}`, color: COLOR,
    description: `**${md(name)}** at ${md(ev.track)}, ${day(ev.start_time)}\n${md(change)}\n\n${md(reason)}`, footer: { text: "GLR HUB" } }] };
}

export async function enqueue(db, seriesId, hook, kind, sub, body, editOf = null) {
  await ensureSchema(db);
  await db.prepare(`INSERT INTO discord_queue (series_id, hook, kind, subsession_id, body, edit_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(seriesId, hook, kind, sub, JSON.stringify(body), editOf, new Date().toISOString()).run();
}

const CARD_WAITS = 3;      // times a post waits for Browser Run to be free before it goes out as text
async function sendOne(db, q, url, env) {
  const { card, ...post } = JSON.parse(q.body);
  const editing = !!q.edit_of;
  let payload = { ...post, allowed_mentions: { parse: [] }, username: "GLR HUB" }, init = null;
  if (card && !editing) {
    const pic = (q.card_waits || 0) < CARD_WAITS ? await cardPicture(env, card) : null;
    if (pic && pic.busy) {          // Browser Run takes one picture every 10 seconds on the free plan: this one waits its turn
      await db.prepare(`UPDATE discord_queue SET next_try = ?, card_waits = COALESCE(card_waits, 0) + 1, last_error = ? WHERE id = ?`).bind(Date.now() + 12000, "Waiting to make the standings picture", q.id).run();
      return "wait-picture";
    }
    if (pic && pic.png) {
      const first = (post.embeds || [])[0] || {};
      payload = { ...payload, embeds: [{ title: (post.embeds || []).length > 1 ? String(first.title || "").split(" · ")[0] + " · Standings" : first.title, url: first.url, color: first.color, footer: first.footer, image: { url: "attachment://standings.png" } }],
        attachments: [{ id: 0, filename: "standings.png" }] };
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([pic.png], { type: "image/png" }), "standings.png");
      init = { method: "POST", body: form };
    }
  }
  if (!init) init = { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  let res;
  try {
    res = await fetch(editing ? `${url}/messages/${q.edit_of}` : `${url}?wait=true`, init);
  } catch (e) { res = null; }
  const now = Date.now();
  if (res && res.ok) {
    const msg = await res.json().catch(() => ({}));
    await db.prepare(`UPDATE discord_queue SET sent_at = ?, last_error = NULL WHERE id = ?`).bind(new Date().toISOString(), q.id).run();
    if (q.kind === "results" && q.subsession_id && msg.id)       // remember the post, so corrections can edit it
      await db.prepare(`UPDATE events SET discord = json_set(COALESCE(discord, '{}'), '$.results', ?) WHERE subsession_id = ?`).bind(msg.id, q.subsession_id).run();
    return "sent";
  }
  if (res && res.status === 404 && editing) {                     // the post was deleted in Discord: post it again
    await db.prepare(`UPDATE discord_queue SET edit_of = NULL WHERE id = ?`).bind(q.id).run();
    return sendOne(db, { ...q, edit_of: null }, url, env);
  }
  if (res && res.status === 429) {                                // Discord says wait: wait exactly that long
    const j = await res.json().catch(() => ({}));
    const wait = Math.ceil((Number(j.retry_after) || Number(res.headers.get("retry-after")) || 5) * 1000) + 250;
    await db.prepare(`UPDATE discord_queue SET next_try = ?, last_error = ? WHERE id = ?`).bind(now + wait, "Discord asked to slow down; trying again shortly", q.id).run();
    return "wait";
  }
  if (res && [401, 403, 404].includes(res.status))
    return fail(db, q, "Discord doesn't know this webhook any more (deleted?). Paste a new one on the series' Edit page.", true);
  if (res && res.status === 400) {
    const j = await res.json().catch(() => ({}));
    return fail(db, q, "Discord refused the post: " + JSON.stringify(j).slice(0, 200), true);
  }
  return fail(db, q, res ? `Discord had a problem (${res.status})` : "Couldn't reach Discord", false);
}

async function fail(db, q, why, permanent) {
  const attempts = q.attempts + 1;
  const stop = permanent || attempts >= GIVE_UP;
  await db.prepare(`UPDATE discord_queue SET attempts = ?, next_try = ?, last_error = ? WHERE id = ?`)
    .bind(attempts, stop ? 8.64e15 : Date.now() + Math.min(3600e3, 60e3 * 2 ** attempts), why, q.id).run();
  return stop ? "failed" : "retry";
}

// send what's due, oldest first, one at a time (Discord allows a few posts a second per webhook)
export async function processQueue(db, limit = 15, env = null) {
  await ensureSchema(db);
  const due = (await db.prepare(`SELECT * FROM discord_queue WHERE sent_at IS NULL AND next_try <= ? ORDER BY id LIMIT ?`).bind(Date.now(), limit).all()).results;
  const out = [];
  for (const q of due) {
    const sr = await db.prepare(`SELECT hook_results, hook_standings, hook_teams, hook_penalties FROM series WHERE id = ?`).bind(q.series_id).first();
    const url = sr && sr[`hook_${q.hook}`];
    if (!url) { out.push(await fail(db, q, "No webhook set for this post", true)); continue; }
    out.push(await sendOne(db, q, url, env));
    if (out[out.length - 1] === "wait") break;
  }
  // a post waiting its turn for a picture (Browser Run takes one every 10 seconds on the free plan: standings, then
  // team standings) gets it here, not at the next 5-minute check
  for (let pass = 0; pass < 2 && out.includes("wait-picture"); pass++) {
    await new Promise(r => setTimeout(r, Number(env && env.CARD_WAIT_MS) || 11000));
    const again = due.filter((q, i) => out[i] === "wait-picture");
    for (const q of again) {
      const sr = await db.prepare(`SELECT hook_results, hook_standings, hook_teams, hook_penalties FROM series WHERE id = ?`).bind(q.series_id).first();
      const fresh = await db.prepare(`SELECT * FROM discord_queue WHERE id = ? AND sent_at IS NULL`).bind(q.id).first();
      if (fresh && sr && sr[`hook_${q.hook}`]) out[due.indexOf(q)] = await sendOne(db, fresh, sr[`hook_${q.hook}`], env);
    }
  }
  // keep the table small: sent posts older than 30 days go
  await db.prepare(`DELETE FROM discord_queue WHERE sent_at IS NOT NULL AND sent_at < ?`).bind(new Date(Date.now() - 30 * 864e5).toISOString()).run();
  return out;
}

export async function queueFor(db, seriesId) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT id, hook, kind, subsession_id, attempts, next_try, last_error, created_at FROM discord_queue
      WHERE series_id = ? AND sent_at IS NULL ORDER BY id`).bind(seriesId).all()).results;
}

export async function retryQueued(db, seriesId, id) {
  await db.prepare(`UPDATE discord_queue SET next_try = 0, attempts = 0 WHERE id = ? AND series_id = ? AND sent_at IS NULL`).bind(id, seriesId).run();
}
export async function discardQueued(db, seriesId, id) {
  await db.prepare(`DELETE FROM discord_queue WHERE id = ? AND series_id = ? AND sent_at IS NULL`).bind(id, seriesId).run();
}
