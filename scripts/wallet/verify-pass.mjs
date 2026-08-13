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
//   4. the certificate that signed it was issued for THIS pass type and team,
//      and not for some other pass that happens to share a keychain
//   5. pass.json's structure matches the spec for the style it declares
//   6. the barcode payload is EXACTLY the identifier /api/admin/checkin expects
//   7. that payload survives a round trip through a real QR encoder and a real
//      camera-grade decoder (zbarimg), at the pixel size Wallet draws it
//   8. every image is the size Apple documents, not merely the right shape
//
// Step 7 is the one that matters. A payload that is present in JSON but cannot
// be decoded off a screen is the same as no pass at all.
//
// The checks that could pass without proving anything carry a negative control
// beside them — a deliberately broken input the same check has to reject. A
// green line from a check that cannot go red is worse than no check at all.
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
// published TEST Event, its real billed artist, a real party size. Held in a
// const because the negative controls below rebuild the same pass with one
// thing deliberately wrong.
const PASS_INPUT = {
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
};

const bytes = await buildPkpass(PASS_INPUT);

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

// --- 6. does the signature belong to THIS pass? -----------------------------

// Step 4 proves the signature covers these bytes. It says nothing about whose
// pass they are, and the three things that decide that are unrelated to each
// other: pass.json's passTypeIdentifier and teamIdentifier are read from
// PASS_TYPE_ID and PASS_TEAM_ID, while the signature comes from PASS_CERT_B64.
// Nothing in the build ties those env vars together, so pointing the identifiers
// at a pass type the certificate was never issued for produces a bundle that is
// internally consistent, verifies perfectly, and is refused by iOS the moment a
// guest taps Add — with no error the guest can see. That is the same silent
// failure class as the barcode typo this rig exists to catch, and it is one
// certificate rotation away at any time.
//
// Apple's leaf carries the evidence to catch it: the pass type identifier is the
// subject's UID and the team identifier is its OU.

