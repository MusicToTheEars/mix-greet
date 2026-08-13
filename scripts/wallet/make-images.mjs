#!/usr/bin/env node
//
// Regenerates convex/wallet/images.ts.
//
// The pass art is NOT hand-painted. It is the invite page's own composed
// flyer — the .flyer / .fl-* layer stack out of rsvp.html, the @font-face
// blobs out of brand.css, the headliner's photograph out of the live event —
// re-laid at each of Apple's frame sizes and screenshotted with the same
// engine that draws the page. That is the only way the wallet card and the
// invitation can be the same artwork rather than two drawings of it.
//
//   node scripts/wallet/make-images.mjs            # render + rewrite images.ts
//   node scripts/wallet/make-images.mjs --no-write # render only
//   node scripts/wallet/make-images.mjs --out DIR  # also drop the PNGs in DIR
//
// icon.* is NOT regenerated: it is the 45rpm spindle mark, it is not composed
// from the event, and the one in images.ts already reads at 29px. It is carried
// through verbatim.
//
// logo.* IS regenerated, from the project's own academix-logo.png — as a
// TRANSPARENT png. The old cut baked a red rectangle into the file, which put
// the only hard edge in the card's top third onto a soft blurred ground and
// read as a logo that had lost its alpha channel. Wallet composites the logo
// itself; transparency is what it expects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const IMAGES_TS = path.join(ROOT, "convex", "wallet", "images.ts");
const EVENT_API =
  "https://good-labrador-980.convex.site/api/events?event=test-event-2frp";

const argv = process.argv.slice(2);
const WRITE = !argv.includes("--no-write");
const OUT = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 ? argv[i + 1] : null;
})();
const PHOTO_ARG = (() => {
  const i = argv.indexOf("--photo");
  return i >= 0 ? argv[i + 1] : null;
})();

// --- the invite page's own assets -------------------------------------------

// Both @font-face blocks are lifted out of brand.css untouched, base64 payload
// and all: 'Big Shoulders' 800 is the poster lockup, 'Plex Mono' 700 is the
// date stamp. Re-cutting either would change the letterfit.
function fontFaces() {
  const css = fs.readFileSync(path.join(ROOT, "brand.css"), "utf8");
  const want = [
    (b) => b.includes("'Big Shoulders'"),
    (b) => b.includes("'Plex Mono'") && b.includes("font-weight:700"),
  ];
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  const out = want.map((p) => blocks.find(p));
  if (out.some((b) => !b)) throw new Error("brand.css: @font-face not found");
  return out.join("\n");
}

async function headliner() {
  const ev = await (await fetch(EVENT_API)).json();
  const f = (ev.featured || []).find(
    (x) => x.kind !== "company" && x.imageUrl,
  );
  if (!f) throw new Error("event has no featured artist with a photo");
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ev.date || ""));
  const photo = PHOTO_ARG
    ? fs.readFileSync(PHOTO_ARG)
    : Buffer.from(await (await fetch(f.imageUrl)).arrayBuffer());
  // The uploads are PNG or JPEG regardless of what the URL is called; sniff it
  // so the data: URI declares the truth.
  const mime = photo[0] === 0x89 ? "image/png" : "image/jpeg";
  return {
    // renderFlyer(): with a headliner photograph up there the lockup is the
    // ARTIST, never the event title.
    title: f.name,
    stamp: dm ? `${dm[2]}.${dm[3]}.${dm[1].slice(2)}` : "",
    photo: `data:${mime};base64,${photo.toString("base64")}`,
  };
}

// --- the page, rebuilt at a frame size --------------------------------------

