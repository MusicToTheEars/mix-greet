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

PassKit's `Barcodes` dictionary defines exactly four values, all camel case,
none with underscores: `PKBarcodeFormatQR`, `PKBarcodeFormatPDF417`,
`PKBarcodeFormatAztec` and `PKBarcodeFormatCode128`. That is the entire list.
It is an easy list to pad, because Code 39, Codabar, EAN-13 and Interleaved 2
of 5 do all have Apple constants — but those are AVFoundation and Vision
metadata object types, the names for barcodes a camera *reads*. They are not
formats a pass may ask Wallet to *draw*, and putting one in a pass gets the same
silence as a typo. The rig holds the same four in `BARCODE_FORMATS` in
`scripts/wallet/verify-pass.mjs`, and every build is checked against them.

The underscored spelling appears in no Apple document and in none of Apple's
sample passes. That was established by grepping the Apple documentation, sample
bundles and Swift sources fetched while this was being worked out. Those files
are not in this repo, so take it as a report of what was found at the time
rather than something to re-run here — what is reproducible is the check, which
rejects any format outside the four.

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
moved this to SHA-256. That was verified against *Apple's* sample: `openssl
asn1parse` on Apple's own signed `Event.pkpass` reports `digestAlgorithms` of
`sha1`, and its signed `messageDigest` matches `shasum -a 1 manifest.json`
exactly. Our bundle follows Apple on the manifest — `pkpass.ts` hashes each file
with `forge.md.sha1` — but not on the signature: our `addSigner` passes
`digestAlgorithm: forge.pki.oids.sha256`, and `openssl asn1parse` on our own
`signature` shows `sha256` and `sha256WithRSAEncryption`. So the two halves use
different digests, deliberately: **SHA-1 for the manifest hashes, SHA-256 for
the signature**. Apple's requirement is on the manifest, and iOS does not object
to a stronger digest over it. `signature` itself is a **detached PKCS#7**, DER,
with `contentType`, `signingTime` and `messageDigest` as signed attributes,
carrying the leaf and the WWDR intermediate — that shape is the same in both.

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
ground the fields sit on rather than a flat colour block. `artwork.png` is a
different image for a different layout, and it does **not** ship: §6 explains why
it was taken out, and `PASS_IMAGES` in `convex/wallet/images.ts` now holds nine
entries, `background`, `icon` and `logo` at 1x/2x/3x, and nothing else. So the
day an NFC entitlement exists, switching `WALLET_STYLE_SCHEMES` to
`posterEventTicket,eventTicket` is a rebuild rather than a config change:
`make-images.mjs --with-artwork` has to run first, or the poster layout gets a
ground it cannot find. The four semantic tags that layout requires (`eventName`,
`venueName`, `venueRegionName`, `venueRoom`) *are* already populated, so that
half of the switch costs nothing.

---

## 4. The rig

Five files, none of which ship to Convex.

```
scripts/wallet/gen-test-certs.sh    a throwaway Pass Type ID chain
scripts/wallet/make-images.mjs      draws every image the pass ships
scripts/wallet/convex-resolve.mjs   lets plain node import the Convex modules
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

`make-images.mjs` is the largest of the five and the least like a test. It is
the generator: it screenshots the invite page's own `.flyer` stack — the same
`brand.css`, the same fonts, the same SVG rings — at Apple's frame sizes, and
base64s the result into `convex/wallet/images.ts`, so every pixel the pass ships
comes from the stylesheet that draws the invitation rather than from a
hand-exported copy of it. `--with-artwork` adds the poster layout's `artwork.*`
back to that set; without the flag it writes the nine images §3 describes, which
is what ships.

`convex-resolve.mjs` is a resolver hook and nothing else. Convex bundles with
esbuild, so its source imports `./images` without an extension and Node's ESM
resolver will not take it. The hook puts the extension back at resolve time,
which is what lets the rig import the shipped modules unchanged rather than
editing the server code to suit the test.

