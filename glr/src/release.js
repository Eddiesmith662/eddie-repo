// The latest VSPEED program release on GitHub, for the Downloads page. One program, two start files: producers use
// start.bat (the broadcast overlay), stewards start-race-control.bat. The site only links to GitHub's zip; it never
// hosts a copy. GitHub allows 60 unauthenticated API calls an hour per address, so the answer is kept in the
// database for an hour, and the last good one is used if GitHub can't be reached.
import { getSetting, setSetting } from "./db.js";

export const REPO = "Eddiesmith662/eddie-repo";
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const KEEP_MS = 60 * 60 * 1000;
const TAG = /^v?\d+(\.\d+){1,3}$/;

export const zipUrl = tag => `https://github.com/${REPO}/archive/refs/tags/${tag}.zip`;

// { tag, url }: the newest release's zip, or { tag: "", url: RELEASES_PAGE } if it has never been found
export async function latestRelease(db) {
  let tag = await getSetting(db, "release_tag");
  const checked = Number(await getSetting(db, "release_checked")) || 0;
  if (Date.now() - checked > KEEP_MS) {
    try {
      const r = await fetch(API, { headers: { "user-agent": "GLR-HUB (glrhub.app)", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(4000) });
      const j = r.ok ? await r.json() : null;
      if (j && TAG.test(j.tag_name || "")) { tag = j.tag_name; await setSetting(db, "release_tag", tag); }
    } catch { /* GitHub down or slow: keep the last one we knew */ }
    await setSetting(db, "release_checked", Date.now());   // a failure waits an hour too, so a GitHub outage isn't asked every visit
  }
  return tag ? { tag, url: zipUrl(tag) } : { tag: "", url: RELEASES_PAGE };
}
