# League site tests

Runs the whole league site on your own machine against a throwaway database, so changes can be checked before they're pushed (every push to main goes live).

```
cd glr
node --no-warnings --test test/*.test.mjs
```

Needs Node 22 or newer (it uses Node's built-in SQLite in place of Cloudflare's D1). Nothing to install, and nothing touches the real site or Discord.

- `d1shim.mjs`: the stand-in for Cloudflare D1.
- `helpers.mjs`: `raceExport()` makes a race in iRacing's results-file format, and `makeSite()` gives a fresh copy of the site with a fake Discord sign-in (`site.who` is who signs in next), so pages, uploads and officials' tools can be tested.
- `core.test.mjs`: parsing results files, standings (points, bonuses, drop weeks, places moved, playoffs) and stats.
- `site.test.mjs`: pages, sign-in and roles, uploads, overlay results, fixes and removals, schedules, themes.

All drivers in the tests are made up (Racer A, Racer B, ...). Keep real names out of this folder.
