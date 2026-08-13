import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Mix & Greet backend schema (Phase 0 foundation).
// Convex adds _id and _creationTime to every table automatically, so we only
// keep explicit createdAt fields where a legacy ISO value must be preserved.
export default defineSchema({
  // Events. Superset of the current Netlify Blobs record so migration is lossless.
  events: defineTable({
    legacyId: v.optional(v.string()), // crypto.randomUUID() from the Blobs era
    // Short, URL-safe public key for the hosted invite link. It is the whole
    // path segment a guest sees: "mix-and-greet-vol-2-k7fq" ->
    // https://mixandgreet.com/i/mix-and-greet-vol-2-k7fq
    // Minted at creation and NEVER rewritten, not even on a retitle, so a link
    // already in circulation stays valid for the life of the event. Optional
    // because rows created before this field existed must keep validating; the
    // back office backfills them on first load and every read falls back to the
    // document id, so pre-slug links keep resolving too.
    slug: v.optional(v.string()),
    title: v.string(),
    subtitle: v.optional(v.string()),
    date: v.string(), // "YYYY-MM-DD" (keeps string-sort semantics)
    start: v.optional(v.string()),
    end: v.optional(v.string()),
    location: v.optional(v.string()),
    parking: v.optional(v.string()),
    notes: v.optional(v.string()),
    rsvpUrl: v.optional(v.string()), // current external (Canva) link
    rsvpMode: v.union(
      v.literal("external"), // button uses rsvpUrl (today's behavior)
      v.literal("hosted"), // button posts to /api/rsvp (future flip)
      v.literal("closed"),
    ),
    inviteOnly: v.boolean(),
    capacity: v.optional(v.number()),
    status: v.union(v.literal("published"), v.literal("archived")),
    legacyCreatedAt: v.optional(v.string()), // original ISO string, migration only

    // The event's flyer. Same Convex-file-storage pattern as featured[].imageId
    // below: the id is stored, and every read resolves it to a URL. This is what
    // makes an invite (and the confirmation email that follows it) look like
    // THIS party rather than like a template. Optional so pre-existing rows keep
    // validating and so an event without artwork simply omits the band.
    posterId: v.optional(v.id("_storage")),

    // Featured artists / speakers / companies shown on the event flyer.
    // Optional so pre-existing rows keep validating. Images live in Convex
    // file storage; imageId is resolved to a URL at read time.
    featured: v.optional(
      v.array(
        v.object({
          name: v.string(),
          kind: v.union(
            v.literal("artist"),
            v.literal("speaker"),
            v.literal("company"),
          ),
          role: v.optional(v.string()), // free text, e.g. "Headliner", "Panelist"
          imageId: v.optional(v.id("_storage")), // headshot or logo
          link: v.optional(v.string()),
          bio: v.optional(v.string()),
        }),
      ),
    ),
  })
    .index("by_status_and_date", ["status", "date"])
    .index("by_legacyId", ["legacyId"])
    .index("by_slug", ["slug"]),

  // RSVPs captured by our own hosted form (Phase 1).
  rsvps: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    email: v.string(), // normalized: trim + lowercase
    phone: v.optional(v.string()),
    guests: v.number(),
    status: v.union(
      v.literal("confirmed"),
      v.literal("waitlist"),
      v.literal("cancelled"),
      v.literal("checked_in"),
    ),
    source: v.union(
      v.literal("site"),
      v.literal("admin"),
      v.literal("import"),
      v.literal("canva"),
    ),
    notes: v.optional(v.string()),
    dedupeKey: v.string(), // `${eventId}:${email}`
    confirmationSentAt: v.optional(v.number()),
    // When the guest was scanned through the door. Optional so every existing
    // row keeps validating; its presence is what separates "said they'd come"
    // from "actually showed up".
    checkedInAt: v.optional(v.number()),
    // Which list the guest was on immediately before that scan. Checking in
    // overwrites `status`, so without this an undo has to guess, and guessing
    // "confirmed" quietly promoted a mis-scanned waitlist guest onto the
    // confirmed list, where every later capacity sum then counted a seat that
    // was never given. Only ever "confirmed" or "waitlist", because those are
    // the only statuses a check-in can be performed from. Optional: rows
    // scanned in before this field existed have nothing recorded, and rows that
    // are not currently checked in carry nothing at all.
    statusBeforeCheckIn: v.optional(
      v.union(v.literal("confirmed"), v.literal("waitlist")),
    ),
  })
    .index("by_event", ["eventId"])
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_email", ["email"]),

  // Contacts. RSVP emails upsert here; later the campaign audience.
  contacts: defineTable({
    name: v.optional(v.string()),
    email: v.string(), // normalized lowercase
    phone: v.optional(v.string()),
    tags: v.array(v.string()),
    emailStatus: v.union(
      v.literal("unverified"),
      v.literal("verified"),
      v.literal("bounced"),
      v.literal("suppressed"),
    ),
    source: v.union(
      v.literal("manual"),
      v.literal("rsvp"),
      v.literal("import"),
    ),
    updatedAt: v.number(),
  })
    .index("by_email", ["email"]),

  // One row per send attempt (transactional now, campaigns later).
  emailSends: defineTable({
    rsvpId: v.optional(v.id("rsvps")),
    contactId: v.optional(v.id("contacts")),
    toEmail: v.string(),
    kind: v.union(
      v.literal("rsvp_confirmation"),
      v.literal("reminder"),
      v.literal("campaign"),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("bounced"),
      v.literal("complained"),
      v.literal("failed"),
      v.literal("suppressed_skip"),
    ),
    dedupeKey: v.string(), // app-level, outlives Resend's 24h idempotency window
    componentEmailId: v.optional(v.string()), // id returned by resend.sendEmail (webhook correlation)
    providerMessageId: v.optional(v.string()), // Resend's own email id, from webhook events
    error: v.optional(v.string()),
    sentAt: v.optional(v.number()),
  })
    .index("by_toEmail", ["toEmail"])
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_componentEmailId", ["componentEmailId"])
    .index("by_providerMessageId", ["providerMessageId"]),

  // Global do-not-send, keyed by bare email so it blocks any contact/rsvp.
  suppressions: defineTable({
    email: v.string(), // lowercase
    reason: v.union(
      v.literal("unsubscribe"),
      v.literal("bounce"),
      v.literal("complaint"),
      v.literal("manual"),
    ),
    sourceSendId: v.optional(v.id("emailSends")),
  })
    .index("by_email", ["email"]),

  // Admin sessions: password is exchanged once for a short-lived token.
  adminSessions: defineTable({
    token: v.string(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"]),

  // Failed-login counters for /api/admin/login. One shared ADMIN_PASSWORD guards
  // every invite-link mutation and *.convex.site is a public origin, so without
  // this the login route is an unlimited guessing oracle.
  //
  // Two kinds of row, same shape, told apart by `key`:
  //   "ip:<x-forwarded-for>" — per-caller, the tight budget
  //   "global"               — every failure everywhere, the backstop, because
  //                            x-forwarded-for is spoofable and a spray across
  //                            forged values would never fill one client bucket
  // Rows are deleted on success and lazily pruned once their window lapses, so
  // the table stays proportional to attackers rather than to traffic.
  adminLoginAttempts: defineTable({
    key: v.string(),
    windowStart: v.number(), // ms epoch; the window this count belongs to
    failures: v.number(),
    lockedUntil: v.number(), // ms epoch; 0 when not locked
  })
    .index("by_key", ["key"]),

  // Request counters for the three public routes that cost something real:
  // /api/rsvp writes a row and schedules an email, /api/pass builds and signs a
  // 200 KB bundle in a Node action, /api/qr renders a PNG. None of them is
  // guessable-secret protected — an invite slug is printed in every link — so
  // without a ceiling the only limit on them is how fast somebody can loop.
  //
  // Same two-row shape as adminLoginAttempts, and for the same reason: a
  // per-caller budget keyed on x-forwarded-for, plus a global backstop, because
  // that header is the only caller identity a Convex httpAction can see and it
  // is trivially forged. Unlike the login table there is no lockout — the
  // window simply has to lapse — because these are things real guests do, and a
  // guest who reloads their code too eagerly should wait, not be banned.
  //
  //   "<route>:ip:<x-forwarded-for>" — per-caller
  //   "<route>:global"               — every caller summed
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(), // ms epoch; the window this count belongs to
    count: v.number(),
  })
    .index("by_key", ["key"]),
});
