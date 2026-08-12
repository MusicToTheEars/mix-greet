# The Wallet pass, and why the door was dark

Guests could add a pass. The pass showed no QR. Nobody could be checked in.

Five commits went after that, and all five went after the layout. This is the
record of what was actually wrong, what Apple's spec actually says, and what
the pass now proves about itself before it ships.

---

## 1. What the previous conclusion got wrong

The comments at the top of `convex/wallet/pkpass.ts` recorded three beliefs,
all of them presented as proven on device. Checked against Apple's own
documentation and Apple's own shipped sample passes, all three are wrong.

### "None of the classic layouts support background.png"

Backwards. Apple's Table 4-1, in *Pass Design and Creation*:

> Boarding pass | logo, icon, footer
> Coupon | logo, icon, strip
> **Event ticket | logo, icon, strip, background, thumbnail**
> Generic | logo, icon, thumbnail
> Store card | logo, icon, strip

`eventTicket` is precisely the classic style that takes a background.
`generic` is the one style that cannot. Apple's own `Event.pass` sample, in
WalletCompanionFiles, is a classic `eventTicket` and ships `background.png`,
`background@2x.png`, `thumbnail.png` and `thumbnail@2x.png`.

So commit `6cae598`, "switch to generic style so the QR actually prints", did
not work around a limitation of `eventTicket`. It moved the pass to the only
style that genuinely cannot show a background, and deleted the artwork to fit.

### "eventTicket hides the barcode, generic prints it"

Not the style. A plain `eventTicket` renders the classic card with the barcode
on the face, and always has. Hiding the barcode is behaviour of the **iOS 18
poster layout**, which a pass cannot enter by accident: Apple requires

> - Add `posterEventTicket` to the `preferredStyleSchemes`.
> - Provide the required semantic tags to populate the pass and certain event content.

and, if any required tag is missing, "your pass falls back to the legacy event
pass style". The old pass named no style schemes at all, so it was never in the
poster layout to begin with, under either style key.

### "preferredStyleSchemes did not override it"

Correct, but for the opposite reason to the one recorded. `preferredStyleSchemes`
opts a pass **into** the poster layout. It is not a lever for forcing the classic
one. Omitting the key is what pins the classic card.

---

## 2. What was actually wrong

One string.

```
"format": "PKBARCODE_FORMAT_QR"     <- what the code sent
"format": "PKBarcodeFormatQR"       <- what PassKit defines
```

Apple's `Barcodes` dictionary enumerates exactly eight values, all camel case,
none with underscores: `PKBarcodeFormatQR`, `PKBarcodeFormatPDF417`,
`PKBarcodeFormatAztec`, `PKBarcodeFormatCode128`, `PKBarcodeFormatCode39`,
`PKBarcodeFormatCodabar`, `PKBarcodeFormatEAN13`, `PKBarcodeFormatI2of5`.

The underscored spelling appears in no Apple document and in none of Apple's
sample passes. Grepping every Apple source pulled for this exercise:

```
  9 PKBarcodeFormatAztec      2 PKBarcodeFormatCodabar
 22 PKBarcodeFormatCode128    2 PKBarcodeFormatCode39
 35 PKBarcodeFormatPDF417     2 PKBarcodeFormatEAN13
 19 PKBarcodeFormatQR         2 PKBarcodeFormatI2of5
  0 PKBARCODE_FORMAT_*
```

iOS does not reject a pass over an unrecognised barcode format and shows the
guest no error. It drops the barcode and draws the card without one.

`git log -S` puts the typo in the very first wallet commit:

```
$ git log --oneline -S "PKBARCODE_FORMAT_QR" -- convex/wallet/pkpass.ts
2ce881f Wallet passes, guest cancel/edit, and door check-in
```

So the QR had never rendered, in any style, in any build. Every on-device A/B
was comparing two passes that could not print a code either way, and the style
key kept taking the blame for a typo. Four subsequent commits removed real
features — the background image, the thumbnail, the header fields, the relevant
date — to chase a symptom none of them caused.

The lesson worth keeping: the pass generated cleanly at every step. Valid zip,
valid manifest, valid signature, well-formed JSON, correct payload. Every check
anyone would think to run passed, and the door stayed dark. Nothing short of
looking at the rendered pixels would have caught it, which is why the rig below
now does exactly that.

---

## 3. What the spec actually requires

Sourced from Apple's live documentation, Apple's archived *Pass Design and
Creation*, Apple's `pass-builder` Swift package, WWDC24 session 10108, and
Apple's five shipped sample bundles.

