"use node";

// Apple Wallet pass builder.
//
// A .pkpass is a zip containing pass.json, the artwork, a manifest.json of
// SHA-1 hashes for every other file, and `signature` — a detached PKCS#7
// signature over that manifest, made with the Pass Type ID certificate and
// chained to Apple's WWDR intermediate. iOS verifies all four; a pass that is
// unsigned, mis-signed, or missing icon.png is rejected without an error the
// guest can see, so every piece here is load-bearing.
//
// "use node" is required: the signature needs node-forge, which does not run
// in Convex's default V8 isolate.
//
// ---------------------------------------------------------------------------
// WHY THE DOOR WAS DARK, AND WHAT IT WAS NOT
//
// For five commits this pass generated cleanly and printed no QR, and the
// hunt went after the layout: the style key was flipped to `generic`,
// background.png was abandoned, thumbnail.png was deleted, headerFields were
// stripped, relevantDate was dropped. None of that was the cause.
//
// The cause was one string. The barcode format was written
// `PKBARCODE_FORMAT_QR`. Apple's constant is `PKBarcodeFormatQR` — camel case,
// no underscores. That spelling appears in no Apple document and in none of
// Apple's sample passes; it has been wrong since the first wallet commit. iOS
// does not reject a pass over it and shows no error: it does not recognise the
// format, so it drops the barcode and draws the card without one. Every A/B on
// device was therefore comparing two passes that could not print a code either
// way, and the style key took the blame for a typo.
//
// The two beliefs recorded in the old comments here are also false, and the
// proof is in Apple's own documentation and shipped samples:
//
//   * "none of the classic layouts support background.png" — backwards.
//     Apple's Table 4-1 gives eventTicket "logo, icon, strip, background,
//     thumbnail", and gives `generic` only "logo, icon, thumbnail". Apple's own
//     Event.pass sample is a classic eventTicket shipping background.png and
//     background@2x.png. So the switch to `generic` did not work around a
//     limitation of eventTicket — it moved to the one style that genuinely
//     cannot show a background, and threw the artwork away to do it.
//
//   * "eventTicket hides the barcode" — not the style. That behaviour belongs
//     to the iOS 18 POSTER layout, which a pass cannot enter by accident: it
//     requires preferredStyleSchemes to name `posterEventTicket` AND all four
//     required semantic tags to validate. A plain eventTicket renders the
//     classic card with the barcode on the face, exactly as it always did.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT THE POSTER LAYOUT
//
// The obvious next move is the iOS 18 poster ticket — full-bleed unblurred
// artwork, the modern Wallet event card. Apple rules it out for this pass, in
// as many words:
//
//   "Poster event tickets aren't compatible with tickets that require a QR
//    code or barcode for entry."
//   — Creating an event pass using semantic tags
//
// That layout is built around NFC entry, which needs an entitlement this team
// does not have. A door that cannot scan is the whole problem being fixed, so
// the barcode wins and the pass stays a classic eventTicket.
//
// The artwork still lands: on a classic event ticket Apple scales background.png
// to fill the card and blurs it, so the card has a designed ground rather than a
// flat colour block.
//
// artwork.png is NOT in the bundle. Only the poster layout draws it, that layout
// is off, and shipping it cost 395 KB of a 583 KB pass for a picture no guest
// could see. `scripts/wallet/make-images.mjs --with-artwork` puts it back, so
// enabling the poster scheme is a rebuild rather than a config change — which is
// the right trade while the door is what matters.

import forge from "node-forge";
import JSZip from "jszip";
import { PASS_IMAGES } from "./images";

function pem(envName: string): string {
  const b64 = process.env[envName];
  if (!b64) throw new Error(`wallet not configured: ${envName} is unset`);
  // Stored base64-encoded because the Convex CLI cannot carry a multi-line
  // value through an argv slot.
  return Buffer.from(b64, "base64").toString("utf8");
}

export type PassInput = {
  serial: string; // stable per RSVP, so re-adding updates rather than duplicates
  authToken: string; // also the QR payload the door scans
  eventTitle: string;
  subtitle?: string;
  // Every non-company name on the bill, in order. Plural because an event can
  // have several and they are printed as a column.
  artists?: string[];
  whenIso?: string; // ISO 8601 with offset; drives the lock-screen relevance
  endIso?: string;
  whenLabel: string;
  dateShort?: string; // "AUG 15" — the header stamp
  timeShort?: string; // "1:00 PM"
  location: string;
  guestName: string;
  partyLabel: string;
  status: "confirmed" | "waitlist";
  inviteUrl?: string;
  venueLine?: string; // street only — the full address is on the back
};

