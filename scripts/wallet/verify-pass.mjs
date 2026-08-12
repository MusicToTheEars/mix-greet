// End-to-end proof that the .pkpass this repo builds is a real, signed,
// scannable pass. Run it with `node scripts/wallet/verify-pass.mjs`.
//
// The pass had a bug that no amount of reading pass.json would have caught: it
// generated cleanly and showed no code at the door. So this harness refuses to
// take the JSON's word for anything. It checks, in order:
//
//   1. the zip opens and carries every file Apple requires
//   2. manifest.json hashes EVERY other file, and each hash actually matches
//   3. `signature` is a detached PKCS#7 that openssl verifies against the
//      manifest and the chain
//   4. pass.json's structure matches the spec for the style it declares
//   5. the barcode payload is EXACTLY the identifier /api/admin/checkin expects
//   6. that payload survives a round trip through a real QR encoder and a real
//      camera-grade decoder (zbarimg), at the pixel size Wallet draws it
//
// Step 6 is the one that matters. A payload that is present in JSON but cannot
// be decoded off a screen is the same as no pass at all.
//
// Signing uses the throwaway chain from gen-test-certs.sh. iOS would reject it,
// which is the point: this proves OUR pipeline, not Apple's trust store.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = path.join(ROOT, ".wallet-test");
const CERTS = path.join(WORK, "certs");
const OUT = path.join(WORK, "out");

