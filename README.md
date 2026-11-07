# VSPEED Broadcast Overlay

Live iRacing graphics for vMix or OBS, run from a control panel in your browser: the ticker, driver info, grid,
standings, live points, podium, sponsors and more, built to the VSPEED Brand Style Guide.

**Contents:** [Quick start](#quick-start) · [Race night](#race-night) · [The control panel](#the-control-panel) ·
[The graphics](#the-graphics) · [Standings, live points and playoffs](#standings-live-points-and-playoffs) ·
[Several series](#several-series) · [Race results](#race-results) · [Announcer page](#announcer-page) ·
[Live timing window](#live-timing-window) · [Race control](#race-control) · [Updates](#updates) · [When something goes wrong](#when-something-goes-wrong) ·
[Files](#files)

---

## Quick start

1. **Download** the latest release (Releases on the right of the GitHub page → the newest version → *Source code (zip)*)
   and unzip it anywhere, e.g. your Desktop.
2. **Double-click `start.bat`.** The first time it sets itself up, which takes about a minute and needs internet.
   You don't need to install Python. Keep the black window open while you broadcast.
3. **Open the control panel:** `http://localhost:8765/control` in your browser. A new setup opens on a
   **Getting started** checklist that ticks itself as you go:
   - add the overlay to vMix or OBS (below)
   - put your league logo in the overlay's `data\logos` folder and pick it
   - type the ticker header (your league or race name)
   - load your standings, if your league uses them
4. **Add the overlay to vMix or OBS,** on a layer above your iRacing capture. The page is see-through.
   - **vMix:** Add Input → **Web Browser**, URL `http://localhost:8765/overlay`, size **1920 × 1080**.
   - **OBS:** in your scene, Sources → **+** → **Browser**. URL `http://localhost:8765/overlay`, width **1920**,
     height **1080**. Leave **Shutdown source when not visible** and **Refresh browser when scene becomes active**
     off, so the graphics keep running when you switch scenes. Put the source at the top of the list so it sits
     above the game capture.
5. **Start iRacing.** The overlay connects by itself.

No iRacing handy? **`start-demo.bat`** runs a pretend race so you can try every graphic.

---

## Race night

Before the green flag:

- [ ] **Start the overlay** (`start.bat`). If it offers an update, press **Y**.
- [ ] **Series picker** (top right of the control panel) shows tonight's series.
- [ ] **Standings tab → Pull standings now**, before the race. Pull before Xtreme Scoring posts tonight's race,
      or tonight's points get counted twice.
- [ ] **Prerace tab:** race info, broadcast team, Next broadcast text and tonight's track graphic.
- [ ] **Open live timing ↗** (top right) on a second screen for camera changes and replays.
- [ ] **Announcer page:** send your announcers the link (Race tab → **Copy announcer link**).
- [ ] **Show base package** (Race tab → Graphics) puts the logos, ticker and driver info up.

After the race: **Podium** (Race tab); **Standings tab → Add tonight's race** if you want to show the standings
with tonight's points before the league posts them; then **Save diagnostics** (Setup tab) if anything looked wrong,
and send the zip to Claude. The race results save themselves.

---

## The control panel

`http://localhost:8765/control`. It works from a phone or tablet on the same network too: the black window shows
the address to use.

| Tab | What's on it |
|---|---|
| **Prerace** | Getting started checklist, race info, broadcast team, Next broadcast, broadcast text (ticker header and league logo), track graphic, Results board title |
| **Race** | Graphics tiles, Race off pit road, Podium, Live points, ticker and driver info settings, cameras, incident log, Grid and Pole Award, Sponsors, Announcer page link and notes |
| **Standings** | Standings graphic on/off, title and logo, Xtreme Scoring link or CSV, the standings table (edit, exclude), playoff bracket |
| **Layout** | Drag any graphic to move it, sliders to resize it. Changes show in vMix or OBS straight away and are saved |
| **Setup** | Live points scoring (points per place, bonuses), the overlay links for vMix or OBS, car renders, announcer page setup, diagnostics |

At the top: the version, the **Series** picker, **Open live timing ↗** and **Producer codes ↗** (for the announcer page).

**Show and Hide:** most graphics have Show and Hide buttons, and the lit one tells you what's on air. Sponsors have
a single button that turns red while that sponsor is up. **Hide all** (Race tab) clears everything; **Show base
package** brings back the logos, ticker and driver info.

---

## The graphics

| Graphic | Where | What it shows |
|---|---|---|
| **VSPEED logo** | Top left | Right-click its tile to switch between slanted and straight |
| **League logo + LIVE tag** | Top right | The tag switches to REPLAY by itself during iRacing replays |
| **Ticker** | Left | Running order with interval or gap to the leader, the lap and laps to go, flags, pit stops, meatball flags |
| **Driver info** | Bottom | The car the iRacing camera is on: last and best lap, gap; in qualifying, the gap to pole |
| **Results board** | Center | Full running order with gaps |
| **Biggest movers** | Bottom right | Top 5 positions gained since the start |
| **Race recap** | Top left, slides out from under the VSPEED logo | Cautions and lead changes so far (iRacing's count, or the overlay's own if that's higher). Steps aside while the penalty box is up |
| **Track conditions** | Same place and slide as the race recap, a wider bar | Sky, track and air temperature (°F) from iRacing. One of the two bars at a time: showing one slides the other away |
| **Telemetry** | Rises up from the bottom of the ticker, over its lower rows | The car on camera: position, number, car picture (iRacing's render, as on the Grid), name, gear, RPM, MPH and the gap to the leader |
| **Race off pit road** | Over the ticker | The order cars came off pit road under caution, spots gained or lost, stop times |
| **Live points** | Over the ticker | The championship if the race ended now, with the playoff cutline ([guide](GUIDE-standings-live-points-playoffs.md)) |
| **Penalty box** | Top center | A black-flagged driver with a reason, shown from the live timing window |
| **Grid** | Bottom | The starting grid, a row at a time, with car renders in each driver's paint; Pole Award badge |
| **Podium** | Full screen | Winner, 2nd and 3rd on the VSPEED artwork: start position, laps led, fastest lap |
| **Standings** | Center | Championship points, playoff cutline, playoff bracket |
| **Race info** | Bottom right | Title and 5 lines (race length, pit speed …) |
| **Broadcast team** | Bottom center | Up to 3 names with roles |
| **Track graphic** | Anywhere | A ready-made image or video from a folder (e.g. Google Drive) |
| **Next broadcast** | Bottom center | Event, date and time, with a logo |
| **Sponsor reads** | Full screen | Three slots: Sponsor Read 1–3 |
| **Flag sponsors** | In the ticker | GREEN FLAG / RESTART ZONE / WHITE FLAG, "presented by" and the sponsor's logo, in the ticker's flag flash |

When standings, race info or the broadcast team are on screen, any live graphic underneath steps aside by itself.

### Notes on some of them

- **Ticker:** *Interval* or *To leader* gaps, how many rows, and how many stay fixed at the top while the rest page
  through (Race tab → Ticker & driver info). Lapped cars show −1 LAP, −2 LAPS. Pit stops show a blue PIT with the
  stop time. Caution, white and checkered flags flash the rows and leave a band under the lap line; ONE TO GREEN and
  PACE LAP show when iRacing sends them. Laps to go count down like TV (10 TO GO … FINAL LAP), and late cautions show
  OVERTIME · ATTEMPT 1 OF 2. Multi-class races group by class, IMSA style.
- **Driver info:** *Always on*, or *8s on camera cut* to show it only after each camera change. Showing a sponsor
  turns it off until you press its tile again.
- **Race off pit road:** captures itself when 3 or more lead-lap cars pit under caution (CAPTURING, then READY).
  Press **Show** any time from the first car out. **Capture now** starts one by hand, e.g. for green-flag stops.
- **Grid:** **Show** starts at row 1. Next row is *Automatic* (every few seconds) or *Manual*. For the **Pole Award**,
  load the badge once (**Load…**), show the grid on row 1, then press **Show** next to the badge.
- **Podium:** after the race, press **Winner**, **2nd place**, **3rd place**, then **Hide**.
- **Sponsors:** click a slot's picture to load an image.
  - **Green Flag, Restart, White Flag:** the sponsor's logo, a PNG with a transparent background, best at about
    **800 × 400** (twice as wide as tall: that fills the box; square logos fit too, just smaller). It plays by itself in
    the ticker's flag flash, under "presented by": Green Flag on the first green of the race, Restart on every green
    after a caution (the ticker flashes green), White Flag on the white flag. Only in races, while the ticker is up.
  - **Sponsor Read 1–3:** a 1920 × 1080 PNG with a transparent background, shown full screen with **Show**. Optional
    auto-hide after a number of seconds.
- **Track graphic:** Prerace tab → **Browse…** to pick the folder, then pick tonight's track and **Show track**.
  For a Google Drive folder, right-click it in File Explorer → *Available offline* so nothing downloads at the
  moment you press Show.
- **Penalty box:** black-flagged drivers appear in the live timing window's Penalties list. Pick a reason
  (Speeding / Passing under yellow) if you want one, then press **Show**.
- **Results board** and **finish gaps:** after the checkered, gaps lock as each car crosses the line and are
  replaced by iRacing's official results (−1 LAP, DNF) once they come in.

---

## Standings, live points and playoffs

All on the **Standings** tab. The full walkthrough, including a race-by-race playoff routine, is in
**[GUIDE-standings-live-points-playoffs.md](GUIDE-standings-live-points-playoffs.md)**.

- **Getting the standings:** paste your Xtreme Scoring widget link and press **Pull standings now**, or load a CSV
  (columns Pos, #, Driver, Pts, Wins; **Example CSV** gives one to copy). It only pulls when you press the button;
  the last copy is saved with the series.
- **Edit by hand** fixes a name, number or points.
- **Add tonight's race** (once the checkered flag is out) puts tonight's live points into the standings: points and
  bonuses, a win for the winner, drivers new to the series, re-sorted. It asks first, and won't add the same race
  twice without asking. It lasts until the next pull, which brings in the league's official numbers.
- **⊘ Exclude** leaves a driver out of the standings graphic, live points and the bracket (e.g. not eligible for the
  playoffs). Everyone below moves up. **Include** puts them back.
  A driver in the race who isn't in the standings at all gets a **⊘** under Live points on the Race tab.
- **Live points** (Race tab): standings points + what each driver would score for where they're running now +
  bonuses (led a lap, most laps led, pole). Points per place and bonuses are on the Setup tab.
- **Playoffs:** fill the bracket with **Load top 12**, advance drivers with **→**, mark round wins with 🏆 (a win moves
  them on) and missed races with **MISS** (then only a win moves them on), and switch live points to **Playoffs: use this
  bracket**.

---

## Several series

The **Series** picker (top right) keeps each series separate. Picking one switches all of these at once:

- the standings (Xtreme link, the table, hand edits, excluded drivers), the standings title, logo and cutoff
- the playoff bracket
- live points settings (points table, bonuses, line, places, playoff mode)
- the ticker header, the league logo and the Next broadcast text

Shared by every series: race info, the broadcast team, sponsors, the layout and the announcer page.
**⋯** next to the picker adds (a copy, or an empty one), renames or deletes a series.

---

## Race results

Every race the overlay is connected to is saved as a spreadsheet (CSV, opens in Excel or Google Sheets) in
`data\results\<series>\`, named by date and track, e.g. `2026-10-30 Atlanta Motor Speedway.csv`.

Each file has position, car number, driver, start, laps, laps led, gap, fastest lap, incidents and status
(Running, or why they're out). A first copy is saved a minute after the checkered flag and replaced when iRacing makes
the results official. It goes into the folder of the series picked when the race ends.

### Sending results to the league site

The overlay can also send each league race's results to the league site (GLR HUB, glrhub.app) when the race ends.
It's off until you connect it, in the control panel under **Setup > League site upload**:

- **Sign in with Discord** (the usual way): press it, check the code matches on the page that opens, and press
  **Allow** there with your Discord account. It needs the **Producer** role on the league site (an admin gives it).
  The overlay picks up the sign-in by itself and switches the upload on. **Sign out** ends it, here and on the site.
- **Or an overlay key**: a site admin makes one on the site's **Keys** page and sends it to you; paste it and press
  **Save**.

**Test** checks the connection any time. If the site stops accepting the sign-in (signed out on the site, or the
Producer role taken away), the panel says so and races wait on this PC until you sign in again.

Results go a minute after the checkered and again when iRacing makes them official. On the site they show as
**Provisional** until a league official uploads the iRacing results file, which replaces them. Only league races are
sent, and only to a series the site already has. If the internet drops or the site is down, races wait in
`data\league-upload\` and go once it's back. The sign-in and the key are kept on this PC only, in their own file
(`data\league-site-key.json`): they aren't shown in the control panel and aren't included in diagnostics. Don't share
that file.

---

## Announcer page

A live page for remote announcers: they open a link in any browser (computer, tablet or phone) and see what's on
screen, your notes, the weather, the running order, incidents, live points and standings, updated twice a second.
Nothing on their page can change anything on your PC.

1. **Setup tab → Announcer page:** paste the show's **producer code** and press **Save**. Codes are made by the
   relay's owner (**Producer codes ↗** at the top; it needs the relay password). One code per show.
2. **Copy the announcer link** (Setup tab, or **Copy announcer link** on the Race tab) and send it to your announcers.
3. **Notes** (Race tab) go out as you type, e.g. "Sponsor read after the restart".

If a link gets passed around, **New link** (Setup tab) makes a fresh one and the old one stops working straight away.
The relay itself runs on Cloudflare and is looked after by VSPEED.

---

## Live timing window

**Open live timing ↗** (top right of the control panel), best on a second screen.

- **Click a driver** to put the camera on them; **right-click** (or press and hold on a tablet) to pick the camera.
- **Columns ▾** picks what's shown: position, number, driver, positions gained, gap, interval (red within half a
  second), speed, last and best lap, pit stops, last stop time, laps since the last stop.
- **Cameras** on the left switch camera group.
- **Replay controls:** start, rewind, play, pause, fast-forward, **Live**, speeds, **◀ LAP ▶**, **↻ REPLAY** (jump
  back and play), **On Track ◀ ▶** (car behind / ahead), **Sim UI** (iRacing's own screen controls).
- **Incident log** (right): spins, contact, cautions, penalties and more as they happen. Double-click one to replay
  it. **Types ▾** picks which kinds are listed. *iRacing* entries come from iRacing; *predicted* ones are the overlay's
  best guess from speeds and positions.
- **Penalties:** see the Penalty box above.

---

## Race control

For a league steward: the same program, started with **`start-race-control.bat`** instead of `start.bat`. No
graphics, vMix or OBS: just iRacing and this. The steward needs to be a session admin in the league session, so that
iRacing shares every driver's incident points. The Race Control page opens in your browser by itself (best on a
second screen); if it doesn't, open **http://localhost:8766/racecontrol**. `--no-browser` turns that off. It works the same whether or not the race is being broadcast.

The first time it runs, it puts a **VSPEED Race Control** shortcut on the desktop: from then on the steward starts
race control with that, and its black window stays minimized on the taskbar (look there if the page doesn't open).
A deleted shortcut isn't put back; double-click `race-control-shortcut.bat` to make it again, for example after
moving the folder.

Race control has its own port (**8766**; the overlay is 8765) and keeps all its own files (settings, logs, results,
calls) in `data\steward`, so it can run beside the overlay on the same PC, from the same folder, without the two
sharing buttons or saving over each other's settings and results. Only one copy of each can run at a time. Race
control from before v1.5.38 kept its calls in `data\race-control`; they're copied into `data\steward` the first time.

- **Steward** (top right): type your name first. Every call is saved with who made it.
- **Incidents** (left): spins, contact, stopped and slow cars, meatballs and more, as they happen. **To review** shows
  what still needs a look. Click one to open it; double-click to replay it in the sim (the seconds box sets how far
  before it the replay starts). Replaying marks it **Reviewing**.
- **Logged**: iRacing's own penalties (black flag, warning, disqualified), cautions and retirements. They're recorded
  for the stewards, not decisions, and nothing is done with them.
- **Making a call** (middle): pick the car, the call (warning, drive-through, stop-and-go, time penalty, end of line,
  positions, points, disqualified or no action), the number of seconds / positions / points where it needs one, and
  the reason, then **Make the call**. The incident moves to **Decided** (or **No action**). For something that isn't
  in the list, double-click the driver in the running order, or press **New call without an incident**.
- **Sent to iRacing in the same press:** for a call iRacing can give in the sim (marked *in the sim*), the exact admin
  command shows under the reason, and the button says **Make the call and send to iRacing**. Race control types it
  into iRacing's chat for you, without switching away from the Race Control page:

  | Call | Sent to iRacing |
  |---|---|
  | Warning | a private message to the driver: `/#87 Race control warning: <reason>` |
  | Drive-through | `!black #87 D <reason>` |
  | Stop-and-go | `!black #87 <seconds - 25> <reason>` (iRacing holds 25 s longer than the number sent, so the steward types the hold they want; 25 s is the shortest) |
  | End of line | `!eol #87 <reason>`, only under caution |
  | Disqualified | `!dq #87 <reason>`, after an "are you sure" (iRacing can't undo a DQ) |

  The reason after a `!` command is shown in chat to **everyone** in the session. Time, positions and points penalties
  change the results instead (on the league site, coming later). After sending, the call shows **In the sim** when the
  black flag (or DQ) comes up and **Served** when it goes away. A warning or end of line just shows **Sent**, since
  iRacing's data can't confirm those. **Didn't show in iRacing** means no flag came up within 10 seconds: check the sim
  and **Send again**. If it couldn't be sent (e.g. end of line while green), the call is still logged and has a
  **Send to iRacing** button for later.
- **Clear** (running order, next to a driver with a black flag) sends `!clear #87`; **Clear all penalties** sends
  `!clearall`. Both ask first, since they remove **all** of those penalties, iRacing's own included, and both are kept in
  the call log with who sent them. A call whose penalty was cleared shows **Cleared in iRacing** and can be sent again.
- **Withdraw** a call made by mistake: it stays in the log, crossed out, with who withdrew it and why. If it was sent,
  you're asked whether to clear it in iRacing too: `!clear #87` removes **all** of that driver's penalties, iRacing's
  own included.
- **While you watch a replay**, new incidents aren't detected (iRacing's car data is the replay). Incident points
  gained in the meantime are added when you go back to **Live**, marked **found after review**; replaying one of those
  goes to where your review started.
- **Sign in to the league site** (top right): the site opens in your browser; sign in with Discord there and press
  **Allow** for the code race control shows. You need the league's race control role in Discord (or the series' own
  role). Once signed in:
  - calls carry your Discord name (the Steward box fills itself in), and every change to a race's calls is sent to that
    race's stewards' report on the site, where they become stewards' decisions;
  - the other steward's calls on the same race show in the call log under their name, and race control asks first
    before you penalize a driver they penalized in the last 2 minutes;
  - a call an official withdraws on the site shows withdrawn here too;
  - the race's official results go to the site with the same sign-in, so no overlay key is needed.

  The **League site** pill shows how it's going. If the site can't be reached, the calls wait on this PC and go when it
  can, even after a restart. A race the site turns down (not a GLR series, or no steward role for it) stays on this PC
  with the site's reason. **Sign out** ends the sign-in, and so does taking the Discord role away or turning it off on
  the site's Keys page. The sign-in is kept only in `data\steward\race-control\signin.json`, never in the diagnostics zip. The
  demo race never goes to the site.

Calls are saved after every change in `data\steward\race-control\<race>.json` (one file per iRacing session), so closing the
program mid-race loses nothing. `start-race-control.bat --demo` runs it on a pretend race.

---

## Updates

The overlay checks GitHub each time it starts. If there's a new version, the black window shows what's new and asks
**Install it now? [Y/N]**. With no answer it starts the version you have after 30 seconds. It never updates
during a broadcast; the control panel says when one is waiting. After an update, the overlay in vMix or OBS reloads itself.

Everything you set up lives in the `data` folder, which updates never touch.

- **Something wrong after an update?** `restore-previous.bat` goes back to the version before.
- **Moving to a new PC:** copy the whole folder (or install fresh and copy just the `data` folder).
- **Python:** the overlay brings its own Python 3.13, set up the first time into `%LOCALAPPDATA%\VSPEED`. It doesn't
  matter which Python, if any, is installed on the PC. Delete that folder to remove it.

---

## When something goes wrong

- **Save diagnostics** (Setup tab) bundles the logs, the last 3 hours of iRacing data and your settings into one zip
  (also kept in `data\diagnostics`). Send it to Claude. Everything stays on your PC unless you share it.
- **Nothing on screen in vMix or OBS:** check the input or browser source is `http://localhost:8765/overlay` at
  1920 × 1080 and the black window is still open. The Getting started checklist ticks *overlay added* once vMix or
  OBS has opened it.
- **A graphic looks stuck or half drawn:** reload the overlay. OBS: select the browser source → **Properties** →
  **Refresh cache of current page**. vMix: right-click the input → **Refresh**. Then Save diagnostics and send it, so
  the cause can be found.
- **"Waiting for iRacing":** iRacing has to run on the same PC as the overlay. vMix or OBS can be on another PC: use
  `http://<this PC's address>:8765/overlay` (the black window shows the address).
- **Standings look a race behind or ahead:** pull before the race (Standings tab → Pull standings now).
- **The black window says Python wasn't found:** check the internet connection and run `start.bat` again; the first
  start downloads the overlay's own Python.
- **Gaps** are worked out from track position, accurate to a few tenths, and settle after the first lap.

---

## Files

For whoever looks after the overlay.

```
start.bat                  run against iRacing (checks for updates first)
start-demo.bat             a pretend race; start-demo-qualifying.bat a pretend qualifying session
start-race-control.bat     race control, for a steward (add --demo for a pretend race)
race-control-shortcut.bat  puts the VSPEED Race Control shortcut on the desktop (done by itself the first time)
restore-previous.bat       go back to the version before the last update
python-setup.bat           sets up the overlay's own Python the first time
data\                      YOUR files, never touched by updates:
  settings.json              control panel settings and layout
  profiles\                  each series' standings, bracket, live points and branding
  standings\                 the current series' standings, bracket, logo, race info and team
  results\                   race results, one folder per series
  league-upload\             races waiting to go to the league site (only if the upload is on)
  league-site-key.json       the league site sign-in and overlay key (keep it private)
  steward\                   race control's own data folder (start-race-control.bat): its settings, logs and
                             results, and in race-control\ each race's incident queue and calls, the league site
                             sign-in (signin.json) and races waiting to go to the site (outbox.json)
  logos\  sponsors\          league logos; sponsor and Pole Award images
  demo-field.csv             optional: your own drivers for the demo (car number,name per line)
  logs\  diagnostics\        logs, the black box and saved diagnostics
  backup\                    the last few versions, for restore-previous.bat
server.py                  reads iRacing and serves every page (port 8765; race control 8766)
standings.py  livepoints.py  profiles.py  pitrace.py  incidents.py  raceresults.py  announcer.py  leagueupload.py
racecontrol.py  simchat.py  rcsite.py
update.py  run.py  net.py  datafiles.py  diag.py
static\                    the overlay, control panel, race control and standings graphic pages
run-tests.bat              runs the tests (see below)
tests\                     the tests, and recorded races they replay (tests\fixtures)
relay\                     the announcer relay (Cloudflare Worker) and the announcer page
glr\                       the league site (Cloudflare Worker at vspeedlivetiming.app/glr)
```

### Tests

Double-click **`run-tests.bat`** (or `python -m unittest discover -s tests -t tests`) before every release. It takes
about 10 seconds and never touches the `data` folder: it uses a throwaway one.

- **Recorded races** (`tests\test_replay.py`): black boxes from real races, replayed through the overlay's own code with
  a stand-in for iRacing. They check what was seen on the broadcast (cautions, overtime, white and checkered flags, the
  winner, pit cycles) and compare every second with a checked copy (the golden file). When a change is *meant* to alter
  what the overlay shows, read the differences the test prints, then save new golden files with
  `python tests\replay.py --update`.
- **Adding a race:** after a race that went wrong, take `logs\blackbox.jsonl` from its diagnostics zip, gzip it into
  `tests\fixtures\<track>-<date>-<what>.jsonl.gz`, add it to `RECORDINGS` in `tests\replay.py` (track, length, laps),
  then save its golden file once the overlay handles it right. Black boxes hold car numbers only, no driver names.
- **Race logic, live points, standings, bracket and data safety:** the other `tests\test_*.py` files, with made-up
  drivers.
- **Race control** (`tests\test_race_control.py`): the incident queue, the catch-up after a replay, calls, the exact
  commands typed into iRacing, In the sim / Served / didn't show, clearing, and the race's saved file (picked up after a
  restart, damaged file kept aside). Sending runs against the demo race, so iRacing isn't needed.
- **Race control and the league site** (`tests\test_race_control_site.py`): signing in, the race file, waiting and
  trying again, races the site turns down, the other stewards' calls, and official results going with the sign-in,
  against a stand-in for the site. The site's own side is tested in `glr\test\racecontrol.test.mjs`.

The overlay uses the **Bahnschrift** font, which comes with Windows 10 and 11.

© 2026 VSPEED. All rights reserved. Not for redistribution. See `LICENSE`.
