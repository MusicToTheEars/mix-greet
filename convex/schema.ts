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

    // What this event is FOR, in the same vocabulary the brand questionnaire
    // uses ("DJ Products", "K-12 Educators", "Product Demonstration / Demo
    // Day"). It exists so a campaign about this event can propose an audience
    // instead of asking the operator to remember who would care.
    //
    // The same words on both sides is the whole mechanism, so these are picked
    // from the questionnaire's own option lists rather than typed free. Optional
    // because every existing event predates it and an untagged event simply
    // proposes nobody, which is a worse default than a wrong one.
    interestTags: v.optional(v.array(v.string())),

    // The event's flyer. Same Convex-file-storage pattern as featured[].imageId
    // below: the id is stored, and every read resolves it to a URL. This is what
    // makes an invite (and the confirmation email that follows it) look like
    // THIS party rather than like a template. Optional so pre-existing rows keep
    // validating and so an event without artwork simply omits the band.
    posterId: v.optional(v.id("_storage")),

    // The link-preview card for THIS event: a still from the header video with
    // a gradient over it and the event's own name, date and venue on top.
    //
    // Generated in the back office at save time and stored like any other
    // upload, rather than composed on the fly, because the thing that reads it
    // is a link-preview bot: iMessage, WhatsApp and Slack fetch the URL once,
    // never run JavaScript, and cache what they get. It has to already exist,
    // as a real PNG at a stable URL, before the first person pastes the link.
    //
    // Optional: pre-existing rows have none, and an event without one falls
    // back to the site-wide /social-card.jpg rather than previewing nothing.
    socialCardId: v.optional(v.id("_storage")),

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
    // Who the guest is, professionally, and who vouched for them. This is an
    // invite-only room, so these are the fields that make the door list useful
    // the morning after: who came, what they do, and which guest brought them.
    //
    // All optional, and that is deliberate rather than lax. Existing rows have
    // none of them and must keep validating, and a guest who leaves one blank
    // must still get in — an RSVP that fails because somebody did not want to
    // name their employer is an RSVP the room loses.
    company: v.optional(v.string()),
    creativeField: v.optional(v.string()),
    invitedBy: v.optional(v.string()),
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

  // Contacts. RSVP emails upsert here; brand interest upserts here; and this is
  // the audience a campaign is drawn from.
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

    // ---- CRM fields. All optional: every existing row predates them. ----

    // What this person does and where. `company` is the free-text answer they
    // actually gave; `companyId` is the account it was rolled up to. Both are
    // kept because the roll-up is a guess (see companies below) and the raw
    // answer is evidence for correcting it.
    title: v.optional(v.string()),
    company: v.optional(v.string()),
    companyId: v.optional(v.id("companies")),

    // Every option this person has ever ticked: goals, solutions, audience,
    // product categories, community impact. Stored as the labels themselves, on
    // the contact rather than only on the submission, because this is the field
    // a campaign is matched against and a campaign must not have to read every
    // brandInterests row to find out who cares about DJ products.
    //
    // A union, never a replacement: a brand that submits twice has said two
    // things about itself, not corrected itself.
    interests: v.optional(v.array(v.string())),

    // The last thing that happened involving this person, from any source: an
    // RSVP, a check-in, a form, a note, a send. Denormalised so the contact
    // list can sort by it without assembling every timeline first.
    lastActivityAt: v.optional(v.number()),

    // Where this contact is in the partnership conversation. Deliberately NOT
    // the brandInterests status, which is the triage state of one submission:
    // a company can have a reviewed submission and still be a live lead, and a
    // contact with no submission at all can be a lead.
    stage: v.optional(
      v.union(
        v.literal("none"),
        v.literal("lead"),
        v.literal("talking"),
        v.literal("proposal"),
        v.literal("won"),
        v.literal("lost"),
      ),
    ),
  })
    .index("by_email", ["email"])
    .index("by_company", ["companyId"])
    .index("by_stage", ["stage"])
    .index("by_lastActivity", ["lastActivityAt"]),

  // Companies. Three people from one brand are one account, and the thing that
  // decides whether to run an activation is the account, not the individual.
  //
  // Rolled up on write from two weak signals: the company name a person typed,
  // and the domain of their email. Both are guesses. A free-provider domain
  // (gmail, icloud) is never a company, and the operator can re-point any
  // contact by hand, which is why contacts keep their raw `company` string.
  companies: defineTable({
    name: v.string(),
    // Lowercased, no protocol, no www. The join key that actually works:
    // "Pioneer DJ" and "PioneerDJ North America" are one company if the mail
    // comes from the same domain.
    domain: v.optional(v.string()),
    website: v.optional(v.string()),
    notes: v.optional(v.string()),
    // A company is only ever created from something that happened, so this is
    // never a blank record waiting to be filled in.
    createdFrom: v.union(
      v.literal("brand_interest"),
      v.literal("rsvp"),
      v.literal("manual"),
    ),
    updatedAt: v.number(),
  })
    .index("by_domain", ["domain"])
    .index("by_name", ["name"]),

  // Operator notes, against whatever they are about. Polymorphic by subject
  // rather than one nullable column per table: the alternative is three foreign
  // keys of which two are always empty, and a fourth the day companies get
  // notes of their own.
  //
  // subjectId is a string, not a v.id, because a v.id is bound to ONE table and
  // this row points at three. Every read resolves it through the matching
  // ctx.db.get, so a stale id reads as a missing subject rather than a crash.
  crmNotes: defineTable({
    subjectType: v.union(
      v.literal("contact"),
      v.literal("company"),
      v.literal("brandInterest"),
    ),
    subjectId: v.string(),
    body: v.string(),
    // Free text, because there is no user table on this deployment: everyone
    // who reaches the back office holds the same password. Recording who typed
    // it is still worth more than recording nobody.
    author: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_subject", ["subjectType", "subjectId"]),

  // One row per send attempt (transactional now, campaigns later).
  emailSends: defineTable({
    rsvpId: v.optional(v.id("rsvps")),
    contactId: v.optional(v.id("contacts")),
    // Which campaign this send belongs to, if any. A campaign's recipient list
    // IS its rows in this table rather than a table of its own: the ledger
    // already carries delivery, bounce and complaint state from the webhook, and
    // a parallel list would immediately disagree with it about what happened.
    campaignId: v.optional(v.id("campaigns")),
    toEmail: v.string(),
    kind: v.union(
      v.literal("rsvp_confirmation"),
      v.literal("reminder"),
      v.literal("campaign"),
      // The operator's notification that a brand filled in /brand-interest.
      // Ledgered like every other send so a partnership lead that never
      // arrived can be told apart from one that was never submitted.
      v.literal("brand_interest"),
      // One operator, one recipient, typed in the back office. Ledgered like
      // everything else so a reply shows up on the contact's timeline next to
      // the thing it was replying to.
      v.literal("crm_reply"),
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

    // ---- engagement ----
    //
    // A separate axis from `status`, never folded into it. Status is the
    // delivery state machine (queued -> sent -> delivered -> bounced), and an
    // open is not a delivery state: a message can be delivered and never
    // opened, opened five times, or opened after a complaint. Writing "opened"
    // into status would destroy the one field that says whether the mail
    // actually arrived.
    //
    // First and last are both kept because they answer different questions:
    // first says whether this send worked, last says whether the thread is
    // still warm.
    openedAt: v.optional(v.number()),
    lastOpenedAt: v.optional(v.number()),
    openCount: v.optional(v.number()),
    clickedAt: v.optional(v.number()),
    lastClickedAt: v.optional(v.number()),
    clickCount: v.optional(v.number()),
  })
    .index("by_toEmail", ["toEmail"])
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_componentEmailId", ["componentEmailId"])
    .index("by_providerMessageId", ["providerMessageId"])
    .index("by_campaign", ["campaignId"]),

  // Campaigns: one authored message, sent to a matched slice of contacts.
  //
  // The audience is stored as the RULE, not as the resolved list. Two reasons:
  // a list frozen at draft time is wrong by the time it sends, and the rule is
  // the thing the operator actually reviews before pressing send. The resolved
  // list only exists twice, both times on purpose: once in the preview, and
  // once as the emailSends rows the send writes.
  campaigns: defineTable({
    name: v.string(),
    subject: v.string(),
    // What the operator typed. Plain text with blank lines between paragraphs;
    // the branded HTML is rendered from it at send time rather than stored, so
    // a template fix reaches drafts that have not gone out yet.
    body: v.string(),
    // The event this is about, when it is about one. Drives the WHEN/WHERE
    // block and the invite button in the rendered email, and seeds the
    // interest match from the event's own tags.
    eventId: v.optional(v.id("events")),

    audience: v.object({
      // Contact tags, e.g. "attendee", "brand-interest". Any match qualifies.
      tags: v.array(v.string()),
      // Interest labels straight off the questionnaire, e.g. "DJ Products".
      // Any match qualifies. This is the "custom matching" half.
      interests: v.array(v.string()),
      stages: v.array(v.string()),
      sources: v.array(v.string()),
      // Hand-picked contacts, always included whatever the rules say. This is
      // the "manual matching" half, and it is additive on purpose: an operator
      // adding one person should never have to reverse-engineer a rule that
      // would have caught them.
      manualContactIds: v.array(v.id("contacts")),
      // Hand-excluded contacts, always dropped. Wins over everything above,
      // because "not this one" is a decision and a rule is only a guess.
      excludeContactIds: v.array(v.id("contacts")),
    }),

    status: v.union(
      v.literal("draft"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    // What the send actually did, written when it finishes. Kept on the
    // campaign so the list can show an outcome without counting ledger rows.
    matched: v.optional(v.number()),
    queued: v.optional(v.number()),
    skipped: v.optional(v.number()),
    error: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"]),

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

  // Brand-side gate sessions for /brand-interest. Deliberately NOT adminSessions:
  // the two passwords guard different things, and a brand that is handed the
  // questionnaire password must never end up holding a token the back office
  // would honour. Separate table, separate validator, no shared row shape.
  brandSessions: defineTable({
    token: v.string(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"]),

  // One row per completed Brand Activation & Partnership Interest submission.
  //
  // Every checklist answer is stored as the option's own label rather than a
  // code, because the thing that reads this is a person deciding which program
  // to put in front of a brand. A code would need a legend that lives in the
  // page, and the page will be edited long before this table is.
  //
  // Nothing here is optional-by-laziness: the five contact fields at the top
  // are what make a lead followable, and only two of them are actually required
  // at the form (company + contact + email), so the rest must be allowed empty.
  brandInterests: defineTable({
    company: v.string(),
    contact: v.string(),
    title: v.optional(v.string()),
    email: v.string(), // normalized: trim + lowercase
    timeline: v.optional(v.string()),

    goals: v.array(v.string()),
    solutions: v.array(v.string()),
    audience: v.array(v.string()),
    audienceOther: v.optional(v.string()),
    categories: v.array(v.string()),
    categoriesOther: v.optional(v.string()),
    impact: v.array(v.string()),
    budget: v.optional(v.string()),
    success: v.optional(v.string()),
    context: v.optional(v.string()),

    status: v.union(
      v.literal("new"),
      v.literal("reviewed"),
      v.literal("archived"),
    ),
    // Kept for triage only. No dedupe key: a brand may legitimately submit
    // twice — a second, better-considered answer is a signal, not a mistake —
    // so the write path never rejects on a repeat address.
    submittedAt: v.number(),
  })
    .index("by_status", ["status"])
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