// Everything between the two markers below is rsvp.html's flyer stylesheet
// verbatim (lines 219-297) — the layer z-order, the duotone filter, the wash,
// the halftone mask, the grain tile, the scrim and the misregistered lockup.
// The only additions are: the stage that fixes the box to a frame size, the
// transform that shrinks the whole composition for the small frames so the 7px
// dot screen and the 150px grain tile stay in proportion with it, and the
// per-frame override block appended last.
function page({ art, w, h, css, extra = "", heavy = false, brand = false, blurRings = false }) {
  const scale = w / css; // css = the width the flyer is laid out at
  return `<!doctype html><meta charset="utf-8"><style>
${fontFaces()}
:root{
  --bg:#0B0B0D; --ink:#EDEAE3; --muted:#8B8B94; --brand:#EC1C24;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0B0B0D}
body{font-family:'Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;-webkit-font-smoothing:antialiased}
#stage{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:#0B0B0D}
#stage .flyer{
  position:absolute;top:0;left:0;
  width:${css}px;height:${(h / scale).toFixed(4)}px;
  transform:scale(${scale});transform-origin:0 0;
  aspect-ratio:auto;
}

/* ---------- rsvp.html: the flyer ---------- */
.flyer{
  position:relative;overflow:hidden;aspect-ratio:4/5;background:#0B0B0D;
  border:0;border-radius:0;box-shadow:none;isolation:isolate;
  container-type:inline-size;
}
.fl-l{position:absolute;inset:0;pointer-events:none}
.fl-art{display:grid;z-index:0}
.fl-art img{width:100%;height:100%;object-fit:cover;display:block;filter:grayscale(1) contrast(1.3) brightness(1.06)}
.fl-ink{z-index:1;background:#EC1C24;mix-blend-mode:multiply}
.flyer:not(.has-art) .fl-ink{display:none}
.fl-wash{
  z-index:2;
  background:
    radial-gradient(78% 58% at 84% 4%,rgba(236,28,36,.55),transparent 62%),
    radial-gradient(70% 54% at 4% 98%,rgba(237,234,227,.10),transparent 64%);
}
.flyer.has-art .fl-wash{opacity:.42}
.fl-wash::after{
  content:"";position:absolute;inset:0;
  background-image:radial-gradient(rgba(237,234,227,.34) 1px,transparent 1.5px);
  background-size:7px 7px;opacity:.55;
  -webkit-mask-image:linear-gradient(212deg,transparent 44%,#000 104%);
  mask-image:linear-gradient(212deg,transparent 44%,#000 104%);
}
.flyer.has-art .fl-wash::after{opacity:.3}
.fl-mark{z-index:3;width:100%;height:100%;display:block}
.flyer.has-art .fl-disc{display:none}
.flyer.has-art .fl-rings{opacity:.36}
.flyer.has-art .fl-arcs{stroke:#EDEAE3;opacity:.34}
.fl-grain{
  z-index:4;opacity:.55;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23g)'/%3E%3C/svg%3E");
  background-size:150px 150px;
}
.fl-scrim{
  z-index:5;
  background:linear-gradient(180deg,
    rgba(11,11,13,.80) 0%,rgba(11,11,13,.10) 20%,
    rgba(11,11,13,0) 40%,rgba(11,11,13,.72) 76%,rgba(11,11,13,.94) 100%);
}
.flyer.has-art .fl-scrim{
  background:linear-gradient(180deg,
    rgba(11,11,13,.88) 0%,rgba(11,11,13,.16) 22%,
    rgba(11,11,13,.04) 42%,rgba(11,11,13,.86) 74%,rgba(11,11,13,.97) 100%);
}
.fl-type{
  position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;
  justify-content:space-between;padding:clamp(15px,4.6cqw,22px);
}
.fl-no{font-size:9.5px;letter-spacing:.26em;text-transform:uppercase;color:var(--muted);font-weight:700}
.fl-rule{display:block;width:44px;height:4px;background:var(--brand);margin-bottom:11px}
.fl-title{
  margin:0;
  font-family:'Big Shoulders',Impact,sans-serif;font-weight:800;text-transform:uppercase;
  line-height:.88;letter-spacing:.012em;color:var(--ink);
  font-size:38px;font-size:clamp(27px,13.2cqw,52px);
  text-shadow:3px 4px 0 rgba(236,28,36,.6);
}
.fl-title.t-md{font-size:32px;font-size:clamp(24px,10.4cqw,42px)}
.fl-title.t-sm{font-size:26px;font-size:clamp(21px,8.2cqw,34px);line-height:.94}
.flyer .amp{color:var(--brand)}
/* ---------- /rsvp.html ---------- */
${extra}
</style>
<div id="stage">
<div class="flyer ${brand ? "" : "has-art"}">
  ${brand ? "" : `<div class="fl-l fl-art"><img src="${art.photo}" alt=""></div>`}
  <div class="fl-l fl-ink"></div>
  <div class="fl-l fl-wash"></div>
  ${mark(heavy, blurRings)}
  <div class="fl-l fl-grain"></div>
  <div class="fl-l fl-scrim"></div>
  ${
    brand
      ? ""
      : `<div class="fl-type">
    <span class="fl-no">${esc(art.stamp)}</span>
    <div>
      <i class="fl-rule"></i>
      <p class="fl-title ${sizeClass(art.title)}">${esc(art.title)}</p>
    </div>
  </div>`
  }
</div>
</div>`;
}

