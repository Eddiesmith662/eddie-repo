# Next release: v1.5.46 (draft)

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

Race control is race control only: started with start-race-control.bat, it now shows just the race control page. The overlay's control panel, broadcast pages and buttons answer "This is race control. Start the overlay to use graphics." Before, opening the control panel on race control's port gave the whole overlay without signing in. Stewards see no change: race control still sends its calls and official results with the steward's sign-in. Producers keep starting the overlay as usual.

Race control: on the track map, cars on pit road are now drawn on the pit lane instead of on the track beside it (still in blue). At tracks with two pit roads, such as Bristol, each car shows on the one it is using. Kansas, Nashville and Spielberg GP no longer show the cars going round the wrong way.

Race control: a Session strip under the top bar for actions that aren't about one driver: throw a caution (press twice), add or take away caution laps or set green in N laps, single or double-file restarts, a message to everyone, and advance to the next session (asks first). Each is typed into iRacing's chat and listed under Calls with who sent it. Incidents from practice and qualifying no longer carry over into the race's list, and the track map marks an incident for one minute.
