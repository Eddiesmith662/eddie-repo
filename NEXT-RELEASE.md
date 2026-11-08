# Next release: v1.5.44 (draft)

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

Control panel: the Graphics buttons on the Race tab are grouped by when in the show they are used, each group in a thin blue frame: logo and league tag; prerace (broadcast team, track graphic, standings, grid, race info); during the race (ticker, driver info, telemetry, track conditions, race recap, biggest movers); after the race (results, next broadcast). The buttons work as before.

Ticker flag flash: with no sponsor logo loaded for the Green Flag, Restart or White Flag slot, the flash now still shows GREEN FLAG, RESTART ZONE or WHITE FLAG, centered on two lines, without "presented by". With a logo loaded it works as before.