// The mark. `heavy` is the same instrument redrawn for a frame Wallet is going
// to blur: the sixteen hairlines of the sharp cut arrive as a single grey haze
// under a 14px blur, so the heavy cut keeps four rings at four times the gauge
// and a fatter hub. Same centre, same outermost and innermost radius, same
// three arcs off the bottom-left corner — it reads as the same instrument
// after the blur instead of dissolving into it.
function mark(heavy, blurRings) {
  const arcs = `
    <g class="fl-arcs" fill="none" stroke="#EC1C24" stroke-width="${heavy ? 5 : 2}" opacity=".5">
      <path d="M-40 402a150 150 0 0 1 150-150"/>
      <path d="M-40 448a196 196 0 0 1 196-196"/>
      <path d="M-40 494a242 242 0 0 1 242-242"/>
    </g>`;
  const open = `<svg class="fl-l fl-mark" viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" focusable="false">`;

  // The brand plate's instrument. On the sharp poster the rings are a motif
  // struck over a photograph; here they ARE the picture, so they are recentred
  // toward the middle of the frame, opened out until the outer two run off the
  // edges, and struck at a gauge that survives the blur as light rather than
  // dissolving into it. The hub lands about a third down, which is the band
  // Wallet leaves empty between the logo and the title.
  if (blurRings) {
    // The gauge is the whole trick, and it is set by the blur rather than by
    // taste. Apple's blur is on the order of a fifth of the card's width; a
    // line thinner than that is not softened, it is erased. The sharp poster's
    // 1px hairlines and the earlier 4.5 "heavy" cut both came back as an even
    // grey haze. 15 units in this 400-wide viewBox is about 6.75pt on the
    // card, which survives as a band of light with dark either side — still
    // legibly a ring. Four rings, widely spaced, for the same reason: rings
    // closer together than the blur radius merge into one.
    return `${open}
    <circle class="fl-disc" cx="295" cy="168" r="168" fill="#EC1C24" opacity=".34"/>
    <g class="fl-rings" fill="none" stroke="#EDEAE3" stroke-width="15" opacity=".55">
      <circle cx="295" cy="168" r="336"/><circle cx="295" cy="168" r="244"/>
      <circle cx="295" cy="168" r="152"/><circle cx="295" cy="168" r="66"/>
    </g>
    <circle class="fl-hub" cx="295" cy="168" r="26" fill="#EDEAE3" opacity=".95"/>
    <g class="fl-arcs" fill="none" stroke="#EC1C24" stroke-width="16" opacity=".5">
      <path d="M-40 412a160 160 0 0 1 160-160"/>
    </g>
  </svg>`;
  }

  if (heavy) {
    return `${open}
    <g class="fl-rings" fill="none" stroke="#EDEAE3" stroke-width="4.5">
      <circle cx="322" cy="128" r="188"/><circle cx="322" cy="128" r="141"/>
      <circle cx="322" cy="128" r="94"/>
    </g>
    <circle class="fl-hub" cx="322" cy="128" r="13" fill="#EDEAE3" opacity=".8"/>
${arcs}
  </svg>`;
  }
  return `${open}
    <g class="fl-rings" fill="none" stroke="#EDEAE3" stroke-width="1" opacity=".18">
      <circle cx="322" cy="128" r="188"/><circle cx="322" cy="128" r="160"/>
      <circle cx="322" cy="128" r="132"/><circle cx="322" cy="128" r="104"/>
      <circle cx="322" cy="128" r="76"/><circle cx="322" cy="128" r="48"/>
      <circle cx="322" cy="128" r="106"/><circle cx="322" cy="128" r="92"/>
      <circle cx="322" cy="128" r="64"/><circle cx="322" cy="128" r="36"/>
    </g>
    <circle class="fl-disc" cx="322" cy="128" r="118" fill="#EC1C24" opacity=".55"/>
    <g class="fl-rings" fill="none" stroke="#EDEAE3" stroke-width=".9" opacity=".24">
      <circle cx="322" cy="128" r="106"/><circle cx="322" cy="128" r="92"/>
      <circle cx="322" cy="128" r="78"/><circle cx="322" cy="128" r="64"/>
      <circle cx="322" cy="128" r="50"/><circle cx="322" cy="128" r="36"/>
    </g>
    <circle class="fl-hub" cx="322" cy="128" r="9" fill="#EDEAE3" opacity=".85"/>
${arcs}
  </svg>`;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// renderFlyer()'s own rule, unchanged.
const sizeClass = (t) =>
  t.length > 30 ? "t-sm" : t.length > 17 ? "t-md" : "";

// --- render -----------------------------------------------------------------

// Apple's frame sizes. @2x/@3x are exact integer multiples of @1x or Wallet
// refuses the pass, so every family is rendered once at @3x and stepped down,
// which also keeps the three densities identical rather than merely similar.
const FRAMES = {
  // The iOS 18 poster event ticket's full-bleed ground: sharp, full detail,
  // the invitation's flyer as it is. Only rendered if the poster scheme is
  // ever switched on, so it is the forward-compatible asset, not the shipping
  // one.
  // The iOS 18 poster event ticket's full-bleed ground, sharp. Nothing renders
  // it while the poster scheme is off, so it is the forward-compatible asset,
  // not the shipping one.
  //
  // It carries no photograph either, for the same reason background.* does not:
  // PASS_IMAGES is baked once for every event, and most of the events on the
  // calendar have no featured artist to bake. The difference between the two is
  // only that this one is never blurred, so it keeps the full mark — every
  // hairline of the ring stack, the red disc, the three arcs — at the gauge the
  // invitation draws them, instead of the four heavy rings the blur needs.
  //
  // The grain is pulled back hard here. At .55 it was tuned to sit over a
  // photograph, where it disappears into the picture's own texture; over the
  // flat gradients of a plate it is the only high-frequency content in the
  // frame, so it both reads as dirt and costs more bytes than everything else
  // combined — 818 KB of the 1089x1530, against 120 KB for the whole blurred
  // family. .18 keeps the press feel and gives the file back.
  //
  // NOT BUILT BY DEFAULT. Pass --with-artwork to include it.
  //
  // Nothing renders artwork.* while the poster scheme is off, and the poster
  // scheme is off deliberately and permanently for a ticket that is scanned at
  // a door — Apple: "Poster event tickets aren't compatible with tickets that
  // require a QR code or barcode for entry." Shipping it anyway cost 1.31 MB of
  // a 1.53 MB bundle, at three densities, for a picture no guest can ever see.
  //
  // The grain is why it is so expensive: at 1089x1530 the feTurbulence tile is
  // real per-pixel noise, and over a plate rather than a photograph it is the
  // only high-frequency content in the frame, so PNG cannot compress it and
  // dithering cannot help. The blurred family, which does ship, is 0.26 MB for
  // all three.
  //
  // If the poster layout is ever switched on, regenerate with --with-artwork.
  // That is a rebuild rather than a config change, which is the honest trade:
  // the bundle stays small for the layout that actually ships.
  ...(argv.includes("--with-artwork")
    ? {
        artwork: {
          w: 363,
          h: 510,
          css: 363,
          brand: true,
          budgets: [40_000, 130_000, 300_000],
          extra: `.fl-grain{opacity:.18}`,
        },
      }
    : {}),

  // The classic eventTicket ground, and therefore the asset the guest actually
  // sees. Apple: "The image is cropped slightly on all sides and blurred."
  //
  // This frame carries NO PHOTOGRAPH, and that is the whole design, for two
  // independent reasons that happen to want the same thing.
  //
  // The first is that a blurred portrait conveys nothing. Put any red-lit
  // photograph of any person behind a 14px blur and you get the same warm
  // smudge; a critic comparing the finished card to the invitation could name
  // only one legible feature in the whole plate and read it as "the background
  // image failed to load". The rings are the opposite: large, thin, high
  // contrast, low frequency. Blur turns them into soft concentric halos that
  // are still unmistakably rings, and the rings are the invitation's
  // logo-level idea — the "sound" in the poster.
  //
  // The second is that PASS_IMAGES is static. It is baked once and every guest
  // of every event gets the same bytes, so a plate composed from one event's
  // headliner is wrong for every other event. Three of the four published
  // events have no featured artist at all; their guests would have opened a
  // stranger's face.
  //
  // So the plate is the brand, not the bill: the mark opened out until it
  // fills the frame, the red bloom, the grain, the black. The invite page has
  // its own vocabulary for exactly this — `.flyer:not(.has-art)`, where the
  // red disc returns and the mark carries the composition alone — and that is
  // the state this renders.
  //
  // Also composed for the blur specifically:
  //  - no type. Wallet prints the event, the date, the guest and the barcode
  //    over this; a blurred cream lockup under its own white fields is the one
  //    thing that makes a pass look broken.
  //  - no 7px halftone. It cannot survive the blur as anything but a grey
  //    lift, and that lift only lightens the ground the barcode tile sits on.
  //  - the LEFT THIRD is pulled down to near black, because Wallet's type
  //    column runs down it and the red field labels need a ground they clear.
  //  - the scrim's foot is deepened so the bottom third — where the barcode
  //    lands — is flat #0B0B0D.
  background: {
    w: 180,
    h: 220,
    css: 363,
    brand: true,
    blurRings: true,
    budgets: [26_000, 58_000, 130_000],
    extra: `
.fl-wash::after{display:none}
.fl-type{display:none}
/* The bloom stays; it is the strongest low-frequency brand cue on the plate.
   The cream lift from the bottom-left goes, because the bottom-left is exactly
   where the barcode tile lands and it must stay black. */
.fl-wash{
  opacity:1;
  background:radial-gradient(86% 62% at 82% 6%,rgba(236,28,36,.62),transparent 66%);
}
/* Wallet's fields run down the left edge and its labels are brand red. Red on
   dark red measures about 2.5:1 and fails; red on #0B0B0D is about 4.3:1 and
   holds. So the left third is taken down before the type ever gets there. */
.fl-scrim{
  background:
    linear-gradient(90deg,
      rgba(11,11,13,.94) 0%,rgba(11,11,13,.72) 26%,
      rgba(11,11,13,.22) 52%,rgba(11,11,13,0) 74%),
    linear-gradient(180deg,
      rgba(11,11,13,.72) 0%,rgba(11,11,13,.12) 20%,
      rgba(11,11,13,.10) 46%,rgba(11,11,13,.66) 64%,
      rgba(11,11,13,.96) 80%,rgba(11,11,13,1) 91%);
}`,
  },
};

async function render(browser, art, frame, scale) {
  const { w, h, css, extra, heavy, brand, blurRings } = frame;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: scale,
  });
  const p = await ctx.newPage();
  await p.setContent(page({ art, w, h, css, extra, heavy, brand, blurRings }), {
    waitUntil: "load",
  });
  await p.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((i) => (i.complete ? null : i.decode())),
    );
  });
  const png = await p.screenshot({
    clip: { x: 0, y: 0, width: w, height: h },
  });
  await ctx.close();
  return png;
}