`verify-pass.mjs` imports `buildPkpass` from the module the server actually
calls, not a copy of it. It checks the zip, checks that the manifest hashes every
file and that every hash matches the bytes, and verifies the signature with
**openssl** rather than with node-forge — verifying with the library that signed
would only prove the library agrees with itself.

Two of its checks carry a **negative control**: a deliberately broken input the
same check has to reject before its green line means anything. The signature
check flips a byte of the manifest and requires the verification to fail. The
identity check, described next, rebuilds the pass with the wrong identifiers and
requires itself to fail. The rest of the checks have no such control; they are
assertions about the bundle, and they are only as good as the assertion.

The identity check is there because verifying the signature says nothing about
*whose* pass it is. `passTypeIdentifier` and `teamIdentifier` come out of
`PASS_TYPE_ID` and `PASS_TEAM_ID`, while the signature comes out of
`PASS_CERT_B64`, and nothing in the build ties those three env vars to each
other. Point the identifiers at a pass type the certificate was never issued for
and the bundle is still internally consistent, still verifies, and is still
refused by iOS the instant a guest taps Add — with no error the guest can see.
That is the same silent failure this whole branch exists to atone for, and it is
one certificate rotation away. Apple puts the pass type identifier in the leaf's
subject `UID` and the team identifier in its `OU`, so the rig pulls the leaf out
of the PKCS#7 and requires both to match `pass.json`.

Then it checks the parts that were actually broken: that every barcode format is
a constant Apple defines, that the payload is exactly the identifier
`/api/admin/checkin` expects and matches that route's own regex, that the style
can display every image shipped, that a background exists at all three densities,
and that the poster scheme is not silently switched on.

The image check asserts sizes, not shapes. Ratios are not enough: a set of
3x3, 6x6 and 9x9 icons is perfectly self-consistent and draws a smear where the
icon goes, because Wallet lays the card out at the point sizes §3 recites and
does not scale an image up to fill the box it was given. So `icon.png` must be
29x29, `logo.png` 160x50 and `background.png` 180x220, with @2x and @3x exact
integer multiples of those — and a family shipping an @2x with no @1x is a
failure rather than a family to skip, since @1x is what a non-retina render
falls back to and what everything else is measured against.

`render-face.mjs` is the half that would have caught the original bug. It lays
the card out the way Wallet does, rasterises it in a real browser at
`deviceScaleFactor: 3`, and points **zbarimg** and **jsQR** at the resulting PNG.
It decodes the whole card, not a crop of where the code is known to be — cropping
would quietly test the encoder instead of the card. It is not a Wallet emulator
and does not pretend to be. What it proves is the thing that was wrong: that a
code of this payload, at the size and contrast Wallet draws it, over this
artwork, survives being looked at.

### What the rig still cannot catch

Recorded plainly, because a green run is only worth what it actually covers, and
the bug this branch exists to atone for was one nobody had thought to check.

**An expired certificate.** The signature is verified with `-purpose any` against
the throwaway chain, so nothing reads the leaf's validity window. An Apple Pass
Type ID certificate lasts a year. The day the production one lapses this rig
still scores 20/20 while iOS refuses every pass — the same silent shape as the
identity mismatch the rig now does catch. That one is a calendar reminder more
than a check, since the rig signs with its own chain and cannot see production's.

**The wrong images for the style.** `artwork` and `secondaryLogo` are accepted
for every style, so an `eventTicket` shipping `artwork.*` with the poster layout
off — exactly the waste section 6 is about — passes.

**A barcode carrying no `altText` at all.** The check validates the value when
one is present and skips when it is absent, so a build that dropped it goes green
while the door quietly loses its read-it-aloud fallback.

**Agreement with the door, and with the card.** `CHECKIN_ACCEPTS` is a
hand-copied transcription of the regex in `convex/http.ts` rather than an import
of it, so tightening that route would not fail the rig. The semantic tags are
likewise checked for presence, not against the text actually printed on the card,
so the two can drift apart.

**Anything about the deployment.** The poster-scheme check reads
`WALLET_STYLE_SCHEMES` out of the environment the rig runs in, which says nothing
about what Convex is set to.

---

