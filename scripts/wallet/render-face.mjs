// Draws the pass face and reads the QR back out of the pixels.
//
// Everything else in this rig inspects the pass as data. That is exactly the
// blind spot that let a broken pass ship: pass.json can carry a perfect payload
// and still put nothing on glass. So this script takes the generated .pkpass,
// lays the card out the way Wallet does — the artwork as the ground, the fields
// over it, the code on its tile — rasterises it in a real browser, and then
// points a decoder at the resulting PNG. Nothing is passed to the decoder but
// pixels.
//
// It is not a Wallet emulator and does not pretend to be. What it can prove is
// the thing that was actually wrong: that a code of this payload, at the size
// and contrast Wallet draws it, over THIS artwork, survives being looked at.
//
// Run after verify-pass.mjs, which produces .wallet-test/out/unzipped.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".wallet-test", "out");
const UNZIPPED = path.join(OUT, "unzipped");
const SHOTS = path.join(OUT, "faces");

if (!fs.existsSync(path.join(UNZIPPED, "pass.json"))) {
  console.error("no unzipped pass. run scripts/wallet/verify-pass.mjs first");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

const pass = JSON.parse(fs.readFileSync(path.join(UNZIPPED, "pass.json"), "utf8"));
const style =
  ["boardingPass", "coupon", "eventTicket", "generic", "storeCard"].find((s) => pass[s]) ||
  "generic";
const f = pass[style] || {};
const sem = pass.semantics || {};

const qr =
  (pass.barcodes || []).find((b) => b.format === "PKBarcodeFormatQR") ||
  (pass.barcode && pass.barcode.format === "PKBarcodeFormatQR" ? pass.barcode : null);

if (!qr) {
  console.error(
    "FAIL  the pass declares no PKBarcodeFormatQR barcode, so there is nothing to draw.\n" +
      "      formats present: " +
      JSON.stringify([...(pass.barcodes || []), pass.barcode].filter(Boolean).map((b) => b.format)),
  );
  process.exit(1);
}

function dataUri(name) {
  const p = path.join(UNZIPPED, name);
  if (!fs.existsSync(p)) return null;
  return "data:image/png;base64," + fs.readFileSync(p).toString("base64");
}

const rgb = (s, fb) => s || fb;
const INK = rgb(pass.foregroundColor, "rgb(255,255,255)");
const LABEL = rgb(pass.labelColor, "rgb(255,255,255)");
const GROUND = rgb(pass.backgroundColor, "rgb(20,20,24)");

// Wallet draws the QR on an opaque white tile at roughly 150pt, with altText
// under it. 150pt at 3x is 450 device px, which is what a door camera sees.
const QR_PT = 150;
const SCALE = 3;

const qrPng = await QRCode.toDataURL(qr.message, {
  errorCorrectionLevel: "M",
  margin: 2,
  width: QR_PT * SCALE,
  color: { dark: "#000000FF", light: "#FFFFFFFF" },
});

const field = (arr, i = 0) => (arr && arr[i]) || null;
const esc = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function fieldsBlock(arr, cls) {
  if (!arr || !arr.length) return "";
  return `<div class="row ${cls}">${arr
    .map(
      (x) =>
        `<div class="f"><div class="l">${esc(x.label)}</div><div class="v">${esc(
          x.value,
        ).replace(/\n/g, "<br>")}</div></div>`,
    )
    .join("")}</div>`;
}

// --- the poster layout (iOS 18, preferredStyleSchemes posterEventTicket) -----
// Full-bleed artwork behind everything, the billing and title over its lower
// third, the code on its own tile beneath.
function posterHtml() {
  const art = dataUri("artwork@3x.png") || dataUri("artwork.png") || dataUri("background@3x.png");
  return `<div class="card poster">
    <div class="art" ${art ? `style="background-image:url('${art}')"` : ""}></div>
    <div class="veil"></div>
    <div class="top">
      ${dataUri("logo@3x.png") ? `<img class="logo" src="${dataUri("logo@3x.png")}">` : ""}
      <div class="hdr">${(f.headerFields || [])
        .map((x) => `<div class="hv">${esc(x.value)}</div>`)
        .join("")}</div>
    </div>
    <div class="body">
      <div class="title">${esc(field(f.primaryFields)?.value || sem.eventName || "")}</div>
      ${fieldsBlock(f.secondaryFields, "sec")}
      ${fieldsBlock(f.auxiliaryFields, "aux")}
    </div>
    <div class="code">
      <img src="${qrPng}">
      ${qr.altText ? `<div class="alt">${esc(qr.altText)}</div>` : ""}
    </div>
  </div>`;
}

// --- the classic layout (older iOS, or eventTicket named alone) --------------
// background.png blurred and scaled to fill, per Apple's own Event.pass.
function classicHtml() {
  const bg = dataUri("background@3x.png") || dataUri("background.png") || dataUri("artwork@3x.png");
  return `<div class="card classic">
    <div class="art blur" ${bg ? `style="background-image:url('${bg}')"` : ""}></div>
    <div class="veil"></div>
    <div class="top">
      ${dataUri("logo@3x.png") ? `<img class="logo" src="${dataUri("logo@3x.png")}">` : ""}
      <div class="hdr">${(f.headerFields || [])
        .map((x) => `<div class="hv">${esc(x.value)}</div>`)
        .join("")}</div>
    </div>
    <div class="body">
      <div class="title">${esc(field(f.primaryFields)?.value || "")}</div>
      ${fieldsBlock(f.secondaryFields, "sec")}
      ${fieldsBlock(f.auxiliaryFields, "aux")}
    </div>
    <div class="code">
      <img src="${qrPng}">
      ${qr.altText ? `<div class="alt">${esc(qr.altText)}</div>` : ""}
    </div>
  </div>`;
}

const css = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#3a3a3e;padding:0;font-family:-apple-system,'SF Pro Text',Helvetica,sans-serif}
.card{position:relative;width:375px;overflow:hidden;border-radius:14px;
      background:${GROUND};color:${INK};isolation:isolate}
.art{position:absolute;inset:0;background-size:cover;background-position:center;z-index:0}
.art.blur{filter:blur(14px) saturate(1.1);transform:scale(1.15)}
/* Wallet darkens behind its own type so the fields stay legible over any
   artwork. Without this the renderer would flatter art that Wallet would
   actually veil. */
.veil{position:absolute;inset:0;z-index:1;
      background:linear-gradient(180deg,rgba(0,0,0,.45) 0%,rgba(0,0,0,.05) 22%,
                 rgba(0,0,0,.10) 46%,rgba(0,0,0,.78) 72%,rgba(0,0,0,.92) 100%)}
.top,.body,.code{position:relative;z-index:2}
.top{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 16px 0}
.logo{height:34px;width:auto;display:block}
.hdr .hv{font-size:15px;font-weight:600;letter-spacing:.04em;text-align:right}
.body{padding:0 16px}
.poster .body{padding-top:150px}
.classic .body{padding-top:64px}
.title{font-size:30px;line-height:1.04;font-weight:700;letter-spacing:-.01em;margin-bottom:14px}
.row{display:flex;gap:18px;margin-bottom:12px}
.row .f{flex:1;min-width:0}
.l{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;
   color:${LABEL};margin-bottom:2px}
.v{font-size:15px;font-weight:500;line-height:1.24}
.code{margin:16px auto 0;background:#fff;border-radius:10px;padding:10px;
      width:186px;text-align:center}
.code img{width:166px;height:166px;display:block}
.alt{font-size:10px;color:#4a4a4a;margin-top:6px;letter-spacing:.02em;
     font-variant-numeric:tabular-nums}
`;

const html = (inner) =>
  `<!doctype html><meta charset="utf-8"><style>${css}</style><body>${inner}</body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: SCALE });