// Two inks over black: a palette PNG is a fraction of the truecolour file and
// the only visible cost is in the grain, which is noise anyway. Walk the
// palette down until the frame fits its share of the 1.2MB the whole map gets.
//
// The ladder starts at 160 rather than 255 deliberately. A red duotone over
// black is a one-dimensional ramp; past ~160 entries the extra colours are
// spent describing the grain, which triples the file for a difference nobody
// can see.
//
// The ladder is walked for the FAMILY, not for each density: the depth chosen
// is the deepest one at which all three densities clear their budgets, and all
// three are then quantised at it. Choosing per density is what produced a set
// where @2x was smaller than @1x — three neighbouring palettes, three slightly
// different pictures, and the density Wallet happens to pick deciding which
// one the guest sees.
// The ladder has exactly two rungs, and that is not laziness — it is the only
// two values sharp actually honours.
//
// sharp's `colours` does not select a palette size; it selects a BIT DEPTH
// bucket. Measured against a truecolour source:
//
//   colours: 16  -> 16-entry palette, 4-bit
//   colours: 64  -> 16-entry palette, 4-bit
//   colours: 128 -> 16-entry palette, 4-bit
//   colours: 160 -> 256-entry palette, 8-bit
//   colours: 256 -> 256-entry palette, 8-bit
//
// Everything from 17 to 159 collapses to sixteen colours. The old ladder was
// [160, 128, 96, 64, 48], so the moment a frame missed its budget at 160 it
// fell straight off a cliff to 16 — and it reported "128 colours" while doing
// it, because it logged the rung rather than the result.
//
// Sixteen colours is not a compression setting, it is a different picture. A
// critic comparing the artwork to the invitation measured the damage: the red
// ramp reduced to nine steps, a flat black region carrying exactly one
// luminance value and no grain at all, highlights clipping at 194 so the beard
// went to a single plate, the 8px arcs breaking into 6px and 2px+4px stipple,
// ring strokes flickering between two greys along one continuous line, the
// #EC1C24 rule bar dulling to (194,26,33), and the cool grey date stamp turning
// warm rose because the palette held no neutral.
//
// So: 256 or nothing. If a frame cannot make its budget at full depth, the
// answer is to make the picture cheaper, not to posterise it.
const LADDER = [256];

