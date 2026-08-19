// Brand Activation & Partnership Interest — the data layer behind
// /brand-interest.
//
// Three things live here and nothing else does: the gate session a brand holds
// while it fills the questionnaire, the write that records a finished
// submission, and the notification that puts it in front of a human. The HTTP
// surface (routes, rate limits, CORS) stays in http.ts, the same as every other
// feature on this deployment.

import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { resend } from "./email";
import { enrichContact } from "./crm";

// Same 12 hours as an admin session. A brand filling this in is doing it in one
// sitting; the TTL only has to outlive an interrupted afternoon.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// --- Gate sessions ----------------------------------------------------------

export const createSession = internalMutation({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    const expiresAt = now + SESSION_TTL_MS;
    await ctx.db.insert("brandSessions", { token, expiresAt });
    return { expiresAt };
  },
});

export const validateToken = internalQuery({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    if (!token) return false;
    const session = await ctx.db
      .query("brandSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session) return false;
    return session.expiresAt > now;
  },
});

// --- The submission ---------------------------------------------------------

// Everything the questionnaire can send. Written as one flat object rather than
// a free-form blob so a malformed client cannot invent fields, and so the shape
// of a lead is legible here without opening the page.
const submission = v.object({
  company: v.string(),
  contact: v.string(),
  title: v.optional(v.string()),
  email: v.string(),
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
});

export const record = internalMutation({
  args: { submission },
  handler: async (ctx, { submission: s }) => {
    const now = Date.now();
    const id = await ctx.db.insert("brandInterests", {
      ...s,
      email: s.email.trim().toLowerCase(),
      status: "new",
      submittedAt: now,
    });

    // The brand's contact joins the list like an RSVP does, tagged so a later
    // campaign can tell a partnership lead from a party guest. Upsert rather
    // than insert: a brand contact who once RSVP'd is the same person, and two
    // rows for one address is what makes a suppression list stop working.
    const email = s.email.trim().toLowerCase();
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    const contactId =
      existing?._id ??
      (await ctx.db.insert("contacts", {
        name: s.contact,
        email,
        tags: [],
        emailStatus: "unverified",
        source: "manual",
        updatedAt: now,
      }));

    // Everything they ticked is copied onto the contact, not left to be read
    // back out of this row. A campaign matches on the contact, and a matcher
    // that has to open every submission to find out who cares about DJ products
    // is a matcher nobody will run twice.
    await enrichContact(ctx, contactId, {
      name: s.contact,
      title: s.title,
      company: s.company,
      interests: [
        ...s.goals,
        ...s.solutions,
        ...s.audience,
        ...s.categories,
        ...s.impact,
        ...(s.audienceOther ? [s.audienceOther] : []),
        ...(s.categoriesOther ? [s.categoriesOther] : []),
      ],
      tag: "brand-interest",
      at: now,
    });

    return { id };
  },
});

export const get = internalQuery({
  args: { id: v.id("brandInterests") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

// Newest first. The whole table, because this is a lead list measured in dozens
// per year, not a feed — paginating it would be ceremony around nothing.
export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("brandInterests").collect();
    return rows.sort((a, b) => b.submittedAt - a.submittedAt);
  },
});

export const setStatus = internalMutation({
  args: {
    id: v.id("brandInterests"),
    status: v.union(
      v.literal("new"),
      v.literal("reviewed"),
      v.literal("archived"),
    ),
  },
  handler: async (ctx, { id, status }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("submission not found");
    await ctx.db.patch(id, { status });
    return { ok: true };
  },
});

// --- Operator notification --------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A list of picks, or the fact that there were none. "—" rather than an empty
// row: a blank cell in an email reads as a rendering fault, and an unanswered
// section is itself worth seeing.
function bullets(items: string[], other?: string): string {
  const all = [...items];
  if (other) all.push(`Other: ${other}`);
  if (!all.length) return `<p style="margin:0;color:#8B8B94;">—</p>`;
  return `<ul style="margin:0;padding-left:18px;color:#EDEAE3;line-height:1.7;">${all
    .map((i) => `<li>${esc(i)}</li>`)
    .join("")}</ul>`;
}

function block(title: string, inner: string): string {
  return `<tr><td style="padding:18px 0 0;">
<div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#EC1C24;font-weight:700;margin-bottom:8px;">${esc(title)}</div>
${inner}
</td></tr>`;
}

function renderNotification(s: any, siteOrigin: string): { html: string; text: string } {
  const facts = [
    ["Company / Brand", s.company],
    ["Contact", s.contact],
    ["Title / Department", s.title],
    ["Email", s.email],
    ["Target date / timeline", s.timeline],
    ["Estimated budget", s.budget],
  ].filter(([, value]) => String(value ?? "").trim());

  const factRows = facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 14px 4px 0;color:#8B8B94;font-size:12px;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;vertical-align:top;">${esc(
          label,
        )}</td><td style="padding:4px 0;color:#EDEAE3;font-size:15px;">${esc(value)}</td></tr>`,
    )
    .join("");

  const prose = (label: string, body?: string) =>
    String(body ?? "").trim()
      ? block(
          label,
          `<p style="margin:0;color:#EDEAE3;line-height:1.7;white-space:pre-wrap;">${esc(body)}</p>`,
        )
      : "";

  const html = `<!doctype html>
