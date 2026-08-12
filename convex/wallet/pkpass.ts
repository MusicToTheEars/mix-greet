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
  // The headliner's photograph, fetched at build time. This is the one thing
  // that makes a pass look like THIS party rather than a template, which is
  // exactly what the reference tickets do with their event artwork.
  thumbnail?: Uint8Array | null;
};

// Brand values, matching brand.css. Wallet takes CSS-style rgb() only.
//
// The card is the site's LIGHT content column, not its dark zone: bone surface,
// near-black type, and red reserved for the field labels. A light face is also
// what makes the QR read cleanly — Wallet draws the code on white, and a white
// block on a black card is a hole, while on bone it belongs.
// Red here is --brand-ink #C8151C, the deepened variant that survives on a
// light surface; plain #EC1C24 is only 4.0:1 on bone.
const INK = "rgb(22, 22, 26)";
const BG = "rgb(245, 244, 241)";
const BRAND = "rgb(200, 21, 28)";

function buildPassJson(p: PassInput) {
  const fields = {
    // Top-right, beside the logo: the date, the way a printed ticket stamps it.
    headerFields: [
      ...(p.dateShort ? [{ key: "d", label: "", value: p.dateShort }] : []),
      ...(p.timeShort ? [{ key: "t", label: "", value: p.timeShort }] : []),
    ],
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
    description: `${p.eventTitle} — Mix & Greet`,
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
    ...(p.whenIso ? { relevantDate: p.whenIso } : {}),
    // iOS 18 gave eventTicket a second, poster-style layout where the barcode
    // is behind a tap rather than on the card face — the same behaviour a
    // Ticketmaster ticket shows. A door needs the QR without an extra gesture,
    // so ask for the classic rectangular scheme explicitly. Older iOS ignores
    // the key, which is why it is safe to send unconditionally.
    preferredStyleSchemes: ["eventTicket"],
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
    eventTicket: fields,
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
    files[name] = Buffer.from(b64, "base64");
  }
  // A real headliner photo replaces the fallback disc. Written ONCE, at the 1x
  // key only: there is no image resizer in this runtime, so writing the same
  // file to all three densities tripled an 843KB headshot into a 2.5MB pass.
  // Wallet scales a single thumbnail perfectly well, and the @2x/@3x keys are
  // optional. The bundled fallback art is dropped so the manifest carries one
  // thumbnail rather than a mismatched set.
  if (p.thumbnail && p.thumbnail.length > 0) {
    delete files["thumbnail@2x.png"];
    delete files["thumbnail@3x.png"];
    files["thumbnail.png"] = Buffer.from(p.thumbnail);
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
