// Stateless HMAC-SHA256 tokens that identify one RSVP.
//
// The same token does three jobs: it fetches the guest's Wallet pass, it is the
// QR the door scans, and it authorises cancelling or editing that RSVP. Signing
// it rather than storing it keeps the rsvps table unchanged and means a link in
// an old email keeps working without a lookup table to maintain.
//
// Shape: "<rsvpId>.<hmac>". The id travels in the clear on purpose — it is a
// Convex document id, not a secret, and the signature is what grants access.
// Same primitive as lib/unsub.ts, kept separate so an unsubscribe token can
// never be replayed as an RSVP-management token.

const PURPOSE = "rsvp-manage-v1";

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function rsvpToken(secret: string, rsvpId: string): Promise<string> {
  const mac = await hmacHex(secret, `${PURPOSE}:${rsvpId}`);
  // Half the digest is 128 bits — far past guessing, and short enough that the
  // QR stays coarse. A dense QR is the difference between a door scan that
  // works on the first try and one that does not.
  return `${rsvpId}.${mac.slice(0, 32)}`;
}

// Returns the rsvpId only if the signature checks out. Constant-time compare so
// verification cannot be probed by timing.
export async function verifyRsvpToken(
  secret: string,
  token: string,
): Promise<string | null> {
  const raw = String(token || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const given = raw.slice(dot + 1);
  const expected = (await rsvpToken(secret, id)).slice(dot + 1);
  if (given.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return mismatch === 0 ? id : null;
}
