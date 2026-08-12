import { Resend, vOnEmailEventArgs } from "@convex-dev/resend";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { rsvpToken } from "./lib/rsvpToken";
import { inviteOrigin } from "./events";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  buildRsvpIcs,
  renderRsvpConfirmation,
  VENUE_FALLBACK,
  type ConfirmationVars,
} from "./emails/rsvpConfirmation";
import { inviteUrl } from "./events";
import { unsubToken } from "./lib/unsub";

// The Resend component: durable queueing, batching, retries, idempotency, and
// signed-webhook verification. apiKey/webhookSecret come from the Convex env
// vars RESEND_API_KEY / RESEND_WEBHOOK_SECRET. testMode is explicitly off so
// production sends reach real recipients (spec: transactional-email 5.1).
export const resend: Resend = new Resend(components.resend, {
  onEmailEvent: internal.email.handleEmailEvent,
  testMode: false,
});

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// "2026-07-11" + "1:00 PM"/"4:00 PM" -> "Saturday, July 11, 2026 · 1:00 PM – 4:00 PM"
// Mirrors the site's event-card format; parsed manually so no timezone shifts.
function formatWhenLine(date: string, start?: string, end?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  let line = date;
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    line = `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  }
  if (start) line += ` · ${start}${end ? ` – ${end}` : ""}`;
  return line;
}

// VENUE_FALLBACK is imported, not redeclared. A local copy of it lived here and
// led with the venue NAME while the template's own default led with the street,
// and the template's waitlist redaction had been written against the street-
// first shape. The result was a street address printed to every waitlisted
// guest on the fallback path. One exported constant, one shape, one redactor.

export const confirmationData = internalQuery({
  args: { rsvpId: v.id("rsvps") },
  handler: async (ctx, { rsvpId }) => {
    const rsvp = await ctx.db.get(rsvpId);
    if (!rsvp) return null;
    const event = await ctx.db.get(rsvp.eventId);
    if (!event) return null;
    // Resolve the poster and the headshot/logo storage ids here so the email
    // renderer only ever sees plain URLs (it runs in an action, which has no
    // storage access).
    const posterUrl = event.posterId
      ? await ctx.storage.getUrl(event.posterId)
      : null;
    const featured = await Promise.all(
      (event.featured ?? []).map(async (f) => ({
        name: f.name,
        role: f.role,
        kind: f.kind,
        link: f.link,
        bio: f.bio,
        imageUrl: f.imageId ? await ctx.storage.getUrl(f.imageId) : null,
      })),
    );
    return { rsvp, event, featured, posterUrl };
  },
});

// Renders the confirmation and hands it to recordAndEnqueue. An action (not a
// mutation) because the unsubscribe token needs WebCrypto; all transactional
// invariants (dedupe, suppression, ledger + enqueue atomically) live in the
// mutation it calls.
export const sendRsvpConfirmation = internalAction({
  args: { rsvpId: v.id("rsvps") },
  handler: async (ctx, { rsvpId }) => {
    const data = await ctx.runQuery(internal.email.confirmationData, { rsvpId });
    if (!data) return;
    const { rsvp, event, featured, posterUrl } = data;

    let unsubUrl: string | undefined;
    const secret = process.env.UNSUB_SECRET;
    const siteUrl = process.env.CONVEX_SITE_URL;
    // The same string is rendered as an href AND copied into the
    // List-Unsubscribe header below, so the scheme is checked once here rather
    // than trusted at either point of use.
    if (secret && siteUrl && /^https?:\/\//i.test(siteUrl)) {
      const token = await unsubToken(secret, rsvp.email);
      unsubUrl = `${siteUrl}/unsubscribe?e=${encodeURIComponent(rsvp.email)}&t=${token}`;
    }

    const vars: ConfirmationVars = {
      name: rsvp.name,
      eventTitle: event.title,
      whenLine: formatWhenLine(event.date, event.start, event.end),
      location: event.location || VENUE_FALLBACK,
      status: rsvp.status === "waitlist" ? "waitlist" : "confirmed",
      parking: event.parking,
      notes: event.notes,
      unsubUrl,
      // Everything below is optional in the template; a missing value just
      // drops its row rather than breaking the layout.
      subtitle: event.subtitle,
      guests: rsvp.guests,
      date: event.date,
      start: event.start,
      end: event.end,
      // An external RSVP url is an explicit override; otherwise link to the
      // hosted invite minted with the event, so the email points at the same
      // url that gets texted around. inviteUrl() keys off the slug and falls
      // back to the document id for rows created before slugs existed —
      // rsvp.html resolves either, so old links keep working.
      eventUrl:
        event.rsvpMode === "external" && event.rsvpUrl
          ? event.rsvpUrl
          : inviteUrl(event.slug || event._id),
      // The event's flyer. Absent -> the poster band is omitted entirely and
      // the layout closes up, so an event with no artwork still renders.
      posterUrl,
      featured,
    };

    // ADD TO CALENDAR has to work for a guest who does not use Google. A
    // `calendar.google.com` template link puts a Google sign-in wall in front
    // of every iCloud, Outlook and Proton recipient, so the real calendar
    // entry is built here as an iCalendar file, parked in Convex file storage
    // (which serves it back with its own `text/calendar` content type) and
    // handed to the template as `icsUrl`. Apple Mail, Outlook and Fastmail
    // then add the event in one tap, exactly like an attachment would.
    //
    // The file is small (well under 1KB) and immutable, and a failure here is
    // never allowed to block a confirmation: the template falls back to the
    // Google link plus the Outlook web link on its own.
    let icsUrl: string | undefined;
    let icsStorageId: Id<"_storage"> | undefined;
    try {
      const ics = buildRsvpIcs(vars);
      if (ics) {
        icsStorageId = await ctx.storage.store(
          new Blob([ics], { type: "text/calendar; charset=utf-8" }),
        );
        icsUrl = (await ctx.storage.getUrl(icsStorageId)) ?? undefined;
      }
    } catch {
      icsUrl = undefined;
    }

    // The file has to be written here, before the dedupe and suppression checks
    // run, because only an action can write to storage and only a mutation can
    // make those checks atomic. So the action cleans up after itself: without
    // this, a retried action, a duplicate invocation or a send to a suppressed
    // address each leaves behind a permanent, never-referenced,
    // publicly-reachable file carrying the guest's event and venue address.
    // Nothing links to a file whose send was skipped, so deleting it is safe,
    // and a failed delete is never allowed to fail the send.
    const discardIcs = async () => {
      const id = icsStorageId;
      if (!id) return;
      icsStorageId = undefined;
      try {
        await ctx.storage.delete(id);
      } catch {
        // best effort: an undeleted file is a wasted byte, not a broken send
      }
    };

    // One signed token opens the pass, the QR at the door, and the change or
    // cancel page. Minted here so an old email keeps working without a lookup
    // table to maintain. `secret` and `siteUrl` are the ones resolved above for
    // the unsubscribe link.
    const mgTok = secret ? await rsvpToken(secret, rsvpId) : "";
    // The pass is served by this deployment's HTTP router, not by the site.
    const apiOrigin = siteUrl || "https://good-labrador-980.convex.site";
    const walletUrl = mgTok ? `${apiOrigin}/api/pass?t=${encodeURIComponent(mgTok)}` : undefined;
    const manageUrl = mgTok ? `${inviteOrigin()}/rsvp?manage=${encodeURIComponent(mgTok)}` : undefined;

    const rendered = renderRsvpConfirmation({ ...vars, icsUrl, walletUrl, manageUrl });

    let enqueued = false;
    try {
      const result = await ctx.runMutation(internal.email.recordAndEnqueue, {
        rsvpId,
        toEmail: rsvp.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey: `rsvp_confirmation:${rsvpId}`,
        unsubUrl,
      });
      enqueued = (result as { enqueued?: boolean } | null)?.enqueued === true;
    } catch (err) {
      // A throwing mutation rolled its transaction back, so nothing references
      // the file and the scheduler is about to run this action again.
      await discardIcs();
      throw err;
    }
    if (!enqueued) await discardIcs();
  },
});

// Ledger + enqueue in one transaction. The app-level dedupeKey outlives
// Resend's 24h idempotency window: once a non-failed row exists for this RSVP,
// no second confirmation can ever be enqueued.
export const recordAndEnqueue = internalMutation({
  args: {
    rsvpId: v.id("rsvps"),
    toEmail: v.string(),
    subject: v.string(),
    html: v.string(),
    text: v.string(),
    dedupeKey: v.string(),
    unsubUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const prior = await ctx.db
      .query("emailSends")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", args.dedupeKey))
      .first();
    if (prior && prior.status !== "failed") return { skipped: "duplicate" };

    const base = {
      rsvpId: args.rsvpId,
      toEmail: args.toEmail,
      kind: "rsvp_confirmation" as const,
      dedupeKey: args.dedupeKey,
    };
    // Reuse the failed row on retry so the dedupe key stays unique.
    const record = async (fields: {
      status: "queued" | "failed" | "suppressed_skip";
      error?: string;
      componentEmailId?: string;
    }) => {
      if (prior) {
        await ctx.db.patch(prior._id, { ...fields, error: fields.error });
      } else {
        await ctx.db.insert("emailSends", { ...base, ...fields });
      }
    };

    // Suppression check in the same transaction as the enqueue.
    const suppressed = await ctx.db
      .query("suppressions")
      .withIndex("by_email", (q) => q.eq("email", args.toEmail))
      .first();
    if (suppressed) {
      await record({
        status: "suppressed_skip",
        error: `suppressed: ${suppressed.reason}`,
      });
      return { skipped: "suppressed" };
    }

    const from = process.env.EMAIL_FROM; // e.g. Mix & Greet <rsvp@example.com>
    if (!process.env.RESEND_API_KEY || !from) {
      await record({
        status: "failed",
        error: "email not configured: set RESEND_API_KEY and EMAIL_FROM",
      });
      return { skipped: "unconfigured" };
    }

    const headers = args.unsubUrl
      ? [
          { name: "List-Unsubscribe", value: `<${args.unsubUrl}>` },
          { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        ]
      : undefined;

    try {
      const emailId = await resend.sendEmail(ctx, {
        from,
        to: args.toEmail,
        subject: args.subject,
        html: args.html,
        text: args.text,
        headers,
      });
      await record({ status: "queued", componentEmailId: emailId, error: undefined });
      await ctx.db.patch(args.rsvpId, { confirmationSentAt: Date.now() });
      return { enqueued: true };
    } catch (err: any) {
      await record({ status: "failed", error: String(err?.message || err) });
      return { skipped: "error" };
    }
  },
});

// Add an address to the global do-not-send list and mark its contact.
async function suppress(
  ctx: MutationCtx,
  email: string,
  reason: "unsubscribe" | "bounce" | "complaint" | "manual",
  sourceSendId?: Id<"emailSends">,
) {
  const existing = await ctx.db
    .query("suppressions")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (!existing) {
    await ctx.db.insert("suppressions", { email, reason, sourceSendId });
  }
  const contact = await ctx.db
    .query("contacts")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (contact && contact.emailStatus !== "suppressed") {
    await ctx.db.patch(contact._id, {
      emailStatus: "suppressed",
      updatedAt: Date.now(),
    });
  }
}

// Called by the /unsubscribe httpAction after HMAC verification.
export const unsubscribe = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await suppress(ctx, email.trim().toLowerCase(), "unsubscribe");
    return { ok: true };
  },
});

// Resend component callback: sync provider events into the emailSends ledger
// and auto-suppress hard bounces and complaints.
export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    const send = await ctx.db
      .query("emailSends")
      .withIndex("by_componentEmailId", (q) => q.eq("componentEmailId", id))
      .first();
    if (!send) return;
    const providerMessageId = (event.data as any)?.email_id;

    switch (event.type) {
      case "email.sent":
        await ctx.db.patch(send._id, {
          status: "sent",
          sentAt: Date.now(),
          providerMessageId,
        });
        break;
      case "email.delivered":
        await ctx.db.patch(send._id, { status: "delivered", providerMessageId });
        break;
      case "email.bounced": {
        const bounce = (event.data as any)?.bounce;
        await ctx.db.patch(send._id, {
          status: "bounced",
          providerMessageId,
          error: bounce ? `${bounce.type}: ${bounce.message}` : "bounced",
        });
        // Anything not explicitly transient counts as a hard bounce.
        if (!/transient/i.test(String(bounce?.type ?? ""))) {
          await suppress(ctx, send.toEmail, "bounce", send._id);
        }
        break;
      }
      case "email.complained":
        await ctx.db.patch(send._id, { status: "complained", providerMessageId });
        await suppress(ctx, send.toEmail, "complaint", send._id);
        break;
      default:
        // delivery_delayed / opened / clicked: no ledger transition.
        break;
    }
  },
});
