# Next release: v1.5.54 (draft)

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

Announcer page (league races on GLR HUB): the driver on camera now has a card in place of the column of numbers: the season's numbers in one strip, the season in a few words, and in the playoffs what the driver needs to go through. During the race the card follows live points ("Right now: Running 3rd. 12 points over the cut line as they run."). Announcers can tap any driver in the running order or live points to open that driver's card. Nothing to set up.

Fixed: the overlay could show nothing for a whole session when one driver's licence colour came from iRacing in a form it couldn't read (seen Nov 14 in an overnight session). That colour is now left out and everything else carries on. Nothing to do.
