#!/usr/bin/env node
/**
 * Render the partners strip to a scrolling GIF for the confirmation email.
 *
 *   node scripts/build-partners-gif.mjs      # writes ./partners.gif
 *
 * Same reasoning as scripts/build-meter-gif.mjs: email clients do not run
 * JavaScript, Gmail strips @keyframes, and the Word engine behind Outlook for
 * Windows never had them. A GIF is the only motion every major client agrees
 * on, and Outlook's fallback is well defined — it draws frame 1 and stops, so
 * frame 1 must be a frame that reads as a deliberate still. Here that is the
 * loop at rest: the first three logos, evenly spaced, nothing half-cropped.
 *
 * The strip is rendered from /partners/*.png, the same files rsvp.html points
 * at, so the email and the invite page cannot show different partners.
 *
 * The scroll is driven by translating the track by hand rather than letting the
 * CSS animation run: a captured animation is at the mercy of whatever the
 * compositor did that millisecond, and the loop has to close EXACTLY on itself
 * or the GIF visibly jumps once per cycle. One set of logos is duplicated and
 * the track is walked from 0 to exactly -50% across the frame count, so the
 * last frame is one step short of the first and the seam disappears.
 */

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const OUT = join(REPO, "partners.gif");

// Sized against weight, not against the retina ideal, and that trade is the
// interesting part of this file.
//
// A scrolling strip is the worst case for GIF: every pixel moves on every
// frame, so frame-differencing — the thing that keeps meter.gif at 88 KB —
// buys almost nothing. At 2x and 60 frames this came out at 932 KB, which is
// not a thing to put in a confirmation email. 680x88 at 30 frames is 262 KB
// for the same 4.8s cycle: displayed at 544px it is 1.25x rather than 2x, very
// slightly soft on a retina phone, and an order of magnitude cheaper on a
// stranger's mobile data. Overridable per-run for anyone re-tuning that call:
//   W=816 H=104 F=40 D=12 C=96 node scripts/build-partners-gif.mjs
const WIDTH = Number(process.env.W || 680);
const HEIGHT = Number(process.env.H || 88);
const FRAMES = Number(process.env.F || 30);
const DELAY_CS = Number(process.env.D || 16);
const COLORS = Number(process.env.C || 80);

const logos = readdirSync(join(REPO, "partners")).filter((f) => f.endsWith(".png")).sort();
if (!logos.length) throw new Error("no logos in ./partners");

const row = (hidden) =>
  logos
    .map(
      (f) =>
        `<span class="cell"${hidden ? ' aria-hidden="true"' : ""}><img class="${
          f.startsWith("mixmats") ? "mm" : ""
        }" src="file://${join(REPO, "partners", f)}"></span>`,
    )
    .join("");

const page = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#0B0B0D}
  #stage{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0B0B0D;position:relative}
  #track{display:flex;align-items:center;gap:84px;width:max-content;
         height:${HEIGHT}px;padding-left:84px;will-change:transform}
  .cell{flex:none;display:flex;align-items:center}
  .cell img{height:40px;width:auto;display:block}
  .cell img.mm{height:56px}
</style>
<div id="stage"><div id="track">${row(false)}${row(true)}</div></div>`;

const work = mkdtempSync(join(tmpdir(), "mg-partners-"));
const html = join(work, "p.html");
writeFileSync(html, page);

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await tab.goto("file://" + html);
await tab.waitForLoadState("networkidle");

// Half the track is one full set, so translating by exactly that lands the
// duplicate where the original started — the definition of a seamless loop.
const half = await tab.evaluate(() => document.getElementById("track").scrollWidth / 2);
const stage = tab.locator("#stage");

for (let i = 0; i < FRAMES; i++) {
  const x = -(half * i) / FRAMES;
  await tab.evaluate(
    (px) => { document.getElementById("track").style.transform = `translateX(${px}px)`; },
    x,
  );
  await stage.screenshot({ path: join(work, `f${String(i).padStart(3, "0")}.png`) });
}
await browser.close();

const frames = Array.from({ length: FRAMES }, (_, i) =>
  join(work, `f${String(i).padStart(3, "0")}.png`),
);
// One shared palette across every frame, so a logo does not shift colour as it
// crosses the strip. Wider than the meter's 64: these are antialiased type
// marks rather than flat LED segments, and too few colours bands the greys.
const histogram = join(work, "palette.gif");
execFileSync("magick", [...frames, "-colors", String(COLORS), "+append", histogram], {
  stdio: ["ignore", "ignore", "pipe"],
});
execFileSync(
  "magick",
  ["-delay", String(DELAY_CS), "-loop", "0", ...frames,
   "-remap", histogram, "-layers", "OptimizeTransparency", OUT],
  { stdio: ["ignore", "ignore", "pipe"] },
);

console.log(`wrote ${OUT}`);
console.log(`  logos   ${logos.length} (${logos.join(", ")})`);
console.log(`  frames  ${FRAMES} at ${DELAY_CS}cs = ${(FRAMES * DELAY_CS) / 100}s per cycle`);
console.log(`  size    ${(statSync(OUT).size / 1024).toFixed(1)} KB`);
rmSync(work, { recursive: true, force: true });
