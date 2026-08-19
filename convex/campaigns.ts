// Campaigns: one message written once, matched to a slice of the contact list,
// and sent with every send ledgered.
//
// The matching has two halves and they are additive, never alternatives:
//
//   automatic  the audience RULE — tags, interest labels, stage, source. The
//              interest labels are the same strings the brand questionnaire
//              prints, which is what makes "everyone who ticked DJ Products"
//              a query rather than a memory exercise.
//   manual     hand-picked contacts, always in; hand-excluded contacts, always
//              out. Exclusion wins over everything, because "not this one" is a
//              decision and a rule is only a guess.
//
// The audience is stored as the rule and resolved at send time. A list frozen
// at draft time is already wrong by the time somebody presses send.

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { resend } from "./email";
import { unsubToken } from "./lib/unsub";
import { renderCampaign } from "./emails/campaign";
import { inviteUrl } from "./events";

const audienceValidator = v.object({
  tags: v.array(v.string()),
  interests: v.array(v.string()),
  stages: v.array(v.string()),
  sources: v.array(v.string()),
  manualContactIds: v.array(v.id("contacts")),
  excludeContactIds: v.array(v.id("contacts")),
});

type Audience = {
  tags: string[];
  interests: string[];
  stages: string[];
  sources: string[];
  manualContactIds: Id<"contacts">[];
  excludeContactIds: Id<"contacts">[];
};

// An address we will not send to, and the reason, so the preview can say why a
// matched contact is not in the count rather than silently dropping them. A
// campaign that quietly sends to 40 of the 52 people it showed you is a
// campaign nobody trusts twice.
async function blockReason(ctx: QueryCtx, c: Doc<"contacts">): Promise<string | null> {
  if (c.emailStatus === "suppressed") return "unsubscribed";
  if (c.emailStatus === "bounced") return "bounced";
  const s = await ctx.db
    .query("suppressions")
    .withIndex("by_email", (q) => q.eq("email", c.email))
    .first();
  if (s) return s.reason === "unsubscribe" ? "unsubscribed" : s.reason;
  return null;
}

// Resolve the rule against the list as it is right now.
async function resolve(ctx: QueryCtx, a: Audience) {
  const all = await ctx.db.query("contacts").collect();
  const manual = new Set<string>(a.manualContactIds);
  const excluded = new Set<string>(a.excludeContactIds);
  const anyRule =
    a.tags.length > 0 || a.interests.length > 0 || a.stages.length > 0 || a.sources.length > 0;

  const matched: Array<{ contact: Doc<"contacts">; why: string[] }> = [];
  for (const c of all) {
    if (excluded.has(c._id)) continue;
    const why: string[] = [];
    if (manual.has(c._id)) why.push("picked by hand");
    if (anyRule) {
      const tagHit = a.tags.filter((t) => c.tags.includes(t));
      const intHit = a.interests.filter((i) => (c.interests ?? []).includes(i));
      const stageHit = a.stages.includes(c.stage ?? "none");
      const srcHit = a.sources.includes(c.source);
      if (tagHit.length) why.push(...tagHit);
      if (intHit.length) why.push(...intHit);
      if (stageHit) why.push(`stage: ${c.stage ?? "none"}`);
      if (srcHit) why.push(`source: ${c.source}`);
    }
    if (why.length) matched.push({ contact: c, why });
  }

  const sendable: Array<{ contact: Doc<"contacts">; why: string[] }> = [];
  const blocked: Array<{ contact: Doc<"contacts">; reason: string }> = [];
  for (const m of matched) {
    const reason = await blockReason(ctx, m.contact);
    if (reason) blocked.push({ contact: m.contact, reason });
    else sendable.push(m);
  }
  sendable.sort((x, y) =>
    (x.contact.name || x.contact.email).localeCompare(y.contact.name || y.contact.email),
  );
  return { sendable, blocked };
}

// --- audience preview -------------------------------------------------------

