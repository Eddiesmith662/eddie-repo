# VSPEED Broadcast Overlay

A custom iRacing overlay for broadcasting software, built to the VSPEED Brand Style Guide V1.

## What's included

| Graphic | Where | Notes |
|---|---|---|
| VSPEED logo | Top left | 92% grey plate with red accent, slanted or straight: right-click (or press and hold) the VSPEED logo tile to pick |
| League logo + LIVE / REPLAY tag | Top right | Tag switches to REPLAY automatically when iRacing plays back |
| Ticker (timing tower) | Left | Live running order, interval or gap to leader, multi-class color stripe, highlights the camera car. A PIT tag pops out to the right on pit road, times the stop in the box and shows the final stop time. If a stop reaches 50 seconds the car is treated as parked and the tag hides until its next pit visit |
| Driver info | Bottom | Follows whichever car the iRacing camera is on. In multi-class races the line under the name takes the class color and grows into a small class label |
| Flag banners | Top center | Switched off for now; the ticker shows flags instead (flag square, flag wipes and the CAUTION / WHITE FLAG / CHECKERED band) |
| Results board | Center | Live running order with gaps, from iRacing |
| **Penalty box** | Top center | When a driver gets a black flag they appear in the live timing window's Penalties list; press **Show** there to put the box up for 8 seconds: car number, driver, position, and the reason if you pick one (Speeding / Passing under yellow) |
| **Biggest movers** | Bottom right | Top 5 drivers by positions gained since the start (start, now, gained); within each class in multi-class races. Turn it on with the Biggest movers tile; it steps aside while race info is up |
| **Grid** | Bottom | Starting grid from qualifying, one row (two cars) at a time: position tabs, ROW n, car render, car name, driver, qualifying time and number |
| **Standings** | Center | Championship points from Xtreme Scoring (top 20, two columns), playoff cutoff line, playoff bracket |
| **Race info** | Bottom right | The race analysis box (title + 5 lines) |
| **Broadcast team** | Bottom center | Up to 3 people with roles |
| **Track graphic** | Anywhere | A ready-made track graphic (PNG / JPG / WebM) from a Google Drive folder, wiped in and out |
| **Sponsors** | Full screen | Six sponsor slots on the Race tab (Green Flag, Restart, White Flag, Sponsor Read 1–3): load an image for each, then Show / Hide. One on air at a time, optional auto-hide |

Standings, race info and broadcast team are your existing standings graphic (same look and animations), now run by this server instead of the separate Standings Control program. They live in the main overlay, and while one is on screen the live graphics it would cover step aside on their own.

The **control panel** (Prerace, Race, Standings, Layout and Setup tabs; race info, broadcast team, broadcast text, the track graphic and the results board title are on the Prerace tab) toggles every graphic, edits all text, and switches the iRacing camera to any car with one tap. It works from a phone or tablet on the same network.

## Setup (Windows broadcast PC)

1. Install Python 3.10 or newer from python.org. Tick **"Add Python to PATH"** during install.
2. Put this folder anywhere, for example `C:\VSPEED\vspeed-overlay`.
3. Double-click **`start.bat`**. The first run installs `pyirsdk` automatically and creates the `data` folder.
4. Put your league/series logo for the top right into `data\logos` (transparent PNG, e.g. `league_logo.png`). Add more logos with any name and pick them on the Prerace tab.
5. In your broadcasting software, add a **web browser (browser source) input**
   - URL: `http://localhost:8765/overlay`
   - Size: 1920 × 1080
   - Put it on a layer above your iRacing capture. The page is transparent.
6. Open the control panel at `http://localhost:8765/control`. The console window also prints a link for your phone.

**Moving things around:** the control panel's **Layout** tab shows a preview of the screen with every graphic on it. Drag any graphic to move it and use the sliders to resize it. It updates live in your broadcasting software as you go and is saved for next time. While standings, race info or the team box are on air, any live graphic they overlap steps aside on its own.

**Track graphic:** in the **Prerace** tab's Track graphic section, press **Browse…** and pick the folder with your track graphics in the Windows folder window (from a phone or another PC, Browse shows an in-page folder list instead) (any folder on the PC, including a Google Drive for desktop folder), or paste its path and press Save. Pick tonight's track from the list, then use **Show track** / **Hide** or the Track graphic tile. Tip: right-click the folder in File Explorer and choose **Offline access → Available offline**, so nothing has to download at the moment you hit Show.

