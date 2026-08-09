import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Idempotent import of events from the Netlify Blobs store.
// Run with:  npx convex run migrate:importEvents '{"events": <events.json>}'
// where events.json is the output of `curl https://<site>/api/events`.
// Re-running is safe: each event is matched by legacyId and skipped if present.
export const importEvents = internalMutation({
  args: {
    events: v.array(
      v.object({
        id: v.optional(v.string()),
        title: v.string(),
        subtitle: v.optional(v.string()),
        date: v.string(),
        start: v.optional(v.string()),
        end: v.optional(v.string()),
        location: v.optional(v.string()),
        parking: v.optional(v.string()),
        notes: v.optional(v.string()),
        rsvp: v.optional(v.string()),
        inviteOnly: v.optional(v.boolean()),
        createdAt: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { events }) => {
    let created = 0;
    let skipped = 0;
    for (const e of events) {
      const legacyId = e.id;
      if (legacyId) {
        const existing = await ctx.db
          .query("events")
          .withIndex("by_legacyId", (q) => q.eq("legacyId", legacyId))
          .unique();
        if (existing) {
          skipped++;
          continue;
        }
      }
      const rsvpUrl = e.rsvp && /^https?:\/\//i.test(e.rsvp) ? e.rsvp : undefined;
      await ctx.db.insert("events", {
        legacyId,
        title: e.title,
        subtitle: e.subtitle,
        date: e.date,
        start: e.start,
        end: e.end,
        location: e.location,
        parking: e.parking,
        notes: e.notes,
        rsvpUrl,
        rsvpMode: rsvpUrl ? "external" : "closed",
        inviteOnly: !!e.inviteOnly,
        status: "published",
        legacyCreatedAt: e.createdAt,
      });
      created++;
    }
    return { created, skipped, total: events.length };
  },
});

// Remove verification fixtures after an end-to-end test pass. Guarded: only
// touches rows whose email ends in @<emailDomain> and, optionally, one event
// by its Convex id (plus that event's rsvps).
// Run with:  npx convex run migrate:purgeTestData '{"emailDomain": "example.test", "eventId": "..."}'
export const purgeTestData = internalMutation({
  args: { emailDomain: v.string(), eventId: v.optional(v.string()) },
  handler: async (ctx, { emailDomain, eventId }) => {
    const suffix = "@" + emailDomain.replace(/^@/, "");
    const counts = { rsvps: 0, contacts: 0, emailSends: 0, suppressions: 0, events: 0 };

    for (const table of ["rsvps", "contacts", "suppressions"] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        if ((row as any).email?.endsWith(suffix)) {
          await ctx.db.delete(row._id);
          counts[table]++;
        }
      }
    }
    for (const row of await ctx.db.query("emailSends").collect()) {
      if (row.toEmail.endsWith(suffix)) {
        await ctx.db.delete(row._id);
        counts.emailSends++;
      }
    }
    if (eventId) {
      const id = ctx.db.normalizeId("events", eventId);
      if (id && (await ctx.db.get(id))) {
        for (const r of await ctx.db
          .query("rsvps")
          .withIndex("by_event", (q) => q.eq("eventId", id))
          .collect()) {
          await ctx.db.delete(r._id);
          counts.rsvps++;
        }
        await ctx.db.delete(id);
        counts.events++;
      }
    }
    return counts;
  },
});
