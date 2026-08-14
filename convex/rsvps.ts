import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clamp = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

// Heads already holding a seat tonight: every confirmed party plus everyone
// already through the door, because somebody standing in the room occupies
// their seat every bit as much as somebody who has only promised to arrive.
// `exclude` drops one row from the sum, for a caller that is about to rewrite
// that row's own party size and must not count its old heads twice.
//
// Every capacity decision in this file goes through here. That is the whole
// point: when promotion counted only the rows still sitting in "confirmed" and
// the RSVP path counted the checked-in ones as well, a single cancellation
// promoted a party into a room that had no space left in it.
async function seatsTaken(
  ctx: MutationCtx,
  eventId: Id<"events">,
  exclude?: Id<"rsvps">,
): Promise<number> {
  const all = await ctx.db
    .query("rsvps")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  return all
    .filter(
      (r) =>
        r._id !== exclude &&
        (r.status === "confirmed" || r.status === "checked_in"),
    )
    .reduce((sum, r) => sum + (r.guests || 1), 0);
}

// Is there room for this party? An event with no capacity set never fills up.
// Lifted out of `submit` because two doors now lead onto the list, a brand new
// RSVP and a cancelled guest coming back, and if they ran different sums the
// same party could be told "confirmed" on one path and "waitlist" on the other.
async function assignStatus(
  ctx: MutationCtx,
  eventId: Id<"events">,
  capacity: number | undefined,
  guests: number,
  exclude?: Id<"rsvps">,
): Promise<"confirmed" | "waitlist"> {
  if (typeof capacity !== "number" || capacity <= 0) return "confirmed";
  const taken = await seatsTaken(ctx, eventId, exclude);
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
    company: v.optional(v.string()),
    creativeField: v.optional(v.string()),
    invitedBy: v.optional(v.string()),
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
    // Clamped like every other free-text field. 120 matches the name cap: these
    // are a company and a discipline, not a biography, and an unbounded string
    // here is a row that breaks the CSV and the guest list on one bad paste.
    const company = clamp(args.company, 120) || undefined;
    const creativeField = clamp(args.creativeField, 120) || undefined;
    const invitedBy = clamp(args.invitedBy, 120) || undefined;

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
          company,
          creativeField,
          invitedBy,
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
      // Somebody already inside the room is not editable from a form anybody
      // can post to. This route takes an event slug, which is printed in every
      // invite link, and an email address, and nothing else: with neither the
      // guest's token nor a staff login it was rewriting the party size of a
      // guest the door had already counted, so an anonymous post could turn
      // three heads into ten in the one number the host cannot rebuild the next
      // morning. `updateByGuest` already refuses this for the same reason, and
      // that refusal is worthless while the public form will do it anyway.
      if (existing.status === "checked_in") {
        return {
          ok: false as const,
          error:
            "This guest is already checked in at the door, so their RSVP can't be changed here. Talk to the door team.",
        };
      }

      // Growing a party on a repeat submission claims seats the room may not
      // have. It is the same hole the manage page's "guests" action is guarded
      // against, reachable without a token, so it runs the same seat test —
      // the guest's own heads excluded, because they are being replaced.
      if (
        existing.status === "confirmed" &&
        guests > existing.guests &&
        typeof event.capacity === "number" &&
        event.capacity > 0
      ) {
        const taken = await seatsTaken(ctx, eventId, existing._id);
        if (taken + guests > event.capacity) {
          return {
            ok: false as const,
            error:
              "There isn't room for that many. The existing RSVP is unchanged at its current size.",
          };
        }
      }

      // Same bound as the manage page puts on a waitlisted party: it claims no
      // seats, so it is not tested against the ones taken, but a party larger
      // than the room can never be promoted and should not be told it is
      // waiting for something that will not come.
      if (
        existing.status === "waitlist" &&
        guests > existing.guests &&
        typeof event.capacity === "number" &&
        event.capacity > 0 &&
        guests > event.capacity
      ) {
        return {
          ok: false as const,
          error: `This event only holds ${event.capacity}, so a party that size could never be let in. The existing RSVP is unchanged.`,
        };
      }

      await ctx.db.patch(existing._id, { name, phone, guests, notes, company, creativeField, invitedBy });
      // Deliberately no rsvpId, which is what /api/rsvp mints the manage token
      // from. The invite slug is public and an email address is not a secret,
      // so minting one here handed anybody who could guess a guest's address
      // that guest's door QR, their Wallet pass and their cancel button, from
      // one unsigned POST. A returning guest is not locked out by this: their
      // own link is in the confirmation email, the device that RSVPed already
      // remembers its token, and the cancelled-and-back path above is a
      // different case — that row was carrying no live pass to hand out.
      return { ok: true as const, status: existing.status, duplicate: true };
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
      company,
      creativeField,
      invitedBy,
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
        company: r.company ?? "",
        creativeField: r.creativeField ?? "",
        invitedBy: r.invitedBy ?? "",
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
          const others = await seatsTaken(ctx, rsvp.eventId, id);
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
      // A waitlisted party is not tested against seats taken — it holds none —
      // but it is still bounded by the room. Waiting for twelve seats in a room
      // of eight is not a queue position, it is a party that can never be
      // promoted: the promotion loop tests `taken + guests <= capacity`, so an
      // oversized row sits at the front of the queue being skipped forever
      // while the guest believes they are next. Refusing here says so at the
      // moment they ask, instead of at the door.
      if (rsvp.status === "waitlist" && n > rsvp.guests) {
        const event = await ctx.db.get(rsvp.eventId);
        if (typeof event?.capacity === "number" && event.capacity > 0 && n > event.capacity) {
          return {
            ok: false as const,
            reason: "full" as const,
            error:
              `This event only holds ${event.capacity}, so a party that size could never be let in. Your place on the waitlist is unchanged.`,
            status: rsvp.status,
            guests: rsvp.guests,
          };
        }
      }
      await ctx.db.patch(id, { guests: n });
      return { ok: true as const, status: rsvp.status, guests: n };
    }

    if (rsvp.status === "cancelled") {
      return { ok: true as const, status: "cancelled" as const, guests: rsvp.guests };
    }
    await ctx.db.patch(id, { status: "cancelled" });

    // Promote off the waitlist if the event has a capacity and cancelling
    // actually put us back under it.
    //
    // The seats freed are counted by the same `seatsTaken` every other capacity
    // decision uses, so the people already through the door still hold theirs.
    // Counting only the rows left in "confirmed" was how a cancellation
    // promoted a party of four into a room of four with three guests already
    // standing in it.
    //
    // The whole waitlist is walked, in the order people joined it, and every
    // party that fits is promoted. Trying only the head of the queue meant one
    // large party that no longer fitted blocked everybody behind it: a room
    // emptied and nobody at all was let in, which is the opposite of what a
    // cancellation is for. Order is still respected — a party is only skipped
    // when it genuinely does not fit — so nobody jumps the queue, they only
    // step around somebody the room cannot take.
    const event = await ctx.db.get(rsvp.eventId);
    const promoted: Array<Id<"rsvps">> = [];
    if (event?.capacity && rsvp.status === "confirmed") {
      let heads = await seatsTaken(ctx, rsvp.eventId);
      const waiting = (
        await ctx.db
          .query("rsvps")
          .withIndex("by_event", (q) => q.eq("eventId", rsvp.eventId))
          .collect()
      )
        .filter((r) => r.status === "waitlist")
        .sort((a, b) => a._creationTime - b._creationTime);
      for (const next of waiting) {
        const party = next.guests || 1;
        if (heads + party > event.capacity) continue;
        await ctx.db.patch(next._id, { status: "confirmed" });
        heads += party;
        promoted.push(next._id);
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
    // raw id by the route. Still optional in the shape, because a caller can
    // always omit it, but a scan that does not name its event is now refused
    // rather than trusted: see the handler.
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
    //
    // A scan that names no event at all is refused outright. It used to be let
    // through as an unscoped door, for manual entry, but nothing calls it that
    // way — checkin.html will not scan until an event is picked and sends it on
    // every call including the undo — while a stale or cached scanner tab is
    // exactly the caller that sends none, and that caller was checking guests
    // in against whatever night their pass happened to be for. Refused rather
    // than guessed: the door is told to pick tonight's event, which is one tap.
    const scopeId = args.eventId ? ctx.db.normalizeId("events", args.eventId) : null;
    if (!args.eventId) {
      return {
        ok: false as const,
        error:
          "No event was named for this scan. Pick tonight's event on the scanner and scan again.",
      };
    }
    if (scopeId !== rsvp.eventId) {
      return {
        ok: true as const,
        state: "wrong_event" as const,
        name: rsvp.name,
        guests: rsvp.guests,
        event: event?.title ?? "",
      };
    }

    // An archived event is over, or was never meant to run: it is not a door.
    // Nothing here looked at the event's status, so the pass for a night the
    // host has already put away still opened it, and the arrivals it recorded
    // landed on an event no back-office list is watching. Undo is refused for
    // the same reason — there is nothing legitimate left to reverse — and both
    // answer with a sentence the person on the iPad can act on.
    if (!event || event.status !== "published") {
      return {
        ok: false as const,
        error:
          "That event is archived, so it is not running a door. Check which event this scanner is set to.",
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
