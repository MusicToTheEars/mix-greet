#!/usr/bin/env node
/**
 * Door-to-door proof of the invite journey.
 *
 * Invite link -> RSVP -> signed token -> QR PNG -> a real image decode -> the
 * door scanner's check-in call -> attendance recorded -> a second scan caught.
 *
 * Nothing here is mocked. Every step is the same HTTP route the browser calls,
 * and the QR is decoded from the actual PNG bytes the endpoint returns, so a
 * change that makes the code unscannable fails the test rather than passing on
 * a string comparison.
 *
 * Run it with scripts/e2e-invite-flow.sh, which brings up a throwaway local
 * Convex deployment first. Pointing it at a real deployment by hand is
 * possible (API=... ADMIN_PASSWORD=... node scripts/e2e-invite-flow.mjs) but it
 * writes events and RSVPs, so never aim it at production.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const API = process.env.API || "http://127.0.0.1:3211";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "e2e-door-pass";
// The QR decoders are resolved from wherever the runner installed them, so this
// repo does not need its own node_modules to be testable.
const require = createRequire(
  process.env.E2E_MODULE_BASE
    ? join(process.env.E2E_MODULE_BASE, "e2e-resolver.cjs")
    : import.meta.url,
);

// ---------------------------------------------------------------- assertions
let passed = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
  return ok;
}
function step(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------- http
async function req(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
const jsonPost = (path, body, headers = {}) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

let TOKEN = "";
const adminPost = (path, body) => jsonPost(path, body, { "x-admin-token": TOKEN });
const adminGet = (path) => req(path, { headers: { "x-admin-token": TOKEN } });

// ---------------------------------------------------------------- QR decode
// Decoded from the real pixels, twice where possible: jsQR always (pure JS, so
// the test runs anywhere) and zbarimg when it is installed, because a PNG that
// only one decoder can read is not a QR a door scanner will read.
function decodeQr(pngBytes) {
  const jsQR = require("jsqr");
  const { PNG } = require("pngjs");
  const img = PNG.sync.read(Buffer.from(pngBytes));
  const hit = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  const results = { jsqr: hit ? hit.data : null, zbar: null, size: `${img.width}x${img.height}` };
  try {
    const file = join(mkdtempSync(join(tmpdir(), "mg-qr-")), "code.png");
    writeFileSync(file, Buffer.from(pngBytes));
    results.zbar = execFileSync("zbarimg", ["--raw", "-q", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // zbar is optional; jsQR is the gate.
  }
  return results;
}

// ---------------------------------------------------------------- the walk
const stamp = Date.now();
const mail = (who) => `${who}.${stamp}@example.test`;

async function main() {
  step("0. door staff sign in");
  const login = await jsonPost("/api/admin/login", { password: ADMIN_PASSWORD });
  if (!check("admin login returns a session token", login.status === 200 && !!login.body?.token, JSON.stringify(login.body))) {
    throw new Error("cannot continue without an admin session");
  }
  TOKEN = login.body.token;

  const badLogin = await jsonPost("/api/admin/login", { password: "not-the-password" });
  check("wrong password is refused", badLogin.status === 401);

  step("1. seed the event a host would create");
  const mkEvent = async (event) => {
    const res = await adminPost("/api/events", { action: "create", event });
    const row = (res.body?.published || []).find((e) => e.title === event.title);
    if (!row) throw new Error(`event not created: ${JSON.stringify(res.body).slice(0, 200)}`);
    return row;
  };
  const ev = await mkEvent({
    title: `E2E Door Night ${stamp}`,
    date: "2099-01-01",
    start: "7:00 PM",
    end: "11:00 PM",
    location: "1933 S. Broadway, Suite 1202, Los Angeles, CA 90007",
    rsvpMode: "hosted",
    // Small on purpose: the waitlist step below has to overflow it no matter
    // which of the earlier guests are through the door.
    capacity: 4,
  });
  const other = await mkEvent({
    title: `E2E Other Night ${stamp}`,
    date: "2099-02-02",
    rsvpMode: "hosted",
  });
  check("event mints an invite slug", !!ev.slug, JSON.stringify(ev.slug));
  check("invite url is absolute and carries the slug", /^https?:\/\/.+\/i\/.+/.test(ev.inviteUrl || ""), ev.inviteUrl);

  step("2. the invite page loads that event by its public slug");
  const publicEvent = await req(`/api/events?event=${encodeURIComponent(ev.slug)}`);
  check("GET /api/events?event=<slug> returns the event", publicEvent.status === 200 && publicEvent.body?.id === ev.id);
  check("hosted event exposes an rsvp target", publicEvent.body?.rsvpMode === "hosted" && !!publicEvent.body?.rsvp);
  const missing = await req("/api/events?event=definitely-not-an-event");
  check("unknown slug 404s instead of leaking the list", missing.status === 404);

  step("3. a guest RSVPs through the real route");
  const rsvp = await jsonPost("/api/rsvp", {
    eventId: ev.slug,
    name: "Dana Door",
    email: mail("dana"),
    phone: "555-0100",
    guests: 2,
  });
  check("RSVP accepted and confirmed", rsvp.status === 200 && rsvp.body?.ok === true && rsvp.body?.status === "confirmed", JSON.stringify(rsvp.body));
  const token = rsvp.body?.manageToken;
  check("a signed token comes back with the RSVP", typeof token === "string" && token.includes("."), String(token));
  check("the raw rsvp id is never returned to the browser", rsvp.body?.rsvpId === undefined);

  const honeypot = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Bot", email: mail("bot"), website: "spam" });
  check("honeypot answers success-shaped", honeypot.status === 200 && honeypot.body?.ok === true);

  step("4. the guest gets a scannable code");
  const qr = await fetch(`${API}/api/qr?t=${encodeURIComponent(token)}`);
  check("GET /api/qr returns a PNG", qr.status === 200 && (qr.headers.get("content-type") || "").includes("image/png"), `status ${qr.status}`);
  const png = Buffer.from(await qr.arrayBuffer());
  check("the PNG has real bytes", png.length > 200, `${png.length} bytes`);

  const decoded = decodeQr(png);
  check("jsQR decodes the PNG", !!decoded.jsqr, `size ${decoded.size}`);
  // A code that is technically decodable but renders 90px wide is one a door
  // scanner fails on across a dark room. The endpoint asks for scale 10, so
  // anything much under 300px means the render silently changed.
  const [w] = decoded.size.split("x").map(Number);
  check("the code is printed large enough to scan off a phone", w >= 300, `${decoded.size}`);
  if (decoded.zbar !== null) {
    check("zbar decodes the PNG to the same payload", decoded.zbar === decoded.jsqr, `zbar=${decoded.zbar} jsqr=${decoded.jsqr}`);
  } else {
    console.log("  ....  zbarimg not installed, skipped the second decoder");
  }
  const payload = decoded.jsqr;
  check("the decoded payload is the guest's rsvp id", !!payload && token.startsWith(payload + "."), `payload=${payload}`);

  step("5. the door scans it");
  const scan1 = await adminPost("/api/admin/checkin", { code: payload, eventId: ev.slug });
  check("first scan checks the guest in", scan1.status === 200 && scan1.body?.state === "in", JSON.stringify(scan1.body));
  check("the door sees the guest's name", scan1.body?.name === "Dana Door");
  check("the door sees the party size", scan1.body?.guests === 2);

  const list1 = await adminGet(`/api/admin/rsvps?eventId=${ev.slug}`);
  const dana = (list1.body?.rsvps || []).find((r) => r.name === "Dana Door");
  check("the RSVP is recorded as checked in", dana?.status === "checked_in", JSON.stringify(dana));
  check("the guest list reports when they arrived", !!dana?.checkedInAt, JSON.stringify(dana?.checkedInAt));

  step("6. the same code shown twice is caught");
  const scan2 = await adminPost("/api/admin/checkin", { code: payload, eventId: ev.slug });
  check("second scan is reported as a duplicate", scan2.status === 200 && scan2.body?.state === "already", JSON.stringify(scan2.body));
  check("the duplicate says when they first came through", !!scan2.body?.at);
  // The Wallet pass and the PNG both encode the bare id, but a scanner gun and
  // a guest's own link can also present the full signed token. Both have to
  // land on the same row, or one guest could be counted twice.
  const scan3 = await adminPost("/api/admin/checkin", { code: token, eventId: ev.slug });
  check("the signed token scans to the same guest, still a duplicate", scan3.body?.state === "already" && scan3.body?.name === "Dana Door", JSON.stringify(scan3.body));

  const door1 = await adminGet(`/api/admin/door?eventId=${ev.slug}`);
  check("door counts 2 heads through", door1.body?.checkedIn === 2, JSON.stringify(door1.body));
  check("door counts the party once, not twice", door1.body?.parties?.checkedIn === 1, JSON.stringify(door1.body?.parties));

  step("7. a pass for another event does not open this door");
  const wrong = await adminPost("/api/admin/checkin", { code: payload, eventId: other.slug });
  check("scanning at the wrong event is refused", wrong.body?.state === "wrong_event", JSON.stringify(wrong.body));
  check("the refusal names the event the pass is really for", wrong.body?.event === ev.title, JSON.stringify(wrong.body?.event));
  const otherDoor = await adminGet(`/api/admin/door?eventId=${other.slug}`);
  check("the wrong event's numbers are untouched", otherDoor.body?.checkedIn === 0, JSON.stringify(otherDoor.body));
  // Fail closed: a door running an event key that resolves to nothing (a typo,
  // a deleted event, a stale tab) must not quietly become an unscoped door.
  const unknownScope = await adminPost("/api/admin/checkin", { code: payload, eventId: "no-such-event-key" });
  check("an unresolvable event key does not fall back to an unscoped scan", unknownScope.body?.state === "wrong_event", JSON.stringify(unknownScope.body));
  // Undo has to be scoped too, or the wrong door can un-check-in a guest who
  // is standing inside a different room.
  const wrongUndo = await adminPost("/api/admin/checkin", { code: payload, eventId: other.slug, undo: true });
  check("undo at the wrong event changes nothing", wrongUndo.body?.state === "wrong_event", JSON.stringify(wrongUndo.body));
  const stillIn = await adminGet(`/api/admin/rsvps?eventId=${ev.slug}`);
  check("the guest is still checked in after a wrong-event undo", (stillIn.body?.rsvps || []).find((r) => r.name === "Dana Door")?.status === "checked_in");

  step("8. a tampered or expired code is refused");
  const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  const badQr = await req(`/api/qr?t=${encodeURIComponent(tampered)}`);
  check("a tampered token gets no QR", badQr.status === 404, `status ${badQr.status}`);
  const badScan = await adminPost("/api/admin/checkin", { code: "not-a-real-code", eventId: ev.slug });
  check("an unrecognised code is refused", badScan.status === 404, JSON.stringify(badScan.body));
  const noAuth = await jsonPost("/api/admin/checkin", { code: payload, eventId: ev.slug });
  check("check-in without a staff token is refused", noAuth.status === 401);

  step("9. a guest who cancels cannot walk in on the old code");
  const chrisMail = mail("chris");
  const chris = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Chris Cancels", email: chrisMail, guests: 1 });
  const chrisTok = chris.body?.manageToken;
  const cancelled = await jsonPost("/api/rsvp/manage", { t: chrisTok, action: "cancel" });
  check("the guest can cancel with their own token", cancelled.status === 200 && cancelled.body?.status === "cancelled", JSON.stringify(cancelled.body));
  const chrisQr = await req(`/api/qr?t=${encodeURIComponent(chrisTok)}`);
  check("a cancelled RSVP has no QR", chrisQr.status === 404);
  const chrisScan = await adminPost("/api/admin/checkin", { code: chrisTok.split(".")[0], eventId: ev.slug });
  check("scanning a cancelled RSVP is refused at the door", chrisScan.body?.state === "cancelled", JSON.stringify(chrisScan.body));

  step("10. that guest changes their mind and RSVPs again");
  const chrisAgain = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Chris Cancels", email: chrisMail, guests: 1 });
  check("re-RSVP puts a cancelled guest back on the list", chrisAgain.body?.status === "confirmed", JSON.stringify(chrisAgain.body));
  const chrisTok2 = chrisAgain.body?.manageToken;
  const chrisQr2 = await req(`/api/qr?t=${encodeURIComponent(chrisTok2)}`);
  check("their code works again", chrisQr2.status === 200);
  const chrisScan2 = await adminPost("/api/admin/checkin", { code: chrisTok2.split(".")[0], eventId: ev.slug });
  check("they get through the door", chrisScan2.body?.state === "in", JSON.stringify(chrisScan2.body));

  step("11. a waitlisted guest turns up");
  const wanda = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Wanda Wait", email: mail("wanda"), guests: 4 });
  check("over capacity lands on the waitlist", wanda.body?.status === "waitlist", JSON.stringify(wanda.body));
  const wandaTok = wanda.body?.manageToken;
  const wandaQr = await req(`/api/qr?t=${encodeURIComponent(wandaTok)}`);
  check("a waitlisted guest still gets a code", wandaQr.status === 200);
  const wandaScan = await adminPost("/api/admin/checkin", { code: wandaTok.split(".")[0], eventId: ev.slug });
  check("the door is told they were on the waitlist", wandaScan.body?.state === "waitlist_in", JSON.stringify(wandaScan.body));

  step("12. a mis-scan can be undone without corrupting the list");
  const undo = await adminPost("/api/admin/checkin", { code: wandaTok.split(".")[0], eventId: ev.slug, undo: true });
  check("undo reverses the check-in", undo.body?.state === "undone", JSON.stringify(undo.body));
  const listAfterUndo = await adminGet(`/api/admin/rsvps?eventId=${ev.slug}`);
  const wandaRow = (listAfterUndo.body?.rsvps || []).find((r) => r.name === "Wanda Wait");
  check("undo puts a waitlisted guest back on the waitlist, not the confirmed list", wandaRow?.status === "waitlist", JSON.stringify(wandaRow));

  step("12b. a guest who is already inside cannot delete their own attendance");
  // Cancelling is a promise about the future. A guest fiddling with the link in
  // their email an hour into the party, or an accidental tap, must not be able
  // to remove a head that physically walked through the door: that is the one
  // number the host cannot reconstruct afterwards.
  const insideCancel = await jsonPost("/api/rsvp/manage", { t: token, action: "cancel" });
  const listAfterInside = await adminGet(`/api/admin/rsvps?eventId=${ev.slug}`);
  const danaNow = (listAfterInside.body?.rsvps || []).find((r) => r.name === "Dana Door");
  check("a checked-in guest stays checked in when they hit cancel", danaNow?.status === "checked_in", JSON.stringify({ response: insideCancel.body, row: danaNow }));

  step("13. the numbers a host reads at the end of the night");
  const door2 = await adminGet(`/api/admin/door?eventId=${ev.slug}`);
  check("expected heads still counts the people already through", (door2.body?.expected ?? -1) >= (door2.body?.checkedIn ?? 0), JSON.stringify(door2.body));
  const csv = await fetch(`${API}/api/admin/rsvps.csv?eventId=${ev.slug}`, { headers: { "x-admin-token": TOKEN } });
  const csvText = await csv.text();
  check("CSV export includes attendance", csv.status === 200 && /checkedInAt/i.test(csvText.split("\r\n")[0]), csvText.split("\r\n")[0]);

  step("14. the pass link never dead-ends the guest");
  const pass = await req(`/api/pass?t=${encodeURIComponent(token)}`);
  check("a pass request answers with a page or a pass, never a 500", pass.status !== 500, `status ${pass.status}`);

  step("15. the confirmation email carries a code for a guest with no Apple device");
  renderEmailChecks(token);

  step("16. knowing a guest's email address is not the same as being them");
  // The invite slug is public and printed in every invite link, so an email
  // address was the only other thing needed to be handed that guest's door
  // code, their Wallet pass and their cancel button, all from one unsigned
  // POST. This is the assertion that stops it coming back.
  const victimMail = mail("victim");
  const victim = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Vera Victim", email: victimMail, guests: 1 });
  const victimToken = victim.body?.manageToken;
  check("a brand new RSVP does get a token", !!victimToken);
  const impostor = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Someone Else", email: victimMail, guests: 1 });
  check("re-submitting a known email hands out no token at all", !impostor.body?.manageToken, JSON.stringify(impostor.body));
  check("and still never returns the raw rsvp id", impostor.body?.rsvpId === undefined, JSON.stringify(impostor.body));

  step("17. an anonymous form post cannot rewrite attendance");
  // The manage route refuses to resize a guest who is already inside. That
  // refusal is worthless if the public RSVP form will do it anyway.
  const doorBefore = await adminGet(`/api/admin/door?eventId=${ev.slug}`);
  const rewrite = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Dana Door", email: dana.email, guests: 9 });
  const doorAfter = await adminGet(`/api/admin/door?eventId=${ev.slug}`);
  check(
    "re-submitting for a checked-in guest does not change the head count",
    doorAfter.body?.checkedIn === doorBefore.body?.checkedIn,
    JSON.stringify({ before: doorBefore.body?.checkedIn, after: doorAfter.body?.checkedIn, response: rewrite.body }),
  );

  step("18. a scan with no event named is refused, not trusted");
  // A stale tab or a cached older copy of the scanner is exactly the caller
  // that sends no event, so this cannot be enforced in the browser alone.
  const wandaId = wandaTok.split(".")[0];
  for (const [label, body] of [
    ["no eventId key at all", { code: wandaId }],
    ["an empty eventId", { code: wandaId, eventId: "" }],
    ["a whitespace eventId", { code: wandaId, eventId: "   " }],
    ["a null eventId", { code: wandaId, eventId: null }],
  ]) {
    const res = await adminPost("/api/admin/checkin", body);
    check(`unscoped scan refused: ${label}`, res.status >= 400 || res.body?.state === "wrong_event", JSON.stringify(res.body));
  }
  const wandaAfterUnscoped = (await adminGet(`/api/admin/rsvps?eventId=${ev.slug}`)).body?.rsvps?.find((r) => r.name === "Wanda Wait");
  check("none of those unscoped scans checked anybody in", wandaAfterUnscoped?.status === "waitlist", JSON.stringify(wandaAfterUnscoped));

  step("19. undo really clears the arrival, it does not just change the status");
  const solo = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Solo Sam", email: mail("sam"), guests: 1 });
  const soloId = solo.body.manageToken.split(".")[0];
  await adminPost("/api/admin/checkin", { code: soloId, eventId: ev.slug });
  await adminPost("/api/admin/checkin", { code: soloId, eventId: ev.slug, undo: true });
  const soloRow = (await adminGet(`/api/admin/rsvps?eventId=${ev.slug}`)).body?.rsvps?.find((r) => r.name === "Solo Sam");
  // Against the list they were actually on, not a hardcoded "confirmed": by
  // this point in the run this room of four is holding four heads (two parties
  // through the door and one still confirmed), so Sam RSVPs onto the waitlist
  // and undo restoring "waitlist" is the correct answer. Demanding "confirmed"
  // here would demand the exact overbooking step 21 forbids. What undo has to
  // prove is that it puts a guest back on the list they came in on, whichever
  // one that is, rather than only wiping the stamp.
  check(
    "undo returns a guest to the list they were on before the scan",
    !!solo.body?.status && soloRow?.status === solo.body.status,
    JSON.stringify({ atRsvp: solo.body?.status, afterUndo: soloRow }),
  );
  check("undo clears the arrival time", soloRow?.checkedInAt === "", JSON.stringify(soloRow?.checkedInAt));
  const csv2 = await (await fetch(`${API}/api/admin/rsvps.csv?eventId=${ev.slug}`, { headers: { "x-admin-token": TOKEN } })).text();
  const soloLine = csv2.split("\r\n").find((l) => l.includes("Solo Sam")) || "";
  check("and the CSV shows no arrival for them either", /,""\s*$/.test(soloLine), soloLine);

  step("20. an archived event is not a working door");
  const oldEv = await mkEvent({ title: `E2E Archived ${stamp}`, date: "2099-03-03", rsvpMode: "hosted" });
  const ghost = await jsonPost("/api/rsvp", { eventId: oldEv.slug, name: "Ghost Guest", email: mail("ghost"), guests: 1 });
  const ghostId = ghost.body.manageToken.split(".")[0];
  await adminPost("/api/events", { action: "archive", id: oldEv.id });
  const ghostScan = await adminPost("/api/admin/checkin", { code: ghostId, eventId: oldEv.slug });
  check("scanning into an archived event is refused", ghostScan.status >= 400 || ghostScan.body?.state !== "in", JSON.stringify(ghostScan.body));

  step("21. a cancellation cannot overbook the room");
  // Promotion used to count only the rows still sitting in "confirmed", while
  // every other capacity sum counted the people already inside as well, so one
  // guest dropping out could promote a party into a room that had no space.
  const small = await mkEvent({ title: `E2E Tight Room ${stamp}`, date: "2099-04-04", rsvpMode: "hosted", capacity: 4 });
  const singles = [];
  for (const who of ["a", "b", "c", "d"]) {
    const r = await jsonPost("/api/rsvp", { eventId: small.slug, name: `Single ${who}`, email: mail(`single-${who}`), guests: 1 });
    singles.push(r.body.manageToken);
  }
  for (const t of singles.slice(0, 3)) {
    await adminPost("/api/admin/checkin", { code: t.split(".")[0], eventId: small.slug });
  }
  const four = await jsonPost("/api/rsvp", { eventId: small.slug, name: "Party Of Four", email: mail("four"), guests: 4 });
  check("a party of four cannot fit a room of four with three already inside", four.body?.status === "waitlist", JSON.stringify(four.body));
  await jsonPost("/api/rsvp/manage", { t: singles[3], action: "cancel" });
  const tight = await adminGet(`/api/admin/door?eventId=${small.slug}`);
  check(
    "heads holding a seat never exceed the capacity",
    (tight.body?.checkedIn ?? 0) + (tight.body?.confirmed ?? 0) <= 4,
    JSON.stringify(tight.body),
  );

  step("22. one waitlisted guest cannot block everyone behind them");
  // A room of ten, nine seats spoken for by two parties. The blocker asks for
  // five: more than the one seat free, so they queue, but not more than the room
  // holds, so it is a party that could genuinely be seated one day. Then the
  // party of three leaves, freeing four. The blocker still does not fit and must
  // be stepped over rather than allowed to stall the single guest behind them.
  //
  // The sizes matter and are not arbitrary. The room must start FULL, or the
  // guest behind the blocker is simply seated on arrival and the queue is never
  // exercised — which is exactly what a first draft of this case did. And the
  // freed seats have to land between the two waiting parties: three free, four
  // wanted, one wanted.
  const queue = await mkEvent({ title: `E2E Queue ${stamp}`, date: "2099-05-05", rsvpMode: "hosted", capacity: 8 });
  const big = await jsonPost("/api/rsvp", { eventId: queue.slug, name: "Big Party", email: mail("big"), guests: 5 });
  const mid = await jsonPost("/api/rsvp", { eventId: queue.slug, name: "Mid Party", email: mail("mid"), guests: 3 });
  const blocker = await jsonPost("/api/rsvp", { eventId: queue.slug, name: "Blocker", email: mail("blocker"), guests: 4 });
  const behind = await jsonPost("/api/rsvp", { eventId: queue.slug, name: "Behind Them", email: mail("behind"), guests: 1 });
  check(
    "the two seated parties are confirmed",
    big.body?.status === "confirmed" && mid.body?.status === "confirmed",
    JSON.stringify({ big: big.body?.status, mid: mid.body?.status }),
  );
  check(
    "both later guests are waitlisted",
    blocker.body?.status === "waitlist" && behind.body?.status === "waitlist",
    JSON.stringify({ blocker: blocker.body?.status, behind: behind.body?.status }),
  );
  await jsonPost("/api/rsvp/manage", { t: mid.body.manageToken, action: "cancel" });
  const queueRows = await adminGet(`/api/admin/rsvps?eventId=${queue.slug}`);
  const queueList = Array.isArray(queueRows.body)
    ? queueRows.body
    : queueRows.body?.rsvps || queueRows.body?.rows || [];
  const byName = (n) => queueList.find((r) => r.name === n);
  check(
    "the guest behind the blocker is let in",
    byName("Behind Them")?.status === "confirmed",
    JSON.stringify(queueList.map((r) => [r.name, r.status, r.guests])),
  );
  check(
    "the blocker, who still does not fit, stays on the waitlist",
    byName("Blocker")?.status === "waitlist",
    JSON.stringify(queueList.map((r) => [r.name, r.status, r.guests])),
  );

  step("22b. a waitlisted party cannot grow past the room it is waiting for");
  // The queue only works because a waiting party is a size the room could take.
  // A party larger than the venue can never be promoted, so it would sit at the
  // front being skipped forever while the guest believed they were next.
  // Ten, against a room of eight. Asking for more than ten is pointless here:
  // the mutation clamps every party to ten before it tests anything, so a room
  // of ten can never trip this rule and the case has to use a smaller one.
  const overgrow = await jsonPost("/api/rsvp/manage", {
    t: blocker.body.manageToken,
    action: "guests",
    guests: 10,
  });
  check(
    "growing past capacity is refused",
    overgrow.body?.ok === false && overgrow.body?.reason === "full",
    JSON.stringify(overgrow.body),
  );
  const afterGrow = await adminGet(`/api/admin/rsvps?eventId=${queue.slug}`);
  const afterList = Array.isArray(afterGrow.body)
    ? afterGrow.body
    : afterGrow.body?.rsvps || afterGrow.body?.rows || [];
  check(
    "and the party is left at the size it was",
    afterList.find((r) => r.name === "Blocker")?.guests === 4,
    JSON.stringify(afterList.map((r) => [r.name, r.status, r.guests])),
  );
  const shrink = await jsonPost("/api/rsvp/manage", {
    t: blocker.body.manageToken,
    action: "guests",
    guests: 2,
  });
  check(
    "shrinking to something the room could seat still works",
    shrink.body?.ok === true && shrink.body?.guests === 2,
    JSON.stringify(shrink.body),
  );

  step("23. two iPads scanning the same guest at the same instant");
  const twin = await jsonPost("/api/rsvp", { eventId: ev.slug, name: "Twin Scan", email: mail("twin"), guests: 3 });
  const twinId = twin.body.manageToken.split(".")[0];
  const both = await Promise.all([
    adminPost("/api/admin/checkin", { code: twinId, eventId: ev.slug }),
    adminPost("/api/admin/checkin", { code: twinId, eventId: ev.slug }),
  ]);
  const states = both.map((r) => r.body?.state).sort();
  // One check-in and one duplicate, never two of either. Both forms of a
  // check-in count: this room of four is full by now, so a party of three
  // arrives on the waitlist and is admitted as "waitlist_in", which is a
  // check-in with a label on it. Two check-ins would double the head count and
  // two "already"s would mean nobody was ever counted.
  const admitted = states.filter((s) => s === "in" || s === "waitlist_in");
  check(
    "exactly one of the two scans is the check-in",
    admitted.length === 1 && states.filter((s) => s === "already").length === 1,
    JSON.stringify(states),
  );

  step("24. closing RSVPs actually closes them");
  await adminPost("/api/events", { action: "closeRsvps", id: other.id });
  const closed = await jsonPost("/api/rsvp", { eventId: other.slug, name: "Too Late", email: mail("late"), guests: 1 });
  check("a closed event refuses new RSVPs", closed.status === 400 && /closed/i.test(String(closed.body?.error)), JSON.stringify(closed.body));

  step("25. a spreadsheet formula in a guest name cannot execute");
  const nasty = await mkEvent({ title: `E2E CSV ${stamp}`, date: "2099-06-06", rsvpMode: "hosted" });
  await jsonPost("/api/rsvp", { eventId: nasty.slug, name: `=cmd|' /C calc'!A1`, email: mail("csv"), guests: 1, notes: 'has "quotes", commas' });
  const nastyCsv = await (await fetch(`${API}/api/admin/rsvps.csv?eventId=${nasty.slug}`, { headers: { "x-admin-token": TOKEN } })).text();
  check("a formula cell is neutralised", nastyCsv.includes(`"'=cmd`), nastyCsv.split("\r\n")[1]);
  check("an embedded quote is doubled", nastyCsv.includes('""quotes""'), nastyCsv.split("\r\n")[1]);

  step("25b. the RSVP form's own fields survive the round trip");
  // Collected on the invite form, stored, and read back by the back office and
  // the CSV. Asserted end to end rather than at the mutation, because the three
  // places they can be dropped are all in between: the HTTP route that has to
  // forward them, the shaper that has to return them, and the CSV column order.
  const who = await mkEvent({ title: `E2E Fields ${stamp}`, date: "2099-08-08", rsvpMode: "hosted" });
  const person = {
    eventId: who.slug, name: "Dana Field", email: mail("fields"), guests: 1,
    company: "Sony Music", creativeField: "Photographer", invitedBy: "Lawrence Berment",
    phone: "+1 213 555 0134",
  };
  await jsonPost("/api/rsvp", person);
  const back = await adminGet(`/api/admin/rsvps?eventId=${who.slug}`);
  const rows0 = Array.isArray(back.body) ? back.body : back.body?.rsvps || back.body?.rows || [];
  const filled = rows0.find((r) => r.email === person.email);
  check("the back office reads back company, field and invited-by", !!filled &&
    filled.company === person.company &&
    filled.creativeField === person.creativeField &&
    filled.invitedBy === person.invitedBy,
    JSON.stringify(filled));

  const fieldsCsv = await (await fetch(`${API}/api/admin/rsvps.csv?eventId=${who.slug}`, { headers: { "x-admin-token": TOKEN } })).text();
  const [csvHead, csvRow] = fieldsCsv.split("\r\n");
  const cols = csvHead.split(",");
  // Position, not presence: a header that lists a column the row does not fill
  // in the same slot is the failure that silently shifts every later column.
  const at = (name) => (csvRow.split(",")[cols.indexOf(name)] || "").replace(/^"|"$/g, "");
  check("the CSV puts them under their own headers", 
    at("company") === person.company &&
    at("creativeField") === person.creativeField &&
    at("invitedBy") === person.invitedBy,
    csvHead + "\n" + csvRow);

  // Optional means optional: a guest who fills in none of them still gets in.
  const bare = await jsonPost("/api/rsvp", { eventId: who.slug, name: "No Details", email: mail("bare"), guests: 1 });
  check("a guest who leaves them blank is still confirmed",
    bare.body?.ok === true && bare.body?.status === "confirmed",
    JSON.stringify(bare.body));

  step("26. the public routes have a ceiling");
  // Every other case in this file runs with the budgets raised out of the way,
  // because they all share one loopback caller and would otherwise exhaust a
  // production budget partway through. This case puts a real one back — two
  // requests — and drives the real middleware into a real 429. Nothing is
  // stubbed: the same route, the same counter, the same header a browser sees.
  //
  // /api/qr is the route chosen because it is the cheapest to call repeatedly
  // and its failure mode is the most visible: it is the code a guest without an
  // Apple device shows at the door.
  const convexDir = process.env.E2E_CONVEX_DIR;
  if (!convexDir) {
    check("rate limit case ran", false, "E2E_CONVEX_DIR is not set");
  } else {
    const setBudget = (value) =>
      execFileSync("npx", ["convex", "env", "set", "RATE_LIMIT_QR", value], {
        cwd: convexDir,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      });
    const capped = await mkEvent({ title: `E2E Ceiling ${stamp}`, date: "2099-07-07", rsvpMode: "hosted" });
    const rider = await jsonPost("/api/rsvp", { eventId: capped.slug, name: "Rate Rider", email: mail("rate"), guests: 1 });
    const riderToken = rider.body?.manageToken;
    if (!riderToken) {
      check("rate limit case got a token to work with", false, JSON.stringify(rider.body));
    } else {
      setBudget("2,1000000");
      try {
        // Two invented client addresses, because the counter is per caller and
        // the rest of this suite has already spent the loopback caller's budget
        // many times over — reusing it would start this case already refused,
        // which is what the first draft did. Inventing one also lets the case
        // prove the thing that makes a per-caller limit worth having: one
        // caller running out does not touch anybody else.
        const noisy = { "x-forwarded-for": "203.0.113.7" };
        const quiet = { "x-forwarded-for": "203.0.113.9" };
        const getQr = (headers) =>
          req(`/api/qr?t=${encodeURIComponent(riderToken)}`, { headers });

        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await getQr(noisy)).status);
        check(
          "the first requests inside the budget are served",
          codes[0] === 200 && codes[1] === 200,
          JSON.stringify(codes),
        );
        check(
          "the request past the budget is refused with 429",
          codes[2] === 429,
          JSON.stringify(codes),
        );
        check(
          "and it keeps refusing rather than drifting back under the line",
          codes[3] === 429,
          JSON.stringify(codes),
        );
        const over = await getQr(noisy);
        check(
          "the refusal tells the caller how long to wait",
          Number(over.headers.get("retry-after")) > 0,
          `retry-after: ${over.headers.get("retry-after")}`,
        );
        const bystander = await getQr(quiet);
        check(
          "a different caller is untouched by somebody else's ceiling",
          bystander.status === 200,
          `status: ${bystander.status}`,
        );
      } finally {
        // Put the ceiling back up, or every case added after this one inherits
        // a budget of two and fails for a reason that has nothing to do with it.
        setBudget("100000,100000");
      }
    }
  }
}

// The email itself cannot be posted through an HTTP route, so it is rendered
// directly from its own module. Node strips the TypeScript types, so this is
// the real template with the real merge values, not a copy that can drift.
// Without this the whole delivery step is untested: a guest can be perfectly
// checked in by this script and still receive an email with nothing scannable.
function renderEmailChecks(token) {
  const base = process.env.E2E_MODULE_BASE;
  if (!base) {
    check("email render check ran", false, "E2E_MODULE_BASE is not set");
    return;
  }
  const tpl = join(base, "convex", "emails", "rsvpConfirmation.ts");
  const origin = "http://127.0.0.1:8888";
  const script = `
    const t = ${JSON.stringify(token)};
    const links = {
      walletUrl: "${origin}/api/pass?t=" + encodeURIComponent(t),
      manageUrl: "${origin}/rsvp?manage=" + encodeURIComponent(t),
      qrUrl: "${origin}/api/qr?t=" + encodeURIComponent(t),
    };
    const base = {
      name: "Dana Door",
      eventTitle: "E2E Door Night",
      whenLine: "Saturday, January 1, 2099 · 7:00 PM",
      location: "1933 S. Broadway, Suite 1202, Los Angeles, CA 90007",
      guests: 2,
      date: "2099-01-01",
      start: "7:00 PM",
      ...links,
    };
    import(${JSON.stringify(tpl)}).then((m) => {
      const out = {};
      for (const status of ["confirmed", "waitlist"]) {
        const r = m.renderRsvpConfirmation({ ...base, status });
        out[status] = { html: r.html, text: r.text };
      }
      process.stdout.write(JSON.stringify(out));
    }).catch((e) => { process.stderr.write(String(e && e.message || e)); process.exit(3); });
  `;
  let rendered;
  try {
    const raw = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    rendered = JSON.parse(raw);
  } catch (err) {
    check("the confirmation template renders", false, String(err?.stderr || err?.message || err).slice(0, 300));
    return;
  }
  check("the confirmation template renders", !!rendered.confirmed?.html);

  // The QR endpoint specifically, not just "some link". A link to the guest's
  // own page was already in this email before any of this work and it is not
  // sufficient on its own: it only reaches a code if that page happens to be
  // up and rendering one. The PNG endpoint is the route that survives an email
  // client with images off, a page deploy in progress, and a guest with no
  // Apple device, so it has to be in the message itself, in both parts.
  const hasCodeRoute = (s) => /\/api\/qr\?t=/.test(s);
  for (const status of ["confirmed", "waitlist"]) {
    const r = rendered[status];
    check(`${status} email: HTML offers a code without Apple Wallet`, hasCodeRoute(r.html));
    check(`${status} email: plain text offers a code without Apple Wallet`, hasCodeRoute(r.text));
    check(`${status} email: still links the guest's own page`, /\?manage=/.test(r.html));
  }
  check(
    "waitlisted guests are still not told the street address",
    !/1933 S\. Broadway/.test(rendered.waitlist.html) && !/1933 S\. Broadway/.test(rendered.waitlist.text),
  );
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log("failed:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failures.length ? 1 : 0);
  })
  .catch((err) => {
    console.error(`\nfatal: ${err?.stack || err}`);
    console.log(`\n${passed} passed, ${failures.length + 1} failed`);
    process.exit(1);
  });