async function quantise(buf, colours) {
  return sharp(buf)
    .png({ palette: true, colours, dither: 0.2, compressionLevel: 9, effort: 10 })
    .toBuffer();
}

// The depth is chosen for the FAMILY, not per density: the deepest rung at
// which all three clear their budgets, applied to all three. Choosing per
// density is what produced a set where @2x was smaller than @1x — three
// neighbouring palettes, three subtly different pictures, and whichever density
// Wallet happened to pick deciding which one the guest saw.
async function packFamily(raws, budgets) {
  let last = null;
  for (const colours of LADDER) {
    const outs = await Promise.all(raws.map((r) => quantise(r, colours)));
    last = { outs, colours };
    if (outs.every((o, i) => o.length <= budgets[i])) return last;
  }
  return last;
}

// --- the wordmark -----------------------------------------------------------

// The lockup is not drawn either. academix-logo.png is the project's own
// wordmark, the same file the invite page hangs in its partner row, and it
// arrives correctly as transparent ink: "acade" in white, "mix" and the spindle
// over the i in brand red. Only the white is touched, and only to warm it to
// the card's cream — Wallet's foregroundColor is #EDEAE3, and a pure-white
// wordmark next to cream fields reads as two different whites.
const CREAM = [0xed, 0xea, 0xe3];