<html><body style="margin:0;background:#0B0B0D;color:#EDEAE3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 22px 48px;">
  <div style="font-family:'Helvetica Neue Condensed Bold',Impact,sans-serif;font-size:30px;font-weight:800;letter-spacing:.01em;text-transform:uppercase;color:#EDEAE3;">MIX<span style="color:#EC1C24;">&amp;</span>GREET</div>
  <h1 style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;margin:22px 0 4px;color:#EC1C24;">New brand interest</h1>
  <p style="margin:0 0 18px;color:#8B8B94;font-size:14px;">${esc(s.company)} submitted the partnership questionnaire.</p>
  <div style="background:#141419;border:2px solid #2A2A32;border-top:6px solid #EC1C24;padding:22px;">
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tbody>
      <tr><td colspan="2"><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tbody>${factRows}</tbody></table></td></tr>
    </tbody></table>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tbody>
      ${block("Goals", bullets(s.goals))}
      ${block("Solutions of interest", bullets(s.solutions))}
      ${block("Audience", bullets(s.audience, s.audienceOther))}
      ${block("Product categories", bullets(s.categories, s.categoriesOther))}
      ${block("Community impact", bullets(s.impact))}
      ${prose("What success looks like", s.success)}
      ${prose("Anything else", s.context)}
    </tbody></table>
  </div>
  <p style="margin:22px 0 0;color:#8B8B94;font-size:12px;">Reply straight to <a href="mailto:${esc(
    s.email,
  )}" style="color:#EC1C24;">${esc(s.email)}</a> — ${esc(siteOrigin)}/brand-interest</p>
</div>
</body></html>`;

  const lines = [
    `NEW BRAND INTEREST — ${s.company}`,
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    `Goals: ${s.goals.join("; ") || "—"}`,
    `Solutions: ${s.solutions.join("; ") || "—"}`,
    `Audience: ${[...s.audience, s.audienceOther ? `Other: ${s.audienceOther}` : ""]
      .filter(Boolean)
      .join("; ") || "—"}`,
    `Categories: ${[...s.categories, s.categoriesOther ? `Other: ${s.categoriesOther}` : ""]
      .filter(Boolean)
      .join("; ") || "—"}`,
    `Community impact: ${s.impact.join("; ") || "—"}`,
    "",
    s.success ? `What success looks like:\n${s.success}\n` : "",
    s.context ? `Anything else:\n${s.context}\n` : "",
  ];
  return { html, text: lines.filter((l) => l !== undefined).join("\n") };
}

// Ledger + enqueue, mirroring email.ts's recordAndEnqueue. Separate because
// that one is bound to an RSVP row: it patches confirmationSentAt and keys its
// dedupe off the rsvpId. This send has no guest and no unsubscribe footer — it
// is an internal alert, addressed to the operator, about a form they own.
export const enqueueNotification = internalMutation({
  args: {
    submissionId: v.id("brandInterests"),
    toEmail: v.string(),
    subject: v.string(),
    html: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const dedupeKey = `brand_interest:${args.submissionId}`;
    const prior = await ctx.db
      .query("emailSends")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
      .first();
    if (prior && prior.status !== "failed") return { skipped: "duplicate" };

    const record = async (fields: {
      status: "queued" | "failed";
      error?: string;
      componentEmailId?: string;
    }) => {
      if (prior) {
        await ctx.db.patch(prior._id, { ...fields, error: fields.error });
      } else {
        await ctx.db.insert("emailSends", {
          toEmail: args.toEmail,
          kind: "brand_interest" as const,
          dedupeKey,
          ...fields,
        });
      }
    };

    const from = process.env.EMAIL_FROM;
    if (!process.env.RESEND_API_KEY || !from) {
      await record({
        status: "failed",
        error: "email not configured: set RESEND_API_KEY and EMAIL_FROM",
      });
      return { skipped: "unconfigured" };
    }

    try {
      const emailId = await resend.sendEmail(ctx, {
        from,
        to: args.toEmail,
        subject: args.subject,
        html: args.html,
        text: args.text,
      });
      await record({ status: "queued", componentEmailId: emailId, error: undefined });
      return { enqueued: true };
    } catch (err: any) {
      await record({ status: "failed", error: String(err?.message || err) });
      return { skipped: "error" };
    }
  },
});

// Scheduled from the write path so a mail outage can never fail a submission
// that is already safely in the table.
// The explicit return type is load-bearing, not decoration: this handler calls
// back into internal.brandInterest.*, so without it TypeScript tries to infer
// `notify` from an api object that contains `notify`, and gives up (TS7022).
type NotifyResult = { skipped?: string; enqueued?: boolean };

export const notify = internalAction({
  args: { submissionId: v.id("brandInterests") },
  handler: async (ctx, { submissionId }): Promise<NotifyResult> => {
    const s: any = await ctx.runQuery(internal.brandInterest.get, {
      id: submissionId,
    });
    if (!s) return { skipped: "missing" };

    // Where the alert goes. BRAND_NOTIFY_TO is the explicit setting; without it
    // the alert falls back to the address the deployment already sends AS, so a
    // submission is never silently lost because one env var was forgotten.
    const to =
      (process.env.BRAND_NOTIFY_TO || "").trim() ||
      (process.env.EMAIL_FROM || "").match(/<([^>]+)>/)?.[1] ||
      (process.env.EMAIL_FROM || "").trim();
    if (!to) return { skipped: "no recipient" };

    const siteOrigin = (process.env.SITE_ORIGIN || "https://mixandgreet.com").replace(
      /\/+$/,
      "",
    );
    const { html, text } = renderNotification(s, siteOrigin);
    return await ctx.runMutation(internal.brandInterest.enqueueNotification, {
      submissionId,
      toEmail: to,
      subject: `Brand interest — ${s.company}`,
      html,
      text,
    });
  },
});
