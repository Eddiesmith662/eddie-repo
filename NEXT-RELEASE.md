# Next release: v1.5.40 (draft)

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

Sign in with Discord: connect the overlay to the league site (now GLR HUB, glrhub.app) from Setup > League site upload with your own Discord account. Press Sign in with Discord, check the code, press Allow on the page that opens; you need the Producer role on the site. No more waiting for an admin to send you a key (keys still work). If the site stops accepting the sign-in, the panel says so and races wait on this PC until you sign in again.

League site key: the overlay key (and now the sign-in) is kept in a file of its own (data\league-site-key.json) instead of settings.json, so it no longer travels with copies of your settings. A saved key moves over by itself the first time; nothing to do.
