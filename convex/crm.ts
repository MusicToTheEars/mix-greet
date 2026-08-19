// The CRM layer: contacts as records rather than addresses, the companies they
// roll up to, operator notes, and the timeline that puts the two together.
//
// Nothing here invents a new source of truth. A contact's history is assembled
// at read time out of the tables that already own it (rsvps, emailSends,
// brandInterests, crmNotes) rather than mirrored into an events table, because
// a mirror needs every write path on this deployment to remember it exists and
// is wrong the first time one forgets.

import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";

// Domains that are a person, not a company. A contact at gmail.com is not
// evidence of an account called Gmail, and rolling them up would produce one
// enormous fake company that swallows half the list.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "zoho.com",
  "mail.com", "yandex.com", "comcast.net", "att.net", "verizon.net",
  "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "hey.com",
]);

export function domainOf(email: string): string | undefined {
  const at = String(email || "").toLowerCase().trim().split("@")[1];
  if (!at) return undefined;
  const d = at.replace(/^www\./, "");
  if (!d.includes(".")) return undefined;
  return FREE_MAIL.has(d) ? undefined : d;
}

// Normalised for comparison only. Never stored: the operator sees the name as
// it was typed, and this exists so "Pioneer DJ, Inc." and "pioneer dj inc"
// stop being two accounts.
function nameKey(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|gmbh|sa|plc)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// Find or create the account a person belongs to.
//
// Domain first, name second, and that order is the whole point: the domain is
// evidence and the name is a claim. Two people who type the company name
// differently but mail from the same domain are one account; two people who
// type the same name from different domains probably are too, which is why the
// name pass exists at all, but it only runs when there is no domain to trust.
export async function resolveCompany(
  ctx: MutationCtx,
  opts: { name?: string; email?: string; createdFrom: "brand_interest" | "rsvp" | "manual" },
): Promise<Id<"companies"> | undefined> {
  const name = String(opts.name || "").trim();
  const domain = opts.email ? domainOf(opts.email) : undefined;
  if (!name && !domain) return undefined;

  if (domain) {
    const hit = await ctx.db
      .query("companies")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();
    if (hit) {
      // A row created from a bare domain has the domain as its name. The first
      // human-typed name that arrives is better than that, so take it.
      if (name && hit.name === domain) {
        await ctx.db.patch(hit._id, { name, updatedAt: Date.now() });
      }
      return hit._id;
    }
  }

  if (name) {
    const key = nameKey(name);
    if (key) {
      const all = await ctx.db.query("companies").collect();
      const hit = all.find((c) => nameKey(c.name) === key);
      if (hit) {
        if (domain && !hit.domain) {
          await ctx.db.patch(hit._id, { domain, updatedAt: Date.now() });
        }
        return hit._id;
      }
    }
  }

  return await ctx.db.insert("companies", {
    name: name || domain!,
    domain,
    createdFrom: opts.createdFrom,
    updatedAt: Date.now(),
  });
}

// Fold new facts into a contact without ever losing an old one.
//
// Every field here is additive or fill-the-blank. A second submission that
// leaves the job title empty must not erase the title the first one gave, and a
// brand that ticks two product categories this time and three next time is
// interested in five things, not three.
export async function enrichContact(
  ctx: MutationCtx,
  contactId: Id<"contacts">,
  facts: {
    name?: string;
    title?: string;
    company?: string;
    phone?: string;
    interests?: string[];
    tag?: string;
    at?: number;
  },
) {
  const c = await ctx.db.get(contactId);
  if (!c) return;
  const now = facts.at ?? Date.now();

  const interests = new Set(c.interests ?? []);
  (facts.interests ?? []).forEach((i) => {
    const clean = String(i || "").trim();
    if (clean) interests.add(clean);
  });

  const tags = c.tags.slice();
  if (facts.tag && !tags.includes(facts.tag)) tags.push(facts.tag);

  const company = c.company || String(facts.company || "").trim() || undefined;
  const companyId =
    c.companyId ??
    (await resolveCompany(ctx, {
      name: company,
      email: c.email,
      createdFrom: "manual",
    }));

  await ctx.db.patch(contactId, {
    name: c.name || String(facts.name || "").trim() || undefined,
    title: c.title || String(facts.title || "").trim() || undefined,
    phone: c.phone || String(facts.phone || "").trim() || undefined,
    company,
    companyId,
    tags,
    interests: interests.size ? [...interests] : undefined,
    lastActivityAt: Math.max(c.lastActivityAt ?? 0, now),
    stage: c.stage ?? (facts.tag === "brand-interest" ? "lead" : c.stage),
    updatedAt: now,
  });
}

