// Branded RSVP confirmation email for Mix & Greet.
//
// Plain-TS string template (no bundler, no JSX). Email-client-safe: table
// layout, inlined CSS, 600px container, no web fonts, no external CSS, and
// every merged value HTML-escaped. The plain-text alternative carries the same
// facts and links so it stands on its own.
//
// DESIGN BRIEF: this is an INVITATION, not a receipt. Three rules follow from
// that, and they outrank every other layout preference in this file:
//
//  A. THE EVENT TITLE IS THE HEADLINE. It is set larger than anything else in
//     the message, including the Mix & Greet wordmark. The brand is a small
//     piece of letterhead at the top; the party is the thing the eye lands on.
//     A masthead set larger than the event title turns the message into a
//     branded template with a name merged into it.
//  B. EVERY FACT IS STATED ONCE, AND THE INBOX ROW COUNTS AS PART OF THE
//     MESSAGE. Subject and preheader are read together as one line before
//     anything else, so they split the facts rather than echo each other: the
//     subject carries status, event and date, the preheader carries the clock
//     and the place and nothing the subject already said. In the body, the
//     date appears as the poster date stamp in the dark rail and again, in a
//     different register, inside the WHEN row of the ticket. Status appears
//     exactly once, as the eyebrow line that runs into the title.
//  C. A PERSON HAS TO BE IN IT. Under the opening line, before anything
//     transactional, sits a bordered box holding a note from the host, signed.
//     Without it the message is entirely written about the guest by a system;
//     with it there is a sentence written to them by somebody.
//  D. THE TICKET EARNS ITS KEEP. Unlike a pure invite, a confirmation has a
//     job at the door: when, where, how many, parking, house rules. That block
//     stays, but it sits BELOW the invitation, never above it.
//
// It follows the site's rhythm exactly: dark rail + masthead, LED meter, the
// event's own poster, light content panel, dark footer, using the brand.css
// palette. Academix red #EC1C24 primary, #C8151C on light surfaces, SQUARE
// corners, 2px borders. Amber appears nowhere except inside the LED meter
// graphic, where the amber/red segments are the physical object being drawn.
//
// Fonts: web fonts do not load in most clients, so the display face falls back
// to the same stack brand.css already declares for Big Shoulders (Impact and
// friends), and body copy uses a monospace stack echoing Plex Mono.
//
// Four client-specific rules this file follows everywhere, because breaking
// any one of them silently destroys the design in a major client:
//
//  1. UPPERCASE IS LITERAL. The Word engine behind Outlook 2016-2021/365 for
//     Windows ignores `text-transform`, so every string that the design shows
//     in caps is uppercased in source (`escUp` / already-capital literals).
//     `text-transform:uppercase` is still declared as a belt-and-braces for
//     anything that slips through.
//  2. BUTTON PADDING LIVES ON THE `<td>`. The same engine ignores
//     `display:block` on an anchor, so padding on the `<a>` does not expand the
//     line box and a button collapses to a bare strip of color. Padding goes on
//     the cell (plus `mso-padding-alt`); the anchor keeps `display:block` only
//     so the click target fills the cell in every other client.
//  3. `mso-line-height-rule:exactly` TAKES A PX LINE-HEIGHT, NEVER A UNITLESS
//     MULTIPLIER. The rule tells the Word engine to use the declared value as
//     an absolute line box; handed `line-height:.9` it can compute a near-zero
//     box and clip the type. Every `mso-line-height-rule` in this file is
//     paired with px. Multipliers are still used for flowing body copy, which
//     deliberately does NOT carry the rule.
//  4. NOWRAP IS A WIDTH BUDGET, NOT A STYLING CHOICE. A nowrap label sets the
//     document's minimum width, so at 320px it is the difference between a
//     message that fits and one the client zooms out or scrolls sideways. The
//     budget at 320px is 244px of content (320 - 2*18 outer pad - 2*2 panel
//     border - 2*18 inner pad). Exactly ONE label in this file is nowrap: the
//     slab header, which is a fixed literal that is measured to fit inside it.
//     The footer's two labels are NOT, because "BEAT LAB · ACADEMIX" plus
//     "INVITE ONLY · MUST RSVP" together came to 303px and forced a 339px
//     document; they wrap instead.
//
// CONTRAST IS CHECKED AGAINST THE SURFACE IT LANDS ON. #EC1C24 reaches only
// 4.4:1 against white, so it is reserved for the dark zone and for display
// type; #C8151C (5.87:1 on white, 5.33:1 on --surface) carries every
// light-surface fill and accent. See the BRAND table for the rest.

const BRAND = {
  // dark zone
  bg: "#0B0B0D",
  line: "#2A2A32",
  ink: "#EDEAE3", // 15.7:1 on --bg
  muted: "#8B8B94", // 5.8:1 on --bg — the floor for body copy in the footer
  // light zone
  white: "#FFFFFF",
  surface: "#F5F4F1",
  surfaceLine: "#E5E3DE",
  text: "#16161A",
  textSoft: "#3A3A42", // 10.3:1 on --surface
  // brand.css uses #84848C for --muted-lt, which is 3.4:1 on --surface: fine
  // behind a hover state on a screen, not fine for an 11px label in an inbox.
  // This is the same "deepened for the surface it sits on" move --brand-ink is.
  textMuted: "#6B6B74", // 4.8:1 on --surface, 5.3:1 on white
  // accents
  brand: "#EC1C24", // dark zone + display type only (4.5:1 on --bg)
  brandInk: "#C8151C", // every light-surface fill and accent (5.87:1 on white)
  // LED meter (the one place amber is allowed: it is the object, not an accent)
  ledGreen: "#37C871",
  ledAmber: "#FFB300",
  ledOffAmber: "#2C2410",
  ledOffRed: "#2E1214",
  ledCase: "#101014",
};

// Web-safe echoes of the brand faces. Big Shoulders 800 falls back to Impact
// in brand.css itself, so the email uses the same ladder.
const DISPLAY =
  "Impact,Haettenschweiler,'Arial Narrow Bold','Franklin Gothic Bold',Charcoal,sans-serif";
const MONO =
  "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

// ONE venue, ONE source of truth, exported so the caller cannot hold a second
// copy in a different SHAPE. convex/email.ts used to declare its own
// name-first fallback ("Academix BEAT Lab, 1933 S. Broadway, ...") while this
// file defaulted to a street-first string. The redactor below was written
// against the street-first shape, so on the fallback path — every event with no
// location of its own, i.e. the default — a waitlisted guest was shown the
// street. Two constants that disagree about shape is the bug; one constant,
// imported, is the fix. `splitVenue` no longer trusts the shape either.
const VENUE_NAME = "Academix BEAT Lab";
// The postal line on its own, for the footer, which already prints the name.
const VENUE_STREET = "1933 S. Broadway, Suite 1202, Los Angeles, CA 90007";
export const VENUE_FALLBACK = `${VENUE_NAME}, ${VENUE_STREET}`;
// The venue is in LA; floating times are resolved against this.
const DEFAULT_TZ = "America/Los_Angeles";

const HOST = "ACADEMIX BEAT LAB";

// The light panel's content width at 600px: 600 - 2*28 outer pad = 544.
const POSTER_WIDTH = 544;

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Uppercase THEN escape, never the other way around: `esc` emits named
// references (`&amp;`, `&quot;`, `&#39;`) and upper-casing those afterwards
// produces `&AMP;` / `&QUOT;`, which is not a reference every parser accepts.
function escUp(v: unknown): string {
  return esc(String(v ?? "").toUpperCase());
}

