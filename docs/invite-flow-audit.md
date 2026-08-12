# Invite flow audit

Door to door: what happens between a guest opening an invite link and a member
of staff scanning them into the room, every step walked against running code
rather than read off the source.

Everything below was produced by running the backend. `scripts/e2e-invite-flow.sh`
brings up a throwaway local Convex deployment, pushes this repo's `convex/` into
it, and drives the real HTTP routes. Nothing is mocked: the QR is decoded from
the actual PNG bytes the endpoint returns, by the same kind of decoder a door
scanner uses, and the payload that comes out of that decode is what gets POSTed
to the check-in route.

    npm run test:e2e

It needs Node 20, 22 or 24 somewhere on the machine (the local backend refuses
to run `"use node"` actions, which is what the Wallet pass and the QR renderer
are, on anything else). It needs no Convex login, no deploy key, and it cannot
reach production: `CONVEX_AGENT_MODE=anonymous` never talks to the cloud.

Baseline on entry to this work: **33 passed, 11 failed**.
After: see the run at the bottom.

---

## The flow, step by step

| # | Step | Verdict | What was wrong |
|---|------|---------|----------------|
| 1 | Invite link `/i/<slug>` resolves | works | nothing |
| 2 | Invite page loads the event | works | nothing |
| 3 | RSVP write | **was broken** | re-RSVP after cancelling left the guest cancelled |
| 4 | Token minting | **was broken** | raw rsvp id leaked when `UNSUB_SECRET` was unset |
| 5 | Confirmation email | **was broken** | Apple Wallet was the only route to a code |
| 6 | QR delivery | **was broken** | `/api/qr` existed and nothing in the product linked to it |
| 7 | Wallet pass | partly Lawrence's | throws a raw 500 with no certificate; now degrades |
| 8 | Scanner UI | **was broken** | picked an event and never sent it; no offline path |
| 9 | Check-in write | **was broken** | any pass opened any door; undo corrupted the list |
| 10 | Duplicate guard | works | nothing |
| 11 | Admin view of attendance | **was broken** | nothing showed who actually came |

---

## 1. Invite link resolves

`convex/events.ts` mints an immutable slug at creation and prints
`https://mixandgreet.com/i/<slug>`. Both hosts in the repo rewrite it:
`vercel.json` has `/i/:key -> /rsvp?event=:key`, and `_redirects` has
`/i/* /rsvp.html?event=:splat 200`. `rsvp.html` also reads the key straight off
`location.pathname` as a fallback, so the link survives a host with no rewrite
at all.

Verdict: works. One stale comment: the long note at the top of `convex/events.ts`
says "nothing in rsvp.html reads the path", which stopped being true when
`keyFromPath()` was added. Left alone, it is a comment, not behaviour.

Still open for Lawrence: two host configs are committed and only one host is
live. Whichever is retired should have its config deleted so the next person
does not edit the dead one.

## 2. Invite page loads the event

`GET /api/events?event=<slug|id>` returns one published event or a 404. An
unknown key does not leak the list. Verdict: works.

## 3. RSVP write

**Was broken.** `rsvps.submit` deduped on `<eventId>:<email>` and patched an
existing row's name, phone, guests and notes but never its status. A guest who
cancelled and then RSVPed again (which the manage page explicitly tells them to
do) got `ok: true`, a signed token and a QR, and was refused at the door.

Fixed in `convex/rsvps.ts`: a cancelled row is reinstated and re-run through the
same capacity test a first-time RSVP gets, so the seat they gave up is not
assumed to still be there. The capacity sum was lifted into one `assignStatus`
helper precisely so the two ways onto the list cannot drift apart. No second
confirmation email is sent: the send ledger dedupes on
`rsvp_confirmation:<rsvpId>` and the row id has not changed, so a resend would be
skipped anyway and would only look like a send that never arrived. The guest is
not stranded, because `/api/rsvp` hands the signed token straight back to the
page they are standing on.

## 4. Token minting and verification

`convex/lib/rsvpToken.ts` is an HMAC-SHA256 over `rsvp-manage-v1:<rsvpId>`,
truncated to 128 bits, compared in constant time, with a separate purpose string
from the unsubscribe token so one can never be replayed as the other. It is
stateless, so there is no expiry: a token is valid until the RSVP is deleted.

Verified: a tampered token gets no QR, no pass and no manage page, and returns
the same 404 as a token for a row that does not exist, so a valid-looking token
is not distinguishable from an invalid one.

**Was broken:** `/api/rsvp` only stripped the raw `rsvpId` from its response on
the branch that minted a token. With `UNSUB_SECRET` unset it fell through and
returned the mutation result verbatim, raw id included. That id is exactly what
the door QR encodes, so a misconfigured deployment handed every visitor a working
door code and, at the same time, gave every guest a page with no code on it.
Fixed: the id is stripped on every path, and a missing secret is now a logged
500 that says the guest is on the list but has no pass link, rather than a silent
success.

## 5. The confirmation email

**Was broken.** The only scannable thing in the message was an ADD TO APPLE
WALLET button. An Android guest, a guest whose Wallet declined the pass, and a
guest whose pass certificate had expired server side all arrived at the door
holding an email with nothing in it to scan.