export const preview = internalQuery({
  args: { audience: audienceValidator },
  handler: async (ctx, { audience }) => {
    const { sendable, blocked } = await resolve(ctx, audience as Audience);
    return {
      sendableCount: sendable.length,
      blockedCount: blocked.length,
      // Everyone, not a sample. The operator is about to mail these people and
      // the only honest preview is the actual list; at this deployment's size
      // that is a few hundred short rows.
      recipients: sendable.map(({ contact, why }) => ({
        _id: contact._id,
        name: contact.name,
        email: contact.email,
        company: contact.company,
        why,
      })),
      blocked: blocked.map(({ contact, reason }) => ({
        _id: contact._id,
        name: contact.name,
        email: contact.email,
        reason,
      })),
    };
  },
});

// What an event should probably be sent to. The event's own interest tags, run
// through the list, so the operator starts from a proposal instead of a blank
// audience builder. Never auto-applied: it is a suggestion with a count on it.
export const suggestForEvent = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const ev = await ctx.db.get(eventId);
    if (!ev) return null;
    const interests = ev.interestTags ?? [];
    const contacts = await ctx.db.query("contacts").collect();
    const counts = interests.map((label) => ({
      label,
      count: contacts.filter((c) => (c.interests ?? []).includes(label)).length,
    }));
    const reach = contacts.filter((c) =>
      (c.interests ?? []).some((i) => interests.includes(i)),
    ).length;
    return { eventTitle: ev.title, interests: counts, reach };
  },
});

// How a send performed, counted off the ledger rows rather than stored on the
// campaign, because the delivery webhook keeps rewriting those rows for days
// after the send finishes.
//
// The denominator is DELIVERED, not queued. A message that bounced was never in
// front of a human, and counting it against the open rate makes a clean list
// look worse than a dirty one that silently swallowed the bounces.
function engagement(sends: Array<Doc<"emailSends">>) {
  const live = sends.filter((s) => s.status !== "failed" && s.status !== "suppressed_skip");
  const delivered = live.filter((s) => s.status === "delivered" || s.openedAt).length;
  const opened = live.filter((s) => s.openedAt).length;
  const clicked = live.filter((s) => s.clickedAt).length;
  const bounced = live.filter((s) => s.status === "bounced").length;
  const complained = live.filter((s) => s.status === "complained").length;
  const rate = (n: number) => (delivered ? Math.round((n / delivered) * 1000) / 10 : 0);
  return {
    sent: live.length,
    delivered,
    opened,
    clicked,
    bounced,
    complained,
    // Percentages to one decimal. Whole numbers hide the difference between a
    // campaign that went to nine people and one that went to nine hundred.
    openRate: rate(opened),
    clickRate: rate(clicked),
    // Total opens including repeats, which is the only number that separates
    // "forwarded round the office" from "glanced at once".
    totalOpens: live.reduce((n, s) => n + (s.openCount ?? 0), 0),
  };
}

// --- campaign records -------------------------------------------------------

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("campaigns").collect();
    const out = [];
    const everySend: Array<Doc<"emailSends">> = [];
    for (const c of rows) {
      const ev = c.eventId ? await ctx.db.get(c.eventId) : null;
      const sends = await ctx.db
        .query("emailSends")
        .withIndex("by_campaign", (q) => q.eq("campaignId", c._id))
        .collect();
      everySend.push(...sends);
      out.push({ ...c, eventTitle: ev?.title, stats: engagement(sends) });
    }
    out.sort((a, b) => (b.sentAt ?? b.updatedAt) - (a.sentAt ?? a.updatedAt));
    // The account average, pooled across every campaign send rather than
    // averaged over the per-campaign rates: a campaign sent to four people
    // must not swing the headline number as hard as one sent to four hundred.
    return { campaigns: out, overall: engagement(everySend) };
  },
});