async function wordmark() {
  const src = path.join(ROOT, "academix-logo.png");
  const { data, info } = await sharp(src)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    // The red ink is the only saturated colour in the file; everything else is
    // the neutral wordmark. Leave the red exactly as drawn.
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) continue;
    const k = Math.max(r, g, b) / 255;
    data[i] = Math.round(CREAM[0] * k);
    data[i + 1] = Math.round(CREAM[1] * k);
    data[i + 2] = Math.round(CREAM[2] * k);
  }
  const png = await sharp(data, { raw: info }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

// Wallet composites the logo onto the card itself, so the file it wants is ink
// on nothing. The cut this replaces baked a red rectangle in: on a soft blurred
// ground it was the only hard edge in the whole top third, which is precisely
// what a logo that lost its alpha channel looks like — and the plate was 160
// wide for a wordmark that stopped at 30, so the mark sat in the corner of its
// own box with a hand's width of empty red beside it.
//
// So: no plate, ink only, and the two lines set to one measured width so the
// lockup is a rectangle of type with nothing to pad unevenly. The red stays,
// but as the mark it always was — the "mix" of academix, and the ampersand.
async function renderLogo(browser, wm) {
  const W = 520;
  const H = 220;
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 3,
  });
  const p = await ctx.newPage();
  await p.setContent(
    `<!doctype html><meta charset="utf-8"><style>
${fontFaces()}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
#lock{position:absolute;left:40px;top:40px;width:400px}
#wm{display:block;width:100%;height:auto}
#gg{
  font-family:'Big Shoulders',Impact,sans-serif;font-weight:800;
  text-transform:uppercase;color:#EDEAE3;line-height:1;white-space:nowrap;
  letter-spacing:.085em;margin-top:9px;font-size:60px;
}
#gg .amp{color:#EC1C24}
</style>
<div id="lock">
  <img id="wm" src="${wm}" alt="">
  <div id="gg">MIX <span class="amp">&amp;</span> GREET</div>
</div>`,
    { waitUntil: "load" },
  );
  await p.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((i) => (i.complete ? null : i.decode())),
    );
    // Set the second line to the wordmark's own width. Big Shoulders is
    // condensed and its advance is not linear enough to solve in one step, so
    // measure and correct — the trailing letter-space is discounted, or the
    // line lands short of flush by exactly one gap.
    const gg = document.getElementById("gg");
    const target = 400;
    let fs = 60;
    for (let i = 0; i < 8; i++) {
      gg.style.fontSize = `${fs}px`;
      const ink = gg.scrollWidth - 0.085 * fs;
      fs = (fs * target) / ink;
    }
    gg.style.fontSize = `${fs}px`;
    await document.fonts.ready;
  });
  const shot = await p.screenshot({ omitBackground: true });
  await ctx.close();
  return shot;
}