// --- reading the list -------------------------------------------------------

// The whole contact list, filtered in memory.
//
// This deployment's list is measured in hundreds and its ceiling is the size of
// one room's guest list plus the brands that wrote in, so a full scan is the
// honest implementation. Search across name, email, company and interests is
// four different indexes or one pass; it is one pass until the numbers say
// otherwise, and then it is a search index, not a cleverer scan.
export const listContacts = internalQuery({
  args: {
    search: v.optional(v.string()),
    tag: v.optional(v.string()),
    stage: v.optional(v.string()),
    interest: v.optional(v.string()),
    companyId: v.optional(v.id("companies")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("contacts").collect();
    const q = String(a.search || "").trim().toLowerCase();
    const companies = new Map<string, Doc<"companies">>();
    for (const c of await ctx.db.query("companies").collect()) companies.set(c._id, c);

    const filtered = rows.filter((r) => {
      if (a.tag && !r.tags.includes(a.tag)) return false;
      if (a.stage && (r.stage ?? "none") !== a.stage) return false;
      if (a.interest && !(r.interests ?? []).includes(a.interest)) return false;
      if (a.companyId && r.companyId !== a.companyId) return false;
      if (!q) return true;
      const hay = [
        r.name, r.email, r.company, r.title, r.phone,
        ...(r.tags ?? []), ...(r.interests ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    filtered.sort(
      (x, y) =>
        (y.lastActivityAt ?? y.updatedAt ?? 0) - (x.lastActivityAt ?? x.updatedAt ?? 0),
    );

    const limit = Math.max(1, Math.min(a.limit ?? 400, 2000));
    return {
      total: filtered.length,
      contacts: filtered.slice(0, limit).map((r) => ({
        ...r,
        companyName: r.companyId ? companies.get(r.companyId)?.name : undefined,
      })),
    };
  },
});

// Everything the audience builder needs to offer real choices instead of a free
// text box: the labels that actually exist on real contacts, with counts, so an
// operator can see that "Podcast Production" matches four people before sending
// to it.
export const facets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("contacts").collect();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    const tags = new Map<string, number>();
    const interests = new Map<string, number>();
    const stages = new Map<string, number>();
    const sources = new Map<string, number>();
    for (const r of rows) {
      r.tags.forEach((t) => bump(tags, t));
      (r.interests ?? []).forEach((i) => bump(interests, i));
      bump(stages, r.stage ?? "none");
      bump(sources, r.source);
    }
    const out = (m: Map<string, number>) =>
      [...m.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return {
      total: rows.length,
      sendable: rows.filter((r) => r.emailStatus !== "suppressed" && r.emailStatus !== "bounced").length,
      tags: out(tags),
      interests: out(interests),
      stages: out(stages),
      sources: out(sources),
    };
  },
});

// --- one contact, and everything that ever happened to them -----------------

type TimelineItem = {
  at: number;
  kind: string;
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
};

// Assembled from the tables that own each fact. Sorted newest first, because
// the question an operator opens a record to answer is almost always "where did
// we leave this", not "how did it start".
async function timelineFor(ctx: QueryCtx, email: string, contactId?: Id<"contacts">) {
  const items: TimelineItem[] = [];

  const rsvps = await ctx.db
    .query("rsvps")
    .withIndex("by_email", (q) => q.eq("email", email))
    .collect();
  for (const r of rsvps) {
    const ev = await ctx.db.get(r.eventId);
    const what = ev ? ev.title : "an event";
    items.push({
      at: r._creationTime,
      kind: "rsvp",
      title: `RSVP: ${what}`,
      detail: `${r.status}${r.guests > 1 ? ` · party of ${r.guests}` : ""}`,
      meta: { eventId: r.eventId, status: r.status, guests: r.guests },
    });
    // A check-in is a separate event in time from the RSVP that preceded it,
    // and collapsing the two loses the only proof anyone actually turned up.
    if (r.checkedInAt) {
      items.push({
        at: r.checkedInAt,
        kind: "checkin",
        title: `Checked in: ${what}`,
        meta: { eventId: r.eventId },
      });
    }
  }

  const subs = await ctx.db
    .query("brandInterests")
    .withIndex("by_email", (q) => q.eq("email", email))
    .collect();
  for (const s of subs) {
    items.push({
      at: s.submittedAt,
      kind: "brand_interest",
      title: `Partnership questionnaire: ${s.company}`,
      detail: [s.budget, ...(s.solutions ?? []).slice(0, 2)].filter(Boolean).join(" · "),
      meta: { submissionId: s._id, status: s.status },
    });
  }

  const sends = await ctx.db
    .query("emailSends")
    .withIndex("by_toEmail", (q) => q.eq("toEmail", email))
    .collect();
  for (const s of sends) {
    items.push({
      at: s.sentAt ?? s._creationTime,
      kind: "email",
      title: `Email: ${s.kind.replace(/_/g, " ")}`,
      detail: s.error ? `${s.status} · ${s.error}` : s.status,
      meta: { status: s.status, campaignId: s.campaignId },
    });
    // The open is its own moment, days after the send as often as not, and
    // putting it on the send's row would file it under the wrong date. Only the
    // first open earns a line: a pixel refetched eleven times is one event with
    // a count on it, not eleven things that happened.
    if (s.openedAt) {
      items.push({
        at: s.openedAt,
        kind: "open",
        title: `Opened: ${s.kind.replace(/_/g, " ")}`,
        detail:
          (s.openCount ?? 1) > 1 ? `${s.openCount} opens in total` : undefined,
        meta: { campaignId: s.campaignId, openCount: s.openCount },
      });
    }
    if (s.clickedAt) {
      items.push({
        at: s.clickedAt,
        kind: "click",
        title: `Clicked a link: ${s.kind.replace(/_/g, " ")}`,
        detail:
          (s.clickCount ?? 1) > 1 ? `${s.clickCount} clicks in total` : undefined,
        meta: { campaignId: s.campaignId, clickCount: s.clickCount },
      });
    }
  }

  if (contactId) {
    const notes = await ctx.db
      .query("crmNotes")
      .withIndex("by_subject", (q) =>
        q.eq("subjectType", "contact").eq("subjectId", contactId),
      )
      .collect();
    for (const n of notes) {
      items.push({
        at: n.createdAt,
        kind: "note",
        title: n.author ? `Note from ${n.author}` : "Note",
        detail: n.body,
        meta: { noteId: n._id },
      });
    }
  }

  items.sort((a, b) => b.at - a.at);
  return items;
}

export const getContact = internalQuery({
  args: { id: v.id("contacts") },
  handler: async (ctx, { id }) => {
    const c = await ctx.db.get(id);
    if (!c) return null;
    const company = c.companyId ? await ctx.db.get(c.companyId) : null;
    const submissions = await ctx.db
      .query("brandInterests")
      .withIndex("by_email", (q) => q.eq("email", c.email))
      .collect();
    const suppressed = await ctx.db
      .query("suppressions")
      .withIndex("by_email", (q) => q.eq("email", c.email))
      .first();
    // Whether this person reads what we send, which is the question the record
    // is open to answer before anyone writes to them again.
    const sends = await ctx.db
      .query("emailSends")
      .withIndex("by_toEmail", (q) => q.eq("toEmail", c.email))
      .collect();
    const live = sends.filter(
      (s) => s.status !== "failed" && s.status !== "suppressed_skip",
    );
    const opened = live.filter((s) => s.openedAt);

    return {
      contact: c,
      company,
      suppression: suppressed ? { reason: suppressed.reason } : null,
      submissions: submissions.sort((a, b) => b.submittedAt - a.submittedAt),
      engagement: {
        sent: live.length,
        opened: opened.length,
        clicked: live.filter((s) => s.clickedAt).length,
        totalOpens: live.reduce((n, s) => n + (s.openCount ?? 0), 0),
        lastOpenedAt: opened.reduce((m, s) => Math.max(m, s.lastOpenedAt ?? 0), 0) || undefined,
        openRate: live.length
          ? Math.round((opened.length / live.length) * 1000) / 10
          : 0,
      },
      timeline: await timelineFor(ctx, c.email, c._id),
    };
  },
});

export const patchContact = internalMutation({
  args: {
    id: v.id("contacts"),
    name: v.optional(v.string()),
    title: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    stage: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    interests: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    const c = await ctx.db.get(a.id);
    if (!c) throw new Error("contact not found");
    const now = Date.now();

    const patch: Record<string, unknown> = { updatedAt: now };
    // An empty string is an instruction to clear the field; undefined means the
    // caller did not send it. Conflating the two is how a form that only edits
    // the stage wipes the job title.
    const text = (val: string | undefined) =>
      val === undefined ? undefined : val.trim() || undefined;

    if (a.name !== undefined) patch.name = text(a.name);
    if (a.title !== undefined) patch.title = text(a.title);
    if (a.phone !== undefined) patch.phone = text(a.phone);
    if (a.tags !== undefined) patch.tags = a.tags.map((t) => t.trim()).filter(Boolean);
    if (a.interests !== undefined) {
      patch.interests = a.interests.map((t) => t.trim()).filter(Boolean);
    }
    if (a.stage !== undefined) {
      const ok = ["none", "lead", "talking", "proposal", "won", "lost"];
      if (!ok.includes(a.stage)) throw new Error("unknown stage");
      patch.stage = a.stage;
    }
    if (a.company !== undefined) {
      const name = text(a.company);
      patch.company = name;
      // Re-point the account when the operator retypes the company, because the
      // reason they retyped it is usually that the roll-up guessed wrong.
      patch.companyId = name
        ? await resolveCompany(ctx, { name, email: c.email, createdFrom: "manual" })
        : undefined;
    }

    await ctx.db.patch(a.id, patch);
    return { ok: true };
  },
});

// --- notes ------------------------------------------------------------------

export const addNote = internalMutation({
  args: {
    subjectType: v.union(
      v.literal("contact"),
      v.literal("company"),
      v.literal("brandInterest"),
    ),
    subjectId: v.string(),
    body: v.string(),
    author: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const body = a.body.trim();
    if (!body) throw new Error("a note needs something in it");
    const now = Date.now();
    const id = await ctx.db.insert("crmNotes", {
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      body,
      author: a.author?.trim() || undefined,
      createdAt: now,
    });
    // Writing a note is activity. Without this a record that has been worked on
    // all week sorts below one nobody has touched since the RSVP.
    if (a.subjectType === "contact") {
      const c = await ctx.db.get(a.subjectId as Id<"contacts">);
      if (c) await ctx.db.patch(c._id, { lastActivityAt: now });
    }
    return { id };
  },
});

export const listNotes = internalQuery({
  args: {
    subjectType: v.union(
      v.literal("contact"),
      v.literal("company"),
      v.literal("brandInterest"),
    ),
    subjectId: v.string(),
  },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("crmNotes")
      .withIndex("by_subject", (q) =>
        q.eq("subjectType", a.subjectType).eq("subjectId", a.subjectId),
      )
      .collect();
    return rows.sort((a2, b) => b.createdAt - a2.createdAt);
  },
});

export const deleteNote = internalMutation({
  args: { id: v.id("crmNotes") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  },
});

// --- companies --------------------------------------------------------------

export const listCompanies = internalQuery({
  args: { search: v.optional(v.string()) },
  handler: async (ctx, { search }) => {
    const companies = await ctx.db.query("companies").collect();
    const contacts = await ctx.db.query("contacts").collect();
    const q = String(search || "").trim().toLowerCase();

    const rows = companies.map((co) => {
      const people = contacts.filter((c) => c.companyId === co._id);
      const interests = new Set<string>();
      people.forEach((p) => (p.interests ?? []).forEach((i) => interests.add(i)));
      return {
        ...co,
        contactCount: people.length,
        interests: [...interests],
        lastActivityAt: people.reduce((m, p) => Math.max(m, p.lastActivityAt ?? 0), 0),
      };
    });

    const filtered = q
      ? rows.filter((r) =>
          [r.name, r.domain, ...(r.interests ?? [])]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : rows;
    filtered.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name));
    return filtered;
  },
});

export const getCompany = internalQuery({
  args: { id: v.id("companies") },
  handler: async (ctx, { id }) => {
    const co = await ctx.db.get(id);
    if (!co) return null;
    const people = await ctx.db
      .query("contacts")
      .withIndex("by_company", (q) => q.eq("companyId", id))
      .collect();
    // Every submission from anyone at this company, which is the thing the
    // account view exists for: three people writing in from one brand is one
    // conversation, and reading them separately is how it gets answered twice.
    const submissions = [];
    for (const p of people) {
      const subs = await ctx.db
        .query("brandInterests")
        .withIndex("by_email", (q) => q.eq("email", p.email))
        .collect();
      submissions.push(...subs);
    }
    const notes = await ctx.db
      .query("crmNotes")
      .withIndex("by_subject", (q) => q.eq("subjectType", "company").eq("subjectId", id))
      .collect();
    return {
      company: co,
      contacts: people.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
      submissions: submissions.sort((a, b) => b.submittedAt - a.submittedAt),
      notes: notes.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});

export const patchCompany = internalMutation({
  args: {
    id: v.id("companies"),
    name: v.optional(v.string()),
    domain: v.optional(v.string()),
    website: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const co = await ctx.db.get(a.id);
    if (!co) throw new Error("company not found");
    const text = (val?: string) => (val === undefined ? undefined : val.trim() || undefined);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (a.name !== undefined) {
      const name = text(a.name);
      if (!name) throw new Error("a company needs a name");
      patch.name = name;
    }
    if (a.domain !== undefined) {
      patch.domain = text(a.domain)?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    }
    if (a.website !== undefined) patch.website = text(a.website);
    if (a.notes !== undefined) patch.notes = text(a.notes);
    await ctx.db.patch(a.id, patch);
    return { ok: true };
  },
});

// Move one contact to a different account by hand. The roll-up is a guess and
// this is how a person corrects it, so it also rewrites the contact's own
// company string: leaving the old text behind is what makes the next automatic
// pass undo the correction.
export const assignCompany = internalMutation({
  args: { contactId: v.id("contacts"), companyId: v.optional(v.id("companies")) },
  handler: async (ctx, { contactId, companyId }) => {
    const c = await ctx.db.get(contactId);
    if (!c) throw new Error("contact not found");
    const co = companyId ? await ctx.db.get(companyId) : null;
    if (companyId && !co) throw new Error("company not found");
    await ctx.db.patch(contactId, {
      companyId: companyId ?? undefined,
      company: co ? co.name : undefined,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

// --- backfill ---------------------------------------------------------------

// Fill the CRM fields on rows that predate them, from the tables that already
// hold the answers. Idempotent by construction: enrichContact only ever fills
// blanks and unions sets, so running this twice changes nothing the second
// time, and running it after new submissions have arrived is safe.
//
// Batched by table rather than by contact because the input is what exists, not
// what is missing: a contact with no RSVP and no submission has nothing to
// backfill and should never be visited.
export const backfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const touched = new Set<string>();
    let companiesBefore = (await ctx.db.query("companies").collect()).length;

    const subs = await ctx.db.query("brandInterests").collect();
    for (const s of subs) {
      const email = s.email.trim().toLowerCase();
      let c = await ctx.db
        .query("contacts")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (!c) {
        const id = await ctx.db.insert("contacts", {
          name: s.contact,
          email,
          tags: ["brand-interest"],
          emailStatus: "unverified",
          source: "manual",
          updatedAt: s.submittedAt,
        });
        c = await ctx.db.get(id);
      }
      if (!c) continue;
      await enrichContact(ctx, c._id, {
        name: s.contact,
        title: s.title,
        company: s.company,
        interests: [
          ...(s.goals ?? []),
          ...(s.solutions ?? []),
          ...(s.audience ?? []),
          ...(s.categories ?? []),
          ...(s.impact ?? []),
          ...(s.audienceOther ? [s.audienceOther] : []),
          ...(s.categoriesOther ? [s.categoriesOther] : []),
        ],
        tag: "brand-interest",
        at: s.submittedAt,
      });
      touched.add(email);
    }

    const rsvps = await ctx.db.query("rsvps").collect();
    for (const r of rsvps) {
      const email = r.email.trim().toLowerCase();
      const c = await ctx.db
        .query("contacts")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (!c) continue;
      await enrichContact(ctx, c._id, {
        name: r.name,
        title: r.creativeField,
        company: r.company,
        phone: r.phone,
        // A guest's creative field is the closest thing an RSVP has to a stated
        // interest, and it is written in the same vocabulary the questionnaire
        // uses ("Music Producers", "Photographers"), so it belongs in the same
        // bucket the audience builder reads.
        interests: r.creativeField ? [r.creativeField] : [],
        tag: "attendee",
        at: r.checkedInAt ?? r._creationTime,
      });
      touched.add(email);
    }

    const companiesAfter = (await ctx.db.query("companies").collect()).length;
    return {
      contactsTouched: touched.size,
      submissions: subs.length,
      rsvps: rsvps.length,
      companiesCreated: companiesAfter - companiesBefore,
    };
  },
});

// Delete an account. The roll-up is a guess, so a wrong one has to be
// removable, and the alternative to deleting it is a list where half the rows
// are typos of the other half.
//
// The contacts survive: they are people, and they exist independently of the
// guess about where they work. Each is detached rather than deleted, and the
// raw `company` string goes with it, because leaving the text behind is what
// makes the next automatic pass recreate exactly the row that was just removed.
export const removeCompany = internalMutation({
  args: { id: v.id("companies") },
  handler: async (ctx, { id }) => {
    const people = await ctx.db
      .query("contacts")
      .withIndex("by_company", (q) => q.eq("companyId", id))
      .collect();
    for (const p of people) {
      await ctx.db.patch(p._id, {
        companyId: undefined,
        company: undefined,
        updatedAt: Date.now(),
      });
    }
    const notes = await ctx.db
      .query("crmNotes")
      .withIndex("by_subject", (q) => q.eq("subjectType", "company").eq("subjectId", id))
      .collect();
    for (const n of notes) await ctx.db.delete(n._id);
    await ctx.db.delete(id);
    return { ok: true, detached: people.length };
  },
});

// Delete a questionnaire submission. Spam and test rows both arrive through a
// public form, and archiving is the wrong tool for either: an archived row is
// still a lead somebody has to scroll past.
//
// The contact it created is left alone for the same reason as above, and
// because the address may have reached the list through an RSVP as well.
export const removeSubmission = internalMutation({
  args: { id: v.id("brandInterests") },
  handler: async (ctx, { id }) => {
    const notes = await ctx.db
      .query("crmNotes")
      .withIndex("by_subject", (q) =>
        q.eq("subjectType", "brandInterest").eq("subjectId", id),
      )
      .collect();
    for (const n of notes) await ctx.db.delete(n._id);
    await ctx.db.delete(id);
    return { ok: true };
  },
});
