import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clamp = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

// Is there room for this party? Seats taken are the guests on every confirmed
// or checked-in row; an event with no capacity set never fills up. Lifted out
// of `submit` because two doors now lead onto the list, a brand new RSVP and a
// cancelled guest coming back, and if they ran different sums the same party
// could be told "confirmed" on one path and "waitlist" on the other.
async function assignStatus(
  ctx: MutationCtx,
  eventId: Id<"events">,
  capacity: number | undefined,
  guests: number,
): Promise<"confirmed" | "waitlist"> {
  if (typeof capacity !== "number" || capacity <= 0) return "confirmed";
  const all = await ctx.db
    .query("rsvps")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  const taken = all
    .filter((r) => r.status === "confirmed" || r.status === "checked_in")
    .reduce((sum, r) => sum + r.guests, 0);
  return taken + guests > capacity ? "waitlist" : "confirmed";
}

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
      // A cancelled guest RSVPing again is asking to come back, and the manage
      // page tells them to do exactly this. Patching only their details left
      // them cancelled while the page said "you're on the list" and handed them
      // a token and a QR, so they were turned away at the door. Reinstating
      // runs the same room test a first-time RSVP gets, because the seat they
      // gave up may well be gone. Any arrival stamp from the earlier booking is
      // dropped with it, or the guest list would report a time for someone who
      // is not currently checked in.
      if (existing.status === "cancelled") {
        const status = await assignStatus(ctx, eventId, event.capacity, guests);
        await ctx.db.patch(existing._id, {
          name,
          phone,
          guests,
          notes,
          status,
          checkedInAt: undefined,
          statusBeforeCheckIn: undefined,
        });
        // No second confirmation email, and `duplicate: true` still, because
        // this is the same row: convex/email.ts dedupes its ledger on
        // "rsvp_confirmation:<rsvpId>", so a resend scheduled here would be
        // skipped anyway and would only look like a send that never arrived.
        // The guest is not left without a link either: /api/rsvp hands the
        // signed manage token straight back to the page they are standing on,
        // which is where the pass and the QR are reached from.
        return { ok: true as const, status, duplicate: true, rsvpId: existing._id };
      }
      await ctx.db.patch(existing._id, { name, phone, guests, notes });
      return { ok: true as const, status: existing.status, duplicate: true, rsvpId: existing._id };
    }

    // Capacity: seats taken = sum of guests across confirmed/checked-in RSVPs.
    const status = await assignStatus(ctx, eventId, event.capacity, guests);

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

    // Invite status per guest. The ledger already records every send and the
    // Resend webhook already patches it to delivered/bounced/complained, so the
    // back office can show whether the confirmation actually landed rather than
    // only that we tried. A bounced invite is the one a host needs to chase.
    const sends = await Promise.all(
      rsvps.map((r) =>
        ctx.db
          .query("emailSends")
          .withIndex("by_dedupeKey", (q) =>
            q.eq("dedupeKey", `rsvp_confirmation:${r._id}`),
          )
          .first(),
      ),
    );
    const inviteByRsvp = new Map(
      rsvps.map((r, i) => [r._id, sends[i]] as const),
    );
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
        // When they actually walked in, "" when they have not. Without this the
        // host's list and CSV can say who was invited but not who came, which
        // is the one number that decides how big the next room needs to be.
        checkedInAt: r.checkedInAt ? new Date(r.checkedInAt).toISOString() : "",
        // "" when nothing was ever enqueued for this guest.
        inviteStatus: inviteByRsvp.get(r._id)?.status ?? "",
        inviteError: inviteByRsvp.get(r._id)?.error ?? "",
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

    // Neither action is allowed once the door has scanned this guest in.
    //
    // Cancelling is a promise about the future, and there is no future left to
    // promise from inside the room. This token lives in a confirmation email
    // that is still open on the guest's phone an hour into the party, so one
    // stray tap on "cancel" used to erase the record that they walked in, hand
    // their seat back to the waitlist while they were standing in it, and take
    // them out of the one number the host cannot rebuild the next morning.
    // Resizing is refused for the same reason: the party that came through the
    // door is a counted fact, and changing it here would rewrite attendance
    // without anyone scanning anything. Leaving early, or bringing someone
    // else in, is a conversation with the door.
    //
    // Refused rather than quietly ignored, so the page can say something true
    // instead of reporting a cancellation that never happened.
    if (rsvp.status === "checked_in") {
      return {
        ok: false as const,
        reason: "checked_in" as const,
        error:
          "You are already checked in at the door, so this can't be changed here. Talk to the door team.",
        status: rsvp.status,
        guests: rsvp.guests,
      };
    }

    if (args.action === "guests") {
      const n = Math.max(1, Math.min(10, Math.floor(args.guests ?? 1)));
      // A cancelled row is not a booking any more, so there is nothing to
      // resize: patching it left a guest quietly editing a dead RSVP and
      // believing they had one. Coming back is a fresh submission from the
      // invitation, which is exactly what the manage page tells them, and that
      // path re-tests the room properly.
      if (rsvp.status === "cancelled") {
        return {
          ok: false as const,
          reason: "cancelled" as const,
          error:
            "This RSVP was cancelled. RSVP again from the invitation if you want back in.",
          status: rsvp.status,
          guests: rsvp.guests,
        };
      }
      // Growing a confirmed party claims seats that may not exist. It is the
      // one place a guest can add heads after the capacity check that put them
      // on the list, so without re-testing it a full room can be walked past
      // from a phone. Shrinking always goes through. A waitlisted row is not
      // re-tested because it holds no seats at all: the promotion below is what
      // re-checks the room before it ever does.
      //
      // Refused rather than moved to the waitlist: someone who already has a
      // confirmed seat should not lose it because they asked about a plus one.
      if (rsvp.status === "confirmed" && n > rsvp.guests) {
        const event = await ctx.db.get(rsvp.eventId);
        if (typeof event?.capacity === "number" && event.capacity > 0) {
          const all = await ctx.db
            .query("rsvps")
            .withIndex("by_event", (q) => q.eq("eventId", rsvp.eventId))
            .collect();
          const others = all
            .filter(
              (r) =>
                r._id !== id &&
                (r.status === "confirmed" || r.status === "checked_in"),
            )
            .reduce((sum, r) => sum + r.guests, 0);
          if (others + n > event.capacity) {
            return {
              ok: false as const,
              reason: "full" as const,
              error:
                "There isn't room for that many. Your RSVP is unchanged at its current size.",
              status: rsvp.status,
              guests: rsvp.guests,
            };
          }
        }
      }
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
    // The event the door is running tonight, already resolved from a slug or a
    // raw id by the route. Optional on purpose: manual entry from the back
    // office and any caller written before this existed keep the old unscoped
    // behaviour rather than suddenly failing every scan.
    eventId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("rsvps", args.rsvpId);
    const rsvp = id ? await ctx.db.get(id) : null;
    if (!id || !rsvp) return { ok: false as const, error: "not found" };

    const event = await ctx.db.get(rsvp.eventId);

    // A pass from another night is a valid pass, so nothing else here would
    // have stopped it: last month's guest was checked in against tonight and
    // tonight's head count was wrong. When the door names its event, a scan
    // that belongs to a different one changes nothing at all and says which
    // event the pass is actually for, so staff can tell a wrong night from a
    // gatecrasher. An event key that resolves to nothing is treated the same
    // way, because a scan that cannot be proved to be tonight's must not count.
    const scopeId = args.eventId ? ctx.db.normalizeId("events", args.eventId) : null;
    if (args.eventId && scopeId !== rsvp.eventId) {
      return {
        ok: true as const,
        state: "wrong_event" as const,
        name: rsvp.name,
        guests: rsvp.guests,
        event: event?.title ?? "",
      };
    }

    if (args.undo) {
      if (rsvp.status === "checked_in") {
        await ctx.db.patch(id, {
          // Back to the list they were on before the scan. Rows checked in
          // before that was recorded fall back to "confirmed", which is what
          // undo always wrote, so nothing gets worse for them.
          status: rsvp.statusBeforeCheckIn ?? "confirmed",
          // The arrival never happened, so neither should its stamp: the guest
          // list and the CSV read this as "who came".
          checkedInAt: undefined,
          statusBeforeCheckIn: undefined,
        });
      }
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

    await ctx.db.patch(id, {
      status: "checked_in",
      checkedInAt: Date.now(),
      // Remembered because "checked_in" is about to overwrite the list they
      // were on, and an undo has to put them back on the right one.
      statusBeforeCheckIn: rsvp.status === "waitlist" ? "waitlist" : "confirmed",
    });
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
      // Everyone who said they were coming and has not cancelled, whether or
      // not they are already inside. `confirmed` below counts only the rows
      // still sitting in that status, so it drops by a party every time
      // somebody is scanned: read on its own it says the night is emptying out
      // as the room fills up. Both are kept, because the back office and the
      // door screen already read the old fields.
      expected: heads((r) => r.status === "confirmed" || r.status === "checked_in"),
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

// Hard-delete one RSVP. Cancelling is the guest-facing action and keeps the
// record; this is for an operator removing a test row or a mistake outright.
export const removeByAdmin = internalMutation({
  args: { rsvpId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("rsvps", args.rsvpId);
    const rsvp = id ? await ctx.db.get(id) : null;
    if (!id || !rsvp) return { ok: false as const, error: "not found" };
    // Drop the send ledger row too, or a re-RSVP by the same person is deduped
    // against a confirmation that no longer has an RSVP to belong to.
    const send = await ctx.db
      .query("emailSends")
      .withIndex("by_dedupeKey", (q) =>
        q.eq("dedupeKey", `rsvp_confirmation:${id}`),
      )
      .first();
    if (send) await ctx.db.delete(send._id);
    await ctx.db.delete(id);
    return { ok: true as const, email: rsvp.email };
  },
});