Fixed in `convex/emails/rsvpConfirmation.ts` and `convex/email.ts`: a door code
block under the ticket, carrying three routes to the same code so no single
failure strands anyone. An inline QR image (a bonus only, because Gmail proxies
remote images and Apple Mail and Outlook usually ask first), a primary button to
the guest's own page which draws the code full size, and a quiet secondary link
to the bare PNG. The plain-text part carries the same URLs, because that is what
a screen reader and a stripped-down client read. The Wallet button stays and is
now labelled as the iPhone route rather than presented as the only one.

The waitlist redaction was checked, not assumed: a waitlisted guest still gets a
code, and the new block prints no location at all, so the street address stays
redacted for them. The end-to-end test asserts this on every run.

## 6. QR delivery

`GET /api/qr?t=<token>` renders the bare rsvp id at error-correction level H,
scale 10, margin 2. The end-to-end test decodes the real PNG with jsQR and, when
`zbarimg` is installed, cross-checks with a second decoder, and asserts the image
is at least 300px wide, because a code that is technically decodable at 90px is
one a scanner fails on across a dark room.

Note on the payload: both the QR and the Wallet pass encode the bare rsvp id
rather than the signed token, deliberately, because 32 plain alphanumerics is a
far coarser code to scan than 65 with a dot in it. That is safe here only because
`/api/admin/checkin` is gated by the staff admin token, so holding an id grants
nothing. The check-in route accepts both forms and the test proves they land on
the same row, so one guest cannot be counted twice.

## 7. The Wallet pass

`convex/wallet/*` is owned by another agent and was not touched here. One thing
was fixed at the call site in `convex/http.ts`: `buildPkpass` throws when the
Apple certificate env vars are unset or expired, and that reached the guest as an
unstyled Convex 500 with no way forward. It is now caught, logged, and answered
with the branded "Pass unavailable" page at 503 carrying a button to the guest's
own QR, which works on any phone. The test asserts `/api/pass` never answers 500.

**Needs Lawrence:** on the local test deployment the pass genuinely cannot build,
because the certificate env vars are not set there. Whether production can build
one is not something this work can prove. Load `/api/pass?t=<a real token>` on
the production deployment and confirm you get a `.pkpass` and not the 503
fallback page. If you get the fallback, the certificate is the problem and the
QR is carrying the whole door until it is fixed.

## 8. The scanner UI

See `checkin.html`.

## 9. Check-in write

**Was broken, three ways.**

*Any pass opened any door.* The scanner made staff pick tonight's event and then
never sent it, and `/api/admin/checkin` had no concept of an event. A guest
holding a pass from a previous night was checked in against tonight, and the
verdict screen even said "That code is not a pass for this event", which was a
lie because nothing had checked. Fixed: the route takes an optional `eventId`
(slug or id, resolved the same way every other admin route resolves one) and a
scan that belongs to a different event changes nothing and reports
`state: "wrong_event"` naming the event the pass is really for, so staff can say
it out loud. It fails closed: an event key that resolves to nothing is treated as
a mismatch rather than silently becoming an unscoped door. Undo is scoped too.
The unscoped path is deliberately still permitted for manual entry.

*Undo corrupted the list.* Checking in overwrote `status`, losing whether the
guest was confirmed or waitlisted, and undo always wrote back "confirmed". A
mis-scanned waitlist guest was silently promoted onto the confirmed list and
every later capacity sum counted a seat that had never been given. Fixed with an
additive optional `statusBeforeCheckIn` on the rsvps table; undo restores it and
clears the arrival stamp.

*A guest inside the room could delete their own attendance.* Cancelling patched
`status: "cancelled"` on any row, including one already checked in. See the test
step "a guest who is already inside cannot delete their own attendance".

## 10. Duplicate guard

A second scan reports `state: "already"` with the time of the first, rather than
double counting. Verified for the bare id and for the full signed token, and the
door screen shows it as a distinct amber verdict rather than a green one.

## 11. Admin view of attendance

See `admin.html`.

---

## Still open, and why

Listed so nobody thinks these were missed.

- **`updateByGuest` promotes exactly one waitlisted guest** when a cancellation
  frees capacity, even when the freed seats could take several parties. Out of
  scope: it is a behaviour change, not a defect in the door flow.
- **No rate limit on `/api/rsvp`, `/api/qr` or `/api/pass`.** The tokens are
  128-bit HMACs so brute force is not the risk; volume is. Not touched.
- **The door has no way to look a guest up by name** when a phone is dead and the
  guest has no code at all. That is a real door scenario and the current answer
  is "use the back office on another device".

## Needs Lawrence's hands

1. **Convex env vars on production.** `UNSUB_SECRET` must be set or every RSVP
   now answers 500 (previously it silently leaked the raw rsvp id instead, which
   was worse). Confirm with `npx convex env list` against production.
2. **The Apple Wallet certificate.** See step 7. If `/api/pass` returns the 503
   fallback page in production, no guest is getting a pass and the QR is carrying
   the entire door.
3. **`RESEND_API_KEY` and `EMAIL_FROM`.** Without both, `recordAndEnqueue` writes
   a `failed` row saying "email not configured" and no confirmation is sent at
   all, which means no guest gets a code. The back office shows this per guest as
   the invite status, so check it there after the next real RSVP.
4. **Deploy.** Nothing here has been deployed. `scripts/deploy.sh` against
   production is Lawrence's call.
