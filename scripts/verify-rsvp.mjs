#!/usr/bin/env node
// End-to-end verification of the Convex RSVP + email foundation.
// Uses only fixture addresses under @example.test; clean up afterwards with:
//   npx convex run migrate:purgeTestData '{"emailDomain":"example.test","eventId":"<id>"}'
//
// Usage: node scripts/verify-rsvp.mjs <eventId> [unsubSecretFile]

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://good-labrador-980.convex.site";
const eventId = process.argv[2];
const secretFile = process.argv[3];
if (!eventId) {
  console.error("usage: node scripts/verify-rsvp.mjs <eventId> [unsubSecretFile]");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ->  ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function post(path, body, headers = {}) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 1. Valid RSVP (2 of 3 seats)
let r = await post("/api/rsvp", {
  eventId,
  name: "Alice Tester",
  email: "alice@example.test",
  guests: 2,
  notes: "first through the door",
});
check("valid RSVP confirmed", r.status === 200 && r.body?.ok && r.body.status === "confirmed", JSON.stringify(r.body));

// 2. Duplicate (same email, case-insensitive) updates, no new record
r = await post("/api/rsvp", { eventId, name: "Alice T", email: "ALICE@example.test", guests: 3 });
check("duplicate dedupes", r.status === 200 && r.body?.duplicate === true, JSON.stringify(r.body));

// 3. Capacity: Alice now holds 3 of 3 seats, Bob must waitlist
r = await post("/api/rsvp", { eventId, name: "Bob Tester", email: "bob@example.test", guests: 2 });
check("over-capacity waitlists", r.status === 200 && r.body?.status === "waitlist", JSON.stringify(r.body));

// 4. Honeypot: success-shaped, stores nothing
r = await post("/api/rsvp", { eventId, name: "Bot", email: "bot@example.test", website: "spam.com" });
check("honeypot success-shaped", r.status === 200 && r.body?.ok === true, JSON.stringify(r.body));

// 5. Validation failures
r = await post("/api/rsvp", { eventId, name: "X", email: "not-an-email" });
check("bad email rejected 400", r.status === 400, JSON.stringify(r.body));
r = await post("/api/rsvp", { eventId: "nope", name: "X", email: "x@example.test" });
check("bad event rejected 400", r.status === 400, JSON.stringify(r.body));

// 6. Preflight
const opt = await fetch(API + "/api/rsvp", { method: "OPTIONS" });
check("OPTIONS /api/rsvp 204", opt.status === 204);

// 7. Unsubscribe flow (tokenized): suppress carol@, then RSVP her
if (secretFile) {
  const secret = readFileSync(secretFile, "utf8").trim();
  const email = "carol@example.test";
  const token = createHmac("sha256", secret).update(email).digest("hex");

  const bad = await fetch(`${API}/unsubscribe?e=${encodeURIComponent(email)}&t=${"0".repeat(64)}`);
  check("tampered unsub token 400", bad.status === 400);

  const good = await fetch(`${API}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`);
  const goodBody = await good.text();
  check("valid unsub link 200", good.status === 200 && goodBody.includes("unsubscribed"));

  r = await post("/api/rsvp", { eventId, name: "Carol Tester", email, guests: 1 });
  check("suppressed email can still RSVP", r.status === 200 && r.body?.ok, JSON.stringify(r.body));
}

// 8. Admin: login, guest list, CSV
const adminPass = process.env.ADMIN_PASSWORD;
if (adminPass) {
  const login = await post("/api/admin/login", { password: adminPass });
  check("admin login", login.status === 200 && !!login.body?.token);
  const tok = login.body?.token;

  const list = await fetch(`${API}/api/admin/rsvps?eventId=${eventId}`, {
    headers: { "x-admin-token": tok },
  });
  const listBody = await list.json().catch(() => null);
  const rows = listBody?.rsvps ?? [];
  check(
    "guest list: 3 rsvps (alice, bob, carol), bot absent",
    list.status === 200 && rows.length === 3 && !rows.some((x) => x.email.startsWith("bot")),
    rows.map((x) => `${x.email}:${x.status}:${x.guests}`).join(", "),
  );
  const alice = rows.find((x) => x.email === "alice@example.test");
  check("dedupe updated guests to 3", alice?.guests === 3 && alice?.name === "Alice T");

  const csv = await fetch(`${API}/api/admin/rsvps.csv?eventId=${eventId}`, {
    headers: { "x-admin-token": tok },
  });
  const csvText = await csv.text();
  check(
    "CSV export",
    csv.status === 200 &&
      (csv.headers.get("content-type") || "").includes("text/csv") &&
      csvText.split("\r\n")[0].startsWith("name,email"),
    csvText.split("\r\n")[0],
  );

  const noTok = await fetch(`${API}/api/admin/rsvps?eventId=${eventId}`);
  check("guest list without token 401", noTok.status === 401);
} else {
  console.log("SKIP  admin checks (set ADMIN_PASSWORD env var to include them)");
}

// 9. Unsigned webhook is rejected
const hook = await post("/resend-webhook", { type: "email.delivered", data: {} });
check("unsigned webhook rejected", hook.status >= 400, `status ${hook.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