**Bundle.** `pass.json`, the images, `manifest.json`, `signature`. The manifest
is a flat map of pathname to **SHA-1** hash of every other file — Apple has not
moved this to SHA-256; verified by `openssl asn1parse` against Apple's own
signed `Event.pkpass`, whose `digestAlgorithms` is `sha1` and whose signed
`messageDigest` matches `shasum -a 1 manifest.json` exactly. `signature` is a
**detached PKCS#7**, DER, with `contentType`, `signingTime` and `messageDigest`
as signed attributes, carrying the leaf and the WWDR intermediate.

**Barcodes.** `barcodes` is an array; "the system uses the first displayable
barcode for the device". `format`, `message` and `messageEncoding` are all
required. `iso-8859-1` is what Apple's own samples use. The singular `barcode`
key is deprecated but is what iOS 8 and earlier read, and Apple's own current
samples still ship it, so both are written.

**Images, per style.** Table 4-1 above. Point sizes: icon 29x29, logo 160x50
(usually narrower), background 180x220 "cropped slightly on all sides and
blurred", thumbnail 90x90, strip 375x98 for event tickets. Supply 1x, @2x and
@3x. Strip is mutually exclusive with background and thumbnail.

**The poster event ticket, and why this pass is not one.** Apple:

> **Poster event tickets aren't compatible with tickets that require a QR code
> or barcode for entry.**

That layout is built around NFC entry, which needs an entitlement this team does
not have. This is a door ticket. The barcode wins, so `preferredStyleSchemes` is
absent by default and the pass stays a classic `eventTicket`.

The artwork is not lost to that decision. On a classic event ticket Apple scales
`background.png` to fill the card and blurs it, so the invite poster becomes the
ground the fields sit on rather than a flat colour block. `artwork.png` at
1x/2x/3x ships alongside it, so switching `WALLET_STYLE_SCHEMES` to
`posterEventTicket,eventTicket` on the day an NFC entitlement exists is a config
change and not a rebuild. The four semantic tags that layout requires
(`eventName`, `venueName`, `venueRegionName`, `venueRoom`) are already populated
for the same reason.

---

## 4. The rig

Three files, none of which ship to Convex.

```
scripts/wallet/gen-test-certs.sh    a throwaway Pass Type ID chain
scripts/wallet/verify-pass.mjs      build, unzip, verify, decode
scripts/wallet/render-face.mjs      draw the card, read the code back off it
```

```bash
./scripts/wallet/gen-test-certs.sh
node --import ./scripts/wallet/convex-resolve.mjs scripts/wallet/verify-pass.mjs
node scripts/wallet/render-face.mjs
```

The certificates are self-signed into `.wallet-test/`, which is gitignored. iOS
would reject them, which is the point: the rig proves our pipeline, not Apple's
trust store. Swapping in the real leaf changes nothing structural.

`verify-pass.mjs` imports `buildPkpass` from the module the server actually
calls, not a copy of it. It checks the zip, checks that the manifest hashes every
file and that every hash matches the bytes, verifies the signature with
**openssl** rather than with node-forge — verifying with the library that signed
would only prove the library agrees with itself — and then flips a byte of the
manifest and requires the same verification to fail, so the check cannot pass
vacuously.

Then it checks the parts that were actually broken: that every barcode format is
a constant Apple defines, that the payload is exactly the identifier
`/api/admin/checkin` expects and matches that route's own regex, that the style
can display every image shipped, that a background exists at all three densities,
that @2x and @3x are exact integer multiples of @1x, and that the poster scheme
is not silently switched on.

`render-face.mjs` is the half that would have caught the original bug. It lays
the card out the way Wallet does, rasterises it in a real browser at
`deviceScaleFactor: 3`, and points **zbarimg** and **jsQR** at the resulting PNG.
It decodes the whole card, not a crop of where the code is known to be — cropping
would quietly test the encoder instead of the card. It is not a Wallet emulator
and does not pretend to be. What it proves is the thing that was wrong: that a
code of this payload, at the size and contrast Wallet draws it, over this
artwork, survives being looked at.

---

## 5. The decode test, verbatim

