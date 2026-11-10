// Add series (Nov 2026): an admin adds a series by its iRacing league ID before its first race; hide it from the
// public lists; upload its logo; set its first season's rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSite, week, text, raceExport, ADMIN_ROLE } from "./helpers.mjs";

const ADMIN = { id: "1", roles: [ADMIN_ROLE], nick: "Test Admin" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
async function setup() {
  const s = makeSite();
  await s.addRace({ sub: 1000, date: week(0) });
  await s.signIn(ADMIN);
  s.file = async (path, bytes, name = "logo.png", extra = {}) => { const fd = new FormData(); fd.append("action", "logo");
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    if (bytes) fd.append("file", new Blob([bytes]), name);
    const r = await s.go(path, { method: "POST", body: fd, headers: { origin: "https://glrhub.app" } }); return { status: r.status, html: await r.text() }; };
  return s;
}
const add = (s, f) => s.post("/series/add", { id: "7777", short_name: "Trucks", slug: "", name: "", ...f });

test("an admin adds a series by its league ID; duplicates and the site's own addresses are refused", async () => {
  const s = await setup();
  assert.match((await s.page("/")).html, /href="\/series\/add"/);
  const r = await add(s);
  assert.equal(r.status, 303);
  assert.equal(r.location, "https://glrhub.app/trucks/edit");
  assert.match(text((await s.page("/trucks/edit")).html), /iRacing league 7777/);
  assert.match(text((await add(s)).html), /iRacing league 7777 is already on the site: Trucks \(\/trucks\)/);
  assert.match(text((await add(s, { id: "8888" })).html), /The address \/trucks belongs to Trucks/);
  assert.match(text((await add(s, { id: "8888", slug: "signup" })).html), /\/signup is used by the site itself/);
  assert.match(text((await add(s, { id: "abc" })).html), /Enter the iRacing league ID/);
  assert.match(text((await add(s, { id: "8888", short_name: " " })).html), /short name/);
  assert.match(text((await s.page("/history")).html), /Series added: Trucks \(\/trucks\), iRacing league 7777/);
  // every tab of a series with no races yet opens
  for (const p of ["", "/schedule", "/standings", "/stats", "/drivers", "/rules", "/penalties", "/director", "/signups", "/edit"]) assert.equal((await s.page("/trucks" + p)).status, 200, p);
  // only admins
  await s.signIn({ id: "9", roles: [], nick: "Racer Ray" });
  assert.equal((await s.page("/series/add")).status, 404);
  assert.equal((await add(s, { id: "9999" })).status, 404);
  assert.doesNotMatch((await s.page("/")).html, /series\/add/);
});

test("rules set before the first race are the first race's rules; results find the series by its league ID", async () => {
  const s = await setup();
  await add(s);
  assert.match(text((await s.page("/trucks/rules")).html), /First season/);
  const sid = -7777;
  await s.post(`/trucks/rules?season=${sid}`, { source: "table", table: "50, 40, 30", others: "1", season: String(sid) });
  assert.equal((await s.json("/api/series/trucks/points")).table[0], 50);
  await s.addRace({ sub: 5000, date: new Date().toISOString(), league: 7777, leagueName: "GLR Truck SERIES", season: 900, seasonName: "Trucks 2027", order: [0, 1, 2, 3, 4] });
  const api = (await s.json("/api/series")).series.find(x => x.id === 7777);
  assert.equal(api.short_name, "Trucks");                                // the name and address given are kept
  assert.equal(api.slug, "trucks");
  assert.equal(api.races, 1);
  const st = await s.json("/api/standings/trucks");
  assert.equal(st.season.name, "Trucks 2027");
  assert.deepEqual(st.groups[0].regular.slice(0, 4).map(x => x.points), [50, 40, 30, 1]);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM seasons WHERE id < 0").get().n, 0);      // the stand-in season is gone
  assert.doesNotMatch(text((await s.page("/trucks/rules")).html), /First season/);
});

test("a hidden series is off the public lists but works by its link; admins still see it", async () => {
  const s = await setup();
  await add(s);
  await s.post("/trucks/schedule", { bulk: `${new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)}, 8:00 PM, Truck Oval` });
  await s.post("/trucks/drivers", { cust: "909090", name: "Hidden Hank", number: "9" });
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await s.post("/trucks/signups", { action: "round", name: "2027", keep_date: d(-3), open_date: d(-1) });
  await s.post("/trucks/edit", { short_name: "Trucks", slug: "trucks", teams_form: "1", hidden: "on" });
  assert.match(text((await s.page("/")).html), /Trucks Hidden/);          // the admin still sees it, marked
  assert.match(text((await s.page("/history")).html), /Hidden from the Series List/);
  s.cookie = "";
  for (const p of ["/", "/schedule", "/drivers", "/signup"]) assert.doesNotMatch(text((await s.page(p)).html), /Trucks|Truck Oval|Hidden Hank/, p);
  assert.doesNotMatch((await s.page("/")).html, /href="\/signup"/);
  assert.equal((await s.json("/api/schedule")).races.length, 0);
  assert.equal((await s.json("/api/drivers")).drivers.some(x => x.name === "Hidden Hank"), false);
  // by direct link, the widgets and the overlay's list still work
  for (const p of ["/trucks", "/trucks/schedule", "/trucks/drivers", "/trucks/widget/schedule"]) assert.equal((await s.page(p)).status, 200, p);
  assert.match(text((await s.page("/trucks/schedule")).html), /Truck Oval/);
  const api = (await s.json("/api/series")).series.find(x => x.slug === "trucks");
  assert.equal(api.hidden, 1);
  // unhide
  await s.signIn(ADMIN);
  await s.post("/trucks/edit", { short_name: "Trucks", slug: "trucks", teams_form: "1" });
  s.cookie = "";
  assert.match(text((await s.page("/")).html), /Trucks/);
  assert.match(text((await s.page("/schedule")).html), /Truck Oval/);
});

test("logo upload: PNG, JPG or WebP under 500 KB; shown on the list and the series' pages; removable", async () => {
  const s = await setup();
  await add(s);
  assert.match(text((await s.file("/trucks/edit", new TextEncoder().encode("<svg onload=alert(1)>"), "logo.png")).html), /isn.{1,6}t a PNG, JPG or WebP image/);
  const big = new Uint8Array(600 * 1024); big.set(PNG);
  assert.match(text((await s.file("/trucks/edit", big)).html), /That image is 600 KB\. Use one under 500 KB/);
  const ok = await s.file("/trucks/edit", PNG);
  assert.match(ok.html, /<img src="\/logo\/7777\?v=/);
  const src = ok.html.match(/\/logo\/7777\?v=[^"]+/)[0].replace(/&amp;/g, "&");
  const img = await s.go(src);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), PNG);
  s.cookie = "";
  assert.match((await s.page("/")).html, /class="slogo"><img src="\/logo\/7777/);
  assert.match((await s.page("/trucks")).html, /class="shlogo" src="\/logo\/7777/);
  await s.signIn(ADMIN);
  await s.file("/trucks/edit", null, "", { remove: "1" });
  assert.doesNotMatch((await s.page("/trucks")).html, /\/logo\/7777/);
  assert.equal((await s.go("/logo/7777")).status, 404);
  await s.signIn({ id: "9", roles: [], nick: "Racer Ray" });
  assert.equal((await s.file("/trucks/edit", PNG)).status, 404);
});
