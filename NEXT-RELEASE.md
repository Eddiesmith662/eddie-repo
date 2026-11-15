# Next release: v1.5.52 (draft)

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

Season stage: one new setting on the Standings tab says where a series is in its season (no playoffs, playoffs ahead, Round of 12, Round of 8, Championship 4), and the standings graphic, live points and the bracket all take the cutoff line and who is "locked in" from it. It replaces the standings cutoff number, live points' "Line after" and the "Regular season / Playoffs" switch above the bracket. Nothing to do after updating: each of your series starts in the stage that matches what it showed before.

In a playoff round, LOCKED IN on the standings graphic now means the driver is marked 🏆 in that round of the bracket, the same mark live points uses. The standings' Wins column shows the season's wins all year again (v1.5.51 had it count only wins in the round, for GLR HUB series). Live points lists the round the stage says, not the latest round with drivers in it.

A series with no playoffs ("Regular season, no playoffs") shows live points as the plain championship order: no cutoff line and nobody marked IN. You can add a plain line after any place, with your own words on it.

Series from GLR HUB get their stage from the site at each refresh, and in the playoffs their bracket. Press **Refresh from GLR HUB** once after updating.