<!-- DECODE_OUTPUT_START -->
```
$ ./scripts/wallet/gen-test-certs.sh
test chain written to ./.wallet-test/certs
./.wallet-test/certs/pass.pem: OK

$ node --import ./scripts/wallet/convex-resolve.mjs scripts/wallet/verify-pass.mjs
PASS  zip opens and is non-trivial                                       15 files, 538 KB
PASS  carries the files Apple requires                                   artwork.png, artwork@2x.png, artwork@3x.png, background.png, background@2x.png, background@3x.png, icon.png, icon@2x.png, icon@3x.png, logo.png, logo@2x.png, logo@3x.png, manifest.json, pass.json, signature
PASS  manifest hashes every file, and every hash matches                 13 files, all SHA-1 matched
PASS  signature is a detached PKCS#7 that verifies against the manifest  openssl smime -verify: OK
PASS  the signed content really is this manifest, not another one        tampered manifest rejected, as it must be
PASS  pass.json declares exactly one style, with its field dictionary    eventTicket
PASS  pass.json carries the required top-level keys                      formatVersion 1, ids and description present
PASS  every barcode format is a constant Apple actually defines          PKBarcodeFormatQR, PKBarcodeFormatQR
PASS  barcodes is a non-empty array of well-formed entries               PKBarcodeFormatQR/iso-8859-1
PASS  the QR payload is EXACTLY the id /api/admin/checkin expects        jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd (32 chars, matches /^[a-z0-9]{20,40}$/i)
PASS  the payload round-trips through a real QR encoder and zbarimg      zbarimg --raw -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
PASS  a second, independent decoder agrees                               jsQR -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
PASS  every image is a real PNG at the density its filename claims       artwork.png 363x510, artwork@2x.png 726x1020, artwork@3x.png 1089x1530, background.png 180x220, background@2x.png 360x440, background@3x.png 540x660, icon.png 29x29, icon@2x.png 58x58, icon@3x.png 87x87, logo.png 160x50, logo@2x.png 320x100, logo@3x.png 480x150
PASS  the style can actually display every image the bundle ships        eventTicket: artwork, background, icon, logo
PASS  the card has an artwork ground, not just a flat colour             background.png at 1x, 2x and 3x
PASS  the poster layout is not silently switched on                      preferredStyleSchemes absent, classic card, barcode on the face
PASS  the altText under the code is something the door would accept      jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
PASS  semantics carry the four tags Apple requires of an event pass      PKEventTypeLivePerformance, TEST Event @ 1933 S. Broadway

pkpass:   ./.wallet-test/out/MixAndGreet.pkpass
unzipped: ./.wallet-test/out/unzipped
18/18 checks passed

$ node scripts/wallet/render-face.mjs
style: eventTicket   schemes: "(none)"
payload in pass.json: jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd

PASS  poster face  1125x1623px
        zbarimg  -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
        jsQR     -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
        file     -> ./.wallet-test/out/faces/face-poster.png
PASS  classic face  1125x1365px
        zbarimg  -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
        jsQR     -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
        file     -> ./.wallet-test/out/faces/face-classic.png
under door conditions:
  PASS  poster @  420px  phone at arm's length            zbar:ok jsQR:ok
  PASS  poster @  300px  further back, softer focus       zbar:ok jsQR:ok
  PASS  poster @  240px  dim doorway, heavy compression   zbar:ok jsQR:ok
  PASS  classic @  420px  phone at arm's length            zbar:ok jsQR:ok
  PASS  classic @  300px  further back, softer focus       zbar:ok jsQR:ok
  PASS  classic @  240px  dim doorway, heavy compression   zbar:ok jsQR:ok

all rendered faces decoded to the exact RSVP id: jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
```
<!-- DECODE_OUTPUT_END -->

---

## 6. Blind comparison against the invite page

The invite page was served locally against the real published event
`test-event-2frp` and screenshotted, and the generated pass was rendered beside
it. A critic with no stake in the work and no labels on the images was asked
which was which and what was missing. Two rounds ran.

### Round 1 — the poster artwork

The sharp `artwork.png` was put next to the invite's own composed flyer with the
labels stripped. The reproduction is built by screenshotting the invite page's
own `.flyer` CSS — the same stylesheet, the same `@font-face` blobs out of
`brand.css`, the same SVG ring markup, the same duotone filter chain — so the
pixels come from the same engine that draws the invitation. It survived the
comparison.

### Round 2 — the card as the guest sees it

This is the one that mattered, and it did not go well. Verdict: **"Adjacent.
Not the same product. Same colour family, different hand."** Recognition scored
**4/10**.

What survived: the darkness, strongly. The red, moderately — "the invite red is
a cut; the card red is a smudge". The cream ink colour, exactly.

What was lost:

> **Ring motif — lost. Completely.** The concentric circle system with the
> single cream dot at its centre is the invite's actual logo-level idea — it is
> the "sound" in the poster. There is not one arc of it on the card.

