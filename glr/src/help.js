// The Help chat for series directors, race control and admins (Nov 2026, for the first release's learning curve).
// It answers questions about using GLR HUB from the knowledge below, and never changes anything.
// The knowledge is the Series Director, Race Control and Admin guides (Claude Docs) and the README's race control
// section, shortened, plus what was added after them.
// When a page changes, change its paragraph here too, or the helper gives the old answer.

export const HELP_MODEL = "claude-haiku-5-5";
export const HELP_PER_DAY = 30;          // questions per person per day (UTC)
const MAX_TURNS = 12, MAX_CHARS = 2000;

export const KNOWLEDGE = String.raw`
# GLR HUB (glrhub.app) and race control: how they work, for series directors, race control stewards and admins

## Roles (they add up: someone with two roles gets everything from both)
- Admin: the admin Discord role (set in Cloudflare as DISCORD_ROLE_ID). Does everything in every series. Only admins have Accounts, Overlay keys and Settings in the header, assign series directors, decide driver disputes, merge drivers, block someone from the overlay, and turn Team points on for a series.
- Series director (also called series official): needs BOTH the Series official role in the GLR Discord AND an admin assigning them their series on the Accounts page. Runs and stewards only the series assigned. The role alone does nothing. Losing the role in Discord removes all their series within 15 minutes. A person can direct more than one series.
- Race control: the race control role (Settings). Stewards every series (protests and decisions) from the site or the race control program. Edits no series.
- Producer: the Producer role (Settings). Signs the broadcast overlay in; the overlay sends provisional results. Admins count as producers.
- Linked driver: someone who signed in and picked themselves as a driver. Gets My races, can file protests, can edit their own driver info.
- Member or visitor: can view the site.
Role changes reach the site within 15 minutes; signing out and back in picks them up straight away.

## Getting access as a director
1. Get the Series official role in Discord from an admin. 2. Sign in once at glrhub.app with Discord (the first time it asks which driver you are: pick yourself, or "I don't race"). 3. An admin assigns your series on Accounts (you must have signed in once first). 4. Your header then shows History, Upload results and Downloads, and your series shows Edit series and a Director tab.

## Header links
Series List (home, all series), Schedule (all series), Drivers, My races (linked drivers), Protests, Downloads (producers and race control users), History and Upload results (officials), Accounts, Overlay keys and Settings (admins). Help is the button in the bottom-right corner (directors, race control and admins).

## The Director tab (start here)
Each series has a Director tab, seen only by its directors and admins. "Needs attention" lists: scheduled races with no results on the site by noon Eastern the next day (upload the iRacing file, or remove the race from the schedule if it didn't run); races still provisional; open protests; Discord posts that didn't go out. Below that are links to everything a director can change, and the series' recent changes.

## Running a series (on its tabs)
- Edit series (under the series name): short name and web address (glrhub.app/<address>; changing it breaks old links to the series page, not race or driver links), and Discord posts.
- Schedule tab: Add races (date, start time Eastern, track, layout, length, notes), Edit or Remove upcoming races. Results link to their schedule line by themselves when they arrive (within 36 hours of the listed time).
- Rules tab, Change the rules, per season: Points (iRacing's league points, your own table for 1st, 2nd, 3rd..., or "By the size of the field": one point per car that completed a lap for 1st, one less for each place after, down to 1); Bonus points per race (win, pole, leading a lap, most laps led, fastest lap; leave at 0 if iRacing's points already include bonuses); Season (per-class standings for multi-class, tie-breaks, Drop worst races (GLR series drop each driver's 2 worst), which races count); Playoffs (turn on, "Fill in the GLR playoff format", win-and-in, seeding bonuses, each round's races, drivers and reset). Standings recalculate as soon as you save.
- Drivers tab, Add a driver: by iRacing ID, for someone who hasn't raced yet.
- Embed on a website (under the series name): standings, schedule and results widgets (and team standings where Team points is on) for another website, OBS or vMix, with a preview and code to paste.
- History for one series: the Director tab links to that series' own History.

## After each race
- If the race was broadcast, the producer's overlay (or race control) sends results about a minute after the checkered. They show as Provisional.
- To make them official, either upload the iRacing results file (best: iRacing members site > League > Results > the race > Export; JSON is best, CSV works if you keep its original file name; then Upload results in the header and drop the file in; uploading the same race again replaces it), or open the race, check it, fix anything wrong, and press Mark results official.
- A race not broadcast only gets in by uploading the file.
- "You can't upload ... results. Ask an admin to assign you that series." means the file is for a series you don't direct.
- Fix a result: open the race, scroll to Officials > Fix a result. Pick the driver, change only what's wrong (finish, laps, laps led, incidents, league points, status) and give a reason (shown on the race page). A new finish moves the others to make room. To disqualify: status Disqualified and finish last.
- Re-uploading the iRacing file replaces the race's results, fixes included, so make fixes after the final upload.
- Points penalties and adjustments: the series' Penalties tab > Add a penalty or adjustment (race, driver, points, negative for a penalty, and a reason drivers see).
- Remove a race uploaded by mistake: open it > Remove this race (at the bottom, Officials). Its results, penalties and fixes are deleted and standings recalculate. It can be uploaded again.
- A race outside every season's dates doesn't count. Open it and use Add to a season (Officials, at the bottom) to count it.

## Stewarding on the site
Race control stewards every series; directors steward their own series. Some stewarding happens after the race, on the site.
- Protests in the header lists open protests and recently closed ones.
- Decide a protest: open it (it's on the race's stewards' report) > Decide this protest: driver, decision (no action, warning, points, positions, time, disqualified, or an in-race penalty) and reason. Or Close it without a decision (filed by mistake, duplicate). Closed protests can be reopened.
- A decision without a protest: make it on the race's stewards' report.
- Time, positions or points penalties change that race's results and standings straight away. A decision made once the race is official posts to the penalties Discord channel by itself; decisions made while it was provisional (most race control calls) don't. To post them, a director or admin presses Send penalty report to Discord on the race's stewards' report: one post with every penalty on the race (decisions, race control's calls, points penalties; not withdrawn calls or no action). It needs a Penalties webhook on Edit series.
- Race control's live calls show on the same report, marked as from race control. Withdraw one there: it stays crossed out.
- Change a decision after further review (any decision, race control's calls included, even after the race is official): on the race's stewards' report press Edit next to it, change the penalty, amount or reason, and Save change. Race control, the series' directors and admins can; never for your own car or a protest you're in. Results and standings update straight away, the report shows "Changed <date> by <name>, was <old penalty>", and History records it. Race control sending the race again doesn't change it back. Nothing posts to Discord by itself: use Send penalty report to Discord afterwards if wanted.
- Take back a site decision: remove it from the report.
- Nobody judges themselves: if you raced and the protest is yours or against you, or it's about your car, the site won't let you decide it.
- Driver pages show which Discord account is linked ("Discord: name"); only officials see this.

## Race control (the program)
Race control is a program a steward runs on their own Windows PC during a league race. It watches the race through iRacing, lists every incident as it happens, and lets the steward make calls. It works the same whether or not the race is broadcast. Who can use it: the race control role (every series), or a series director (only their assigned series).
- Needs: the race control role; a Windows PC with iRacing joined to the league session as a session admin (so iRacing shares incident points and accepts penalty commands; ask the series director to make you one); internet; a browser, best on a second screen. No vMix or OBS, no Python to install.
- Install: GLR HUB > Downloads (header) > Download VSPEED race control. Right-click the zip > Properties > tick Unblock > OK, then extract it to a folder not synced by OneDrive (e.g. C:\VSPEED). Double-click start-race-control.bat (not start.bat, which is the broadcast overlay). The first time it sets itself up (about a minute). The Race Control page opens in the browser; if not, open http://localhost:8766/racecontrol. A VSPEED Race Control desktop shortcut is made: start it with that from then on. Its black window stays minimized on the taskbar; leave it running. A deleted shortcut can be made again with race-control-shortcut.bat. start-race-control.bat --demo runs a pretend race for practice (demo calls never go to the site).
- Same PC as the overlay is fine: race control uses port 8766 and data\steward; the overlay uses 8765. Only one copy of each runs at a time ("VSPEED is already running on this PC" means it's open in another window).
- Sign in to GLR HUB (once per PC): press Sign in to the league site (top right). Race control shows a code like K7QF-2MXP and opens a GLR HUB page; sign in with Discord there, check the code matches, press Allow (the page must say Race control, not broadcast overlay). The League site pill then shows signed in and the Steward box fills with your Discord name. Codes last 10 minutes; a PC stays signed in for a year from last use. "Race control needs the race control role, or the Series official role with a series assigned to you" means you need the role from an admin (role changes take up to 15 minutes).
- Before the green flag: join the session as a session admin, start race control from the shortcut, check the League site pill says signed in.
- Screen: Incidents (left; To review is what still needs a look; click to open, double-click to replay in the sim, the seconds box sets how far back). Logged: iRacing's own penalties, cautions and retirements (a record, not decisions). Map (bottom right): every car (camera car red, pits blue, black-flagged black, recent incident flashing) and a mark per open incident; click a car to put the camera on it, click a mark to open the incident; Pop out map for a second screen. While watching a replay, new incidents aren't detected; incident points gained meanwhile are added when you press Live, marked found after review.
- Making a call: pick the car, the call (warning, drive-through, stop-and-go, time penalty, end of line, positions, points, disqualified, no action), the number where needed, and the reason; press Make the call. For calls iRacing can give in the sim (warning, drive-through, stop-and-go, end of line, disqualified) the button says Make the call and send to iRacing, and race control types the admin command into iRacing's chat. The reason after !black, !eol or !dq shows in chat to everyone: keep it short and neutral. Stop-and-go: type the hold you want (25 s is the shortest). End of line only works under caution; otherwise it's logged with a Send to iRacing button for later. DQ asks are you sure (iRacing can't undo it). After sending: In the sim when the flag shows, Served when it goes; Didn't show in iRacing means no flag within 10 seconds (check the sim, Send again; commands only work as a session admin). Time, positions and points penalties don't go to iRacing: they change the results on GLR HUB.
- Something with no incident: double-click the driver in the running order, or New call without an incident.
- Withdraw a call made by mistake: it stays in the log crossed out, with who and why. Clear (next to a black-flagged driver) sends !clear for that driver and Clear all penalties sends !clearall; both remove all their penalties, iRacing's own included, and ask first.
- Other stewards: every call goes to GLR HUB straight away under your Discord name; every 10 seconds race control reads the race back, so other stewards' calls show in your call log under their names, and it asks first before you penalize a driver another steward penalized in the last 2 minutes. If the internet drops, calls wait on the PC and go when it's back, even after a restart; closing race control mid-race loses nothing. The race's official results also go to the site with the same sign-in.
- The broadcast: the producer's overlay reads calls from GLR HUB; a black-flagged car's penalty can show in its penalty box, but nothing goes on air until the producer presses Show.
- Updates: race control checks for a new version at each start and asks Install it now? [Y/N]: press Y before the race, not during. Settings and calls are never touched. restore-previous.bat goes back a version.
- Sign out in race control ends that PC's sign-in; an admin can also turn it off on the Overlay keys page, and removing the role does it within 15 minutes.
- Save diagnostics (top right) makes a zip of logs and race files to send to an admin when something goes wrong (no sign-in in it).
- Troubleshooting: page didn't open: find the black window on the taskbar, or open http://localhost:8766/racecontrol. League site pill not signed in: Sign in to the league site and Allow again. A race "turned down" by the site: not a GLR series on the site, or you don't steward that series; the calls stay on the PC. "You can't steward any series now": role or assignment taken away. No incident points: you're not a session admin. The map is empty: needs internet; "No map for this track yet" means tell an admin which track. Pop out map or Sign in does nothing: update race control. Anything else: tell an admin which race and roughly when.

## Discord posts
On Edit series > Discord posts, paste a webhook link for each kind of post (in Discord: the channel's settings > Integrations > Webhooks > New Webhook > Copy Webhook URL): Results (when a race is official), Standings (after each official race), Team standings (where Team points is on), Penalties and result fixes. One link can go in several boxes. Send test checks a link; Send latest posts the latest one again (a missed post, or on demand). Posts come from "GLR HUB". Treat a webhook link like a password. A post that can't go waits under Waiting to post with the problem: Try again or Discard.

## Team points (Warrior series only)
An admin turns on Team points on that series' Edit page; then it has a Teams tab. In each race a team scores its drivers' finishing points added together, divided by how many of its drivers raced. Teams are set by uploading a CSV on the Teams tab (Upload teams): columns Team and Driver, optionally iRacing ID, one row per driver. Download the teams (or a blank file) as CSV there to start from. Team standings have a widget and their own Discord post.

## Driver info
Drivers can add team, sponsor, hometown and a bio: Edit my info on their driver page. Officials see Edit info there for drivers who raced in their series, and admins for anyone. It shows on the driver page and in the driver API.

## History
History in the header shows who changed what: uploads, official results, fixes, penalties, rules, schedule, decisions, protests, accounts and settings. Directors see their series; admins see everything.

## Admin only
- Settings: theme (with Preview), league short name, and Discord role IDs for Race control, Producer and Series official (Discord: Server Settings > Roles > right-click > Copy Role ID; turn on Developer Mode if missing). Assign directors on Accounts BEFORE saving the Series official role: saving it switches off each series' old role. Also the Help chat on/off switch.
- Accounts: everyone who has signed in. Driver column: Set (name or iRacing ID, or "I don't race") or Unlink (asked again at next sign-in). Disputes: when someone picks a driver already linked to another account; Approve moves the driver, Reject leaves it. Directs column: Add series... or x to remove; "No Series official role in Discord: not active" means assigned without the role. Overlay column: Block turns someone's broadcast overlay off even if they have the Producer role, until Unblock; it shows when and by whom. Blocking doesn't touch their race control or website access. You can't block yourself.
- Overlay keys: signed-in overlay PCs and race control PCs (turn one off to sign that PC out), overlay keys (older way: make, name, copy once, send to the producer; turn off a leaked one), import keys for one-off jobs.
- Adding a series: it appears the first time an admin uploads a results file from that iRacing league. Then Edit series, Discord posts and directors on Accounts. Series logos are built into the site's code (ask for a change, not a setting).
- Merging drivers: only when one person has two records (e.g. a new iRacing account). On the driver to keep > Merge drivers, type the other's name or ID. Separate again undoes it.
- Downloads: producers see the broadcast overlay, race control users see race control, admins both; latest GitHub release, checked about hourly.
- Where things live: the site is the Cloudflare Worker vspeed-glr at glrhub.app (a push to the repo's main branch deploys it), its D1 database vspeed-glr, secrets in Cloudflare (Discord IDs and secret, the admin role ID, the Help key), Discord sign-in in the Discord Developer Portal (redirect https://glrhub.app/auth/callback).

## Troubleshooting
- No Edit series, History or Upload results: role or assignment missing, or changed in the last 15 minutes. Sign out and in, or ask an admin.
- Results still Provisional: upload the iRacing file, or Mark results official.
- Standings look wrong: check the Rules tab for that season (points, drops, races that count, playoffs) and the Penalties tab; a race outside the season needs Add to a season.
- Discord post didn't appear: Waiting to post on Edit series, Send test, Send latest.
- "You're not in the league's Discord server" at sign-in: they used a Discord account not in the GLR server.
- Two people claim one driver: Accounts > Disputes.
- An overlay says its access was turned off by an admin: they're blocked on Accounts.
- Results from iRacing can't be pulled automatically: iRacing isn't giving out new API access right now, so results come from the overlay/race control or an uploaded file.
`;

