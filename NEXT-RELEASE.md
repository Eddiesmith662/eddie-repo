# Next release: v1.5.47 (draft)

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

Penalties box (live timing): it no longer covers the live timing when race control makes a lot of calls. Past about three rows it scrolls, and the ▾ button collapses it to one line ("Penalties · 1 black flag · 5 race control calls"), remembered on that PC; a new black flag opens it again. A race control call you've shown leaves the list 2 minutes later; ones not shown yet stay.

Announcer page: no more producer codes. Switch the feed On (Setup tab) and the overlay gets your show from GLR HUB with your sign-in, so each producer has one announcer link, whichever series they broadcast. If you'd already pasted a code, you keep that show and your announcers' links keep working. The Producer codes button and the paste box are gone.