const shots = [];
for (const [name, markup] of [
  ["poster", posterHtml()],
  ["classic", classicHtml()],
]) {
  await page.setContent(html(markup));
  await page.waitForLoadState("networkidle");
  const el = await page.locator(".card");
  const file = path.join(SHOTS, `face-${name}.png`);
  await el.screenshot({ path: file });
  shots.push([name, file]);
}
await browser.close();

// --- read the code back out of the pixels -----------------------------------

function zbar(file) {
  try {
    return execFileSync("zbarimg", ["-q", "--raw", file], { encoding: "utf8" }).replace(/\n$/, "");
  } catch {
    return null;
  }
}

function jsqr(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return r ? r.data : null;
}

let failed = 0;
console.log("");
console.log(`style: ${style}   schemes: ${JSON.stringify(pass.preferredStyleSchemes || "(none)")}`);
console.log(`payload in pass.json: ${qr.message}`);
console.log("");

for (const [name, file] of shots) {
  const png = PNG.sync.read(fs.readFileSync(file));
  // Decode the WHOLE rendered card, not a crop of where we know the code is.
  // Cropping to the barcode would quietly test the encoder instead of the card.
  const z = zbar(file);
  const j = jsqr(file);
  const ok = z === qr.message && j === qr.message;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} face  ${png.width}x${png.height}px`);
  console.log(`        zbarimg  -> ${z === null ? "(no code found)" : z}`);
  console.log(`        jsQR     -> ${j === null ? "(no code found)" : j}`);
  console.log(`        file     -> ${file}`);
}

// --- the door, not the darkroom ---------------------------------------------
//
// The renders above are pristine. A door sees a phone held at arm's length in
// bad light: the card is small in frame, slightly out of focus, and the camera
// hands the decoder a compressed, noisy JPEG. A code that only survives perfect
// conditions has not been proven, so the same faces get degraded and read
// again.

async function degrade(src, dest, { width, blur, quality, dark }) {
  const sharp = (await import("sharp")).default;
  let img = sharp(src).resize({ width });
  if (blur) img = img.blur(blur);
  // A phone screen at an angle, under a dim doorway, loses contrast and gains
  // a warm cast from the room.
  if (dark) img = img.modulate({ brightness: dark }).linear(0.88, 8);
  await img.jpeg({ quality }).toFile(dest);
  // zbarimg reads JPEG directly; jsQR needs raw pixels, so re-encode to PNG.
  await sharp(dest).png().toFile(dest.replace(/\.jpg$/, ".png"));
}

const CONDITIONS = [
  { name: "phone at arm's length", width: 420, blur: 0.6, quality: 72, dark: 0.92 },
  { name: "further back, softer focus", width: 300, blur: 1.1, quality: 58, dark: 0.85 },
  { name: "dim doorway, heavy compression", width: 240, blur: 1.4, quality: 40, dark: 0.72 },
];

let hasSharp = true;
try {
  await import("sharp");
} catch {
  hasSharp = false;
}

if (hasSharp) {
  console.log("under door conditions:");
  for (const [name, file] of shots) {
    for (const c of CONDITIONS) {
      const jpg = path.join(SHOTS, `door-${name}-${c.width}.jpg`);
      await degrade(file, jpg, c);
      const z = zbar(jpg);
      const j = jsqr(jpg.replace(/\.jpg$/, ".png"));
      const ok = z === qr.message || j === qr.message;
      if (!ok) failed++;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  ${name} @ ${String(c.width).padStart(4)}px  ` +
          `${c.name.padEnd(32)} zbar:${z === qr.message ? "ok" : "-"} jsQR:${
            j === qr.message ? "ok" : "-"
          }`,
      );
    }
  }
  console.log("");
}

if (failed) {
  console.log(`${failed} decode(s) failed`);
  process.exit(1);
}
console.log(`all rendered faces decoded to the exact RSVP id: ${qr.message}`);