// Trim to the ink, then re-centre in the frame. sharp's own trim keys off a
// background colour; this keys off alpha, which is the only thing that means
// "not the logo" in a transparent PNG.
async function inkBox(buf) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("logo render is empty");
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// One frame, one trim, one set of margins scaled by density: the three files
// are the same lockup at three sizes rather than three separate layouts. The
// margin is a percentage of the frame, so the optical padding is identical at
// every density and equal on all four sides.
const LOGO = { w: 160, h: 50, padX: 0.03, padY: 0.06 };

async function logoFamily(browser) {
  const shot = await renderLogo(browser, await wordmark());
  const box = await inkBox(shot);
  const ink = await sharp(shot).extract(box).png().toBuffer();
  const outs = [];
  for (const d of [3, 2, 1]) {
    const W = LOGO.w * d;
    const H = LOGO.h * d;
    const px = Math.round(W * LOGO.padX);
    const py = Math.round(H * LOGO.padY);
    const inner = await sharp(ink)
      .resize(W - 2 * px, H - 2 * py, {
        fit: "inside",
        kernel: "lanczos3",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const m = await sharp(inner).metadata();
    const out = await sharp({
      create: {
        width: W,
        height: H,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: inner,
          left: Math.round((W - m.width) / 2),
          top: Math.round((H - m.height) / 2),
        },
      ])
      // 64 entries is more than a two-ink wordmark plus its antialiasing needs,
      // and libimagequant keeps the alpha ramp in the palette, so the file
      // stays transparent where Wallet expects the card to show through.
      .png({ palette: true, colours: 64, dither: 0, compressionLevel: 9, effort: 10 })
      .toBuffer();
    if (!(await sharp(out).metadata()).hasAlpha) {
      throw new Error("logo lost its alpha channel in packing");
    }
    outs.push({ d, out });
  }
  return outs;
}

async function main() {
  const art = await headliner();
  console.log(`headliner: ${art.title}   stamp: ${art.stamp}`);
  const browser = await chromium.launch();
  const files = {};
  const meta = [];

  for (const [name, frame] of Object.entries(FRAMES)) {
    const at3 = await render(browser, art, frame, 3);
    // Render once at @3x and step down, so the three densities are the same
    // picture at three sizes rather than three renders that merely resemble
    // each other.
    const raws = [];
    for (const d of [1, 2, 3]) {
      raws.push(
        d === 3
          ? at3
          : await sharp(at3)
              .resize(frame.w * d, frame.h * d, { kernel: "lanczos3" })
              .png()
              .toBuffer(),
      );
    }
    const { outs, colours } = await packFamily(raws, frame.budgets);
    for (const d of [1, 2, 3]) {
      const key = d === 1 ? `${name}.png` : `${name}@${d}x.png`;
      const w = frame.w * d;
      const h = frame.h * d;
      const out = outs[d - 1];
      const dim = pngSize(out);
      if (dim.w !== w || dim.h !== h) {
        throw new Error(`${key} rendered ${dim.w}x${dim.h}, wanted ${w}x${h}`);
      }
      files[key] = out;
      meta.push({ key, w, h, bytes: out.length, colours });
    }
  }

  for (const { d, out } of await logoFamily(browser)) {
    const key = d === 1 ? "logo.png" : `logo@${d}x.png`;
    const w = LOGO.w * d;
    const h = LOGO.h * d;
    const dim = pngSize(out);
    if (dim.w !== w || dim.h !== h) {
      throw new Error(`${key} rendered ${dim.w}x${dim.h}, wanted ${w}x${h}`);
    }
    files[key] = out;
    meta.push({ key, w, h, bytes: out.length, colours: "alpha" });
  }
  await browser.close();

  // icon.* survives untouched: it is the 45rpm spindle mark rather than
  // artwork, and it already reads at 29px.
  const prev = readImagesTs();
  for (const k of Object.keys(prev)) {
    if (/^icon(@[23]x)?\.png$/.test(k)) files[k] = prev[k];
  }

  const order = [
    // Only present with --with-artwork; see the artwork frame for why.
    ...(files["artwork.png"]
      ? ["artwork.png", "artwork@2x.png", "artwork@3x.png"]
      : []),
    "background.png", "background@2x.png", "background@3x.png",
    "icon.png", "icon@2x.png", "icon@3x.png",
    "logo.png", "logo@2x.png", "logo@3x.png",
  ];
  for (const k of order) if (!files[k]) throw new Error(`missing ${k}`);

  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const k of order) fs.writeFileSync(path.join(OUT, k), files[k]);
  }
  if (WRITE) fs.writeFileSync(IMAGES_TS, emit(order, files));

  let b64 = 0;
  for (const k of order) {
    const d = pngSize(files[k]);
    const e = files[k].toString("base64").length;
    b64 += e;
    const m = meta.find((x) => x.key === k);
    console.log(
      `${k.padEnd(18)} ${`${d.w}x${d.h}`.padEnd(11)} ${String(files[k].length).padStart(7)} B  ` +
        `${String(e).padStart(7)} b64${m ? `  ${m.colours} colours` : "  (kept)"}`,
    );
  }
  console.log(`\ntotal base64: ${b64} (${(b64 / 1048576).toFixed(3)} MB)`);
}