function subjectFields(certPem) {
  const file = path.join(OUT, "signer-leaf.pem");
  fs.writeFileSync(file, certPem);
  // openssl again rather than node-forge, for the same reason step 4 uses it:
  // reading the signature back with the library that wrote it would only prove
  // the library agrees with itself.
  const out = execFileSync(
    "openssl",
    ["x509", "-in", file, "-noout", "-subject", "-nameopt", "RFC2253,sep_multiline"],
    { encoding: "utf8" },
  );
  const fields = {};
  for (const line of out.split("\n")) {
    const m = /^\s+([A-Za-z0-9.]+)=(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

function signerSubjectOf(signaturePath) {
  let bundle = "";
  try {
    bundle = execFileSync(
      "openssl",
      ["pkcs7", "-inform", "DER", "-in", signaturePath, "-print_certs"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    bundle = "";
  }
  const pems =
    bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  // The leaf is the one with a UID. The WWDR intermediate travelling with it
  // has none, which is what separates them without guessing at ordering.
  const leaves = pems.map(subjectFields).filter((s) => s.UID);
  if (leaves.length === 1) return leaves[0];
  assert(leaves.length < 2, `the signature carries ${leaves.length} leaf certificates`);
  // A signature that embedded no certificate at all still has to be held to
  // something, so fall back to the leaf this chain was signed with.
  const onDisk = path.join(CERTS, "pass.pem");
  assert(
    fs.existsSync(onDisk),
    "the signature embeds no leaf certificate and there is none on disk to check against",
  );
  return subjectFields(fs.readFileSync(onDisk, "utf8"));
}

function assertSignerMatches(passJson, subject) {
  assert(subject.UID, "the signing certificate has no UID, so it names no pass type");
  assert(subject.OU, "the signing certificate has no OU, so it names no team");
  assert(
    subject.UID === passJson.passTypeIdentifier,
    `the certificate was issued for ${JSON.stringify(subject.UID)} but pass.json ` +
      `declares ${JSON.stringify(passJson.passTypeIdentifier)}. iOS refuses such a ` +
      "pass at add time and tells the guest nothing.",
  );
  assert(
    subject.OU === passJson.teamIdentifier,
    `the certificate belongs to team ${JSON.stringify(subject.OU)} but pass.json ` +
      `declares ${JSON.stringify(passJson.teamIdentifier)}. iOS refuses such a ` +
      "pass at add time and tells the guest nothing.",
  );
  return `UID=${subject.UID}, OU=${subject.OU}`;
}

let signerSubject = null;
let signerSubjectError = null;
try {
  signerSubject = signerSubjectOf(path.join(unzipped, "signature"));
} catch (e) {
  signerSubjectError = e;
}

check("the certificate that signed it was issued for THIS pass type and team", () => {
  if (!signerSubject) throw signerSubjectError;
  return assertSignerMatches(pass, signerSubject);
});

// Negative control, in the shape of the tampered-manifest one above: rebuild the
// pass with the identifiers pointed somewhere else and the certificate left
// alone — precisely the state a rotated PASS_CERT_B64 leaves behind — and
// require the check to catch it. Without this it is two strings compared for
// equality with nothing proving they were ever free to differ.
const realTypeId = process.env.PASS_TYPE_ID;
const realTeamId = process.env.PASS_TEAM_ID;
const strays = [];
for (const [what, override] of [
  ["passTypeIdentifier", { PASS_TYPE_ID: "pass.com.someone.else.entirely" }],
  ["teamIdentifier", { PASS_TEAM_ID: "WRONGTEAM" }],
]) {
  process.env.PASS_TYPE_ID = realTypeId;
  process.env.PASS_TEAM_ID = realTeamId;
  Object.assign(process.env, override);
  const strayZip = await JSZip.loadAsync(await buildPkpass(PASS_INPUT));
  strays.push([what, JSON.parse(await strayZip.file("pass.json").async("string"))]);
}
process.env.PASS_TYPE_ID = realTypeId;
process.env.PASS_TEAM_ID = realTeamId;

check("a pass whose identifiers the certificate does not cover is rejected", () => {
  if (!signerSubject) throw signerSubjectError;
  const caught = [];
  for (const [what, strayPass] of strays) {
    let rejected = false;
    try {
      assertSignerMatches(strayPass, signerSubject);
    } catch {
      rejected = true;
    }
    assert(
      rejected,
      `a pass declaring a ${what} the certificate does not name still passed — ` +
        "the check is not real",
    );
    caught.push(what);
  }
  return `stray ${caught.join(" and ")} both rejected, as they must be`;
});

// --- 7. the barcode block ---------------------------------------------------

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

// --- 8. does it actually scan? ----------------------------------------------

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

// --- 9. the image set -------------------------------------------------------

// Apple's point sizes, from Table 4-1 and the notes beside it in Pass Design and
// Creation. These are the sizes Wallet lays the card out to; it does not scale
// an image up to fill the box it was given, so a bundle can be internally
// consistent — every density an exact multiple of the one below it — and still
// draw a 3x3 icon into a 29x29 slot. Ratios alone cannot see that, which is why
// the actual numbers are asserted here rather than the shapes.
//
// The logo box is Apple's maximum rather than a required size, and a narrower
// mark is legal. This one is composed to fill it exactly, so an exact assertion
// is the tighter check: if the logo stops being 160x50 that is a change worth
// being told about rather than one to shrug at.
const IMAGE_POINTS = {
  icon: [29, 29],
  logo: [160, 50],
  background: [180, 220],
  thumbnail: [90, 90],
  strip: [375, 98],
  artwork: [363, 510], // the poster layout's full-bleed ground, off by default
};

check("every image is a real PNG at the exact point size Apple documents", () => {
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
  // The @1x is the size everything else is measured against, so a family that
  // ships only a retina density is a hole, not a case to skip. Wallet falls back
  // to @1x on a non-retina render, and an @2x on its own says nothing about
  // what that fallback would draw.
  for (const n of pngs) {
    const base = n.replace(/@[23]x\.png$/, ".png");
    if (base === n) continue;
    assert(
      dims[base],
      `${n} ships but ${base} does not, so there is no @1x to be a multiple of ` +
        "and nothing for a non-retina device to fall back to",
    );
    // @2x must be twice @1x, @3x three times. Wallet picks by density and a
    // mismatched set is drawn at the wrong size or skipped.
    const scale = n.includes("@2x") ? 2 : 3;
    const [w1, h1] = dims[base];
    const [wn, hn] = dims[n];
    assert(
      wn === w1 * scale && hn === h1 * scale,
      `${n} is ${wn}x${hn}, but ${base} is ${w1}x${h1} so it should be ${w1 * scale}x${h1 * scale}`,
    );
  }
  // And the @1x itself has to be the size Apple asks for, or the whole family
  // is an exact multiple of the wrong picture.
  for (const n of pngs) {
    if (/@[23]x\.png$/.test(n)) continue;
    const base = n.replace(/\.png$/, "");
    const want = IMAGE_POINTS[base];
    assert(want, `${n} is not an image name Apple defines a size for`);
    const [w, h] = dims[n];
    assert(
      w === want[0] && h === want[1],
      `${n} is ${w}x${h}, but Apple draws ${base} at ${want[0]}x${want[1]}`,
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

check("the barcode tile carries the code and nothing else", () => {
  // altText is the line Wallet prints inside the white tile under the QR. It is
  // deliberately absent: it made the tile bottom-heavy instead of an even frame
  // around the code. See the note in convex/wallet/pkpass.ts.
  //
  // Asserted rather than skipped. The previous version of this check read "if
  // (!b.altText) continue", so the day the field was dropped the rig went green
  // and said nothing — the exact silent pass §4 of docs/wallet-gauntlet.md
  // listed as one of the things it could not catch. Now the absence is the
  // thing under test, and putting altText back fails here until this check is
  // updated too, which is the point: it is a design decision with a cost, so it
  // should not be reversible by accident in either direction.
  for (const b of pass.barcodes) {
    assert(
      b.altText === undefined,
      `barcode carries altText ${JSON.stringify(b.altText)}; the tile is meant to ` +
        "hold the code alone. If this is intentional, update this check and the " +
        "note in pkpass.ts together.",
    );
  }
  if (pass.barcode) {
    assert(
      pass.barcode.altText === undefined,
      "the legacy `barcode` key still carries altText; iOS versions that read it " +
        "would print a line the modern `barcodes` entry does not",
    );
  }
  return "no altText on any barcode entry";
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
