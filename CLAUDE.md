# VSPEED overlay: notes for Claude

The broadcast overlay is the Python program at the root plus `static/`. `glr/` (league site) and `relay/` (announcer
relay) are separate pieces with their own rules: leave them alone unless the task is about them.

Read the plan doc before building anything: https://claude.ai/artifact/DFgAXMU5VZzYJ5SLFK92UU (a Claude Doc: read it
with the docs tools, not a web fetch). Its Principles, Decisions and "How Eddie works" sections apply here. Say the plan
before building, batch changes, and ask before adding anything that wasn't requested.

The latest handoff note (`HANDOFF-*.md`) says what was done most recently and what's still open.

## Three chats, one repo

Three Claude chats work on this repo at once, all on `main`. Each owns one piece:

| Chat | Owns | Where it runs |
| --- | --- | --- |
| Overlay | the root Python program and `static/` (all but the race control files), `tests/`, releases | the producer's PC (`C:\vspeed-overlay`), with iRacing |
| Race control | `racecontrol.py`, `simchat.py`, `static/racecontrol.html`, `start-race-control.bat`, and the race control parts of `server.py` | its own chat |
| GLR site | `glr/` | its own chat |

- **Stay in your piece.** A change mostly in another chat's piece is that chat's job: say so and stop. A job that
  touches two pieces goes to the chat for the side that changes most (plan doc). Shared files (`server.py`, `README.md`,
  `CLAUDE.md`, `datafiles.py`, `tests/support.py`): change only what the task needs, and say in the commit message what
  you changed there.
- **Pull first.** Start every task with `git pull --rebase origin main`; another chat may have pushed since.
- **Push small, push soon.** When a task is done, the tests pass and the user agrees, `git pull --rebase` again, run the
  tests again, then push. Work left unpushed is invisible to the other chats. If the rebase conflicts, stop and tell the
  user; never force-push, and never undo another chat's commit.
- **Releases come only from the overlay chat.** Race control ships inside overlay releases: the race control chat says
  when a change is ready, and the overlay chat checks it (tests, demo, live where it matters), writes the release notes,
  and bumps VERSION after the user publishes. The GLR site needs no release: a push to `main` deploys it.
- **Shared memory is in the repo and the plan doc, not in a chat.** Decisions and what's built go in the plan doc;
  working rules go here; a handoff note for the next session is committed as `HANDOFF-<date>.md`.

## Tests

- Run them before and after every change: `run-tests.bat`, or
  `"%LOCALAPPDATA%\VSPEED\python-3.13.16+20261013\python.exe" -m unittest discover -s tests -t tests` (about 7 s).
- They use a throwaway data folder (`VSPEED_DATA`, set by `tests/support.py`). Never point a test at the real `data/`
  folder: it holds the producer's settings, standings, series and results.
- `tests/test_replay.py` replays recorded races (`tests/fixtures/*.jsonl.gz`, black boxes from diagnostics zips) through
  the real code. If a change alters what the overlay shows, print and read the golden differences first; only then save
  new golden files with `python tests\replay.py --update`, and say in the reply what changed and why.
- A bug found on race night: add its black box as a fixture (README, "Tests") and a failing test before fixing it.
- Test data uses made-up drivers. No real driver names in the repo.

## Code conventions

- Save data files with `datafiles.write_json` / `write_text` (temp file + swap, retries OneDrive locks) and read them
  with `datafiles.load_json` (keeps damaged files aside, falls back to `.bak`). Never `open(path, "w")` on a data file.
- Anything that can fail on race night must never stop the telemetry loop: wrap it and log with `diag.error`.
- Nothing goes on air by itself: new graphics wait for a button press in the control panel.
- Comments and messages are written for producers and maintainers in plain words, with the real race that showed a
  problem (track, date) where there is one.

## Working here

- On the producer's PC the overlay is a git checkout of the repo (GitHub: Eddiesmith662/eddie-repo) at
  `C:\vspeed-overlay`, on `main`. Git is at `C:\Program Files\Git\cmd\git.exe` (not on the tools' PATH: call it by that
  path). Pushing follows "Three chats, one repo" above. Other producers' installs are plain copies, kept up to date by
  the updater from published releases.
- Don't accept the start-up update in a git checkout: it replaces program files outside git (the replaced ones go to
  `data/backup/`). Use `git pull` instead.
- Before big changes, make a dated copy of the whole folder next to it.
- Don't run the overlay against the real `data/` folder to test: copy the program into the scratchpad with its own
  `data/`, or set `VSPEED_DATA`.
- Releases: push to main with release notes; the tag is published by hand, then VERSION is bumped (plan doc).
