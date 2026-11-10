# Next release: v1.5.48 (draft)

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

Incident points live (overlay incident log and race control): when you're an admin of the hosted or league session, the incident boxes now get iRacing's incident points as they happen (+1x off track, +2x loss of control, +4x contact), instead of only after the checkered. A wreck with many cars at once is logged too. Results sent to GLR HUB still use iRacing's final incident counts. Not an admin: no change.
