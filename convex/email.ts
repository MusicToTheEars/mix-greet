import { Resend, vOnEmailEventArgs } from "@convex-dev/resend";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { renderRsvpConfirmation } from "./emails/rsvpConfirmation";
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

const VENUE_FALLBACK =
  "Academix BEAT Lab, 1933 S. Broadway, Suite 1202, Los Angeles, CA 90007";

export const confirmationData = internalQuery({
  args: { rsvpId: v.id("rsvps") },
  handler: async (ctx, { rsvpId }) => {
    const rsvp = await ctx.db.get(rsvpId);
    if (!rsvp) return null;
    const event = await ctx.db.get(rsvp.eventId);
    if (!event) return null;
    return { rsvp, event };
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
    const { rsvp, event } = data;

    let unsubUrl: string | undefined;
    const secret = process.env.UNSUB_SECRET;
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (secret && siteUrl) {
      const token = await unsubToken(secret, rsvp.email);
      unsubUrl = `${siteUrl}/unsubscribe?e=${encodeURIComponent(rsvp.email)}&t=${token}`;
    }

    const rendered = renderRsvpConfirmation({
      name: rsvp.name,
      eventTitle: event.title,
      whenLine: formatWhenLine(event.date, event.start, event.end),
      location: event.location || VENUE_FALLBACK,
      status: rsvp.status === "waitlist" ? "waitlist" : "confirmed",
      parking: event.parking,
      notes: event.notes,
      unsubUrl,
    });

    await ctx.runMutation(internal.email.recordAndEnqueue, {
      rsvpId,
      toEmail: rsvp.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      dedupeKey: `rsvp_confirmation:${rsvpId}`,
      unsubUrl,
    });
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