// The identifier a Bluetooth scanner types at the door. Shaped like a real
// Convex document id, because /api/admin/checkin accepts a bare id only when it
// matches /^[a-z0-9]{20,40}$/i — a payload of the wrong shape is rejected as an
// "unrecognised code" even when it is otherwise correct.
const RSVP_ID = "jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd";
const CHECKIN_ACCEPTS = /^[a-z0-9]{20,40}$/i;

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail ?? "" });
  } catch (e) {
    failed++;
    results.push({ ok: false, name, detail: e.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- 0. the throwaway chain ------------------------------------------------

if (!fs.existsSync(path.join(CERTS, "env.sh"))) {
  console.error("no test certs. run: ./scripts/wallet/gen-test-certs.sh");
  process.exit(2);
}
for (const line of fs.readFileSync(path.join(CERTS, "env.sh"), "utf8").split("\n")) {
  const m = /^export ([A-Z_0-9]+)='(.*)'$/.exec(line);
  if (m) process.env[m[1]] = m[2];
}

// --- 1. build ---------------------------------------------------------------

// Imported from the module the server actually calls, not a copy of it. A
// harness that tests its own reimplementation proves nothing.
const { buildPkpass } = await import("../../convex/wallet/pkpass.ts");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// The same shape convex/wallet/serve.ts assembles from a live event: the real
// published TEST Event, its real billed artist, a real party size.
const bytes = await buildPkpass({
  serial: `mg-${RSVP_ID}`,
  authToken: RSVP_ID,
  eventTitle: "TEST Event",
  subtitle: "With Artis",
  artists: ['Lawrence "ThaMyind" Berment'],
  whenIso: "2026-08-15T13:00:00-07:00",
  whenLabel: "AUG 15 · 1:00 PM",
  dateShort: "AUG 15",
  timeShort: "1:00 PM",
  location: "1933 S. Broadway, Suite 1202, Los Angeles, CA 90007",
  guestName: "Jordan Ellis",
  partyLabel: "2 guests",
  status: "confirmed",
  venueLine: "1933 S. Broadway",
});

const pkpassPath = path.join(OUT, "MixAndGreet.pkpass");
fs.writeFileSync(pkpassPath, bytes);

// --- 2. the zip -------------------------------------------------------------

const zip = await JSZip.loadAsync(bytes);
const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
const raw = {};
for (const n of names) raw[n] = Buffer.from(await zip.files[n].async("uint8array"));

const unzipped = path.join(OUT, "unzipped");
fs.mkdirSync(unzipped, { recursive: true });
for (const [n, b] of Object.entries(raw)) {
  fs.mkdirSync(path.dirname(path.join(unzipped, n)), { recursive: true });
  fs.writeFileSync(path.join(unzipped, n), b);
}

check("zip opens and is non-trivial", () => {
  assert(names.length >= 4, `only ${names.length} entries`);
  return `${names.length} files, ${(bytes.length / 1024).toFixed(0)} KB`;
});

check("carries the files Apple requires", () => {
  for (const req of ["pass.json", "manifest.json", "signature", "icon.png"]) {
    assert(names.includes(req), `missing ${req}`);
  }
  // icon.png is the one every style needs and the one whose absence makes iOS
  // reject a pass with no message the guest can see.
  return names.join(", ");
});

// --- 3. manifest ------------------------------------------------------------

const manifest = JSON.parse(raw["manifest.json"].toString("utf8"));

check("manifest hashes every file, and every hash matches", () => {
  const shouldHash = names.filter((n) => n !== "manifest.json" && n !== "signature");
  for (const n of shouldHash) {
    assert(manifest[n], `manifest omits ${n}`);
    const actual = createHash("sha1").update(raw[n]).digest("hex");
    assert(
      manifest[n] === actual,
      `${n}: manifest says ${manifest[n]}, bytes hash to ${actual}`,
    );
  }
  for (const n of Object.keys(manifest)) {
    assert(shouldHash.includes(n), `manifest lists ${n}, which is not in the zip`);
  }
  return `${shouldHash.length} files, all SHA-1 matched`;
});

// --- 4. signature -----------------------------------------------------------

check("signature is a detached PKCS#7 that verifies against the manifest", () => {
  // openssl, not node-forge: verifying with the same library that signed would
  // only prove the library agrees with itself.
  const out = execFileSync(
    "openssl",
    [
      "smime", "-verify",
      "-inform", "DER",
      "-in", path.join(unzipped, "signature"),
      "-content", path.join(unzipped, "manifest.json"),
      "-CAfile", path.join(CERTS, "wwdr.pem"),
      "-purpose", "any",
      "-out", "/dev/null",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return "openssl smime -verify: OK";
});

check("the signed content really is this manifest, not another one", () => {
  // Flip one byte of the manifest; the same verify must now fail. Without this,
  // a signature over the wrong bytes would pass step 4 silently.
  const tampered = path.join(OUT, "manifest.tampered.json");
  const b = Buffer.from(raw["manifest.json"]);
  b[b.length - 2] = b[b.length - 2] === 0x30 ? 0x31 : 0x30;
  fs.writeFileSync(tampered, b);
  let rejected = false;
  try {
    execFileSync(
      "openssl",
      ["smime", "-verify", "-inform", "DER", "-in", path.join(unzipped, "signature"),
       "-content", tampered, "-CAfile", path.join(CERTS, "wwdr.pem"),
       "-purpose", "any", "-out", "/dev/null"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "a tampered manifest still verified — the check is not real");
  return "tampered manifest rejected, as it must be";
});

// --- 5. pass.json -----------------------------------------------------------

const pass = JSON.parse(raw["pass.json"].toString("utf8"));
fs.writeFileSync(path.join(OUT, "pass.pretty.json"), JSON.stringify(pass, null, 2));

const STYLES = ["boardingPass", "coupon", "eventTicket", "generic", "storeCard"];

check("pass.json declares exactly one style, with its field dictionary", () => {
  const present = STYLES.filter((s) => pass[s]);
  assert(present.length === 1, `expected 1 style key, found ${present.length}: ${present}`);
  return present[0];
});

check("pass.json carries the required top-level keys", () => {
  for (const k of [
    "formatVersion", "passTypeIdentifier", "serialNumber",
    "teamIdentifier", "organizationName", "description",
  ]) {
    assert(pass[k] !== undefined && pass[k] !== null && pass[k] !== "", `missing ${k}`);
  }
  assert(pass.formatVersion === 1, `formatVersion is ${pass.formatVersion}`);
  return "formatVersion 1, ids and description present";
});

// --- 6. the barcode block ---------------------------------------------------

// Apple's spelling, verbatim from the PassKit Barcode dictionary and from every
// sample pass Apple ships. Camel case, no underscores.
//
// This list is the whole reason the door was dark. The builder used
// PKBARCODE_FORMAT_QR — a constant that appears nowhere in Apple's
// documentation and in none of its samples. Wallet does not error on an
// unrecognised format; it drops the barcode and draws the pass without one. So
// the pass looked perfect in JSON and printed nothing on glass, and the style
// key got the blame for four commits.
const BARCODE_FORMATS = [
  "PKBarcodeFormatQR",
  "PKBarcodeFormatPDF417",
  "PKBarcodeFormatAztec",
  "PKBarcodeFormatCode128",
];

check("every barcode format is a constant Apple actually defines", () => {
  const seen = [];
  for (const b of [...(pass.barcodes ?? []), ...(pass.barcode ? [pass.barcode] : [])]) {
    seen.push(b.format);
    assert(
      BARCODE_FORMATS.includes(b.format),
      `${JSON.stringify(b.format)} is not a PassKit barcode format. ` +
        `Apple defines exactly: ${BARCODE_FORMATS.join(", ")}. ` +
        `Wallet silently drops a barcode whose format it does not recognise.`,
    );
  }
  assert(seen.length, "no barcode anywhere in the pass");
  return seen.join(", ");
});

check("barcodes is a non-empty array of well-formed entries", () => {
  assert(Array.isArray(pass.barcodes), "barcodes is not an array");
  assert(pass.barcodes.length > 0, "barcodes is empty");
  const ENCODINGS = ["iso-8859-1", "utf-8"];
  for (const b of pass.barcodes) {
    assert(typeof b.message === "string" && b.message.length, "empty message");
    assert(ENCODINGS.includes(b.messageEncoding), `bad messageEncoding ${b.messageEncoding}`);
  }
  return pass.barcodes.map((b) => `${b.format}/${b.messageEncoding}`).join(", ");
});

check("the QR payload is EXACTLY the id /api/admin/checkin expects", () => {
  const qr = pass.barcodes.find((b) => b.format === "PKBarcodeFormatQR");
  assert(qr, "no QR barcode in the array");
  assert(
    qr.message === RSVP_ID,
    `payload is ${JSON.stringify(qr.message)}, expected ${JSON.stringify(RSVP_ID)}`,
  );
  assert(CHECKIN_ACCEPTS.test(qr.message), "payload fails the checkin route's own regex");
  // iso-8859-1 is what Apple's samples use, and the payload must survive it.
  assert(
    Buffer.from(qr.message, "latin1").toString("latin1") === qr.message,
    "payload is not representable in iso-8859-1",
  );
  return `${qr.message} (${qr.message.length} chars, matches ${CHECKIN_ACCEPTS})`;
});

// --- 7. does it actually scan? ----------------------------------------------

// Wallet draws the QR at roughly 150pt on the pass face. Rendering it smaller
// than that here would be testing an easier problem than the door.
const QR_PX = 300;

async function renderQr(message, file, opts = {}) {
  await QRCode.toFile(file, message, {
    type: "png",
    errorCorrectionLevel: opts.ec ?? "M",
    margin: opts.margin ?? 2,
    width: opts.width ?? QR_PX,
    color: opts.color ?? { dark: "#000000FF", light: "#FFFFFFFF" },
  });
}

function zbarDecode(file) {
  // zbarimg is a real camera-grade decoder, the same library a lot of door
  // scanners ship. --raw so nothing is added to the payload.
  const out = execFileSync("zbarimg", ["-q", "--raw", file], { encoding: "utf8" });
  return out.replace(/\n$/, "");
}

function jsqrDecode(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return r ? r.data : null;
}

const qrEntry = pass.barcodes.find((b) => b.format === "PKBarcodeFormatQR");
const qrFile = path.join(OUT, "barcode-from-pass.png");
if (qrEntry) await renderQr(qrEntry.message, qrFile);

check("the payload round-trips through a real QR encoder and zbarimg", () => {
  assert(qrEntry, "no QR to render");
  const decoded = zbarDecode(qrFile);
  assert(
    decoded === RSVP_ID,
    `zbarimg read ${JSON.stringify(decoded)}, expected ${JSON.stringify(RSVP_ID)}`,
  );
  return `zbarimg --raw -> ${decoded}`;
});

check("a second, independent decoder agrees", () => {
  const decoded = jsqrDecode(qrFile);
  assert(decoded === RSVP_ID, `jsQR read ${JSON.stringify(decoded)}`);
  return `jsQR -> ${decoded}`;
});

// --- 8. the image set -------------------------------------------------------

check("every image is a real PNG at the density its filename claims", () => {
  const pngs = names.filter((n) => n.endsWith(".png"));
  assert(pngs.length > 0, "no images at all");
  const dims = {};
  for (const n of pngs) {
    const b = raw[n];
    assert(
      b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      `${n} is not a PNG`,
    );
    // IHDR sits at a fixed offset in every PNG.
    dims[n] = [b.readUInt32BE(16), b.readUInt32BE(20)];
  }
  // @2x must be twice @1x, @3x three times. Wallet picks by density and a
  // mismatched set is drawn at the wrong size or skipped.
  for (const n of pngs) {
    const base = n.replace(/@[23]x\.png$/, ".png");
    if (base === n) continue;
    const scale = n.includes("@2x") ? 2 : 3;
    if (!dims[base]) continue;
    const [w1, h1] = dims[base];
    const [wn, hn] = dims[n];
    assert(
      wn === w1 * scale && hn === h1 * scale,
      `${n} is ${wn}x${hn}, but ${base} is ${w1}x${h1} so it should be ${w1 * scale}x${h1 * scale}`,
    );
  }
  return Object.entries(dims).map(([n, d]) => `${n} ${d[0]}x${d[1]}`).join(", ");
});

// Apple's Table 4-1, verbatim: which styles may carry which images. The old
// build got this backwards and moved the pass to the ONE style that cannot show
// a background, in order to work around a limitation eventTicket does not have.
const STYLE_IMAGES = {
  boardingPass: ["logo", "icon", "footer"],
  coupon: ["logo", "icon", "strip"],
  eventTicket: ["logo", "icon", "strip", "background", "thumbnail"],
  generic: ["logo", "icon", "thumbnail"],
  storeCard: ["logo", "icon", "strip"],
};

check("the style can actually display every image the bundle ships", () => {
  const declared = STYLES.find((s) => pass[s]);
  const allowed = new Set([...(STYLE_IMAGES[declared] || []), "artwork", "secondaryLogo"]);
  const shipped = [
    ...new Set(names.filter((n) => n.endsWith(".png")).map((n) => n.replace(/(@[23]x)?\.png$/, ""))),
  ];
  for (const base of shipped) {
    assert(
      allowed.has(base),
      `${base}.png ships, but ${declared} cannot display it (${declared} takes: ${(
        STYLE_IMAGES[declared] || []
      ).join(", ")})`,
    );
  }
  // Apple: "If you specify a strip image, do not specify a background image or
  // a thumbnail." They are mutually exclusive and shipping both is undefined.
  if (shipped.includes("strip")) {
    assert(!shipped.includes("background"), "strip.png and background.png cannot coexist");
    assert(!shipped.includes("thumbnail"), "strip.png and thumbnail.png cannot coexist");
  }
  return `${declared}: ${shipped.join(", ")}`;
});

check("the card has an artwork ground, not just a flat colour", () => {
  const bases = new Set(
    names.filter((n) => n.endsWith(".png")).map((n) => n.replace(/(@[23]x)?\.png$/, "")),
  );
  assert(
    bases.has("background") || bases.has("strip") || bases.has("artwork"),
    "no background, strip or artwork — the pass is a flat colour block",
  );
  // The classic event ticket draws background.png; without it the poster art
  // never reaches the guest whatever else is in the bundle.
  assert(
    bases.has("background"),
    "no background.png, so a classic eventTicket has nothing to draw behind its fields",
  );
  for (const d of ["", "@2x", "@3x"]) {
    assert(names.includes(`background${d}.png`), `missing background${d}.png`);
  }
  return "background.png at 1x, 2x and 3x";
});

check("the poster layout is not silently switched on", () => {
  // Apple: "Poster event tickets aren't compatible with tickets that require a
  // QR code or barcode for entry." This pass is scanned at a door, so naming
  // posterEventTicket here would trade the code for the layout.
  const schemes = pass.preferredStyleSchemes;
  if (!schemes) return "preferredStyleSchemes absent, classic card, barcode on the face";
  assert(
    !schemes.includes("posterEventTicket"),
    `preferredStyleSchemes names posterEventTicket (${JSON.stringify(schemes)}), ` +
      "which Apple documents as incompatible with barcode entry",
  );
  return JSON.stringify(schemes);
});

check("the altText under the code is something the door would accept", () => {
  // It exists so a human can read the code out when a scanner will not
  // cooperate. Printing anything /api/admin/checkin rejects makes that fallback
  // fail at exactly the moment it is needed.
  for (const b of pass.barcodes) {
    if (!b.altText) continue;
    assert(
      CHECKIN_ACCEPTS.test(b.altText) || b.altText === RSVP_ID,
      `altText ${JSON.stringify(b.altText)} fails the checkin route's regex, ` +
        "so staff typing what they see would be told the code is unrecognised",
    );
  }
  return pass.barcodes.map((b) => b.altText).join(", ");
});

check("semantics carry the four tags Apple requires of an event pass", () => {
  const s = pass.semantics || {};
  for (const k of ["eventName", "venueName", "venueRegionName", "venueRoom"]) {
    assert(typeof s[k] === "string" && s[k].length, `semantics.${k} is missing or empty`);
  }
  assert(
    ["PKEventTypeLivePerformance", "PKEventTypeSports"].includes(s.eventType),
    `eventType ${s.eventType} is outside the set Apple gives richer event handling to`,
  );
  return `${s.eventType}, ${s.eventName} @ ${s.venueName}`;
});

// --- report -----------------------------------------------------------------

const width = Math.max(...results.map((r) => r.name.length));
console.log("");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log("");
console.log(`pkpass:   ${pkpassPath}`);
console.log(`unzipped: ${unzipped}`);
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
