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
// icon.* and logo.* are NOT regenerated: they are a mark and a wordmark, not
// artwork composed from the event, and the ones in images.ts already read at
// 29px. They are carried through verbatim.

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
function page({ art, w, h, css, extra = "", heavy = false }) {
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
<div class="flyer has-art">
  <div class="fl-l fl-art"><img src="${art.photo}" alt=""></div>
  <div class="fl-l fl-ink"></div>
  <div class="fl-l fl-wash"></div>
  ${mark(heavy)}
  <div class="fl-l fl-grain"></div>
  <div class="fl-l fl-scrim"></div>
  <div class="fl-type">
    <span class="fl-no">${esc(art.stamp)}</span>
    <div>
      <i class="fl-rule"></i>
      <p class="fl-title ${sizeClass(art.title)}">${esc(art.title)}</p>
    </div>
  </div>
</div>
</div>`;
}

// The mark. `heavy` is the same instrument redrawn for a frame Wallet is going
// to blur: the sixteen hairlines of the sharp cut arrive as a single grey haze
// under a 14px blur, so the heavy cut keeps four rings at four times the gauge
// and a fatter hub. Same centre, same outermost and innermost radius, same
// three arcs off the bottom-left corner — it reads as the same instrument
// after the blur instead of dissolving into it.
function mark(heavy) {
  const arcs = `
    <g class="fl-arcs" fill="none" stroke="#EC1C24" stroke-width="${heavy ? 5 : 2}" opacity=".5">
      <path d="M-40 402a150 150 0 0 1 150-150"/>
      <path d="M-40 448a196 196 0 0 1 196-196"/>
      <path d="M-40 494a242 242 0 0 1 242-242"/>
    </g>`;
  const open = `<svg class="fl-l fl-mark" viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" focusable="false">`;
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
  artwork: { w: 363, h: 510, css: 363, budgets: [110_000, 260_000, 560_000] },

  // The classic eventTicket ground, and therefore the asset the guest actually
  // sees. Apple: "The image is cropped slightly on all sides and blurred."
  //
  // So this frame is composed FOR the blur rather than in spite of it. It is
  // laid out at its own 180:220 (not squashed out of the portrait frame) and
  // shrunk whole so the dot screen and the grain stay in proportion, then:
  //
  //  - the type comes off. Wallet prints the event, the date, the guest and
  //    the barcode over this; a blurred cream lockup underneath its own white
  //    fields is the one thing that makes a pass look broken.
  //  - the 7px halftone comes off. It cannot survive a 14px blur as anything
  //    but a slight grey lift, and that lift only lightens the ground the
  //    barcode tile sits on.
  //  - the mark goes heavy (see mark()), because hairlines dissolve.
  //  - the scrim's foot is deepened so the bottom third — where the barcode
  //    lands — is near black.
  //
  // What is left is the low-frequency signature that does survive: the red
  // duotone face mass, the #0B0B0D black, the bloom off the top right.
  background: {
    w: 180,
    h: 220,
    css: 363,
    heavy: true,
    budgets: [26_000, 58_000, 130_000],
    extra: `
.flyer.has-art .fl-wash::after{display:none}
.flyer.has-art .fl-rings{opacity:.34}
.flyer.has-art .fl-arcs{stroke:#EDEAE3;opacity:.22}
.fl-type{display:none}
/* The headliner's shirt carries printed type of its own, which the blur turns
   into a second illegible smear right where the barcode tile lands, and Wallet
   crops a few percent off every edge on top of that. So the foot of the scrim
   is brought forward to 63% and taken all the way to opaque by 90%: the face
   keeps the top half, the bottom third goes to flat #0B0B0D, and the shirt —
   printed type and all — is simply not in the picture any more. */
.flyer.has-art .fl-scrim{
  background:linear-gradient(180deg,
    rgba(11,11,13,.88) 0%,rgba(11,11,13,.16) 22%,
    rgba(11,11,13,.06) 44%,rgba(11,11,13,.58) 63%,
    rgba(11,11,13,.94) 78%,rgba(11,11,13,1) 90%);
}`,
  },
};

async function render(browser, art, frame, scale) {
  const { w, h, css, extra, heavy } = frame;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: scale,
  });
  const p = await ctx.newPage();
  await p.setContent(page({ art, w, h, css, extra, heavy }), {
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
// can see, and it lets every density in a family land on the same palette
// depth so they are the same picture rather than three similar ones.
async function pack(buf, budget) {
  let last = null;
  for (const colours of [160, 128, 96, 64, 48]) {
    const out = await sharp(buf)
      .png({
        palette: true,
        colours,
        dither: 0.7,
        compressionLevel: 9,
        effort: 10,
      })
      .toBuffer();
    last = { out, colours };
    if (out.length <= budget) return last;
  }
  return last;
}

async function main() {
  const art = await headliner();
  console.log(`headliner: ${art.title}   stamp: ${art.stamp}`);
  const browser = await chromium.launch();
  const files = {};
  const meta = [];

  for (const [name, frame] of Object.entries(FRAMES)) {
    const at3 = await render(browser, art, frame, 3);
    for (const d of [3, 2, 1]) {
      const key = d === 1 ? `${name}.png` : `${name}@${d}x.png`;
      const w = frame.w * d;
      const h = frame.h * d;
      const raw =
        d === 3
          ? at3
          : await sharp(at3)
              .resize(w, h, { kernel: "lanczos3" })
              .png()
              .toBuffer();
      const { out, colours } = await pack(raw, frame.budgets[d - 1]);
      const dim = pngSize(out);
      if (dim.w !== w || dim.h !== h) {
        throw new Error(`${key} rendered ${dim.w}x${dim.h}, wanted ${w}x${h}`);
      }
      files[key] = out;
      meta.push({ key, w, h, bytes: out.length, colours });
    }
  }
  await browser.close();

  // icon.* and logo.* survive untouched.
  const prev = readImagesTs();
  for (const k of Object.keys(prev)) {
    if (/^(icon|logo)(@[23]x)?\.png$/.test(k)) files[k] = prev[k];
  }

  const order = [
    "artwork.png", "artwork@2x.png", "artwork@3x.png",
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