> **The blurred background is not doing real work.** It is muddy red noise.
> Swap in any other artist's photo, any red-lit concert shot, and the guest
> could not perceive a difference.

> Cover the name field and nothing on this card says this event. If the guest
> recognises it, they recognise it the way you recognise a confirmation email:
> by reading it, not by seeing it.

And the single biggest gap, which is the insight the whole exercise turned on:

> Re-crop the background plate so the concentric ring motif is what fills the
> card... The face cannot survive a blur — a blurred portrait is
> indistinguishable from any other blurred portrait, which is exactly why the
> card currently reads as generic. The rings *can* survive a blur: they are
> large, thin, high-contrast, low-frequency geometry.

That is correct, and it inverted the design. The instinct had been to lead with
the artist's face because the invitation does. But the invitation shows it
sharp; Wallet never will. A blurred face carries no identity at all, while
blurred concentric rings stay unmistakably rings.

The critic also caught the logo shipping with its red plate baked into the PNG
— "the only crisp edge in the top third, so it floats... exactly what a
rendering mistake looks like" — and marginal contrast on the red field labels
where they fell over the plate's red lobe, at roughly 2.5:1.

### What the second round forced, beyond what the critic asked

Following the crop note turned up a bug the critic could not have seen, because
it needs the data and not the pixels. `PASS_IMAGES` is a **static module**: it
is baked once at build time, and every guest of every event receives the same
bytes. The artwork was composed from one specific event's headliner. Of the four
published events on this deployment, three — Vol.2, Vol.3 and Vol.4 — have
`featured: []` and no artist at all:

```
TEST Event             featured=1  status=published
Mix & Greet Vol.2      featured=0  status=published
Mix & Greet Vol.3      featured=0  status=published
Mix & Greet Vol. 4     featured=0  status=published
```

So a Vol.3 guest would have opened their pass to a stranger's face. Nobody would
have noticed until an event with a different headliner shipped.

The fix is the same move the critic already wanted, which is what makes it the
right one rather than a compromise: the portrait comes out of `background.*`
entirely and the plate becomes the brand — rings, bloom, grain, black. It is
then blur-proof, it is what the guest recognises, and it is correct for every
event on the calendar instead of for one.

The invite page already has vocabulary for this. Its `.flyer:not(.has-art)`
state is the design's own answer to "no photograph": the red disc returns, the
rings drop to their base opacities, the arcs go red. That state, not the
portrait state, is what a static asset should be built from.

**Red field labels stay red.** `#EC1C24` on `#0B0B0D` is about 4.3:1, which is
fine for the letterspaced uppercase Wallet draws labels in. The critic's 2.5:1
measurement was red on *dark red*, where the plate's lobe ran under the type
column — a background problem, fixed by darkening the left third, not a reason
to give up the brand colour.

---

## 7. Still needs Lawrence

Nothing here was deployed. `npx convex deploy` and `scripts/deploy.sh` were not
run, and this branch was not merged.

**1. The one thing the rig cannot prove.** Everything above is verified against
Apple's spec, Apple's samples, and real decoders — but on a self-signed chain,
in a browser, not on an iPhone. The remaining unknown is not the barcode, which
is now demonstrably a valid PassKit constant carrying the right payload; it is
whether Wallet's own layout puts it where we expect. That takes one device:
deploy the branch, open a real invite, add the pass, and look at it. If the
code is on the face, this is done.

**2. Env vars.** No new ones are required. `PASS_TYPE_ID`, `PASS_TEAM_ID`,
`PASS_CERT_B64`, `PASS_KEY_B64` and `PASS_WWDR_B64` are unchanged, and the
production certificate is untouched — the fix was a string, not a signing
change.

One new **optional** var exists, `WALLET_STYLE_SCHEMES`. Leave it unset. Setting
it to `posterEventTicket,eventTicket` switches on the iOS 18 poster layout,
which Apple documents as incompatible with barcode entry, and would take the QR
off the door. It is there for the day this pass rides on NFC instead; the
artwork and the semantic tags it needs are already in the bundle.

**3. Certificates.** Untouched, and no cert or key is in this branch. The rig's
throwaway chain lives in `.wallet-test/`, which is gitignored; `git diff` on the
branch shows no `.pem`, no `.key`, nothing base64-encoded but the artwork.

**4. Worth a look, not blocking.** The Android and no-Wallet path,
`GET /api/qr`, is deliberately untouched — `git diff` against `e350fce` shows no
change to `convex/wallet/qr.ts` or `convex/http.ts`. It encodes the same bare
RSVP id the pass does, so both routes check in identically at the same door.