// Brand values, matching brand.css. Wallet takes CSS-style rgb() only.
//
// The card's ground is now the poster artwork, so these colours dress the type
// and the classic-layout fallback rather than carrying the whole design: near
// black from the invite page, cream ink, and the Academix red on labels.
const INK = "rgb(237, 234, 227)"; // #EDEAE3, the invite page's cream
const BG = "rgb(11, 11, 13)"; // #0B0B0D, the invite page's ground
const BRAND = "rgb(236, 28, 36)"; // #EC1C24

// Apple's constant, verbatim. See the note at the top of this file: the
// underscored spelling is not a PassKit format and costs you the whole barcode.
const QR_FORMAT = "PKBarcodeFormatQR";

function buildPassJson(p: PassInput) {
  const artistLabel =
    p.artists && p.artists.length > 1 ? "SPECIAL GUESTS" : "SPECIAL GUEST";

  const fields = {
    // Over the poster art. The date is the one thing a guest checks at a
    // glance, and the header is the only slot Wallet keeps visible when the
    // pass is stacked behind others in the wallet.
    headerFields: p.dateShort
      ? [{ key: "date", label: "", value: p.dateShort }]
      : [],
    primaryFields: [{ key: "event", label: "", value: p.eventTitle }],
    // Wallet lays each group out as a horizontal ROW, so a field only gets the
    // full width when it is alone in its group. The guests need that width to
    // stack, which is why they own auxiliaryFields outright and the venue moved
    // to the back.
    secondaryFields: [
      { key: "when", label: "STARTS", value: p.whenLabel },
      { key: "admit", label: "ADMIT", value: `${p.guestName} · ${p.partyLabel}` },
    ],
    auxiliaryFields: [
      ...(p.artists && p.artists.length
        ? [
            {
              key: "artists",
              label: artistLabel,
              // Newline-joined so several names read as a column, one under the
              // next, rather than running together on one line.
              value: p.artists.join("\n"),
            },
          ]
        : []),
    ],
    backFields: [
      ...(p.subtitle ? [{ key: "sub", label: "Session", value: p.subtitle }] : []),
      ...(p.location ? [{ key: "where", label: "Venue", value: p.location }] : []),
      { key: "party", label: "Party size", value: p.partyLabel },
      { key: "guest", label: "Guest", value: p.guestName },
      {
        key: "status",
        label: "Status",
        value: p.status === "waitlist" ? "Waitlist" : "Confirmed",
      },
      ...(p.inviteUrl
        ? [{ key: "invite", label: "Invitation", value: p.inviteUrl }]
        : []),
      {
        key: "change",
        label: "Plans changed?",
        value: "Reply to your confirmation email and we'll update your spot.",
      },
    ],
  };

  // Structured meaning, not decoration. iOS reads these to put the ticket on
  // the lock screen at the right moment, to offer directions to the right
  // place, and to let Siri answer "when do doors open". Apple restricts the
  // richer event handling to sports and live performance, which is what a
  // Mix & Greet is.
  //
  // eventName, venueName, venueRegionName and venueRoom are the four Apple
  // requires; a pass that omits any of them is silently demoted to the plain
  // layout. They are filled here so the pass is complete on its own terms, and
  // so enabling WALLET_STYLE_SCHEMES later does not also require a data change.
  const address = (p.location || "").split(",").map((s) => s.trim()).filter(Boolean);
  const semantics: Record<string, unknown> = {
    eventType: "PKEventTypeLivePerformance",
    eventName: p.eventTitle,
    attendeeName: p.guestName,
    admissionLevel: p.status === "waitlist" ? "Waitlist" : "Guest",
    // "1933 S. Broadway, Suite 1202, Los Angeles, CA 90007" reads as
    // street / room / city, which is exactly the three tags Apple wants.
    venueName: p.venueLine || address[0] || p.location || "",
    venueRoom: address[1] || "",
    venueRegionName: address[2] || "",
  };
  if (p.artists && p.artists.length) semantics.performerNames = p.artists;
  if (p.location) semantics.venueEntranceDescription = p.location;
  if (p.whenIso) {
    semantics.eventStartDate = p.whenIso;
    semantics.venueDoorsOpenDate = p.whenIso;
  }
  if (p.endIso) semantics.eventEndDate = p.endIso;

  const barcode = {
    format: QR_FORMAT,
    message: p.authToken,
    messageEncoding: "iso-8859-1",
    // Printed under the code for a human to read out when a scanner will not
    // cooperate. It must therefore be the payload itself, not the serial: the
    // serial is `mg-<id>`, and the hyphen makes it fail /api/admin/checkin's
    // own /^[a-z0-9]{20,40}$/ test, so a door typing what it saw would be told
    // the code was unrecognised.
    altText: p.authToken,
  };

  return {
    formatVersion: 1,
    passTypeIdentifier: process.env.PASS_TYPE_ID,
    teamIdentifier: process.env.PASS_TEAM_ID,
    organizationName: "Academix BEAT Lab",
    description: `${p.eventTitle}, Mix & Greet`,
    serialNumber: p.serial,
    // Groups every Mix & Greet ticket under one stack in Wallet instead of
    // scattering them, which is what a guest with three events wants.
    groupingIdentifier: "mix-and-greet",
    // No authenticationToken here on purpose: Apple only accepts it paired with
    // a webServiceURL, and there is no update endpoint yet. Setting one without
    // the other leaves the pass in a half-configured state. The token still
    // travels as the QR payload below.
    foregroundColor: INK,
    backgroundColor: BG,
    labelColor: BRAND,
    // No logoText: Wallet draws it to the RIGHT of the logo with no option to
    // place it below, so "MIX & GREET" is baked into logo.png as the second
    // line of the lockup. Setting it here too would print the name twice.
    //
    // The card is an eventTicket, which is both what it is and the one classic
    // style that takes background.png.
    //
    // preferredStyleSchemes is deliberately ABSENT by default. Naming
    // `posterEventTicket` here is what opts a pass into the iOS 18 poster
    // layout, and that layout is the one Apple says is "not compatible with
    // tickets that require a QR code or barcode for entry". Omitting the key
    // keeps the classic card, which prints the code on the face.
    //
    // The env var exists so the poster layout can be switched on the day this
    // pass no longer depends on a barcode — set
    // WALLET_STYLE_SCHEMES=posterEventTicket,eventTicket. The artwork is
    // already in the bundle for it. Do not set it while the door scans.
    ...(process.env.WALLET_STYLE_SCHEMES
      ? {
          preferredStyleSchemes: process.env.WALLET_STYLE_SCHEMES.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    eventTicket: fields,
    semantics,
    // Surfaces the pass on the lock screen as the event approaches. The array
    // form is what iOS 18 reads; the singular relevantDate stays for older
    // versions, which ignore the array.
    ...(p.whenIso
      ? {
          relevantDate: p.whenIso,
          relevantDates: [
            { startDate: p.whenIso, ...(p.endIso ? { endDate: p.endIso } : {}) },
          ],
        }
      : {}),
    barcodes: [barcode],
    // Deprecated singular form, still read by iOS 8 and earlier. Apple's own
    // current samples still carry both.
    barcode,
  };
}

function sha1(bytes: Buffer): string {
  const md = forge.md.sha1.create();
  md.update(forge.util.createBuffer(bytes.toString("binary")).getBytes());
  return md.digest().toHex();
}

// Detached PKCS#7, DER-encoded — exactly what Apple's `signature` file is.
function signManifest(manifest: Buffer): Buffer {
  const cert = forge.pki.certificateFromPem(pem("PASS_CERT_B64"));
  const key = forge.pki.privateKeyFromPem(pem("PASS_KEY_B64"));
  const wwdr = forge.pki.certificateFromPem(pem("PASS_WWDR_B64"));

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString("binary"));
  p7.addCertificate(cert);
  p7.addCertificate(wwdr); // the chain, or iOS will not trust the leaf
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date().toISOString() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
}

export async function buildPkpass(p: PassInput): Promise<Uint8Array> {
  const files: Record<string, Buffer> = {};

  files["pass.json"] = Buffer.from(JSON.stringify(buildPassJson(p)), "utf8");
  // Whatever the image set holds. There is deliberately no thumbnail and no
  // guest photograph: the names are the billing, the mark is the ground.
  for (const [name, b64] of Object.entries(PASS_IMAGES)) {
    files[name] = Buffer.from(b64, "base64");
  }

  // manifest.json hashes every file EXCEPT itself and the signature.
  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) manifest[name] = sha1(buf);
  const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");

  const zip = new JSZip();
  for (const [name, buf] of Object.entries(files)) zip.file(name, buf);
  zip.file("manifest.json", manifestBuf);
  zip.file("signature", signManifest(manifestBuf));

  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
