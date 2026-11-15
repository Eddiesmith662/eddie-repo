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

Incident log: on road courses, cars braking for a slow corner are no longer logged as spins or car contacts. The log learns the usual speed at each point of the lap from the cars themselves and only logs a car that is well under it (at the Charlotte Roval on Nov 12, 70 false ones in one race came from the hairpin). Nothing to set; ovals work as before. In race control this leaves far fewer incidents to review, for admins and non-admins alike.

Series from GLR HUB: the Series picker (top right of the control panel) now also lists the series on the league site. Pick one and the overlay sets up a series for it with its standings from the site and its name as the standings title and ticker header; no Xtreme link or CSV needed. Picking it again, or **Refresh from GLR HUB** on the Standings tab, pulls the latest standings (never by itself). A series with several classes gets a Class picker. Live points matches drivers to these standings by iRacing ID, so a different name in iRacing no longer shows as "not in the standings". Your existing series, Xtreme Scoring and CSV work as before.

Series from GLR HUB also bring their scoring, cutoff and logo: when the series has its own points table on the site, live points uses that table and its bonuses, so "points as they run" match what the site will publish; the playoff cutoff is set to the series' playoff field; and the series logo becomes the standings logo and the league logo (top right). These are replaced at each refresh, except a logo you picked yourself. A series that takes its points from iRacing keeps the points table on the Setup tab.

Series from GLR HUB in the playoffs: when the series' rounds are 12, 8 and 4 drivers, the playoff bracket, live points' playoff mode and the cutoff for the round being run (8 from the Round of 12, 4 from the Round of 8) are set from the site at each refresh, with wins and missed races in the round marked. The **Next broadcast** box is filled in with the series' next race from the site's schedule (track, date, time in Eastern time).

Live points scoring (Setup tab) has two new rules, both off unless you set them: a **Win** bonus, and **A car with 0 laps scores no points for its place**.
