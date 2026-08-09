import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Mix & Greet backend schema (Phase 0 foundation).
// Convex adds _id and _creationTime to every table automatically, so we only
// keep explicit createdAt fields where a legacy ISO value must be preserved.
export default defineSchema({
  // Events. Superset of the current Netlify Blobs record so migration is lossless.
  events: defineTable({
    legacyId: v.optional(v.string()), // crypto.randomUUID() from the Blobs era
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
    .index("by_legacyId", ["legacyId"]),

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
});