export const get = internalQuery({
  args: { id: v.id("campaigns") },
  handler: async (ctx, { id }) => {
    const c = await ctx.db.get(id);
    if (!c) return null;
    const ev = c.eventId ? await ctx.db.get(c.eventId) : null;
    const sends = await ctx.db
      .query("emailSends")
      .withIndex("by_campaign", (q) => q.eq("campaignId", id))
      .collect();
    // The outcome, counted off the ledger rather than off the campaign row,
    // because the ledger is what the delivery webhook keeps updating.
    const byStatus: Record<string, number> = {};
    for (const s of sends) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

    // Who each row went to, resolved once here rather than by the page making a
    // request per recipient. A campaign report that cannot name the people who
    // opened it is a percentage, not a report.
    const named = [];
    for (const s of sends) {
      const contact = s.contactId ? await ctx.db.get(s.contactId) : null;
      named.push({
        ...s,
        name: contact?.name,
        company: contact?.company,
      });
    }

    return {
      campaign: c,
      eventTitle: ev?.title,
      sendCount: sends.length,
      byStatus,
      openStats: engagement(sends),
      sends: named
        .sort((a, b) => {
          // Openers first, most recently opened at the top, then everyone else
          // by send time. The reason to open this screen is to find out who is
          // interested, and that list should not be buried in alphabetical
          // order behind four hundred people who never looked.
          const ao = a.lastOpenedAt ?? 0;
          const bo = b.lastOpenedAt ?? 0;
          if (ao !== bo) return bo - ao;
          return (b.sentAt ?? b._creationTime) - (a.sentAt ?? a._creationTime);
        })
        .slice(0, 400),
    };
  },
});

export const create = internalMutation({
  args: {
    name: v.string(),
    subject: v.string(),
    body: v.string(),
    eventId: v.optional(v.id("events")),
    audience: v.optional(audienceValidator),
  },
  handler: async (ctx, a) => {
    const name = a.name.trim();
    if (!name) throw new Error("a campaign needs a name");
    const id = await ctx.db.insert("campaigns", {
      name,
      subject: a.subject.trim(),
      body: a.body,
      eventId: a.eventId,
      audience: a.audience ?? {
        tags: [], interests: [], stages: [], sources: [],
        manualContactIds: [], excludeContactIds: [],
      },
      status: "draft",
      updatedAt: Date.now(),
    });
    return { id };
  },
});

export const update = internalMutation({
  args: {
    id: v.id("campaigns"),
    name: v.optional(v.string()),
    subject: v.optional(v.string()),
    body: v.optional(v.string()),
    eventId: v.optional(v.union(v.id("events"), v.null())),
    audience: v.optional(audienceValidator),
  },
  handler: async (ctx, a) => {
    const c = await ctx.db.get(a.id);
    if (!c) throw new Error("campaign not found");
    // A sent campaign is a record of something that happened. Editing it would
    // rewrite the history the ledger rows point at.
    if (c.status !== "draft") throw new Error("this campaign has already been sent");
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (a.name !== undefined) {
      const n = a.name.trim();
      if (!n) throw new Error("a campaign needs a name");
      patch.name = n;
    }
    if (a.subject !== undefined) patch.subject = a.subject.trim();
    if (a.body !== undefined) patch.body = a.body;
    if (a.eventId !== undefined) patch.eventId = a.eventId ?? undefined;
    if (a.audience !== undefined) patch.audience = a.audience;
    await ctx.db.patch(a.id, patch);
    return { ok: true };
  },
});

export const remove = internalMutation({
  args: { id: v.id("campaigns") },
  handler: async (ctx, { id }) => {
    const c = await ctx.db.get(id);
    if (!c) return { ok: true };
    if (c.status !== "draft") throw new Error("a sent campaign is a record, not a draft");
    await ctx.db.delete(id);
    return { ok: true };
  },
});

// --- sending ----------------------------------------------------------------

