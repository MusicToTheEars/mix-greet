#!/usr/bin/env node
/**
 * Render the site's LED meter to an animated GIF for the confirmation email.
 *
 *   node scripts/build-meter-gif.mjs        # writes ./meter.gif
 *
 * Why a GIF at all. Email clients do not run JavaScript, and the ones that
 * matter do not run CSS keyframes either — Gmail strips @keyframes outright,
 * and the Word engine behind Outlook for Windows never had them. An animated
 * GIF is the only motion every major client agrees on, and Outlook's fallback
 * is well defined: it draws frame 1 and stops. So frame 1 has to be a frame
 * that looks deliberate on its own, which is why the loop is captured starting
 * at the fully-lit phase rather than wherever the clock happens to be.
 *
 * Why render the real stylesheet instead of drawing the bars here. The meter is
 * 26 segments, four palettes and sixteen hand-tuned keyframe tracks in
 * brand.css. A second implementation would be a second thing to keep in step,
 * and the first time somebody retuned the site the email would quietly diverge.
 * This loads brand.css itself, so the GIF is the site's meter by construction.
 *
 * How the phase is controlled. Every segment animates on the same 1.8s
 * `steps(1,end)` timeline, and every keyframe in brand.css sits on a multiple
 * of 4% — 25 distinct states, 72ms apart. Each frame is captured by pausing the
 * animation and seeking it with a negative `animation-delay`, so the output is
 * deterministic: the same 25 states in the same order on every run, rather than
 * whatever 25 screenshots happened to catch.
 */

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const OUT = join(REPO, "meter.gif");

// 1.8s / 25 states. Held in one place because the frame delay below has to
// agree with it or the GIF runs at a different speed from the website.
const STATES = 25;
const LOOP_MS = 1800;
const STEP_MS = LOOP_MS / STATES; // 72
// GIF delays are centiseconds, so 72ms is not expressible. 7cs makes the loop
// 1.75s against the site's 1.80s — a 2.8% drift nobody can see, and the only
// alternative is resampling the whole loop onto a 10ms grid for nothing.
const DELAY_CS = 7;

// 2x the 600px the email displays it at, so it is not soft on a retina phone.
const WIDTH = 1200;

const page = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="file://${join(REPO, "brand.css")}">
<style>
  html,body{margin:0;padding:0;background:#F5F4F1}
  /* The meter's own margin is a page rhythm, not part of the object. */
  .meter{margin:0 !important}
  #shot{width:${WIDTH}px;padding:0}
</style>
<div id="shot">
  <div class="meter">${"<i></i>".repeat(26)}</div>
</div>`;

const work = mkdtempSync(join(tmpdir(), "mg-meter-"));
const html = join(work, "meter.html");
writeFileSync(html, page);

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const tab = await ctx.newPage();
await tab.goto("file://" + html);
const el = tab.locator("#shot");

for (let i = 0; i < STATES; i++) {
  // Negative delay seeks a paused animation to that point on its timeline.
  // Applied to every animated segment at once, so the whole bar is sampled at
  // one instant rather than 26 slightly different ones.
  //
  // +0.5 step: land in the MIDDLE of each 72ms plateau. steps(1,end) switches
  // exactly on the boundary, and sampling on it is a coin flip between the two
  // neighbouring states — which showed up as two visibly identical frames and
  // one missing state.
  const at = -((i + 0.5) * STEP_MS) / 1000;
  await tab.addStyleTag({
    content: `.meter i{animation-play-state:paused !important;animation-delay:${at}s !important}`,
  });
  await el.screenshot({ path: join(work, `f${String(i).padStart(2, "0")}.png`) });
}
await browser.close();

// ImageMagick rather than ffmpeg: the ffmpeg on this machine is linked against
// an x265 dylib it cannot load and refuses to start at all, and none of this
// needs a video codec.
//
// One shared 64-colour palette across every frame (+remap against a histogram
// of all of them), because a per-frame palette lets the green shift hue between
// frames — precisely what the eye catches on a bar that is meant to read as a
// physical object. -layers OptimizeTransparency then stores only what changed
// between frames, which is what keeps 25 frames of a 1200px bar small.
const frames = Array.from({ length: STATES }, (_, i) =>
  join(work, `f${String(i).padStart(2, "0")}.png`),
);
const histogram = join(work, "palette.gif");
execFileSync("magick", [...frames, "-colors", "64", "+append", histogram], {
  stdio: ["ignore", "ignore", "pipe"],
});
execFileSync(
  "magick",
  [
    "-delay", String(DELAY_CS),
    "-loop", "0",
    ...frames,
    "-remap", histogram,
    "-layers", "OptimizeTransparency",
    OUT,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const size = statSync(OUT).size;
const head = readFileSync(OUT).subarray(0, 6).toString("latin1");
console.log(`wrote ${OUT}`);
console.log(`  header  ${head}`);
console.log(`  frames  ${STATES} at ${DELAY_CS}cs  (${(STATES * DELAY_CS * 10) / 1000}s loop vs ${LOOP_MS / 1000}s on the site)`);
console.log(`  size    ${(size / 1024).toFixed(1)} KB`);
rmSync(work, { recursive: true, force: true });