// what the helper is told before each conversation
export function systemPrompt(user, seriesNames = []) {
  const directs = !user.admin && (user.directs || []).length > 0;
  const who = user.admin ? "an admin (every series, plus the admin-only pages)"
    : directs ? `the series director of ${seriesNames.length ? seriesNames.join(", ") : "their assigned series"}${user.steward ? ", and race control (a steward for every series)" : ""} (not an admin)`
    : "race control: a steward for every series, using the race control program and the site's protests and stewards' reports (not a series director or an admin)";
  return `You are the GLR HUB help assistant on glrhub.app, the website of Goat Locker Racing, a sim racing league on iRacing.
You're talking with ${user.name || "a league official"}, ${who}.

Answer questions about using GLR HUB, using only the knowledge below. Rules:
- Be short and practical: the steps, with the names of the buttons and tabs as written. Use plain words. No headings.
- Say where things are: a header link, a series tab, or a page; you can give site paths like /upload or /settings.
${user.admin ? "" : "- They're not an admin: if what they want needs an admin (Accounts, Settings, assigning series, disputes, blocking, Team points, merging drivers), say so and tell them to ask an admin.\n"}${user.admin || directs ? "" : "- They're not a series director: running a series (Edit series, schedule, rules, uploading results, Mark results official, fixing results, penalties tab, Discord posts) is for the series director or an admin; say so when that's what they need.\n"}- If the knowledge doesn't cover it, or you're not sure, say so plainly and suggest asking an admin in the GLR Discord. Never guess at buttons or pages that aren't in the knowledge.
- You can't see the site's data (results, standings, accounts) and you can't change anything. Never say you did something.
- Only help with GLR HUB, race control, the league's results, stewarding and Discord posts. Politely decline anything else.

<knowledge>
${KNOWLEDGE}
</knowledge>`;
}

// keep only a sensible conversation: user/assistant turns, the last few, each trimmed; ends with the user's question
export function cleanTurns(messages) {
  if (!Array.isArray(messages)) return null;
  let t = messages.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) })).slice(-MAX_TURNS);
  while (t.length && t[0].role !== "user") t.shift();
  if (!t.length || t[t.length - 1].role !== "user") return null;
  return t;
}

// ask Claude; returns the answer text, or throws with a message that can be shown
export async function askClaude(env, system, turns) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.HELP_MODEL || HELP_MODEL, max_tokens: 700, system, messages: turns }),
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    console.error("help: Anthropic API", r.status, body && body.error ? body.error.message : "");
    throw new Error(r.status === 429 || r.status === 529 ? "The helper is busy right now. Try again in a minute." : "The helper isn't working right now. Ask an admin in the GLR Discord.");
  }
  const text = ((body && body.content) || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) throw new Error("The helper didn't answer. Try asking another way.");
  return text;
}
