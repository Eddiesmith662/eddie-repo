# Next release: v1.5.45 (draft)

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

Sign in to use the overlay: the overlay now needs a producer signed in to GLR HUB with Discord. After updating, the control panel shows a sign-in screen: press **Sign in with Discord**, check the code, and press **Allow** on the page that opens. Anyone with the Producer role can sign in; ask a GLR HUB admin if you don't have it. A PC already signed in for sending results opens straight away. Until someone signs in, the broadcast pages in OBS or vMix stay blank and come up by themselves afterwards. The overlay checks with the site only when it starts, never during a race, and keeps working for 5 days if the site can't be reached.

League site results: the same sign-in sends each league race's results by itself: the League site upload on/off switch and the key box on the Setup tab are gone. The Setup tab's League site section shows who is signed in, with **Sign out**, and the last results sent. A red bar at the top of the control panel says when a league race's results won't reach the site. An overlay key saved before keeps sending results if the sign-in stops working.