function pngSize(b) {
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function readImagesTs() {
  const src = fs.readFileSync(IMAGES_TS, "utf8");
  const out = {};
  for (const m of src.matchAll(/"([^"]+\.png)":\s*"([A-Za-z0-9+/=]+)"/g)) {
    out[m[1]] = Buffer.from(m[2], "base64");
  }
  return out;
}

function emit(order, files) {
  const lines = order.map(
    (k) => `  ${JSON.stringify(k)}:\n    "${files[k].toString("base64")}",`,
  );
  return `// Pass artwork, base64. Apple silently rejects a .pkpass missing icon.png.
//
// artwork.* and background.* are NOT drawn here. They are the invite page's own
// composed flyer — rsvp.html's .flyer / .fl-* layer stack, brand.css's fonts,
// the headliner's photograph re-inked as a single-ink red duotone — re-laid at
// Apple's frame sizes and screenshotted by scripts/wallet/make-images.mjs. The
// wallet card and the invitation are therefore the same artwork, not two
// drawings of the same idea. Re-run that script to regenerate them; do not
// hand-edit the blobs.
//
// artwork.* is the iOS 18 poster event ticket's full-bleed ground at 363x510.
// background.* is the classic eventTicket ground at 180x220; Wallet blurs and
// scales it to fill the card, so it is composed at its own aspect rather than
// squashed out of the portrait frame.
//
// The poster prints no title, no date, no venue and no barcode: Wallet draws
// all of those as real fields over the top, so the centre and the bottom strip
// are left deliberately calm. The only baked type is the MM.DD.YY stamp
// top-left and the headliner's name low in the frame — the same two strings the
// invite page prints.
//
// logo.png stacks the cream academix wordmark over MIX & GREET: Wallet draws
// logoText to the RIGHT of the logo with no way to place it below, and at full
// width the wordmark ran under the top notch. icon.png is the 45rpm spindle
// mark, which is what shows on the lock screen. Neither is composed from the
// event, so make-images.mjs carries both through untouched.
//
// @2x and @3x are exact integer multiples of @1x. Wallet picks by density and
// a mismatched set is drawn at the wrong size or dropped.
export const PASS_IMAGES: Record<string, string> = {
${lines.join("\n")}
};
`;
}

await main();