**Grid:** on the Race tab, press **Show from row 1** (or the Grid tile). Set *Next row* to **Automatic** (steps every *Seconds per row*) or **Manual** (only moves when you press **Next row**). After the last row it hides or starts over. **Previous / Next row** work in both modes. Car renders come from iRacing: the overlay asks iRacing's local service for each car with its paint scheme and the custom paint in your iRacing paint folder (Documents\iRacing\paint by default). The render setup is saved; the test and paint tools live in the **Setup** tab under *Car renders*.

**Sponsors:** in the Race tab's Sponsors section, press **Load image…** on a slot and pick the sponsor's picture. Sponsors play full screen, exactly as the image is, so make them 1920 × 1080 PNGs with a transparent background (smaller images are centered). It's saved in the `data\sponsors` folder and stays loaded for next time. **Show** puts it on air (Show on another slot swaps it in), **Hide** or **Hide sponsor** takes it off. Set *Hide by itself after* if you want it to drop off on its own. Showing a sponsor also turns the driver info off; it stays off afterwards until you turn it back on with the Driver info tile.

**Standings:** open the Standings tab in the control panel, paste your Xtreme Scoring widget link and press **Pull standings now**. It also pulls by itself every time the overlay starts.

**Moving over from Standings Control:** close the old program first, since both use port 8765. To keep your saved title, logo, bracket and team/race-info text, copy `config.json`, `standings.json`, `bracket.json` and your `logo.*` file from the old program's folder into this folder's `data\standings` folder (create it if it isn't there yet). Old browser inputs for `/analysis` and `/team` keep working; the standings graphic itself is now at `/standings` (or just use the single `/overlay` input).

**No iRacing handy?** Double-click **`start-demo.bat`** to run a fake 24-car race so you can test the look in your broadcasting software.

To check the layout in a normal browser over a sample background, open `http://localhost:8765/overlay?preview`.

## Fonts

The overlay uses **Bahnschrift** (SemiBold for headers, Light for sub-text; the brand guide spells it "Bahnscrift"), which comes with Windows 10/11, so your broadcasting software picks it up automatically. It falls back to Arial per the brand guide.

## Race night tips

- **Live timing window:** press **Open live timing ↗** at the right of the panel's top tab bar (or go to `http://localhost:8765/timing`) and park it on a second monitor.
  - Columns: position, number, driver, positions gained (▲) or lost (▼) since the start, gap to the leader (lapped cars show +1 LAP, +2 LAPS… in orange), current speed in mph, last lap, best lap (the fastest lap of the race in purple, a driver's personal best on their last lap in green) and how many pit stops they've made (only stops in their pit box count, not drive-throughs) and their last pit stop time, which stays until their next stop. Both start over each session. On a phone the lap and pit columns are hidden to fit.
  - Click a driver to put the camera on them; **right-click** (or press and hold on a tablet) to pick which camera to cut to.
  - The **Cameras** list on the left switches camera group for the current driver (it spreads into 2–3 columns when a track has lots of cameras).
  - Replay controls underneath: ⏮ Start, rewind / fast-forward (press again to go faster), play, pause, **Live**, speeds ×0.25–×4, **Sim UI** (show/hide iRacing's own UI), **◀ LAP ▶** (jump to the start of the previous / next lap of the car on camera), **↻ REPLAY** (jump back the set number of seconds and play) and **◀ On Track / On Track ▶** (camera to the car behind / ahead on track).
- **Replays:** the tag flips to REPLAY on its own. Still run the VSPEED Instant Replay stinger in your broadcasting software before and after, per the guide. The **Live** button in the live timing window sends iRacing back to the live point.
- **Caution, white and checkered flags:** when iRacing throws one of these, the ticker's rows flash solid in the flag (yellow, white, or a checkered pattern) for about 2 seconds, then the running order fades back in, and a matching CAUTION / WHITE FLAG / CHECKERED band stays under the lap line while that flag is out.
- **Meatball flag:** when iRacing gives a driver the meatball (repair) flag, their row on the ticker gets a pulsing orange outline and a meatball flag (black flag, orange disc) pops out to the right for 10 seconds (it replaces a PIT tag for that time).
- **Penalties:** when a driver gets a black flag, a **Penalties** list appears at the top of the live timing window, and a black flag shows next to their name. Nothing goes on screen by itself: pick **Speeding** or **Passing under yellow** if you want a reason on it (press again to clear), then press **Show** to put that driver's penalty box up for 8 seconds. Press Show on several and they play one after the other; **Hide box** takes it down and cancels the rest. Each driver stays in the Penalties list for 30 seconds, then drops off (the black flag next to their name stays until they serve). iRacing doesn't say what a penalty was for, so the reason only shows if you pick one.
- **Qualifying:** in qualifying sessions the ticker orders drivers by best lap (pole time on P1, gaps to pole below, — for no time yet), and cars on a flying lap get a green wash. The driver info for the car on camera gets a box on the right: on a flying lap it shows the live gap **TO POLE** (green = faster than pole, yellow = slower) and the position that pace would give them; when the lap ends it shows the **lap time** and their position for a few seconds (red if it beat their best). It's hidden on out laps, in the pits, and once a lap falls 2 seconds off pole pace. To try it without iRacing: double-click `start-demo-qualifying.bat`.
- **Lapped cars:** the ticker shows +1 LAP, +2 LAPS… for any car that's a lap or more down, in both Interval and To leader mode.
- **Driver info mode:** "Always on" or "8s on camera cut" if you want it to pop in only after each switch.
- **Multi-class:** with two or more classes the ticker groups by class, IMSA style: a header bar in each class color, fastest class first, class positions and gaps within the class. Set the rows for the two classes on the Race tab: the two boxes are labeled with the classes in the current session (fastest first, default 5 and 15); extra cars page through at the bottom of their group. Switch to *One combined list* if you prefer, or pick a single class to show only that class. To try it without iRacing: `python server.py --demo --multiclass`.
- Settings and text are saved to `data\settings.json`, so they survive restarts and updates.

## Updates

The overlay updates itself from GitHub. Each time you start it, it checks for a newer version (a second or two; if there's no internet it just starts):

- If there is one, the console window shows what's new and asks **Install it now? [Y/N]**. Press **Y** to update, or **N** to start the version you have. With no answer it starts the current version after 30 seconds, so it never waits forever.
- It only ever updates at startup, never while a broadcast is running. If an update comes out while the overlay is already running, the control panel shows *Update ready · restart the overlay to install*.
- Your own files are never touched by an update: everything in the `data` folder (settings, layout, standings, sponsors, logos) stays as it is.
- The version you're on is shown at the top of the control panel and in the console window.

**Something wrong after an update?** Double-click **`restore-previous.bat`** to go back to the version you had before. The last few versions are kept in `data\backup`. It will offer the newer version again next start; press N to stay on the older one.

**Moving to a new PC:** copy the whole folder, or install fresh and copy just the `data` folder over.

## Known limits (first version)

- Gaps are estimated from track position and the leader's last lap time, the same approach most overlay tools use. They're accurate to a few tenths and settle after the first lap.
- iRacing must be running on the same PC as this server, since the SDK only works locally. Your broadcasting software can be on another PC: use `http://<this-pc-ip>:8765/overlay`.
- Built and tested against the iRacing data format without a live session. Expect some tuning after the first real race; send notes on anything that looks off.

## Files

```
start.bat            run against iRacing (checks for updates first)
start-demo.bat       run the fake race
start-demo-qualifying.bat  run a fake qualifying session
restore-previous.bat go back to the version before the last update
data/                YOUR files, never touched by updates (created on first run):
  settings.json        panel settings and layout
  standings/           saved standings data, bracket, team and race info, standings logo
  sponsors/            sponsor images loaded from the Race tab
  logos/               league logos for the top right
  backup/              the last few versions, for restore-previous.bat
server.py            bridge: reads iRacing, serves the pages (port 8765, change with --port)
standings.py         standings, bracket, race info and team (ported from Standings Control)
run.py               starts everything: update check, then the server
update.py            the updater
datafiles.py         where the data folder lives (moves an older install's files into it)
VERSION              the version number
static/overlay.html  the broadcast overlay
static/control.html  the control panel
static/standings-graphic.html  the standings / race info / team graphic
static/assets/       built-in images (VSPEED logo, preview background)
```

## License

© 2026 VSPEED. All rights reserved. Not for redistribution. See `LICENSE`.
