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
// A deep Academix crimson card, white type, soft-pink labels.
//
// This is how the reference ticket gets its richness: the card is a saturated
// colour, not a photograph. That matters, because the only Wallet layouts that
// print a barcode on the face are the classic ones, and none of them support
// background.png — proven on device, where an identical pass showed the QR as
// `generic` and hid it as `eventTicket`. Colour gives the depth an image
// cannot here, and the QR survives.
//
// #A81219 is the brand red carried down so white type clears 5.9:1 on it;
// #EC1C24 at full strength leaves white at roughly 3.4:1.
const INK = "rgb(255, 255, 255)";
const BG = "rgb(168, 18, 25)";
const BRAND = "rgb(255, 197, 197)";

function buildPassJson(p: PassInput) {
  const fields = {
    // No headerFields. The one pass that rendered a QR on this device had none,
    // and the date is already carried by STARTS below. Restore only after the
    // barcode is confirmed working.
    // Printed OVER the strip image, so it stays short and high-contrast.
    primaryFields: [
      { key: "event", label: "", value: p.eventTitle },
    ],
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
              label: p.artists.length > 1 ? "SPECIAL GUESTS" : "SPECIAL GUEST",
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

  return {
    formatVersion: 1,
    passTypeIdentifier: process.env.PASS_TYPE_ID,
    teamIdentifier: process.env.PASS_TEAM_ID,
    organizationName: "Academix BEAT Lab",
    description: `${p.eventTitle}, Mix & Greet`,
    serialNumber: p.serial,
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
    // Surfaces the pass on the lock screen as the event approaches.
    // relevantDate omitted for the same reason: it is a lock-screen nicety and
    // it was one of the few keys the working diagnostic did not carry.
    // NOTE: this pass is deliberately `generic`, not `eventTicket`.
    //
    // iOS 18 renders eventTicket in a poster layout that keeps the barcode
    // behind a tap — the same behaviour a Ticketmaster ticket shows. Proven on
    // device with two passes identical but for the style key: the generic one
    // printed the QR on the face, the eventTicket one printed nothing.
    // preferredStyleSchemes did not override it.
    //
    // A door cannot afford a gesture between the guest and the code, so the
    // functional layout wins over the semantic style name. The cost is
    // background.png, which only eventTicket supports; the poster overlay now
    // rides in thumbnail.png instead.
    barcodes: [
      {
        format: "PKBARCODE_FORMAT_QR",
        message: p.authToken,
        messageEncoding: "iso-8859-1",
        altText: p.serial,
      },
    ],
    // Deprecated singular form, still read by older iOS. Harmless on modern
    // versions, which prefer `barcodes`.
    barcode: {
      format: "PKBARCODE_FORMAT_QR",
      message: p.authToken,
      messageEncoding: "iso-8859-1",
      altText: p.serial,
    },
    generic: fields,
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
  for (const [name, b64] of Object.entries(PASS_IMAGES)) {
    // No thumbnail. In `generic` the thumbnail occupies the right-hand slot and
    // was the one thing the working diagnostic did not carry; with it present
    // the barcode never rendered. The card gets its richness from colour
    // instead, which is exactly how the reference ticket does it.
    if (name.startsWith("thumbnail")) continue;
    files[name] = Buffer.from(b64, "base64");
  }
  // No thumbnail: the card carries no special-guest photograph. The names are
  // the billing; the artwork is the background. This also keeps the pass small
  // — embedding a headshot took it to 891KB.

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
