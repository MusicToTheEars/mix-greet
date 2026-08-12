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
After the work, with harder assertions added on top: **59 passed, 0 failed**.

The eleven original failures were, in the order they would have cost a real
night: a pass from any event opened any door; no guest without an Apple device
ever received a scannable code; a guest who cancelled and RSVPed again was told
they were on the list and then refused at the door; an undo after a mis-scan
promoted a waitlisted guest onto the confirmed list; the guest list and the CSV
could not say who actually came; the door's "expected" number shrank every time
somebody arrived; a missing Wallet certificate reached the guest as an unstyled
500; and the raw rsvp id, which is exactly what the door QR encodes, was
returned to the browser whenever `UNSUB_SECRET` was unset.

Three more were found by raising the bar after those were fixed: a guest already
inside the room could erase their own attendance from the link in their
confirmation email; a confirmed party could grow past the room's capacity from a
phone; and a cancelled RSVP could still be resized.

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
| 12 | The guest's own page | **was broken** | never showed the code; said untrue things |

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

`checkin.html`. **Was broken in five ways**, all of them things a stranger
running the door would have hit within the first hour.

*The event picker was decorative.* Staff chose tonight's event and the page
never sent it. It is sent on every call now, including the undo, and every scan
held in the offline queue carries the event it was taken for, so a replay hours
later is still scoped to the right night. `wrong_event` renders as a red
full-screen refusal naming the event the pass is really for, so the person on
the door can say it out loud.

*No signal meant the door stopped.* The venue is a basement suite. A failed
scan now goes into a `localStorage` queue, the guest is told they are in, and
the queue replays on the `online` event and when the network returns. A
persistent count shows how many scans are still unsynced. The copy is honest
about what an offline scan cannot know: it does not print a name that was never
fetched, and a queued scan the server later refuses comes back as its own
"Let in offline" verdict for review rather than being silently swallowed.

*The session died mid-queue.* The admin token lived in `sessionStorage`, so a
closed tab meant hunting for the door password with people waiting, and any 401
called `location.reload()`, which threw away the queue and the camera. The
token now lives where a reopened tab finds it, and an expired session asks for
the password in place.

*Backgrounding froze the scanner.* The wake lock was requested once and never
reacquired, which is not how the API works: it is released on visibility change
and must be re-requested. Fixed, and returning to the foreground restarts
scanning rather than leaving a frozen video element.

*`BarcodeDetector` does not exist on iOS Safari or Firefox*, which is every
iPhone and iPad. Those browsers used to get one line of grey text over a camera
that could never detect anything. There is now a real path for them.

Every branch the API can answer with produces a full-screen verdict, including
an explicit "Unclear" for a shape the page does not recognise, so nobody is ever
left looking at a blank screen wondering whether to admit someone.

## 8b. How the three static pages were verified

Stated plainly because it is a real limit on this audit. The backend is proved
by `npm run test:e2e`, which drives the actual routes. `checkin.html`,
`rsvp.html` and `admin.html` are static pages with no build step, and they were
verified three ways: their extracted scripts parse (`node --check`), their calls
were checked against the live routes' real responses, and the contracts were
read line by line (every scan sends `eventId`; every queued scan stores its own
`eventId`; the QR is rendered in all four guest states; the back office reads
`expected` with a fallback and `checkedInAt` per row).

They were NOT clicked through in a live browser as part of this work. Before the
next event, somebody should open `checkin.html` on the actual door iPad, scan one
real pass, put the iPad in aeroplane mode, scan a second, and watch the queue
drain when signal returns. That is fifteen minutes and it is the last thing
standing between this and "a stranger could run the door".

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

`admin.html`. **Was broken:** guests were being scanned in and nothing in the
back office showed it. The host could see who was invited and not who came,
which is the one number that decides how big the next room needs to be.

The guest list now shows arrival per row off the `checkedInAt` stamp, and a
live door band shows heads through against heads still expected. It reads
`expected` from `/api/admin/door` with a local fallback, and deliberately does
NOT label the old `confirmed` field as "expected": that field counts only rows
still sitting in status `confirmed`, so it drops by a party every time somebody
is scanned, and a host reading it would watch their event appear to drain away
over the evening it is filling up. The CSV carries the arrival column too.

## 12. The guest's own page

`rsvp.html`. **Was broken:** the guest never saw their code anywhere on the
site, and the page could tell them something untrue.

The QR now renders in all four states a guest can reach it from: after a
confirmed submission, after a waitlisted one, on the manage page, and on the
"you already RSVPed on this device" return path. The image has a visible
fallback with a retry rather than a broken-image icon, and one line under it
asks the guest to screenshot it before they travel, which is the whole of the
offline story on the guest side and is deliberately not a service worker.

The page also handles the refusals the backend now returns (HTTP 409 with a
`reason` of `checked_in`, `cancelled` or `full`) by printing the server's own
sentence rather than a generic "that did not go through", and it stops offering
the cancel button at all once it knows the guest is already checked in.

The manage page's old error copy said the link had "expired or was mistyped".
These tokens are stateless HMACs with no timestamp in them, so they do not
expire; that sentence was never true. It says something true now.

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
  is "use the back office on another device". It is the largest remaining hole
  in the door experience and it is a deliberate omission, not an oversight: the
  scanner is built around "nothing on screen but the camera" and a search field
  is a different product decision for Lawrence to make.
- **A waitlisted guest can still set their party to 10.** They hold no seats, and
  the promotion path re-tests the room before they ever do, so it harms nobody
  today. It would matter if promotion ever became automatic.
- **The three static pages have not been clicked through in a live browser.**
  See section 8b. This is the one verification gap in the work.

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
