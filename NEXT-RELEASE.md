# Next release: v1.5.50 (draft)

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

Race control: when the steward is a session admin (so iRacing's live incident points are coming in), spins and car contacts that only the software's own detection saw, with no points from iRacing, no longer fill To review. They are usually cars braking (at the Charlotte Roval on Nov 12, 80 in one race). They stay under All, tagged unconfirmed, and a new Unconfirmed tick at the bottom of the Types menu brings them back. Stopped cars, wall hits and meatballs always show.
