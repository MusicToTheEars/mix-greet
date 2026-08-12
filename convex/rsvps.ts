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
      return { ok: true as const, status: existing.status, duplicate: true, rsvpId: existing._id };
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
    return { ok: true as const, status, duplicate: false, rsvpId };
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

// --- guest self-service: look up, edit, cancel -------------------------------
// All three are reached with a signed token (lib/rsvpToken.ts), never with a
// raw document id, so possessing an RSVP id is not enough to read or change it.

// Everything the manage page and the Wallet pass need about one RSVP.
export const getForToken = internalQuery({
  args: { rsvpId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("rsvps", args.rsvpId);
    const rsvp = id ? await ctx.db.get(id) : null;
    if (!id || !rsvp) return null;
    const event = await ctx.db.get(rsvp.eventId);
    if (!event) return null;

    const featured = await Promise.all(
      (event.featured ?? []).map(async (f) => ({
        name: f.name,
        kind: f.kind,
        role: f.role,
        imageUrl: f.imageId ? await ctx.storage.getUrl(f.imageId) : null,
      })),
    );

    return {
      rsvp: {
        id: rsvp._id,
        name: rsvp.name,
        email: rsvp.email,
        guests: rsvp.guests,
        status: rsvp.status,
      },
      event: {
        id: event._id,
        slug: event.slug ?? "",
        title: event.title,
        subtitle: event.subtitle ?? "",
        date: event.date,
        start: event.start ?? "",
        end: event.end ?? "",
        location: event.location ?? "",
        parking: event.parking ?? "",
        notes: event.notes ?? "",
      },
      featured,
    };
  },
});

// Cancel, or change party size. Cancelling frees capacity, so the first person
// on the waitlist is promoted in the same transaction — otherwise a spot opens
// and nobody is told, which is the whole reason a guest cancels rather than
// simply not turning up.
export const updateByGuest = internalMutation({
  args: {
    rsvpId: v.string(),
    action: v.union(v.literal("cancel"), v.literal("guests")),
    guests: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("rsvps", args.rsvpId);
    const rsvp = id ? await ctx.db.get(id) : null;
    if (!id || !rsvp) return { ok: false as const, error: "not found" };

    if (args.action === "guests") {
      const n = Math.max(1, Math.min(10, Math.floor(args.guests ?? 1)));
      await ctx.db.patch(id, { guests: n });
      return { ok: true as const, status: rsvp.status, guests: n };
    }

    if (rsvp.status === "cancelled") {
      return { ok: true as const, status: "cancelled" as const, guests: rsvp.guests };
    }
    await ctx.db.patch(id, { status: "cancelled" });

    // Promote the earliest waitlisted guest if the event has a capacity and
    // cancelling actually put us back under it.
    const event = await ctx.db.get(rsvp.eventId);
    let promoted: string | null = null;
    if (event?.capacity && rsvp.status === "confirmed") {
      const all = await ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", rsvp.eventId))
        .collect();
      const heads = all
        .filter((r) => r.status === "confirmed")
        .reduce((n, r) => n + (r.guests || 1), 0);
      const waiting = all
        .filter((r) => r.status === "waitlist")
        .sort((a, b) => a._creationTime - b._creationTime);
      const next = waiting[0];
      if (next && heads + (next.guests || 1) <= event.capacity) {
        await ctx.db.patch(next._id, { status: "confirmed" });
        promoted = next._id;
      }
    }
    return { ok: true as const, status: "cancelled" as const, guests: rsvp.guests, promoted };
  },
});

// --- door check-in -----------------------------------------------------------
// Scanning the QR marks attendance. The point is the gap between who said they
// were coming and who actually walked in — without it "RSVPs" is a vanity
// number and nobody can plan the next room size.
export const checkIn = internalMutation({
  args: {
    rsvpId: v.string(),
    undo: v.optional(v.boolean()), // mis-scans happen at a door; make it reversible
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("rsvps", args.rsvpId);
    const rsvp = id ? await ctx.db.get(id) : null;
    if (!id || !rsvp) return { ok: false as const, error: "not found" };

    const event = await ctx.db.get(rsvp.eventId);

    if (args.undo) {
      if (rsvp.status === "checked_in") await ctx.db.patch(id, { status: "confirmed" });
      return {
        ok: true as const,
        state: "undone" as const,
        name: rsvp.name,
        guests: rsvp.guests,
        event: event?.title ?? "",
      };
    }

    if (rsvp.status === "cancelled") {
      return {
        ok: true as const,
        state: "cancelled" as const,
        name: rsvp.name,
        guests: rsvp.guests,
        event: event?.title ?? "",
      };
    }
    // Already through the door: report it rather than silently double-counting,
    // so the person on the iPad knows this is a second scan of the same pass.
    if (rsvp.status === "checked_in") {
      return {
        ok: true as const,
        state: "already" as const,
        name: rsvp.name,
        guests: rsvp.guests,
        event: event?.title ?? "",
        at: rsvp.checkedInAt ? new Date(rsvp.checkedInAt).toISOString() : "",
      };
    }

    await ctx.db.patch(id, { status: "checked_in", checkedInAt: Date.now() });
    return {
      ok: true as const,
      // A waitlisted guest who turns up is still let in and recorded, but the
      // door should see that they were not on the confirmed list.
      state: (rsvp.status === "waitlist" ? "waitlist_in" : "in") as
        | "in"
        | "waitlist_in",
      name: rsvp.name,
      guests: rsvp.guests,
      event: event?.title ?? "",
    };
  },
});

// Live counts for the door screen: expected heads vs heads actually through.
export const doorStats = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const eventId = ctx.db.normalizeId("events", args.eventId);
    const event = eventId ? await ctx.db.get(eventId) : null;
    if (!eventId || !event) return null;
    const rows = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const heads = (f: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(f).reduce((n, r) => n + (r.guests || 1), 0);
    return {
      event: { id: eventId, title: event.title, date: event.date },
      confirmed: heads((r) => r.status === "confirmed"),
      checkedIn: heads((r) => r.status === "checked_in"),
      waitlist: heads((r) => r.status === "waitlist"),
      cancelled: heads((r) => r.status === "cancelled"),
      parties: {
        confirmed: rows.filter((r) => r.status === "confirmed").length,
        checkedIn: rows.filter((r) => r.status === "checked_in").length,
      },
    };
  },
});