// href guard: anything that is not http(s) is dropped rather than rendered,
// so an admin-entered `javascript:` link can never reach a mail client. EVERY
// href in this file goes through it, including the unsubscribe link, which is
// also copied into the List-Unsubscribe header by the caller.
function safeUrl(v: unknown): string {
  const s = String(v ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

export type ConfirmationFeatured = {
  name: string;
  role?: string;
  kind?: "artist" | "speaker" | "company";
  imageUrl?: string | null;
  link?: string;
  // The one line that says why this person is worth showing up for. It exists
  // on the event and renders on the invite page, and its absence here was the
  // only event content the confirmation dropped.
  bio?: string;
};

export type ConfirmationVars = {
  name: string;
  eventTitle: string;
  whenLine: string; // e.g. "Saturday, July 11, 2026 · 1:00 PM – 4:00 PM"
  location: string;
  status: "confirmed" | "waitlist";
  parking?: string;
  notes?: string;
  unsubUrl?: string; // tokenized /unsubscribe link (also sent as List-Unsubscribe)

  // --- additive, all optional: callers that omit them still render ----------
  // A line in the host's own words, rendered in a bordered box under the
  // opening sentence. Absent, the box still renders and carries a written
  // sign-off from the crew — the block exists so the message has a human in it
  // either way, not so a schema field can be plumbed later.
  hostNote?: string;
  subtitle?: string;
  guests?: number;
  date?: string; // "YYYY-MM-DD" — drives the WHEN block + every calendar link
  start?: string; // "1:00 PM" / "13:00"
  end?: string;
  timezone?: string; // IANA zone for the calendar entry (default America/Los_Angeles)
  eventUrl?: string; // hosted invite link — the primary CTA
  walletUrl?: string; // signed /api/pass link: Add to Apple Wallet
  manageUrl?: string; // signed /rsvp/manage link: change party size or cancel
  // Signed /api/qr link: the guest's door code as a PNG. Same token as the pass
  // and the manage page, so the scan at the door records the same attendance
  // whichever of the three the guest ends up holding. See the door code block
  // in the renderer for why this is rendered as an image AND as a link.
  qrUrl?: string;
  // Absolute URL of the animated LED meter GIF. Optional: without it the meter
  // falls back to the table of coloured cells, which is what shipped before and
  // is still what a client with images off sees.
  meterUrl?: string;
  mapUrl?: string; // overrides the derived Google Maps search link
  // The event's own flyer, resolved from events.posterId in convex/email.ts.
  // This is the only thing in the message that changes shape between events,
  // and it is the reason the email reads as this party's invitation rather than
  // as a template with a name merged into it.
  posterUrl?: string | null;
  // Hosted .ics URL. convex/email.ts builds the file with `buildRsvpIcs` below,
  // parks it in Convex file storage as text/calendar and passes the resulting
  // url here; that makes ADD TO CALENDAR a one-tap action in Apple Mail,
  // Outlook and every other native client instead of a Google-only link. When
  // it is absent the button falls back to the Google template url and the
  // alternates line still offers Outlook, so no recipient is ever stranded.
  icsUrl?: string;
  featured?: ConfirmationFeatured[];
};

// --- date helpers -------------------------------------------------------------

type Ymd = { y: number; m: number; d: number };

function parseYmd(date?: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

// "08-15-26", everywhere a date appears in this message.
//
// Numeric and in one shape, matching the invite link the guest was sent
// (/i/08-15-26) and the date on the invite page. A spelled month read as a
// different fact from the URL that led there, and the message used to carry
// three registers of the same day — longhand in the ticket, abbreviated in the
// subject, poster-style in the rail — which is three chances to disagree.
//
// The Apple Wallet pass is deliberately NOT part of this. It keeps "AUG 15":
// it is a physical-object design with its own typographic register, and it is
// read at a door rather than compared against a link.
function numericDate(ymd: Ymd): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(ymd.m)}-${p(ymd.d)}-${String(ymd.y).slice(2)}`;
}

function longDate(ymd: Ymd): string {
  return numericDate(ymd);
}

// Subject-line length. Already short, now shorter.
function shortDate(ymd: Ymd): string {
  return numericDate(ymd);
}

// The poster date stamp in the dark rail. Same numeric string as everywhere
// else now: the old rule that no two places print the date identically was
// there to stop three registers colliding, and with one register there is
// nothing left to collide.
function railDate(ymd: Ymd): string {
  return numericDate(ymd);
}

// "1:00 PM" / "13:00" / "7pm" -> minutes past midnight. Null when unparseable,
// which downgrades the calendar entry to an all-day one rather than guessing.
function parseClock(t?: string): number | null {
  // "1:00 PM", "7pm", "13:00" — the admin start/end fields are free text.
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?$/i.exec(
    String(t ?? "").trim(),
  );
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const mer = m[3] ? m[3].toLowerCase() : "";
  if (h > 23 || min > 59) return null;
  if (mer === "p" && h < 12) h += 12;
  if (mer === "a" && h === 12) h = 0;
  return h * 60 + min;
}

const pad = (n: number) => String(n).padStart(2, "0");

// The plain-text stand-in for the bordered note box: a leading pipe on every
// line, wrapped at 66 columns so it still reads as a quoted block in a 72-col
// terminal client.
function quoteBlock(body: string, width = 66): string {
  const lines: string[] = [];
  let cur = "";
  for (const word of String(body).trim().split(/\s+/)) {
    if (!word) continue;
    if (cur && `${cur} ${word}`.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `| ${l}`).join("\n");
}

// Start/end as minutes past midnight on the event's date, or null for all-day.
//
// A missing end time gets a 2h block: long enough to hold the slot, short
// enough not to eat someone's evening.
//
// An end STRICTLY BEFORE the start means the night runs past midnight
// ("10:00 PM" -> "1:00 AM"), so it belongs on the next day; without this the
// range comes out backwards and calendars drop the time entirely. An end EQUAL
// to the start is not an overnight event, it is an admin who pasted the same
// value into both fields — rolling that forward would book a 24-hour block, so
// it falls back to the 2h default instead.
function eventMinutes(
  start?: string,
  end?: string,
): { s: number; e: number } | null {
  const s = parseClock(start);
  if (s === null) return null;
  const rawEnd = parseClock(end);
  const e =
    rawEnd === null || rawEnd === s
      ? s + 120
      : rawEnd < s
        ? rawEnd + 1440
        : rawEnd;
  return { s, e };
}

// Floating "YYYYMMDDTHHMMSS" on the event's date, rolled forward across
// midnight when the range needs it.
function floatStamp(ymd: Ymd, mins: number): string {
  const dayShift = Math.floor(mins / 1440);
  const rest = ((mins % 1440) + 1440) % 1440;
  const day = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + dayShift));
  return (
    `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}` +
    `T${pad(Math.floor(rest / 60))}${pad(rest % 60)}00`
  );
}

// "YYYYMMDD" for an all-day range (the second date is exclusive).
function dateStamp(ymd: Ymd, dayShift = 0): string {
  const day = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + dayShift));
  return `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}`;
}

// Google Calendar TEMPLATE range. Floating local times plus &ctz=<zone>, so no
// offset math is needed for the Google link specifically.
function calendarRange(ymd: Ymd, start?: string, end?: string): string {
  const mins = eventMinutes(start, end);
  if (!mins) return `${dateStamp(ymd)}/${dateStamp(ymd, 1)}`;
  return `${floatStamp(ymd, mins.s)}/${floatStamp(ymd, mins.e)}`;
}

// --- wall clock -> UTC, for the .ics and the Outlook deeplink -----------------
// A hosted .ics is read by clients that will NOT look up an IANA zone name for
// us (older Outlook wants a VTIMEZONE block it can trust), so the safest wire
// format is a UTC instant. Intl is the only timezone database available in
// both the Convex V8 runtime and Node, and it is used read-only here: no
// offset tables, no DST guessing. If the runtime cannot resolve the zone the
// caller falls back to floating local time, which is right for everyone
// reading in the venue's own city.
const _tzCache = new Map<string, Intl.DateTimeFormat | null>();
function zoneFormatter(tz: string): Intl.DateTimeFormat | null {
  if (_tzCache.has(tz)) return _tzCache.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    f = null;
  }
  _tzCache.set(tz, f);
  return f;
}

// How far ahead of UTC the zone is at this instant, in ms.
function zoneOffsetMs(utcMs: number, tz: string): number | null {
  const f = zoneFormatter(tz);
  if (!f) return null;
  try {
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(new Date(utcMs))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    if (!Number.isFinite(p.year)) return null;
    // Some ICU builds render midnight as hour 24 under hour12:false.
    const asUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour % 24,
      p.minute,
      p.second,
    );
    return asUtc - utcMs;
  } catch {
    return null;
  }
}

// Wall clock in `tz` -> the UTC instant. Two passes so a time that lands on a
// DST boundary resolves against its own offset rather than the offset of the
// naive guess.
function wallToUtcMs(ymd: Ymd, mins: number, tz: string): number | null {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d) + mins * 60000;
  const o1 = zoneOffsetMs(guess, tz);
  if (o1 === null) return null;
  const t1 = guess - o1;
  const o2 = zoneOffsetMs(t1, tz);
  if (o2 === null) return null;
  return o2 === o1 ? t1 : guess - o2;
}

function utcStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ISO local/UTC stamp for the Outlook.com deeplink.
function isoStamp(ms: number): string {
  const s = utcStamp(ms);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
}

// --- venue ---------------------------------------------------------------------
// The first comma splits the leading line from the rest, which reads as
// name-over-address without needing a second schema field.
//
// A waitlisted guest does not have a spot, so they do not get the door: street,
// suite and venue name are withheld exactly the way the invite page withholds
// them until a guest is in, and the city stays so they know which town to keep
// free. EVERY surface that prints a location goes through this one function —
// the ticket row, the preheader, the Google and Outlook links, the .ics file
// and the plain-text alternative — so the address cannot leak through a side
// door.
//
// REDACTION IS BY SHAPE, NEVER BY INDEX. The previous version dropped
// `parts[0]`, which is only the street when the string happens to start with
// one. The caller's fallback venue starts with the venue NAME, so on that path
// (any event with no location of its own) the street survived into the WHERE
// row, the .ics LOCATION, both calendar deeplinks and the plain-text
// alternative, with only "Suite 1202" removed. Any admin-typed
// "<venue name>, <street>, <city>, <region>" leaked the same way.

// The door itself: a house number leading the line ("1933 S. Broadway",
// "12 High St"), or a line ending in a street-type word ("Sunset Blvd").
// The `\b` in the second alternative is load-bearing: without it "Conway"
// would read as a street because it ends in "way".
const STREET_PART =
  /^\d+[a-z]?(?:\s*[-–/]\s*\d+[a-z]?)?\s+\S|\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|pl|place|way|pkwy|parkway|hwy|highway|ter|terrace|cir|circle|sq|square|row|walk|broadway|plaza)\.?$/i;

// The door pinned further: suite, unit, floor, building.
const UNIT_PART =
  /^(?:suite|ste|apt|apartment|unit|floor|fl|no|rm|room|bldg|building|ph|penthouse|loft|level|lvl)\b\.?|^#|\b(?:floor|fl)\.?$/i;

const isDoorPart = (p: string) => STREET_PART.test(p) || UNIT_PART.test(p);

function splitVenue(
  location: string,
  isWait: boolean,
): { top: string; rest: string; oneLine: string } {
  const parts = location
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!isWait) {
    const top = parts.length ? parts[0] : location;
    const rest = parts.slice(1).join(", ");
    return { top, rest, oneLine: location };
  }
  // A location with no comma cannot be split, so there is no safe subset of it
  // to print. Withhold all of it rather than guess which half is the door.
  if (parts.length < 2) return { top: "", rest: "", oneLine: "" };

  // 1. Drop everything up to and including the LAST door-shaped part. That
  //    treats "<name>, <street>, <suite>, <city>, <region>" and
  //    "<street>, <suite>, <city>, <region>" identically, which is the whole
  //    point: the function no longer cares what the caller put first.
  let cut = -1;
  parts.forEach((p, i) => {
    if (isDoorPart(p)) cut = i;
  });
  let publicParts = parts.slice(cut + 1);

  // 2. Belt and braces: nothing door-shaped survives even if step 1 misread the
  //    ordering of an unusual address.
  publicParts = publicParts.filter((p) => !isDoorPart(p));

  // 3. Keep only the locality tail. A venue string carrying no street at all
  //    ("Academix BEAT Lab, Los Angeles, CA 90007") would otherwise hand a
  //    waitlisted guest the venue NAME, which is a searchable address by
  //    another route.
  //    A bare `length > 2` left a two-part string untouched, so
  //    "Academix BEAT Lab, Los Angeles" handed a waitlisted guest the venue
  //    name — the exact leak this step exists to stop. Decide by what the LAST
  //    part is instead of by how many there are: a trailing region or postal
  //    ("CA 90007") means the part before it is the city and both belong;
  //    anything else means the last part is already the city and everything
  //    ahead of it is venue or street.
  if (publicParts.length > 2) publicParts = publicParts.slice(-2);
  if (publicParts.length === 2) {
    const tail = publicParts[1];
    const looksLikeRegion = /^[A-Za-z.]{2,20}\s*\d{4,6}$/.test(tail) || /^[A-Z]{2}$/.test(tail.trim());
    if (!looksLikeRegion) publicParts = publicParts.slice(-1);
  }

  // What is left is a city and a region, which belong on one line: breaking
  // "Los Angeles" over "CA 90007" would imply a street line had been removed.
  const oneLine = publicParts.join(", ");
  return { top: oneLine, rest: "", oneLine };
}

// --- .ics ---------------------------------------------------------------------
const _enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function byteLen(s: string): number {
  return _enc ? _enc.encode(s).length : s.length;
}

// RFC 5545 TEXT escaping. Order matters: backslash first, or every escape this
// function adds gets escaped again.
function icsText(v: unknown): string {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 content lines are folded at 75 OCTETS, not characters, and a
// continuation starts with one space. Folding by code point keeps surrogate
// pairs intact.
function icsFold(line: string): string {
  if (byteLen(line) <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const n = byteLen(ch);
    if (curBytes + n > 75) {
      out.push(cur);
      cur = " ";
      curBytes = 1;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

// A stable UID keyed to the event, not to the guest.
//
// A stable UID ALONE does not make a second file an update. RFC 5546 §3.2.2
// resolves two PUBLISHed VEVENTs sharing a UID by SEQUENCE first and DTSTAMP
// second, so a re-publish carrying SEQUENCE:0 and a byte-identical DTSTAMP is
// entitled to be ignored or duplicated. Both are supplied below: SEQUENCE
// steps 0 -> 1 on the waitlist -> confirmed promotion, and DTSTAMP is the
// instant the file was built, so a later build always wins on both axes.
//
// To be exact about what ships today: convex/email.ts sends at most ONE
// confirmation per RSVP (dedupeKey `rsvp_confirmation:<rsvpId>`), so nothing
// currently publishes a second file. What is fixed here is the wire format —
// the previous one advertised update-on-resend in a comment while emitting
// SEQUENCE:0 and a byte-identical DTSTAMP, which cannot deliver it. A promotion
// send can now be added without stranding a confirmed guest on a TENTATIVE
// entry that still carries the redacted, city-only location.
function icsUid(v: ConfirmationVars, ymd: Ymd): string {
  const slug =
    String(v.eventTitle || "event")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "event";
  return `${dateStamp(ymd)}-${slug}@mixandgreet.academix`;
}

/**
 * The event as a real iCalendar file.
 *
 * This is the one email-craft behaviour a Google Calendar link cannot match:
 * an iCloud, Outlook or Proton recipient who taps a `calendar.google.com`
 * link lands on a Google sign-in wall, while a `text/calendar` file opens
 * straight into whatever calendar they actually use.
 *
 * Returns "" when the event has no parseable date, which is the caller's
 * signal to skip hosting a file at all.
 */
export function buildRsvpIcs(v: ConfirmationVars): string {
  const ymd = parseYmd(v.date);
  if (!ymd) return "";

  const isWait = v.status === "waitlist";
  const tz = String(v.timezone || DEFAULT_TZ);
  const mins = eventMinutes(v.start, v.end);

  let dtStart: string;
  let dtEnd: string;
  if (!mins) {
    dtStart = `DTSTART;VALUE=DATE:${dateStamp(ymd)}`;
    dtEnd = `DTEND;VALUE=DATE:${dateStamp(ymd, 1)}`;
  } else {
    const sUtc = wallToUtcMs(ymd, mins.s, tz);
    const eUtc = wallToUtcMs(ymd, mins.e, tz);
    if (sUtc !== null && eUtc !== null) {
      dtStart = `DTSTART:${utcStamp(sUtc)}`;
      dtEnd = `DTEND:${utcStamp(eUtc)}`;
    } else {
      // Floating local time: correct for anyone reading in the venue's city,
      // and the only honest answer when the runtime has no zone database.
      dtStart = `DTSTART:${floatStamp(ymd, mins.s)}`;
      dtEnd = `DTEND:${floatStamp(ymd, mins.e)}`;
    }
  }

  const eventUrl = safeUrl(v.eventUrl);
  const description = [
    isWait
      ? "You are on the waitlist for this event. We will email you the moment a spot opens."
      : "Your spot is held. Bring this invite to the door.",
    eventUrl ? `Invite: ${eventUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // RFC 5545 3.8.7.2: for METHOD:PUBLISH, DTSTAMP is when the iCalendar OBJECT
  // was created. The old value was the EVENT's date at 000000Z, which is a
  // future instant on every send and therefore both a spec deviation and
  // useless as a freshness signal. `now` is the honest answer, and it is also
  // what lets a later file supersede an earlier one for the same UID.
  const now = utcStamp(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Academix BEAT Lab//Mix & Greet//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsUid(v, ymd)}`,
    `DTSTAMP:${now}`,
    `LAST-MODIFIED:${now}`,
    // The revision counter a client actually reads. A tentative hold published
    // at 0 is superseded by the confirmed entry at 1, which is what carries the
    // real street address back onto a promoted guest's calendar; without the
    // step they would keep the redacted, city-only entry forever.
    `SEQUENCE:${isWait ? 0 : 1}`,
    dtStart,
    dtEnd,
    `SUMMARY:${icsText(v.eventTitle)}`,
    // Redacted for a waitlisted guest, exactly like the ticket row: a calendar
    // entry is the easiest place for a withheld address to leak back out.
    `LOCATION:${icsText(splitVenue(String(v.location || VENUE_FALLBACK), isWait).oneLine)}`,
    `DESCRIPTION:${icsText(description)}`,
    eventUrl ? `URL:${icsText(eventUrl)}` : "",
    `STATUS:${isWait ? "TENTATIVE" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(v.eventTitle)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// --- small HTML builders ------------------------------------------------------
// A 26-segment LED meter, the site's signature divider, rebuilt as a table so
// it survives Outlook. Static frame: 16 green, 3 amber lit, the rest dark.
function meterHtml(gifUrl?: string): string {
  // The animated version, when the caller gave us somewhere to load it from.
  //
  // A GIF and not CSS: Gmail strips @keyframes outright and the Word engine
  // behind Outlook for Windows never had them, so an animated GIF is the only
  // motion every major client agrees on. It is built from brand.css itself by
  // scripts/build-meter-gif.mjs, so it cannot drift from the site's meter.
  //
  // Two fallbacks are already handled and neither needs markup here:
  //   - Outlook for Windows draws frame 1 and stops. Frame 1 is the resting,
  //     fully-lit state, which is why the capture starts there.
  //   - Images off leaves the <td>'s bgcolor, the LED case colour, at the same
  //     height as the bar — an unlit meter rather than a broken-image icon.
  //     alt is empty on purpose: this is a divider, and a screen reader
  //     announcing "LED meter" here would be reading out the furniture.
  //
  // 544px to sit on the same measure as the poster, at 1200px native, so it is
  // not soft on a retina phone.
  if (gifUrl) {
    return `<table role="presentation" aria-hidden="true" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.ledCase}" style="width:100%;border-collapse:collapse;background-color:${BRAND.ledCase};">
  <tr><td align="center" bgcolor="${BRAND.ledCase}" style="background-color:${BRAND.ledCase};font-size:0;line-height:0;padding:0;">
    <img src="${esc(gifUrl)}" width="${POSTER_WIDTH}" alt="" style="display:block;width:100%;max-width:${POSTER_WIDTH}px;height:auto;border:0;outline:none;text-decoration:none;background-color:${BRAND.ledCase};">
  </td></tr>
</table>`;
  }

  const cells: string[] = [];
  for (let i = 1; i <= 26; i++) {
    const bg =
      i <= 16
        ? BRAND.ledGreen
        : i <= 19
          ? BRAND.ledAmber
          : i <= 22
            ? BRAND.ledOffAmber
            : BRAND.ledOffRed;
    cells.push(
      `<td width="3.8%" height="20" bgcolor="${bg}" style="width:3.8%;height:20px;background-color:${bg};font-size:0;line-height:0;">&nbsp;</td>`,
    );
  }
  return `<table role="presentation" aria-hidden="true" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.ledCase}" style="width:100%;border-collapse:separate;background-color:${BRAND.ledCase};">
  <tr>${cells.join("")}</tr>
