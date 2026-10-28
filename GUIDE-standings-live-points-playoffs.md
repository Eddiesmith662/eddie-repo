# VSPEED Standings, Live Points & Playoffs Guide

Pull the standings from Xtreme Scoring before every race, and everything else follows from them. This guide covers the standings graphic, live points, the playoff bracket and playoff-round live points, for overlay version 1.5.24 and later.

## One-time setup

Do these once per series: pick the series first in the Series picker (top right of the control panel). They're saved with that series and survive updates.

1. **Standings tab → Standings data:** paste the series' **Xtreme Scoring widget link** and press **Pull standings now**. The table fills in below.
2. **Standings tab → Title & logo:** set the title text and the logo shown on the standings graphic.
3. **Setup tab → Live points scoring:** check the points for each finishing place. **VSPEED default** fills in 46, 42, 41, then one less per place down to 1 point for 43rd. Press **Save points**.
4. **Same box, bonuses:** points for **Led a lap**, **Most laps led** and **Pole** (1 each by default). Most laps led goes to everyone tied for the most, on top of the led-a-lap point.

No Xtreme link? **The CSV file picker** on the Standings tab takes a file with the columns Pos, #, Driver, Pts and Wins (**Example CSV** gives a ready-made one).

## Every race night

First, check the **Series** picker (top right of the control panel) shows tonight's series.

- [ ] **Before the green flag, pull the standings** (Standings tab → **Pull standings now**). Pull *before* Xtreme posts tonight's race, or tonight's points get counted twice.
- [ ] **Glance at the Live points box** on the Race tab. Plain text = every driver was found in the standings. **Yellow "Not in standings: …"** = check who it names (next sections).
- [ ] **Playoffs only:** make sure Live points is set to **Playoffs** and the bracket is on the right round.
- [ ] **During the race:** Show / Hide live points from the Race tab as you need it.

## The standings graphic

The championship table from the pulled standings, run from the Standings tab (or the **Standings** tile on the Race tab).