// Take the campaign out of draft in its own transaction, so two operators
// pressing send at the same second produce one send and one error rather than
// two sends. Everything after this point is allowed to be slow; this is the
// only part that has to be atomic.
export const claimSend = internalMutation({
  args: { id: v.id("campaigns") },
  handler: async (ctx, { id }) => {
    const c = await ctx.db.get(id);
    if (!c) throw new Error("campaign not found");
    if (c.status === "sending") throw new Error("this campaign is already sending");
    if (c.status === "sent") throw new Error("this campaign has already been sent");
    if (!c.subject.trim()) throw new Error("the campaign needs a subject");
    if (!c.body.trim()) throw new Error("the campaign has no message in it");
    await ctx.db.patch(id, { status: "sending", error: undefined, updatedAt: Date.now() });
    return { ok: true };
  },
});

export const finishSend = internalMutation({
  args: {
    id: v.id("campaigns"),
    matched: v.number(),
    queued: v.number(),
    skipped: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, {
      status: a.error ? "failed" : "sent",
      matched: a.matched,
      queued: a.queued,
      skipped: a.skipped,
      error: a.error,
      sentAt: a.error ? undefined : Date.now(),
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

// One batch of already-rendered messages. Rendering happens in the action
// because the unsubscribe token needs WebCrypto; the ledger write and the
// enqueue happen here, in one transaction, because a row that says "queued"
// for a message that was never handed to Resend is worse than no row.
export const enqueueBatch = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    messages: v.array(
      v.object({
        contactId: v.id("contacts"),
        toEmail: v.string(),
        subject: v.string(),
        html: v.string(),
        text: v.string(),
        unsubUrl: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { campaignId, messages }) => {
    const from = process.env.EMAIL_FROM;
    if (!process.env.RESEND_API_KEY || !from) {
      throw new Error("email not configured: set RESEND_API_KEY and EMAIL_FROM");
    }
    let queued = 0;
    let skipped = 0;

    for (const m of messages) {
      const dedupeKey = `campaign:${campaignId}:${m.contactId}`;
      const prior = await ctx.db
        .query("emailSends")
        .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
        .first();
      // A resend after a partial failure must not mail the people who already
      // got it.
      if (prior && prior.status !== "failed") { skipped++; continue; }

      // Suppression is re-checked here rather than trusted from the preview:
      // between the preview and this transaction somebody may have clicked
      // unsubscribe in an earlier message.
      const supp = await ctx.db
        .query("suppressions")
        .withIndex("by_email", (q) => q.eq("email", m.toEmail))
        .first();
      if (supp) {
        if (!prior) {
          await ctx.db.insert("emailSends", {
            campaignId, contactId: m.contactId, toEmail: m.toEmail,
            kind: "campaign", dedupeKey, status: "suppressed_skip",
            error: `suppressed: ${supp.reason}`,
          });
        }
        skipped++;
        continue;
      }

      const headers = m.unsubUrl
        ? [
            { name: "List-Unsubscribe", value: `<${m.unsubUrl}>` },
            { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
          ]
        : undefined;

      try {
        const emailId = await resend.sendEmail(ctx, {
          from,
          to: m.toEmail,
          subject: m.subject,
          html: m.html,
          text: m.text,
          headers,
        });
        const fields = {
          campaignId, contactId: m.contactId, toEmail: m.toEmail,
          kind: "campaign" as const, dedupeKey,
          status: "queued" as const, componentEmailId: emailId, error: undefined,
        };
        if (prior) await ctx.db.patch(prior._id, fields);
        else await ctx.db.insert("emailSends", fields);
        // The send is activity on the record, same as a note or an RSVP.
        const c = await ctx.db.get(m.contactId);
        if (c) await ctx.db.patch(m.contactId, { lastActivityAt: Date.now() });
        queued++;
      } catch (err: any) {
        const fields = {
          campaignId, contactId: m.contactId, toEmail: m.toEmail,
          kind: "campaign" as const, dedupeKey,
          status: "failed" as const, error: String(err?.message || err),
        };
        if (prior) await ctx.db.patch(prior._id, fields);
        else await ctx.db.insert("emailSends", fields);
        skipped++;
      }
    }
    return { queued, skipped };
  },
});

// Rendered one at a time rather than once with a merge field, because the two
// things that vary per recipient are the greeting and the unsubscribe token,
// and a shared unsubscribe link would unsubscribe whoever clicked it from
// somebody else's address.
const BATCH = 20;

type SendResult = { matched: number; queued: number; skipped: number; error?: string };

export const send = internalAction({
  args: { id: v.id("campaigns"), testEmail: v.optional(v.string()) },
  handler: async (ctx, { id, testEmail }): Promise<SendResult> => {
    const loaded: any = await ctx.runQuery(internal.campaigns.get, { id });
    if (!loaded) throw new Error("campaign not found");
    const c = loaded.campaign;

    const siteOrigin = (process.env.SITE_ORIGIN || "https://mixandgreet.com").replace(/\/+$/, "");
    const secret = process.env.UNSUB_SECRET;

    let ev: any = undefined;
    if (c.eventId) {
      const row: any = await ctx.runQuery(internal.campaigns.eventForCampaign, {
        eventId: c.eventId,
      });
      if (row) ev = row;
    }

    // A test goes to one address and never touches the campaign's state, so an
    // operator can read the real thing in their own inbox before committing the
    // list. It is deliberately NOT ledgered against the campaign: a test in the
    // send history is a row that looks like a recipient nobody can explain.
    if (testEmail) {
      const { html, text } = renderCampaign({
        subject: c.subject, body: c.body, name: undefined, event: ev,
        siteOrigin, showUnsub: false,
      });
      await ctx.runMutation(internal.campaigns.sendOneOff, {
        toEmail: testEmail.trim().toLowerCase(),
        subject: `[test] ${c.subject}`,
        html, text,
        // Ledgered as a campaign because that is what it is, but with no
        // campaignId, so it never appears in the campaign's own recipient list
        // as a person nobody can account for.
        kind: "campaign",
        dedupeKey: `campaign_test:${id}:${Date.now()}`,
      });
      return { matched: 0, queued: 1, skipped: 0 };
    }

    await ctx.runMutation(internal.campaigns.claimSend, { id });

    try {
      const audience: any = await ctx.runQuery(internal.campaigns.preview, {
        audience: c.audience,
      });
      const recipients: any[] = audience.recipients;
      let queued = 0;
      let skipped = audience.blockedCount;

      for (let i = 0; i < recipients.length; i += BATCH) {
        const slice = recipients.slice(i, i + BATCH);
        const messages = [];
        for (const r of slice) {
          let unsubUrl: string | undefined;
          if (secret) {
            const token = await unsubToken(secret, r.email);
            unsubUrl = `${siteOrigin}/unsubscribe?e=${encodeURIComponent(r.email)}&t=${token}`;
          }
          const { html, text } = renderCampaign({
            subject: c.subject, body: c.body, name: r.name, event: ev,
            unsubUrl, siteOrigin, showUnsub: true,
          });
          messages.push({
            contactId: r._id, toEmail: r.email, subject: c.subject, html, text, unsubUrl,
          });
        }
        const out: any = await ctx.runMutation(internal.campaigns.enqueueBatch, {
          campaignId: id, messages,
        });
        queued += out.queued;
        skipped += out.skipped;
      }

      await ctx.runMutation(internal.campaigns.finishSend, {
        id, matched: recipients.length, queued, skipped,
      });
      return { matched: recipients.length, queued, skipped };
    } catch (err: any) {
      const message = String(err?.message || err);
      await ctx.runMutation(internal.campaigns.finishSend, {
        id, matched: 0, queued: 0, skipped: 0, error: message,
      });
      return { matched: 0, queued: 0, skipped: 0, error: message };
    }
  },
});

// The event facts a campaign needs, resolved once rather than per recipient.
export const eventForCampaign = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const ev = await ctx.db.get(eventId);
    if (!ev) return null;
    // Numeric, matching the invite link (/i/08-29-26) and the confirmation
    // email. An ISO date here would be the only "2026-09-12" in a set of
    // messages that all otherwise read 09-12-26. Parsed by hand rather than
    // through Date so no timezone can shift the day.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ev.date);
    const stamp = m ? `${m[2]}-${m[3]}-${m[1].slice(2)}` : ev.date;
    const when = [stamp, [ev.start, ev.end].filter(Boolean).join(" – ")]
      .filter(Boolean)
      .join(" · ");
    return {
      title: ev.title,
      whenLine: when || undefined,
      location: ev.location || undefined,
      inviteUrl: inviteUrl(ev.slug || ev._id),
    };
  },
});

// One message, one address, outside any campaign: the test send above and the
// operator's one-to-one reply both land here.
export const sendOneOff = internalMutation({
  args: {
    toEmail: v.string(),
    subject: v.string(),
    html: v.string(),
    text: v.string(),
    dedupeKey: v.string(),
    contactId: v.optional(v.id("contacts")),
    kind: v.optional(v.union(v.literal("campaign"), v.literal("crm_reply"))),
  },
  handler: async (ctx, a) => {
    const from = process.env.EMAIL_FROM;
    if (!process.env.RESEND_API_KEY || !from) {
      throw new Error("email not configured: set RESEND_API_KEY and EMAIL_FROM");
    }
    const supp = await ctx.db
      .query("suppressions")
      .withIndex("by_email", (q) => q.eq("email", a.toEmail))
      .first();
    // A reply to somebody who unsubscribed is still blocked. They asked not to
    // be mailed, and the fact that they wrote in first does not undo that.
    if (supp) return { skipped: `suppressed: ${supp.reason}` };

    try {
      const emailId = await resend.sendEmail(ctx, {
        from, to: a.toEmail, subject: a.subject, html: a.html, text: a.text,
      });
      await ctx.db.insert("emailSends", {
        contactId: a.contactId,
        toEmail: a.toEmail,
        kind: a.kind ?? "crm_reply",
        dedupeKey: a.dedupeKey,
        status: "queued",
        componentEmailId: emailId,
      });
      if (a.contactId) {
        await ctx.db.patch(a.contactId, { lastActivityAt: Date.now() });
      }
      return { ok: true };
    } catch (err: any) {
      await ctx.db.insert("emailSends", {
        contactId: a.contactId,
        toEmail: a.toEmail,
        kind: a.kind ?? "crm_reply",
        dedupeKey: a.dedupeKey,
        status: "failed",
        error: String(err?.message || err),
      });
      throw err;
    }
  },
});

type ReplyResult = { ok?: boolean; skipped?: string };

// The operator answering one lead, from inside the record they are reading.
export const reply = internalAction({
  args: {
    contactId: v.id("contacts"),
    subject: v.string(),
    body: v.string(),
    eventId: v.optional(v.id("events")),
  },
  handler: async (ctx, a): Promise<ReplyResult> => {
    const loaded: any = await ctx.runQuery(internal.crm.getContact, { id: a.contactId });
    if (!loaded) throw new Error("contact not found");
    const c = loaded.contact;
    const subject = a.subject.trim();
    const body = a.body.trim();
    if (!subject) throw new Error("the reply needs a subject");
    if (!body) throw new Error("the reply has nothing in it");

    let ev: any = undefined;
    if (a.eventId) {
      ev = await ctx.runQuery(internal.campaigns.eventForCampaign, { eventId: a.eventId });
    }
    const siteOrigin = (process.env.SITE_ORIGIN || "https://mixandgreet.com").replace(/\/+$/, "");
    const { html, text } = renderCampaign({
      subject, body, name: c.name, event: ev ?? undefined, siteOrigin, showUnsub: false,
    });

    return await ctx.runMutation(internal.campaigns.sendOneOff, {
      toEmail: c.email,
      subject,
      html,
      text,
      contactId: a.contactId,
      kind: "crm_reply",
      // Timestamped, because a second reply to the same person is a second
      // reply, not a duplicate to be swallowed.
      dedupeKey: `crm_reply:${a.contactId}:${Date.now()}`,
    });
  },
});
