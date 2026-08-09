import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clamp = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

// Public RSVP submission (called by the /api/rsvp httpAction). Validates and
// normalizes, dedupes per event+email, assigns confirmed/waitlist by capacity,
// upserts the contact, and schedules a confirmation email for new RSVPs only.
export const submit = internalMutation({
  args: {
    eventId: v.string(),
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    guests: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const eventId = ctx.db.normalizeId("events", args.eventId);
    const event = eventId ? await ctx.db.get(eventId) : null;
    if (!eventId || !event || event.status !== "published") {
      return { ok: false as const, error: "event not found" };
    }
    if (event.rsvpMode === "closed") {
      return { ok: false as const, error: "RSVPs are closed for this event" };
    }

    const name = clamp(args.name, 120);
    const email = clamp(args.email, 200).toLowerCase();
    if (!name) return { ok: false as const, error: "name required" };
    if (!EMAIL_RE.test(email)) {
      return { ok: false as const, error: "valid email required" };
    }
    const guests = Math.min(10, Math.max(1, Math.round(Number(args.guests) || 1)));
    const phone = clamp(args.phone, 40) || undefined;
    const notes = clamp(args.notes, 500) || undefined;

    // Dedupe: a repeat submission updates the existing RSVP; no second email.
    const dedupeKey = `${eventId}:${email}`;
    const existing = await ctx.db
      .query("rsvps")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { name, phone, guests, notes });
      return { ok: true as const, status: existing.status, duplicate: true };
    }

    // Capacity: seats taken = sum of guests across confirmed/checked-in RSVPs.
    let status: "confirmed" | "waitlist" = "confirmed";
    if (typeof event.capacity === "number" && event.capacity > 0) {
      const all = await ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect();
      const taken = all
        .filter((r) => r.status === "confirmed" || r.status === "checked_in")
        .reduce((sum, r) => sum + r.guests, 0);
      if (taken + guests > event.capacity) status = "waitlist";
    }

    const rsvpId = await ctx.db.insert("rsvps", {
      eventId,
      name,
      email,
      phone,
      guests,
      status,
      source: "site",
      notes,
      dedupeKey,
    });

    // Contact upsert, skipped entirely for suppressed addresses.
    const suppressed = await ctx.db
      .query("suppressions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!suppressed) {
      const contact = await ctx.db
        .query("contacts")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (contact) {
        await ctx.db.patch(contact._id, {
          name: contact.name || name,
          phone: contact.phone || phone,
          tags: contact.tags.includes("attendee")
            ? contact.tags
            : [...contact.tags, "attendee"],
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("contacts", {
          name,
          email,
          phone,
          tags: ["attendee"],
          emailStatus: "unverified",
          source: "rsvp",
          updatedAt: Date.now(),
        });
      }
    }

    // Scheduled only if this mutation commits; the send itself re-checks
    // suppression and dedupes in its own transaction.
    await ctx.scheduler.runAfter(0, internal.email.sendRsvpConfirmation, {
      rsvpId,
    });
    return { ok: true as const, status, duplicate: false };
  },
});

// Admin guest list for one event (backs the list and CSV export routes).
export const listForEvent = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const eventId = ctx.db.normalizeId("events", args.eventId);
    const event = eventId ? await ctx.db.get(eventId) : null;
    if (!eventId || !event) return null;
    const rsvps = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    rsvps.sort((a, b) => a._creationTime - b._creationTime);
    return {
      event: {
        id: eventId,
        title: event.title,
        date: event.date,
        capacity: event.capacity,
      },
      rsvps: rsvps.map((r) => ({
        id: r._id,
        name: r.name,
        email: r.email,
        phone: r.phone ?? "",
        guests: r.guests,
        status: r.status,
        source: r.source,
        notes: r.notes ?? "",
        createdAt: new Date(r._creationTime).toISOString(),
        confirmationSentAt: r.confirmationSentAt
          ? new Date(r.confirmationSentAt).toISOString()
          : "",
      })),
    };
  },
});
