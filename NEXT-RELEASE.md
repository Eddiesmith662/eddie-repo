# Next release: v1.5.38 (draft)

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

Only one copy at a time. Starting the overlay while it's already open in another window now says so and stops, instead of running two copies that split your button presses between them (Richmond, Nov 6). Close the open window first to restart.

Penalty box: in league races, with the league site key set up, the box and live timing show race control's penalty for a black-flagged car (for example STOP & GO 30 SEC, DRIVE-THROUGH) with the steward's reason. Race control's other calls (time, points, places, DQ, warning) are listed in live timing, each with its own Show. Nothing goes on air until you press Show.

Race control now uses port 8766 (open http://localhost:8766/racecontrol) and keeps its own files in data\steward, so it can run on the same PC as the overlay. Calls from earlier versions are copied over automatically. Stewards can sign in to the league site with Discord, and their calls go to the site; a race with no broadcast can send its official results with that sign-in.