| Control | What it does |
| --- | --- |
| **Show / Hide** | Puts the graphic on or off air |
| **Replay animation** | Plays the intro again while it's up |
| **Reload data** | Re-reads the saved standings into the graphic |
| **View: Standings / Playoff bracket** | Switches between the points table and the bracket (with an animation if it's on air) |
| **Playoff cutoff** | Turns on the green "in" block and red cutline: drivers with a win (Wins column) are LOCKED IN, the rest of the spots go on points, and the gap column becomes TO CUTOFF |
| **Edit by hand** | Fix a name, number or points in the table; **Save edits** keeps them until the next pull |

The standings graphic's playoff cutoff is its own setting: changing it doesn't move the live points line, and the other way round.

## Live points (Race tab)

Live points shows the championship as it would stand if the race ended right now. It rises up over the ticker like Race off pit road (showing one hides the other).

**How each driver's total is worked out:** standings points + the points for where they're running now (your points table) + bonuses (led a lap, most laps led, pole). Drivers are matched to the standings by name, then car number.

| Control | What it does |
| --- | --- |
| **Show / Hide** | On or off air. Show is refused (with the reason) if there's nothing to show, e.g. no standings loaded |
| **Places [1] – [15]** | Which places to show: 3 – 16 shows 3rd to 16th. Up to 15 drivers; a wider range keeps the first 15 |
| **Line after [12]** | Where the red cutoff line goes (12 = between 12th and 13th). Greyed out in playoff mode, where the round sets it |
| **Hide all (Graphics box)** | Hide all also hides live points |

**On the graphic:** green rows are above the line. **IN** = locked in: a driver with a win in the standings' Wins column, or the race leader. The right-hand column is each driver's points to the cutline (red when they're below it). A greyed name is in the standings but not in this race.

**The status line** (under the Live points title):

- `Last in: #9 R. Carter (+4)` = the last driver above the line and their margin. Hover for more detail.
- **Yellow** `Not in standings: #84 Jordan Mills` = a driver in the race who isn't in the standings, so they start from 0. A driver new to the series is expected here. Anyone else means their name *and* car number don't match Xtreme: they'll show up twice (once greyed with their real points, once from 0) until it's fixed. Hover to see everyone it found.

Live points follows the running order, so it moves around during green-flag pit stops while cars cycle through.

## The playoff bracket (Standings tab)

The bracket holds who is in each round: Round of 12, Round of 8, Championship 4 and Champion. You fill it by hand; a standings pull never changes it. The standings graphic shows it with **View: Playoff bracket**.

| Button | What it does |
| --- | --- |
| **Load top 12** | Puts the top 12 of the current standings into the Round of 12, seeded 1–12 (asks first if the bracket already has drivers) |
| **→** | Advances that driver to the next round. From the Championship 4 it makes them Champion |
| **×** | Takes a driver out of that round and every later one (Round of 8 onwards) |
| **✎** | Fixes a driver's name or car number everywhere in the bracket |
| **🏆** | Marks a driver who won a race *in that round* (lit up gold when on). Used by playoff live points; a win only counts in its own round, so it's not carried forward when you advance them |
| **Clear** | Empties the whole bracket (asks first) |

## Playoff live points

Switch it on once, on the Standings tab above the bracket: **Live points (Race tab) → Playoffs: use this bracket**. Live points then follows the bracket.

**What changes in playoff mode:**

- Only the drivers in the current round are listed (the latest bracket round with drivers in it). Everyone else still races, but isn't shown.
- The title shows the round: ROUND OF 12, ROUND OF 8 or CHAMPIONSHIP 4.
- The line sets itself: after 8th in the Round of 12, after 4th in the Round of 8.
- Regular-season wins no longer count. **IN** = a driver marked 🏆 for a win in this round, or a playoff driver leading the race. A non-playoff driver leading locks nobody.
- Points still come from the pulled standings, which Xtreme resets for the playoffs, plus tonight's points and bonuses.
- **Championship 4:** no points. The four are listed in running order with their position (P1, P2…) and the leader marked **CHAMP**, because the highest finisher of the four takes the title.

**Round by round:**

| Race | Round | Before the race | After the race |
| --- | --- | --- | --- |
| Last regular-season race | — | Normal race night | Once Xtreme has the final regular-season standings: pull, **Load top 12**, switch Live points to **Playoffs** |
| 1 | Round of 12, race 1 | Pull standings (everyone level after the reset) | If a playoff driver won: 🏆 on them |
| 2 | Round of 12, race 2 | Pull standings (now includes race 1) | Advance the 8 who made it with **→** (round winners first, then the best on points, as Xtreme shows) |
| 3 | Round of 8, race 1 | Pull standings (reset again) | If a playoff driver won: 🏆 on them |
| 4 | Round of 8, race 2 | Pull standings (includes race 3) | Advance the 4 who made it with **→** |
| 5 | Championship 4 | Nothing extra (it runs on finishing order) | **→** on the champion; switch Live points back to **Regular season** for next season |

Ties on points use Xtreme's order, which applies the league's tiebreaker. During a race, a tie goes to whoever is running ahead.

## Other series during the week

Each series you broadcast is saved separately. Pick it in the **Series** picker, top right of the control panel, next to Open live timing.

**What switches with the series:** the standings (Xtreme link, the pulled table and any hand edits), the standings graphic's title, logo and playoff cutoff, the playoff bracket (with its 🏆 marks), the live points table, bonuses, line, places and playoff mode, the ticker header, the league logo, and the Next broadcast text and logo.

**What every series shares:** race info, the broadcast team and the sponsor images.

| To | Do this |
| --- | --- |
| Change series | Pick it in the Series picker. If a graphic is on air, it asks first. Whatever you changed for the series you're leaving is kept |
| Add a series | **⋯ → New series (a copy of …)** to start from the current one, or **New empty series** to start clean (then pull its standings and set its points) |
| Rename one | **⋯ → Rename** |
| Delete one | **⋯ → Delete …** (only series that aren't loaded) |

Multi-class series: live points scores overall finishing position and ignores classes, so don't use it there.

## When something looks wrong

| What you see | Likely cause | Fix |
| --- | --- | --- |
| A driver appears twice, once greyed | Name and car number don't match Xtreme | Fix the name or number in Xtreme and pull again, or use **Edit by hand** on the Standings tab |
| Yellow "Not in standings" names a new driver | First race in the series | Nothing: they start from 0, which is right |
| Everyone's points look about one race too high | Standings pulled after Xtreme posted tonight's race | Pull before the race next time; for tonight, **Edit by hand** or carry on knowing the totals are high |
| Round of 12 shows regular-season totals | Xtreme hadn't applied the playoff reset when you pulled | Pull again once Xtreme shows the reset |
| Live points still shows the previous round | The bracket wasn't advanced | Advance the drivers with **→** on the Standings tab |
| A round winner isn't shown IN | 🏆 not ticked | Tick 🏆 on them in the bracket |
| Live points shows the wrong series' drivers | The wrong series is picked | Set **Regular season** only if this series isn't in its playoffs; otherwise pick tonight's series in the Series picker |
| Show does nothing and a message pops up | Nothing to show yet (not a race session, or no standings loaded) | Read the message: it says what's missing |

Stage points and penalties the league hands out after a race aren't in live points: they appear once they're in Xtreme and you pull again.
