// Stateless HMAC-SHA256 unsubscribe tokens, signed with the UNSUB_SECRET env
// var. Runs in action/httpAction contexts where WebCrypto is available.

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
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function unsubToken(secret: string, email: string): Promise<string> {
  return hmacHex(secret, email.trim().toLowerCase());
}

// Constant-time comparison so token verification does not leak by timing.
export async function verifyUnsubToken(
  secret: string,
  email: string,
  token: string,
): Promise<boolean> {
  const expected = await unsubToken(secret, email);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}