</table>`;
}

// The panel's top bar, and the loudest of the signals that separate a confirmed
// guest from a waitlisted one: a SOLID 6px red band means the spot is held, a
// BROKEN one means it is not. Drawn as cells rather than a dashed border
// because Outlook renders `border-style:dashed` as solid.
function panelTopBar(isWait: boolean): string {
  if (!isWait) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr><td height="6" bgcolor="${BRAND.brandInk}" class="mg-brandink" style="height:6px;background-color:${BRAND.brandInk};font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>`;
  }
  const cells: string[] = [];
  for (let i = 0; i < 12; i++) {
    const on = i % 2 === 0;
    const bg = on ? BRAND.brandInk : BRAND.surfaceLine;
    cells.push(
      `<td width="8.33%" height="6" bgcolor="${bg}"${on ? ' class="mg-brandink"' : ""} style="width:8.33%;height:6px;background-color:${bg};font-size:0;line-height:0;">&nbsp;</td>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr>${cells.join("")}</tr>
      </table>`;
}

// The .slab section header: red square, tracked label, 2px rule to the edge.
//
// The label cell IS nowrap, and it is the only one in the file. Auto table
// layout collapses any cell that shares a row with a `width:100%` sibling down
// to its longest word, so without it the header breaks into a three-line
// ladder beside the rule. Both literals passed in are measured against the
// 244px budget in rule 4: the longer one, "LINEUP & PARTNERS", needs about
// 182px at the mobile size with the square and padding included.
function slab(label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
  <tr>
    <td width="10" valign="middle" style="width:10px;font-size:0;line-height:0;">
      <!-- the square is its own fixed-width table: a bare width="10" cell gets
           collapsed to 0 by auto table layout once a sibling asks for 100%. -->
      <table role="presentation" width="10" cellpadding="0" cellspacing="0" border="0" style="width:10px;">
        <tr><td class="mg-brandink" width="10" height="10" bgcolor="${BRAND.brandInk}" style="width:10px;height:10px;background-color:${BRAND.brandInk};font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
    </td>
    <td class="mg-ink mg-slab" valign="middle" style="padding:0 16px 0 18px;font-family:${MONO};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.28em;text-transform:uppercase;color:${BRAND.text};white-space:nowrap;">${label}</td>
    <td width="100%" valign="middle" style="width:100%;font-size:0;line-height:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr><td height="2" bgcolor="${BRAND.surfaceLine}" style="height:2px;background-color:${BRAND.surfaceLine};font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
</table>`;
}

// One row of the white "ticket" box. Label is a tracked mono micro-label; the
// value carries the weight. Rows after the first get a 1px hairline.
function ticketRow(label: string, valueHtml: string, first = false): string {
  return `<tr>
    <td style="padding:${first ? "16px" : "14px"} 18px 14px 18px;${first ? "" : `border-top:1px solid ${BRAND.surfaceLine};`}">
      <div class="mg-quiet" style="font-family:${MONO};font-size:11px;line-height:15px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${BRAND.textMuted};">${label}</div>
      <div class="mg-soft" style="margin-top:6px;font-family:${MONO};font-size:14px;line-height:1.55;color:${BRAND.textSoft};">${valueHtml}</div>
    </td>
  </tr>`;
}

// Square, 2px-bordered button. `filled` is the primary: red fill, white label.
// Unfilled is the ghost: white fill, red label, same red 2px border.
//
// The padding lives on the <td> (with mso-padding-alt) because the Word engine
// ignores display:block on an <a>; the anchor keeps display:block purely so the
// whole cell is a click target everywhere else. This is the difference between
// a 48px-tall button and a 16px red strip in Outlook for Windows.
function button(href: string, label: string, filled: boolean): string {
  const bg = filled ? BRAND.brandInk : BRAND.white;
  const fg = filled ? BRAND.white : BRAND.brandInk;
  const cellClass = filled ? "mg-brandink" : "mg-field";
  const linkClass = filled ? "mg-onbrand" : "mg-accent";
  const size = filled ? 13 : 11;
  const padY = filled ? 16 : 13;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr>
    <td class="${cellClass}" align="center" bgcolor="${bg}" style="background-color:${bg};border:2px solid ${BRAND.brandInk};padding:${padY}px 12px;mso-padding-alt:${padY}px 12px;">
      <a class="mg-btn ${linkClass}" href="${esc(href)}" target="_blank" rel="noopener" style="display:block;font-family:${MONO};font-size:${size}px;line-height:18px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${fg};text-decoration:none;text-align:center;">${label}</a>
    </td>
  </tr>
</table>`;
}

// POSTER: `posterUrl` is the event's flyer out of Convex file storage. It needs
// no send-path support (it is a plain hosted <img src>), but it does need the
// field to exist end to end: events.posterId in convex/schema.ts, resolved to a
// URL in convex/email.ts. When it is absent the band is omitted and the layout
// closes up.
export function renderRsvpConfirmation(v: ConfirmationVars): {
  subject: string;
  html: string;
  text: string;
} {
  const isWait = v.status === "waitlist";
  // An empty name gets a NAME-FREE sentence, never a filler word dropped into
  // a slot shaped for a name ("You're in, there.").
  const first = (v.name || "").trim().split(/\s+/)[0] || "";
  const title = esc(v.eventTitle);
  // The site colors the ampersand of the Mix&Greet lockup in ink; event titles
  // that carry one get the same treatment on the card, so mirror it here.
  // Uppercased in source, not with text-transform, so Outlook keeps the voice.
  //
  // The split happens on the RAW title, BEFORE escaping. Escaping first and
  // then hunting for "&amp;" in the output cannot tell a typed "&" from the
  // escape of a typed "&amp;": the second escapes to "&amp;amp;", the replace
  // fires on its leading "&amp;", and the guest reads the literal string
  // "&amp;B" in the headline of the message.
  const titleHtml = String(v.eventTitle ?? "")
    .toUpperCase()
    .split("&")
    .map((s) => esc(s))
    .join(`<span style="color:${BRAND.text};">&amp;</span>`);

  const ymd = parseYmd(v.date);
  const location = String(v.location || VENUE_FALLBACK);
  const guests = Math.max(1, Math.round(Number(v.guests) || 1));
  const partyLine = guests > 1 ? `${guests} guests` : "Just you";

  // Venue, redacted for the waitlist. See splitVenue: this is the only place
  // a location is derived, and everything below reads from it.
  const venue = splitVenue(location, isWait);
  const whereTop = venue.top;
  const whereRest = venue.rest;
  const whereNote = isWait ? "Full address lands here with your spot." : "";
  const calLocation = venue.oneLine;
  // The sender's postal line is the same street as the venue, so withholding
  // the address in the ticket and then printing it in the footer would be
  // theatre. It gets the identical redaction. VENUE_STREET rather than
  // VENUE_FALLBACK because the footer already prints the venue name beside it.
  const footerAddress = splitVenue(VENUE_STREET, isWait).oneLine;

  // A pinned map url is an exact address by definition, so the admin override
  // is honoured for a confirmed guest and ignored for a waitlisted one, whose
  // link is derived from the redacted venue instead. This matters because the
  // no-invite-link fallback below can promote directions to the only button.
  // A location with no commas cannot be split, so a waitlisted guest gets no
  // map link at all rather than a link to the address being withheld.
  const mapUrl = isWait
    ? venue.oneLine
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.oneLine)}`
      : ""
    : safeUrl(v.mapUrl) ||
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  const eventUrl = safeUrl(v.eventUrl);
  const icsUrl = safeUrl(v.icsUrl);
  const posterUrl = safeUrl(v.posterUrl);
  // Guarded like every other href in this file. The caller also copies this
  // string into the List-Unsubscribe header, so the guard has to happen here
  // rather than at the point of use.
  const unsubUrl = safeUrl(v.unsubUrl);

  // --- the door code ---------------------------------------------------------
  // The thing a guest is actually holding when they get to the door, put in the
  // message itself. Until now the only scannable thing this email offered was
  // the Apple Wallet pass, so an Android guest, a guest whose Wallet declined
  // the pass, and a guest whose pass certificate had expired server side all
  // arrived with an email that had no code in it. The same signed token that
  // opens the pass also renders the code as a PNG at /api/qr, so the code goes
  // to everybody and the pass goes back to being one way to carry it rather
  // than the only one.
  //
  // TWO ROUTES, DELIBERATELY, because either one on its own strands somebody:
  //
  //  1. THE INLINE IMAGE IS A BONUS, NEVER THE ROUTE. Gmail proxies remote
  //     images and Apple Mail and Outlook usually ask first, so this draws for
  //     some guests and not for others, and which ones is not knowable from
  //     here. Its `alt` therefore carries an instruction rather than a
  //     description: a blocked image has to point at the link, the way the
  //     lineup thumbnails carry their initial.
  //
  //  2. THE LINK IS THE ROUTE, and it points at the manage page rather than at
  //     the bare PNG. The page draws the code at full size with the guest's name
  //     and the event beside it, a phone browser can zoom and screenshot it, and
  //     it is the same signed address the guest already keeps for changing or
  //     cancelling, so there is one link in the message to hold on to instead of
  //     two. The bare PNG carries no name, no event and nothing to say when a
  //     scanner refuses it, so it is offered underneath as the last resort for a
  //     client that mangles the page.
  //
  // Nothing here prints a location, so the waitlist redaction in `splitVenue`
  // is untouched by this block: a token is not an address.
  //
  // Resolved up here with the other href guards, not down beside the block it
  // renders, because the opening line of the message makes a promise about it.
  const qrImgUrl = safeUrl(v.qrUrl);
  const codeUrl = safeUrl(v.manageUrl) || qrImgUrl;

  const tz = String(v.timezone || DEFAULT_TZ);
  const mins = eventMinutes(v.start, v.end);

  const googleCalUrl = ymd
    ? "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      `&text=${encodeURIComponent(v.eventTitle)}` +
      `&dates=${calendarRange(ymd, v.start, v.end)}` +
      `&ctz=${encodeURIComponent(tz)}` +
      `&location=${encodeURIComponent(calLocation)}` +
      `&details=${encodeURIComponent(
        [
          isWait
            ? "You are on the waitlist for this event."
            : "Your spot is held.",
          eventUrl ? `Invite: ${eventUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )}`
    : "";

  // Outlook.com / Office 365 web deeplink, so a Microsoft recipient is never
  // routed through a Google sign-in wall.
  let outlookCalUrl = "";
  if (ymd) {
    const q: string[] = [
      "path=/calendar/action/compose",
      "rru=addevent",
      `subject=${encodeURIComponent(v.eventTitle)}`,
      `location=${encodeURIComponent(calLocation)}`,
    ];
    if (!mins) {
      q.push("allday=true");
      q.push(`startdt=${dateStamp(ymd).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`);
      q.push(
        `enddt=${dateStamp(ymd, 1).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`,
      );
    } else {
      const sUtc = wallToUtcMs(ymd, mins.s, tz);
      const eUtc = wallToUtcMs(ymd, mins.e, tz);
      const sLocal = floatStamp(ymd, mins.s);
      const eLocal = floatStamp(ymd, mins.e);
      const toIsoLocal = (s: string) =>
        `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00`;
      q.push(
        `startdt=${encodeURIComponent(sUtc !== null ? isoStamp(sUtc) : toIsoLocal(sLocal))}`,
      );
      q.push(
        `enddt=${encodeURIComponent(eUtc !== null ? isoStamp(eUtc) : toIsoLocal(eLocal))}`,
      );
    }
    outlookCalUrl = `https://outlook.live.com/calendar/0/deeplink/compose?${q.join("&")}`;
  }

  const timeLine = v.start ? `${v.start}${v.end ? ` – ${v.end}` : ""}` : "";
  const whenTop = ymd ? longDate(ymd) : v.whenLine;

  // Status is stated ONCE, here, as the line that runs into the title. No
  // badge, no rail flag, no second copy inside the ticket.
  const eyebrow = isWait ? "You're on the waitlist for" : "Your spot is held for";
  // The second clause promises a code, so it is printed only when there is one.
  // Every route to the code hangs off the same signed token in convex/email.ts,
  // which hangs off UNSUB_SECRET, so all three vanish together: with the secret
  // unset this sentence sat at the top of a message that had nothing to check
  // anyone in with, and the door person is the one who finds out.
  const lead = isWait
    ? `We hit capacity${first ? `, ${first}` : ""}, so you're on the waitlist. Spots open up more often than you'd think, and the first email out goes to you.`
    : `You're in${first ? `, ${first}` : ""}. Your name is on the door list${codeUrl ? ", and this email is what we check you in with" : ""}.`;

  // THE INBOX ROW IS ONE LINE. Subject and preheader are read together, in that
  // order, before anything else in the message, so rule B — every fact stated
  // once — spans BOTH of them and not just the body. The subject carries
  // status, event and date; the preheader carries only what the subject could
  // not fit, the clock and the place. Neither one restates the other.
  const subjectDate = ymd ? ` · ${shortDate(ymd)}` : "";
  // The subject is a header, not HTML: collapse any newline an admin managed to
  // save into a title so it can never split the header.
  const subject = (
    isWait
      ? `You're on the waitlist · ${v.eventTitle}${subjectDate}`
      : `You're in · ${v.eventTitle}${subjectDate}`
  ).replace(/[\r\n]+/g, " ");

  const preheader =
    [
      // The date appears here ONLY when the subject had no parseable one to
      // carry, so the two can never print the same string side by side.
      ymd ? "" : v.whenLine,
      timeLine,
      whereTop,
    ]
      .filter(Boolean)
      .join(" · ") ||
    // An event with no date, no clock and a location too short to redact leaves
    // nothing to preview; the opening sentence beats an empty preview pane.
    lead;

  // --- the note from the host ------------------------------------------------
  // The only block in the message written TO the guest by a person rather than
  // ABOUT the guest by a system, and the reason the message reads as an
  // invitation. It is set apart in its own bordered box, directly under the
  // opening line and above everything transactional, which is where the real
  // article puts the host's own words. `hostNote` replaces the copy when a
  // caller has one; the fallback is still a sentence somebody would say out
  // loud, and it is signed.
  // Nothing in the product supplies `hostNote` yet: there is no events column
  // and no back-office field for it, so in production this box always renders
  // the fallback. A fallback signed "THE CREW AT ..." claims to be a person's
  // words and is byte-identical on every send, which a guest attending twice
  // reads as a form letter — worse than no note at all. So the signature is
  // attached ONLY to a real note. House copy stays unsigned and honest.
  // The box carries a HOST's words or it does not appear. There is no events
  // column and no back-office field for `hostNote` yet, so the old fallbacks
  // ("the first beat drops", "the coffee is usually still hot") were invented
  // atmosphere the venue never promised, identical on every send, and telling
  // a guest nothing the message does not already say. An empty box beats a
  // fabricated one, so the whole block is omitted when there is no real note.
  const noteBody = (v.hostNote || "").trim();
  const noteSignature = noteBody ? `THE CREW AT ${HOST}` : "";

  const acts = (v.featured ?? []).filter((f) => f && f.name).slice(0, 6);

  // --- ticket rows -----------------------------------------------------------
  const rows: string[] = [];
  rows.push(
    ticketRow(
      "WHEN",
      `<span style="font-size:17px;font-weight:700;color:${BRAND.text};">${esc(whenTop)}</span>` +
        (timeLine ? `<br>${esc(timeLine)}` : ""),
      true,
    ),
  );
  // The address is typeset, not linked: "Get directions" is always present as a
  // button below, and carrying the same label twice inside 300px read as a bug.
  const whereValue =
    (whereTop
      ? `<span style="font-size:15px;font-weight:700;color:${BRAND.text};">${esc(whereTop)}</span>`
      : "") +
    (whereRest ? `${whereTop ? "<br>" : ""}${esc(whereRest)}` : "") +
    (whereNote
      ? `${whereTop || whereRest ? "<br>" : ""}<span class="mg-quiet" style="color:${BRAND.textMuted};">${esc(whereNote)}</span>`
      : "");
  rows.push(ticketRow("WHERE", whereValue));
  // Party size only. Status lives in the eyebrow above the title and nowhere
  // else, so this row is not a second place to read it.
  rows.push(
    ticketRow(
      "YOUR PARTY",
      `<span style="font-size:15px;font-weight:700;color:${BRAND.text};">${esc(partyLine)}</span>`,
    ),
  );
  // Parking is where-to-leave-the-car detail for someone who has a place to go.
  // A waitlisted guest does not yet, so it is held back until they do.
  if (v.parking && !isWait) rows.push(ticketRow("PARKING", esc(v.parking)));
  // Good-to-know survives on the waitlist: "21+, bring ID" still governs
  // whether they can come at all if a spot opens.
  if (v.notes) rows.push(ticketRow("GOOD TO KNOW", esc(v.notes)));

  // --- the door code block ---------------------------------------------------
  // `qrImgUrl` and `codeUrl` are resolved up with the other href guards, above
  // the opening line of the message, because that line makes a promise about
  // them. See the comment there for why the code has two routes out of here.
  //
  // A waitlisted guest's code is LIVE, and saying otherwise strands them. An
  // earlier draft of this line read "It starts working the moment a spot
  // opens", which is false three times over: convex/wallet/qr.ts refuses only
  // a cancelled RSVP and renders a real PNG for a waitlisted one, checkIn in
  // convex/rsvps.ts accepts that scan and records it as `waitlist_in`, and the
  // door is deliberately built to admit a waitlist walk-up and flag them as
  // one. A guest who reads "later" does not screenshot it and turns up at a
  // door that would have scanned them in. The code being valid is not the same
  // as a place being free, and that is the distinction the sentence has to
  // carry. rsvp.html already says it correctly in two places, so this is the
  // same words rather than a second attempt at them.
  const codeWaitNote = "It only gets you in if a spot opens.";
  // The save-it-now line. One sentence, and it claims nothing about this venue's
  // reception that could turn out to be false; it just refuses to bet on it.
  const codeSaveNote =
    "Screenshot it before you leave. Signal at the door is not a given.";
  // What to do when the screen is cracked, the battery is flat, or the scanner
  // simply refuses. Without it neither the guest nor the person on the door has
  // a script for the one situation this whole block exists to survive, and the
  // guest is standing there while a queue builds behind them. rsvp.html says
  // the same thing when the image fails to load.
  const codeFailNote = "If it will not scan, give your name at the door.";
  // The QR carries a WIDTH and no HEIGHT, the same way the poster does. With
  // both set, a client holding images back reserves the full 180x180 square and
  // draws the alt text inside an empty white hole, which reads as a broken
  // image at the exact moment the block is asking to be trusted. Width alone
  // lets a blocked image collapse to its alt line, and a loaded one still
  // scales by aspect because the code is square.
  const codeBlock = codeUrl
    ? `
        <table role="presentation" class="mg-field" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.white}" style="width:100%;margin-top:14px;background-color:${BRAND.white};border:2px solid ${BRAND.surfaceLine};">
          <tr><td align="center" style="padding:18px 18px 20px 18px;">
            <div class="mg-quiet" style="font-family:${MONO};font-size:11px;line-height:15px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${BRAND.textMuted};">YOUR DOOR CODE</div>${
              qrImgUrl
                ? `
            <img src="${esc(qrImgUrl)}" width="180" alt="Your door code. The button below opens it." style="display:block;margin:14px auto 0 auto;width:180px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;background-color:${BRAND.white};font-family:${MONO};font-size:12px;line-height:18px;color:${BRAND.textSoft};text-align:center;">`
                : ""
            }
            <div class="mg-soft" style="margin-top:14px;font-family:${MONO};font-size:13px;line-height:19px;mso-line-height-rule:exactly;color:${BRAND.textSoft};">${esc(codeSaveNote)}${isWait ? ` ${esc(codeWaitNote)}` : ""}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
              <tr><td style="padding:14px 0 0 0;">${button(codeUrl, "OPEN YOUR CODE", false)}</td></tr>
            </table>${
              qrImgUrl && qrImgUrl !== codeUrl
                ? `
            <div class="mg-quiet" style="margin-top:12px;font-family:${MONO};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:.12em;text-transform:uppercase;color:${BRAND.textMuted};">OR OPEN <a href="${esc(qrImgUrl)}" target="_blank" rel="noopener" class="mg-accent" style="color:${BRAND.brandInk};font-weight:700;text-decoration:none;">THE CODE AS AN IMAGE</a></div>`
                : ""
            }
            <div class="mg-quiet" style="margin-top:12px;font-family:${MONO};font-size:11px;line-height:16px;mso-line-height-rule:exactly;color:${BRAND.textMuted};">${esc(codeFailNote)}</div>
          </td></tr>
        </table>`
    : "";

  // --- featured lineup -------------------------------------------------------
  const lineupHtml = acts.length
    ? `<tr><td style="padding:34px 0 0 0;">${slab(
        acts.some((a) => a.kind === "company")
          ? "LINEUP &amp; PARTNERS"
          : "FEATURED LINEUP",
      )}</td></tr>
    <tr><td style="padding:18px 0 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        ${acts
          .map((a, i) => {
            const nameEsc = esc(a.name);
            const link = safeUrl(a.link);
            const nameHtml = link
              ? `<a href="${esc(link)}" target="_blank" rel="noopener" style="color:${BRAND.text};text-decoration:none;">${nameEsc}</a>`
              : nameEsc;
            const roleText =
              a.role ||
              (a.kind === "speaker"
                ? "Speaker"
                : a.kind === "company"
                  ? "Partner"
                  : "Artist");
            const img = safeUrl(a.imageUrl);
            const initial = escUp(a.name.trim().charAt(0));
            // Images are blocked by default in a lot of clients — a near
            // certainty on a first send from an unfamiliar sending domain — so
            // the fallback has to survive inside the <img> itself, not beside
            // it. The image carries the initial as its `alt` AND carries the
            // display-face type styles, so a blocked image renders as the same
            // bordered white square with the same red initial in it. The
            // surrounding cell keeps its border and fill either way.
            //
            // object-fit is progressive: Apple Mail and most webmail crop with
            // it, the rest scale to the square. Headshots should be uploaded
            // square; nothing in HTML email can crop for them.
            const thumbInner = img
              ? `<img src="${esc(img)}" width="52" height="52" alt="${initial}" style="display:block;width:52px;height:52px;border:0;background-color:${BRAND.white};object-fit:cover;font-family:${DISPLAY};font-size:26px;line-height:52px;color:${BRAND.brandInk};text-align:center;">`
              : initial;
            return `<tr>
          <td width="56" valign="top" style="width:56px;padding:${i ? "14px" : "0"} 0 0 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="56" style="width:56px;">
              <tr><td class="mg-field mg-accent" align="center" valign="middle" width="52" height="52" bgcolor="${BRAND.white}" style="width:52px;height:52px;background-color:${BRAND.white};border:2px solid ${BRAND.surfaceLine};font-family:${DISPLAY};font-size:26px;line-height:52px;mso-line-height-rule:exactly;color:${BRAND.brandInk};text-align:center;">${thumbInner}</td></tr>
            </table>
          </td>
          <td width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
          <td valign="middle" style="padding:${i ? "14px" : "0"} 0 0 0;font-family:${MONO};">
            <div class="mg-ink" style="font-size:15px;font-weight:700;color:${BRAND.text};line-height:1.3;overflow-wrap:break-word;word-break:break-word;">${nameHtml}</div>
            <div class="mg-accent" style="margin-top:4px;font-size:11px;line-height:15px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.brandInk};">${escUp(roleText)}</div>${
              (a.bio || "").trim()
                ? `
            <div class="mg-soft" style="margin-top:7px;font-size:13px;line-height:19px;mso-line-height-rule:exactly;color:${BRAND.textSoft};overflow-wrap:break-word;word-break:break-word;">${esc((a.bio || "").trim())}</div>`
                : ""
            }
          </td>
        </tr>`;
          })
          .join("")}
      </table>
    </td></tr>`
    : "";

  // --- actions ---------------------------------------------------------------
  // One ranked list, first entry filled. Built rather than hard-coded so the
  // message always has exactly one primary action: an event with no invite link
  // and no parseable date used to fall through to a lone ghost button.
  //
  // CALENDAR: the button points at the hosted .ics when there is one, because
  // a `text/calendar` file opens in Apple Calendar, Outlook, Fastmail and
  // Proton with one tap, while `calendar.google.com` puts a sign-in wall in
  // front of everyone who does not use Google. The Google and Outlook web
  // links stay on as a quiet alternates line underneath, so all three
  // ecosystems are one tap away no matter which is primary.
  const calPrimary = icsUrl || googleCalUrl;
  const calLabel = isWait ? "HOLD THE DATE" : "ADD TO CALENDAR";
  // `ownRow: true` marks an entry that ALREADY has its own row further down the
  // HTML. It is in this list for the plain-text half only, and the button block
  // below filters it out. See the wallet and manage pushes for what that
  // prevents.
  const actions: { href: string; label: string; ownRow?: boolean }[] = [];
  if (eventUrl) {
    actions.push({
      href: eventUrl,
      label: isWait ? "VIEW THE EVENT" : "VIEW YOUR INVITE",
    });
  }
  if (calPrimary) actions.push({ href: calPrimary, label: calLabel });
  // Directions belong to someone who has a spot. A waitlisted guest is not
  // told to drive to an address they have not been given.
  if (!isWait && mapUrl) actions.push({ href: mapUrl, label: "GET DIRECTIONS" });
  if (!actions.length && mapUrl)
    actions.push({ href: mapUrl, label: "GET DIRECTIONS" });
  // The buttons stop here. Everything above is a real button in the HTML;
  // everything below is already rendered as its own row further down and is
  // added ONLY so the plain-text alternative offers a guest the same things.
  //
  // These are two lists rather than one because they used to be one, and it
  // printed the Apple Wallet button twice to every waitlisted guest. The
  // button block renders `rest[0]` and `rest[1]` whatever they are, so as long
  // as the wallet entry sat in the same array it just needed the slots ahead of
  // it to be empty to slide into view: a waitlisted guest never gets GET
  // DIRECTIONS, because the address is redacted for them, so the wallet took
  // that slot and then rendered again in its own row underneath. A confirmed
  // guest with a map link never showed it, which is why it survived. Splitting
  // the lists is what makes the button block structurally unable to render a
  // row that has its own place in the layout.
  const textActions = actions.slice();
  // The phone is named in the label, not just in the HTML, because this line is
  // the whole of what a plain-text reader is told about the pass.
  if (v.walletUrl)
    textActions.push({ href: v.walletUrl, label: "ADD TO APPLE WALLET (IPHONE)" });
  if (v.manageUrl)
    textActions.push({ href: v.manageUrl, label: "CHANGE OR CANCEL YOUR RSVP" });

  // An event with no invite link, no date and no linkable venue has nothing to
  // point at; the block collapses rather than rendering an empty button.
  const [lead1, ...rest] = actions;
  const primary = lead1
    ? `<tr><td style="padding:26px 0 0 0;">${button(lead1.href, lead1.label, true)}</td></tr>`
    : "";
  const ghosts =
    rest.length === 0
      ? ""
      : rest.length === 1
        ? `<tr><td style="padding:12px 0 0 0;">${button(rest[0].href, rest[0].label, false)}</td></tr>`
        : `<tr><td style="padding:12px 0 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr>
          <td width="48%" valign="top" style="width:48%;">${button(rest[0].href, rest[0].label, false)}</td>
          <td width="4%" style="width:4%;font-size:0;line-height:0;">&nbsp;</td>
          <td width="48%" valign="top" style="width:48%;">${button(rest[1].href, rest[1].label, false)}</td>
        </tr>
      </table>
    </td></tr>`;

  // Whichever calendars are NOT the primary button, offered quietly.
  const calAlts: { href: string; label: string }[] = [];
  if (googleCalUrl && calPrimary !== googleCalUrl)
    calAlts.push({ href: googleCalUrl, label: "GOOGLE" });
  if (outlookCalUrl) calAlts.push({ href: outlookCalUrl, label: "OUTLOOK" });
  // Add to Apple Wallet, offered under the calendar row. Deliberately not the
  // primary button: on Android and desktop it is a dead end, so it sits as a
  // secondary the way "also add it to" does.
  //
  // Two things changed when the door code above it arrived. The label is now
  // uppercase in source, because rule 1 in the header applies to this button
  // too and it had been reading "Add to Apple Wallet" in Outlook while every
  // other button in the message shouted. And the line under it names the phone
  // the button is for: a guest holding an Android should not have to work out
  // on their own that the one scannable-looking thing in the email was aimed at
  // somebody else. It is only printed when there IS a code above to send them
  // to, so the sentence can never point at a block that did not render.
  const walletLine = v.walletUrl
    ? `<tr><td style="padding:14px 0 0 0;text-align:center;">
         <a href="${esc(v.walletUrl)}" target="_blank" rel="noopener" style="display:inline-block;border:2px solid ${BRAND.text};background:${BRAND.text};color:${BRAND.white};text-decoration:none;font-family:${MONO};font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;padding:12px 22px;">ADD TO APPLE WALLET</a>${
           codeUrl
             ? `
         <div class="mg-quiet" style="margin-top:10px;font-family:${MONO};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:.12em;text-transform:uppercase;color:${BRAND.textMuted};">IPHONE ONLY. THE CODE ABOVE WORKS ON ANY PHONE.</div>`
             : ""
         }
       </td></tr>`
    : "";

  // The way out. A guest whose plans change has to be able to say so, or the
  // door list is fiction by the time the event runs.
  const manageLine = v.manageUrl
    ? `<tr><td style="padding:12px 0 0 0;text-align:center;font-family:${MONO};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:.12em;text-transform:uppercase;color:${BRAND.textMuted};" class="mg-quiet">CAN'T MAKE IT? <a href="${esc(v.manageUrl)}" target="_blank" rel="noopener" class="mg-accent" style="color:${BRAND.brandInk};font-weight:700;text-decoration:none;">CHANGE OR CANCEL</a></td></tr>`
    : "";

  const calAltLine = calAlts.length
    ? `<tr><td style="padding:12px 0 0 0;text-align:center;font-family:${MONO};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:.12em;text-transform:uppercase;color:${BRAND.textMuted};" class="mg-quiet">ALSO ADD IT TO ${calAlts
        .map(
          (c) =>
            `<a href="${esc(c.href)}" target="_blank" rel="noopener" class="mg-accent" style="color:${BRAND.brandInk};font-weight:700;text-decoration:none;">${c.label}</a>`,
        )
        .join(" &middot; ")}</td></tr>`
    : "";

  // --- poster ----------------------------------------------------------------
  // The event's own artwork, full bleed inside the 544px content column, square
  // corners, no frame, no shadow. Sized by the width attribute so Outlook scales
  // the height itself; `alt` is the event title in the display face, so a client
  // with images off shows the title where the flyer would be rather than a gap.
  const posterHtml = posterUrl
    ? `  <tr><td class="mg-pad mg-band" bgcolor="${BRAND.white}" style="background-color:${BRAND.white};padding:0 28px 26px 28px;">
    <img src="${esc(posterUrl)}" width="${POSTER_WIDTH}" alt="${escUp(v.eventTitle)}" style="display:block;width:100%;max-width:${POSTER_WIDTH}px;height:auto;border:0;outline:none;text-decoration:none;background-color:${BRAND.surface};font-family:${DISPLAY};font-size:22px;line-height:26px;letter-spacing:.01em;color:${BRAND.brandInk};text-align:center;">
  </td></tr>
`
    : "";

  // The rail is letterhead: who is throwing it, and when. Never the status,
  // and never a string the panel below repeats verbatim.
  const railLeft = ymd ? railDate(ymd) : HOST;
  const railRight = ymd ? HOST : "";

  const html = `<!doctype html>
<html lang="en" style="margin:0;padding:0;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="x-ua-compatible" content="ie=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<!-- iOS turns dates, addresses and phone-shaped strings into blue underlined
     links on its own. The WHEN and WHERE rows are exactly that, so detection is
     switched off here and neutralised in CSS below for the clients that ignore
     the meta. -->
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<title>${esc(subject)}</title>
<style>
  /* Progressive only: every rule below is already inlined on the element.
     Clients that strip this block lose nothing but the mobile tightening. */
  body{margin:0!important;padding:0!important;width:100%!important;}
  img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
  table{border-collapse:collapse;}
  a{color:${BRAND.brandInk};}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important;}
  /* 599 rather than 600 so a client that renders the table at its full 600px
     still gets the desktop treatment; phones sit well below this. */
  @media only screen and (max-width:599px){
    .mg-container{width:100%!important;}
    .mg-pad{padding-left:18px!important;padding-right:18px!important;}
    .mg-inner{padding-left:18px!important;padding-right:18px!important;}
    /* px line-heights, never multipliers: see rule 3 in the header comment. */
    .mg-masthead{font-size:24px!important;line-height:23px!important;}
    .mg-tagline{font-size:10px!important;letter-spacing:.2em!important;}
    .mg-eyebrow{font-size:10px!important;letter-spacing:.16em!important;}
    .mg-title{font-size:38px!important;line-height:36px!important;}
    .mg-subtitle{font-size:18px!important;line-height:19px!important;}
    .mg-slab{font-size:11px!important;letter-spacing:.14em!important;}
    /* tracking is what makes a button label too wide for half a phone column */
    .mg-btn{letter-spacing:.12em!important;}
    /* same treatment brand.css gives the footer row under 640px */
    .mg-foot{font-size:10px!important;letter-spacing:.12em!important;}
  }
  /* The narrow end of the real world: iPhone SE, and every desktop client
     whose reading pane has been dragged in. Nothing here may be nowrap. */
  @media only screen and (max-width:359px){
    .mg-title{font-size:32px!important;line-height:30px!important;}
    .mg-btn{font-size:10px!important;letter-spacing:.08em!important;}
    .mg-foot{letter-spacing:.06em!important;}
  }
  /* Dark mode: keep the brand's own light panel instead of letting a client
     invert the surface and leave dark ink on a dark ground. Each selector
     names one element on purpose — a descendant selector like ".mg-surface td"
     would also repaint the red button sitting inside it. */
  @media (prefers-color-scheme:dark){
    .mg-band{background-color:${BRAND.white}!important;}
    .mg-surface{background-color:${BRAND.surface}!important;}
    .mg-field{background-color:${BRAND.white}!important;}
    .mg-brandink{background-color:${BRAND.brandInk}!important;color:${BRAND.white}!important;}
    .mg-ink{color:${BRAND.text}!important;}
    .mg-soft{color:${BRAND.textSoft}!important;}
    .mg-quiet{color:${BRAND.textMuted}!important;}
    .mg-accent{color:${BRAND.brandInk}!important;}
    .mg-onbrand{color:${BRAND.white}!important;}
  }
  [data-ogsc] .mg-band{background-color:${BRAND.white}!important;}
  [data-ogsc] .mg-surface{background-color:${BRAND.surface}!important;}
  [data-ogsc] .mg-field{background-color:${BRAND.white}!important;}
  [data-ogsc] .mg-brandink{background-color:${BRAND.brandInk}!important;color:${BRAND.white}!important;}
  [data-ogsc] .mg-ink{color:${BRAND.text}!important;}
  [data-ogsc] .mg-soft{color:${BRAND.textSoft}!important;}
  [data-ogsc] .mg-quiet{color:${BRAND.textMuted}!important;}
  [data-ogsc] .mg-accent{color:${BRAND.brandInk}!important;}
  [data-ogsc] .mg-onbrand{color:${BRAND.white}!important;}
</style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bg};" bgcolor="${BRAND.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}</div>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.bg}" style="width:100%;background-color:${BRAND.bg};">
<tr><td align="center" style="padding:0;">

<table role="presentation" class="mg-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <!-- ============ DARK RAIL ============ -->
  <tr><td class="mg-pad" bgcolor="${BRAND.bg}" style="background-color:${BRAND.bg};padding:30px 28px 0 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      <tr>
        <td align="left" style="font-family:${MONO};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:${BRAND.ink};">${escUp(railLeft)}</td>
        <td align="right" style="font-family:${MONO};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:${BRAND.muted};">${escUp(railRight)}</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      <tr><td height="18" style="height:18px;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td height="2" bgcolor="${BRAND.line}" style="height:2px;background-color:${BRAND.line};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
  </td></tr>

  <!-- ============ MASTHEAD ============
       Deliberately small. The wordmark is letterhead; the event title in the
       panel below is the headline and is set roughly twice this size. -->
  <tr><td class="mg-pad" bgcolor="${BRAND.bg}" style="background-color:${BRAND.bg};padding:22px 28px 26px 28px;">
    <div class="mg-masthead" style="font-family:${DISPLAY};font-size:30px;line-height:28px;mso-line-height-rule:exactly;letter-spacing:.005em;text-transform:uppercase;color:${BRAND.brand};overflow-wrap:break-word;word-break:break-word;">MIX<span style="color:${BRAND.ink};">&amp;</span>GREET</div>
    <div class="mg-tagline" style="margin-top:9px;font-family:${MONO};font-size:11px;line-height:15px;mso-line-height-rule:exactly;font-weight:500;letter-spacing:.3em;text-transform:uppercase;color:${BRAND.muted};">WHERE CREATIVES CONNECT</div>
  </td></tr>

  <!-- ============ LED METER (site signature) ============ -->
  <tr><td class="mg-pad mg-band" bgcolor="${BRAND.white}" style="background-color:${BRAND.white};padding:26px 28px ${posterUrl ? "22px" : "24px"} 28px;">
    ${meterHtml(safeUrl(v.meterUrl))}
  </td></tr>

${posterHtml}  <!-- ============ LIGHT PANEL ============ -->
  <tr><td class="mg-pad mg-band" bgcolor="${BRAND.white}" style="background-color:${BRAND.white};padding:0 28px 8px 28px;">
    <table role="presentation" class="mg-surface" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.surface}" style="width:100%;background-color:${BRAND.surface};border:2px solid ${BRAND.surfaceLine};">
      <tr><td style="padding:0;font-size:0;line-height:0;">
        ${panelTopBar(isWait)}
      </td></tr>
      <tr><td class="mg-inner" style="padding:28px 24px 30px 24px;">

        <!-- The one statement of status, written as the line that runs into
             the event name. Red when the spot is held, grey when it is not. -->
        <div class="mg-eyebrow ${isWait ? "mg-quiet" : "mg-accent"}" style="font-family:${MONO};font-size:11px;line-height:15px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:${isWait ? BRAND.textMuted : BRAND.brandInk};">${escUp(eyebrow)}</div>

        <!-- the event, as the headline -->
        <div class="mg-title mg-accent" style="margin-top:10px;font-family:${DISPLAY};font-size:54px;line-height:50px;mso-line-height-rule:exactly;letter-spacing:.01em;text-transform:uppercase;color:${BRAND.brandInk};overflow-wrap:break-word;word-break:break-word;">${titleHtml}</div>
        ${
          v.subtitle
            ? `<div class="mg-subtitle mg-ink" style="margin-top:6px;font-family:${DISPLAY};font-size:22px;line-height:23px;mso-line-height-rule:exactly;text-transform:uppercase;color:${BRAND.text};overflow-wrap:break-word;word-break:break-word;">${escUp(v.subtitle)}</div>`
            : ""
        }

        <p class="mg-soft" style="margin:18px 0 0 0;font-family:${MONO};font-size:14px;line-height:1.7;color:${BRAND.textSoft};">${esc(lead)}</p>

        <!-- the note from the host: a person's words, in their own box, above
             anything transactional. Omitted entirely without one, rather than
             printing an empty bordered box. -->
        ${
          noteBody
            ? `
        <table role="presentation" class="mg-field" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.white}" style="width:100%;margin-top:22px;background-color:${BRAND.white};border:2px solid ${BRAND.surfaceLine};">
          <tr><td style="padding:18px 18px 16px 18px;">
            <p class="mg-soft" style="margin:0;font-family:${MONO};font-size:14px;line-height:1.7;color:${BRAND.textSoft};">${esc(noteBody)}</p>
            <div class="mg-quiet" style="margin-top:12px;font-family:${MONO};font-size:11px;line-height:15px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${BRAND.textMuted};">${escUp(noteSignature)}</div>
          </td></tr>
        </table>`
            : ""
        }

        <!-- the ticket: what a confirmation owes a guest at the door -->
        <table role="presentation" class="mg-field" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.white}" style="width:100%;margin-top:24px;background-color:${BRAND.white};border:2px solid ${BRAND.surfaceLine};">
          ${rows.join("")}
        </table>
        <!-- the ticket stub: the code that gets scanned. It sits with the
             ticket rather than with the actions because it is not something to
             do later, it is the thing the guest hands over on arrival. -->${codeBlock}

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
          ${primary}
          ${ghosts}
          ${calAltLine}${walletLine}${manageLine}
          ${lineupHtml}
        </table>

        <p class="mg-quiet" style="margin:28px 0 0 0;padding-top:18px;border-top:2px solid ${BRAND.surfaceLine};font-family:${MONO};font-size:12px;line-height:1.7;color:${BRAND.textMuted};">Plans change. If yours do, reply to this email and we'll update your spot.</p>

      </td></tr>
    </table>
  </td></tr>

  <!-- ============ DARK FOOTER ============ -->
  <tr><td class="mg-pad mg-band" bgcolor="${BRAND.white}" style="background-color:${BRAND.white};padding:0 28px 34px 28px;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td class="mg-pad" bgcolor="${BRAND.bg}" style="background-color:${BRAND.bg};padding:34px 28px 44px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      <tr><td height="4" bgcolor="${BRAND.line}" style="height:4px;background-color:${BRAND.line};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      <tr>
        <td class="mg-foot" align="left" valign="top" style="padding:22px 8px 22px 0;font-family:${MONO};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:500;letter-spacing:.16em;color:${BRAND.ink};">BEAT LAB &middot; ACADEMIX</td>
        <td class="mg-foot" align="right" valign="top" style="padding:22px 0 22px 8px;font-family:${MONO};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:500;letter-spacing:.16em;color:${BRAND.ink};">INVITE ONLY &middot; MUST RSVP</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      <tr><td height="4" bgcolor="${BRAND.line}" style="height:4px;background-color:${BRAND.line};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
    <p style="margin:20px 0 0 0;font-family:${MONO};font-size:11px;line-height:1.8;letter-spacing:.06em;color:${BRAND.muted};text-align:center;overflow-wrap:break-word;word-break:break-word;">
      You're receiving this because you RSVP'd to ${title}.<br>
      Academix BEAT Lab &middot; ${esc(footerAddress)}${
        unsubUrl
          ? `<br><a href="${esc(unsubUrl)}" style="color:${BRAND.ink};text-decoration:underline;">Unsubscribe</a>`
          : ""
      }
    </p>
  </td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;

  // --- plain text: stands on its own -----------------------------------------
  // null marks an absent optional line and is dropped; "" is a deliberate blank
  // line and is kept, so the text version keeps its paragraph rhythm.
  const rule = "=".repeat(52);
  const textLines: (string | null)[] = [
    HOST,
    "MIX & GREET · WHERE CREATIVES CONNECT",
    rule,
    "",
    eyebrow.toUpperCase(),
    v.eventTitle.toUpperCase() + (v.subtitle ? ` · ${v.subtitle.toUpperCase()}` : ""),
    "",
    lead,
    "",
    // The bordered note box, as a quoted block: the text alternative has to
    // carry the human line too, or the two formats disagree about who is
    // speaking.
    ...(noteBody
      ? [quoteBlock(noteBody), noteSignature ? `| ${noteSignature}` : "", ""]
      : []),
    `WHEN   ${whenTop}${timeLine ? `\n       ${timeLine}` : ""}`,
    // The waitlist variant withholds street and suite here exactly as the
    // HTML does; the two formats must never disagree about what a guest is
    // allowed to know yet.
    `WHERE  ${[whereTop, whereRest].filter(Boolean).join("\n       ") || "To be shared"}${whereNote ? `\n       ${whereNote}` : ""}`,
    // The map link is an action, so it tracks the button set: a waitlisted
    // guest is not sent driving directions in either format.
    isWait ? null : `       Directions: ${mapUrl}`,
    `PARTY  ${partyLine}`,
    v.parking && !isWait ? `PARK   ${v.parking}` : null,
    v.notes ? `NOTE   ${v.notes}` : null,
    // The door code, in the half of the message a screen reader and a
    // stripped-down client actually read. It sits with the ticket facts rather
    // than down in the list of actions because it is the one line here a guest
    // cannot get through the door without, and a url is the only form of it
    // that survives with images off. Same address the HTML button points at,
    // with the bare PNG under it for a reader that cannot follow a page.
    codeUrl ? `CODE   ${codeUrl}` : null,
    codeUrl && qrImgUrl && qrImgUrl !== codeUrl
      ? `       The code as an image: ${qrImgUrl}`
      : null,
    codeUrl ? `       ${codeSaveNote}` : null,
    codeUrl && isWait ? `       ${codeWaitNote}` : null,
    // The fallback belongs here more than anywhere: this is the half a screen
    // reader speaks and the half a stripped-down client shows, so a guest whose
    // client could not draw the code is likelier to be reading THIS one when
    // the scan fails.
    codeUrl ? `       ${codeFailNote}` : null,
    "",
    ...textActions.map((a) => `${a.label}: ${a.href}`),
    ...calAlts.map((c) => `${calLabel} (${c.label}): ${c.href}`),
  ];

  if (acts.length) {
    textLines.push(
      "",
      acts.some((a) => a.kind === "company")
        ? "LINEUP & PARTNERS"
        : "FEATURED LINEUP",
      "-".repeat(52),
    );
    for (const a of acts) {
      const role =
        a.role ||
        (a.kind === "speaker"
          ? "Speaker"
          : a.kind === "company"
            ? "Partner"
            : "Artist");
      // Wrap the bio so the text alternative stays readable in a client that
      // does not soft-wrap; the HTML half already carries it under the role.
      const bioLines = (a.bio || "").trim()
        ? "\n" +
          (a.bio || "")
            .trim()
            .replace(/\s+/g, " ")
            .replace(/(.{1,66})(\s|$)/g, (_m, chunk) => `  ${chunk.trim()}\n`)
            .replace(/\n$/, "")
        : "";
      textLines.push(
        `· ${a.name} · ${role}${bioLines}${safeUrl(a.link) ? `\n  ${safeUrl(a.link)}` : ""}`,
      );
    }
  }

  textLines.push(
    "",
    "Plans change. If yours do, reply to this email and we'll update your spot.",
    "",
    rule,
    `You're receiving this because you RSVP'd to ${v.eventTitle}.`,
    `Academix BEAT Lab · ${footerAddress}`,
    unsubUrl ? `Unsubscribe: ${unsubUrl}` : null,
  );

  const text = textLines
    .filter((l): l is string => l !== null)
    .join("\n")
    // A whole optional block dropping out can leave a double gap.
    .replace(/\n{3,}/g, "\n\n");

  return { subject, html, text };
}
