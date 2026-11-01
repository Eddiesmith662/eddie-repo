# VSPEED Broadcast Overlay

Live iRacing graphics for vMix or OBS, run from a control panel in your browser: the ticker, driver info, grid,
standings, live points, podium, sponsors and more, built to the VSPEED Brand Style Guide.

**Contents:** [Quick start](#quick-start) · [Race night](#race-night) · [The control panel](#the-control-panel) ·
[The graphics](#the-graphics) · [Standings, live points and playoffs](#standings-live-points-and-playoffs) ·
[Several series](#several-series) · [Race results](#race-results) · [Announcer page](#announcer-page) ·
[Live timing window](#live-timing-window) · [Updates](#updates) · [When something goes wrong](#when-something-goes-wrong) ·
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
4. **Add the overlay to vMix or OBS:** a **Web Browser** input with `http://localhost:8765/overlay`, size
   **1920 × 1080**, on a layer above your iRacing capture. The page is see-through.
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

After the race: **Podium** (Race tab), then **Save diagnostics** (Setup tab) if anything looked wrong, and send the
zip to Claude. The race results save themselves.

---

## The control panel

`http://localhost:8765/control`. It works from a phone or tablet on the same network too: the black window shows
the address to use.

| Tab | What's on it |
|---|---|
| **Prerace** | Getting started checklist, race info, broadcast team, Next broadcast, broadcast text (ticker header and league logo), track graphic, Results board title |
| **Race** | Graphics tiles, Race off pit road, Podium, Live points, ticker and driver info settings, cameras, incident log, Grid and Pole Award, Sponsors, Announcer page link and notes |
| **Standings** | Standings graphic on/off, title and logo, Xtreme Scoring link or CSV, the standings table (edit, exclude), playoff bracket |
| **Layout** | Drag any graphic to move it, sliders to resize it. Changes show in vMix straight away and are saved |
| **Setup** | Live points scoring (points per place, bonuses), the overlay links for vMix, car renders, announcer page setup, diagnostics |

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
| **Sponsors** | Full screen | Six slots: Green Flag, Restart, White Flag, Sponsor Read 1–3 |

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
- **Sponsors:** click a slot's picture to load an image (1920 × 1080 PNG with a transparent background). Optional
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
- **⊘ Exclude** leaves a driver out of the standings graphic, live points and the bracket (e.g. not eligible for the
  playoffs). Everyone below moves up. **Include** puts them back.
- **Live points** (Race tab): standings points + what each driver would score for where they're running now +
  bonuses (led a lap, most laps led, pole). Points per place and bonuses are on the Setup tab.
- **Playoffs:** fill the bracket with **Load top 12**, advance drivers with **→**, mark round wins with 🏆, and switch
  live points to **Playoffs: use this bracket**.

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

## Updates

The overlay checks GitHub each time it starts. If there's a new version, the black window shows what's new and asks
**Install it now? [Y/N]**. With no answer it starts the version you have after 30 seconds. It never updates
during a broadcast; the control panel says when one is waiting. After an update, the pages in vMix reload themselves.

Everything you set up lives in the `data` folder, which updates never touch.

- **Something wrong after an update?** `restore-previous.bat` goes back to the version before.
- **Moving to a new PC:** copy the whole folder (or install fresh and copy just the `data` folder).
- **Python:** the overlay brings its own Python 3.13, set up the first time into `%LOCALAPPDATA%\VSPEED`. It doesn't
  matter which Python, if any, is installed on the PC. Delete that folder to remove it.

---

## When something goes wrong

- **Save diagnostics** (Setup tab) bundles the logs, the last 3 hours of iRacing data and your settings into one zip
  (also kept in `data\diagnostics`). Send it to Claude. Everything stays on your PC unless you share it.
- **Nothing on screen in vMix:** check the input is `http://localhost:8765/overlay` at 1920 × 1080 and the black
  window is still open. The Getting started checklist ticks *overlay added* once vMix has opened it.
- **"Waiting for iRacing":** iRacing has to run on the same PC as the overlay. vMix can be on another PC: use
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
restore-previous.bat       go back to the version before the last update
python-setup.bat           sets up the overlay's own Python the first time
data\                      YOUR files, never touched by updates:
  settings.json              control panel settings and layout
  profiles\                  each series' standings, bracket, live points and branding
  standings\                 the current series' standings, bracket, logo, race info and team
  results\                   race results, one folder per series
  logos\  sponsors\          league logos; sponsor and Pole Award images
  demo-field.csv             optional: your own drivers for the demo (car number,name per line)
  logs\  diagnostics\        logs, the black box and saved diagnostics
  backup\                    the last few versions, for restore-previous.bat
server.py                  reads iRacing and serves every page (port 8765)
standings.py  livepoints.py  profiles.py  pitrace.py  incidents.py  raceresults.py  announcer.py
update.py  run.py  net.py  datafiles.py  diag.py
static\                    the overlay, control panel and standings graphic pages
relay\                     the announcer relay (Cloudflare Worker) and the announcer page
```

The overlay uses the **Bahnschrift** font, which comes with Windows 10 and 11.

© 2026 VSPEED. All rights reserved. Not for redistribution. See `LICENSE`.
