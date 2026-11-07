# Next release: v1.5.39 (draft)

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

Race recap: a new RACE RECAP tile on the Race tab's Graphics. Press it and a black bar slides out to the right from under the VSPEED logo with the race so far, for example 2 CAUTIONS (in yellow)  3 LEAD CHANGES; press it again to slide it back. The numbers update live, races only. It steps aside while the penalty box is up.

Narrower ticker: the ticker and the VSPEED logo box above it are now 292 px wide (were 330), and Race off pit road and Live points, which slide up over the ticker, narrow with them. A name too long for its space is squeezed slightly narrower (up to 15%) instead of being cut off with "…".

Driver info now shows where the driver started, next to the gap and lap times: STARTED P12 (STARTS P12 during the pace laps). In a multi-class race it's their starting place in their class, like the class place shown beside it. Races only.
