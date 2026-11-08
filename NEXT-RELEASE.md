# Next release: v1.5.43 (draft)

The release notes for the next overlay release, built up as changes land. Producers see the notes in the black window
when the update is offered (the first 25 lines), so each change gets one short paragraph in plain words: what's
different for a producer or a steward, and what to do, if anything.

How it works (CLAUDE.md, "Three chats, one repo"):
- Any chat that pushes a change producers or stewards will notice adds its paragraph under "Notes" in the same commit.
  Changes nobody sees (tests, refactors, the GLR site, which deploys on its own) don't go here.
- The overlay chat tidies the notes before a release, checks them against `git log` since the last tag, gives them to
  Eddie to paste into the GitHub release, and after it's published empties this file for the next version (with the
  VERSION bump).

## Notes

Race control: a Save diagnostics button at the top right of the Race Control page, like the overlay's. It saves a zip with the logs, the black box and race control's race files (the incident queue and calls) to send when something goes wrong; the league site sign-in is never in it.

Announcer page: in a league race, the driver on camera now shows their season in that series under their name (championship place and points, starts, wins, top 5s, top 10s, average finish, laps led) and their bio, team, sponsor and hometown when they have written them on the league site. Nothing to set up.

Race control: the line under Calls now says where the race is really saved (data\steward\race-control). Only the label was wrong; nothing was saved in the wrong place.

Control panel: the Graphics buttons on the Race tab are grouped by when in the show they are used, each group in a thin blue frame: logo and league tag; prerace (broadcast team, track graphic, standings, grid, race info); during the race (ticker, driver info, telemetry, track conditions, race recap, biggest movers); after the race (results, next broadcast). The buttons work as before.