## 5. The decode test, verbatim

<!-- DECODE_OUTPUT_START -->
```
$ ./scripts/wallet/gen-test-certs.sh
test chain written to ./.wallet-test/certs
./.wallet-test/certs/pass.pem: OK

$ node --import ./scripts/wallet/convex-resolve.mjs scripts/wallet/verify-pass.mjs
PASS  zip opens and is non-trivial                                           12 files, 217 KB
PASS  carries the files Apple requires                                       background.png, background@2x.png, background@3x.png, icon.png, icon@2x.png, icon@3x.png, logo.png, logo@2x.png, logo@3x.png, manifest.json, pass.json, signature
PASS  manifest hashes every file, and every hash matches                     10 files, all SHA-1 matched
PASS  signature is a detached PKCS#7 that verifies against the manifest      openssl smime -verify: OK
PASS  the signed content really is this manifest, not another one            tampered manifest rejected, as it must be
PASS  pass.json declares exactly one style, with its field dictionary        eventTicket
PASS  pass.json carries the required top-level keys                          formatVersion 1, ids and description present
PASS  the certificate that signed it was issued for THIS pass type and team  UID=pass.com.mixandgreet.test, OU=TESTTEAM99
PASS  a pass whose identifiers the certificate does not cover is rejected    stray passTypeIdentifier and teamIdentifier both rejected, as they must be
PASS  every barcode format is a constant Apple actually defines              PKBarcodeFormatQR, PKBarcodeFormatQR
PASS  barcodes is a non-empty array of well-formed entries                   PKBarcodeFormatQR/iso-8859-1
PASS  the QR payload is EXACTLY the id /api/admin/checkin expects            jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd (32 chars, matches /^[a-z0-9]{20,40}$/i)
PASS  the payload round-trips through a real QR encoder and zbarimg          zbarimg --raw -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
PASS  a second, independent decoder agrees                                   jsQR -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
PASS  every image is a real PNG at the exact point size Apple documents      background.png 180x220, background@2x.png 360x440, background@3x.png 540x660, icon.png 29x29, icon@2x.png 58x58, icon@3x.png 87x87, logo.png 160x50, logo@2x.png 320x100, logo@3x.png 480x150
PASS  the style can actually display every image the bundle ships            eventTicket: background, icon, logo
PASS  the card has an artwork ground, not just a flat colour                 background.png at 1x, 2x and 3x
PASS  the poster layout is not silently switched on                          preferredStyleSchemes absent, classic card, barcode on the face
PASS  the altText under the code is something the door would accept          jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
PASS  semantics carry the four tags Apple requires of an event pass          PKEventTypeLivePerformance, TEST Event @ 1933 S. Broadway

pkpass:   ./.wallet-test/out/MixAndGreet.pkpass
unzipped: ./.wallet-test/out/unzipped
20/20 checks passed

$ node scripts/wallet/render-face.mjs
style: eventTicket   schemes: "(none)"
payload in pass.json: jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd

PASS  poster face  1125x1614px
        zbarimg  -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
        jsQR     -> jh7a4mkq2xvzn9pd3wc6rt8sfe5cabkd
        file     -> ./.wallet-test/out/faces/face-poster.png
PASS  classic face  1125x1356px
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

### Round 1, in full — what it found in the file rather than the design

The first critic compared the sharp artwork against the invite flyer with the
labels stripped. On the design it could not separate them, and said so with
measurements: the hub dot 55x55 px in both, the red rule 132x12 px in both, the
misregistration offset +9x/+12y in both, ring radii all 0.990 of the reference —
exactly the height ratio. Its conclusion was that these were not a copy and an
original but "the same code rendered into two containers", which is precisely
what the generator does.

Then it found the real defect, in the encoding rather than the layout:

> A: PNG colour type 3 (indexed), **16 palette entries, all 16 used**... A flat
> black patch of 14,490 px in A contains **exactly one luminance value**... A
> right-edge patch: **4 distinct levels in A, 56 in B**. A has no grain in the
> blacks at all.

> Its p90 and p95 are the same value (167): a flat plateau where the beard
> highlight should have modelling... **A's arcs are stippled dashes; B's are
> solid.** A's ring strokes alternate between two palette entries along a single
> continuous stroke.

And the single biggest gap:

> **Re-export A as 24-bit RGB. Delete the palette-reduction step.** That one
> setting is responsible for the dead black, the nine-step red ramp, the flat
> beard plate, the 194 highlight clip, the arcs breaking into stipple, the ring
> stroke flicker, the stair-stepped type, the rose date stamp and the muddy rule
> bar. Fifteen minutes, one export flag.

That was right, and the cause turned out to be a quirk in `sharp` rather than a
deliberate setting. `colours` does not choose a palette size; it chooses a bit
depth bucket. Measured against a truecolour source:

```
colours: 16  -> 16-entry palette, 4-bit
colours: 64  -> 16-entry palette, 4-bit
colours: 128 -> 16-entry palette, 4-bit
colours: 160 -> 256-entry palette, 8-bit
colours: 256 -> 256-entry palette, 8-bit
```

Everything from 17 to 159 collapses to sixteen colours. The ladder was
`[160, 128, 96, 64, 48]`, so the first frame to miss its budget at 160 fell
straight off a cliff — and the generator logged `128 colours` while writing a
16-colour file, because it reported the rung it had tried rather than the result
it got. The ladder is now `[256]`: sixteen colours is not a compression setting,
it is a different picture.

### Round 3 — what shipped

Three changes came out of the two critics.

**The palette**, as above. All three background densities now carry one
256-entry palette, so they are the same picture at three sizes rather than three
that merely resemble each other. The family is packed together for that reason:
choosing per density is what produced a set where `@2x` was smaller than `@1x`.

**The logo.** Recut from the project's own `academix-logo.png` as a transparent
PNG, so the red is the acade-**mix** device and the ampersand rather than a
rectangle baked into the file. The critic's read of the old one was correct and
worth keeping: "the only crisp edge in the top third, so it floats... exactly
what a logo that had lost its alpha channel looks like."

**The artwork, dropped from the bundle.** Only the poster layout draws
`artwork.*`, that layout is off by design, and it was **395 KB of a 583 KB
pass** for a picture no guest can ever see — 90.1 KB at 1x, 103.5 KB at @2x and
201.6 KB at @3x, measured per entry in the bundle `efc5f0e` builds. Two thirds
of what a guest downloaded was an image their phone would never draw. The grain
is why: at 1089x1530 the
`feTurbulence` tile is real per-pixel noise, and over a plate rather than a
photograph it is the only high-frequency content in the frame, so PNG cannot
compress it and dithering cannot help. `make-images.mjs --with-artwork` puts it
back if the poster layout is ever switched on. That makes enabling it a rebuild
rather than a config change, which is the honest trade while the door is what
matters.

The pass went from **583 KB to 217 KB**, which is the size §5's decode output
reports.

The card that came out of this: the mark reading through Apple's blur as
concentric halos with the cream hub, the left column dark so the red labels
clear it, the bottom third flat so the white barcode tile sits clean, and a
transparent logo that belongs to the card instead of sitting on top of it.

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
off the door. It is there for the day this pass rides on NFC instead — and on
that day it is not enough on its own. The semantic tags that layout needs are
already in the bundle, but `artwork.*` is not: it was dropped for size, as §6
records. Flipping the var without running `make-images.mjs --with-artwork` first
would produce a poster pass with no poster art and no barcode, which is worse
than either layout on its own.

**3. Certificates.** Untouched, and no cert or key is in this branch. The rig's
throwaway chain lives in `.wallet-test/`, which is gitignored; `git diff` on the
branch shows no `.pem`, no `.key`, nothing base64-encoded but the artwork.

**4. Worth a look, not blocking.** The Android and no-Wallet path,
`GET /api/qr`, is deliberately untouched — `git diff` against `e350fce` shows no
change to `convex/wallet/qr.ts` or `convex/http.ts`. It encodes the same bare
RSVP id the pass does, so both routes check in identically at the same door.
