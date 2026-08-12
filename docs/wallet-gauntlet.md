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
<!-- DECODE_OUTPUT_END -->

---

## 6. Blind comparison against the invite page

<!-- BLIND_START -->
<!-- BLIND_END -->

---

## 7. Still needs Lawrence

<!-- HANDOFF_START -->
<!-- HANDOFF_END -->
