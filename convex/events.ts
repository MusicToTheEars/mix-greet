import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";

// --- Output shape -----------------------------------------------------------
// Deliberately mirrors the old Netlify Blobs record (`id`, `rsvp`, `createdAt`)
// so the public page keeps working, plus the new fields the back office needs
// (`status`, `featured`). Storage ids are resolved to URLs at read time.
async function shape(ctx: QueryCtx | MutationCtx, e: Doc<"events">) {
  const featured = await Promise.all(
    (e.featured ?? []).map(async (f) => ({
      name: f.name,
      kind: f.kind,
      role: f.role ?? "",
      bio: f.bio ?? "",
      link: f.link ?? "",
      imageId: f.imageId ?? null,
      imageUrl: f.imageId ? await ctx.storage.getUrl(f.imageId) : null,
    })),
  );
  return {
    id: e._id,
    title: e.title,
    subtitle: e.subtitle ?? "",
    date: e.date,
    start: e.start ?? "",
    end: e.end ?? "",
    location: e.location ?? "",
    parking: e.parking ?? "",
    notes: e.notes ?? "",
    rsvp: e.rsvpUrl ?? "", // legacy field name the public page reads
    rsvpMode: e.rsvpMode,
    inviteOnly: e.inviteOnly,
    capacity: e.capacity ?? null,
    status: e.status,
    createdAt: e.legacyCreatedAt ?? new Date(e._creationTime).toISOString(),
    featured,
  };
}

async function sortedPublished(ctx: QueryCtx | MutationCtx) {
  const events = await ctx.db
    .query("events")
    .withIndex("by_status_and_date", (q) => q.eq("status", "published"))
    .collect();
  events.sort((a, b) => a.date.localeCompare(b.date));
  return await Promise.all(events.map((e) => shape(ctx, e)));
}

// Everything the back office sees: published (date ascending) and archived
// (most recent first, since that list reads as a history).
async function adminLists(ctx: QueryCtx | MutationCtx) {
  const all = await ctx.db.query("events").collect();
  const published = all
    .filter((e) => e.status === "published")
    .sort((a, b) => a.date.localeCompare(b.date));
  const archived = all
    .filter((e) => e.status === "archived")
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    published: await Promise.all(published.map((e) => shape(ctx, e))),
    archived: await Promise.all(archived.map((e) => shape(ctx, e))),
  };
}

export const listPublished = internalQuery({
  args: {},
  handler: async (ctx) => sortedPublished(ctx),
});

export const listAll = internalQuery({
  args: {},
  handler: async (ctx) => adminLists(ctx),
});

// --- Input ------------------------------------------------------------------
const featuredInput = v.array(
  v.object({
    name: v.string(),
    kind: v.optional(
      v.union(v.literal("artist"), v.literal("speaker"), v.literal("company")),
    ),
    role: v.optional(v.string()),
    imageId: v.optional(v.id("_storage")),
    link: v.optional(v.string()),
    bio: v.optional(v.string()),
  }),
);

const eventInput = v.object({
  title: v.string(),
  subtitle: v.optional(v.string()),
  date: v.string(),
  start: v.optional(v.string()),
  end: v.optional(v.string()),
  location: v.optional(v.string()),
  parking: v.optional(v.string()),
  notes: v.optional(v.string()),
  rsvpUrl: v.optional(v.string()),
  rsvpMode: v.optional(
    v.union(v.literal("external"), v.literal("hosted"), v.literal("closed")),
  ),
  inviteOnly: v.optional(v.boolean()),
  capacity: v.optional(v.number()),
  featured: v.optional(featuredInput),
});

const clamp = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);
const httpUrl = (s: unknown, max = 400) =>
  /^https?:\/\//i.test(clamp(s, max)) ? clamp(s, max) : undefined;

type FeaturedIn = {
  name: string;
  kind?: "artist" | "speaker" | "company";
  role?: string;
  imageId?: Id<"_storage">;
  link?: string;
  bio?: string;
};

// Drop unnamed rows, clamp text, keep at most 12 per event.
function normalizeFeatured(input: FeaturedIn[] | undefined) {
  if (!input) return undefined;
  return input
    .filter((f) => clamp(f.name, 120))
    .slice(0, 12)
    .map((f) => ({
      name: clamp(f.name, 120),
      kind: f.kind ?? ("artist" as const),
      role: clamp(f.role, 80) || undefined,
      bio: clamp(f.bio, 400) || undefined,
      link: httpUrl(f.link),
      imageId: f.imageId,
    }));
}

// Storage objects are only referenced by the event that owns them, so a
// removed reference means the file is now an orphan. Delete it.
async function deleteDroppedImages(
  ctx: MutationCtx,
  before: Doc<"events">["featured"],
  after: ReturnType<typeof normalizeFeatured>,
) {
  const kept = new Set((after ?? []).map((f) => f.imageId).filter(Boolean));
  for (const f of before ?? []) {
    if (f.imageId && !kept.has(f.imageId)) {
      await ctx.storage.delete(f.imageId).catch(() => {});
    }
  }
}

function validate(title: string, date: string) {
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("title and date (YYYY-MM-DD) required");
  }
}

// --- Mutations --------------------------------------------------------------
// Every admin mutation returns the refreshed back-office lists so the UI can
// re-render from one round trip.
export const create = internalMutation({
  args: { event: eventInput },
  handler: async (ctx, { event }) => {
    const title = clamp(event.title, 120);
    const date = clamp(event.date, 10);
    validate(title, date);
    const rsvpUrl = httpUrl(event.rsvpUrl);
    await ctx.db.insert("events", {
      title,
      subtitle: clamp(event.subtitle, 160) || undefined,
      date,
      start: clamp(event.start, 20) || undefined,
      end: clamp(event.end, 20) || undefined,
      location: clamp(event.location, 200) || undefined,
      parking: clamp(event.parking, 300) || undefined,
      notes: clamp(event.notes, 500) || undefined,
      rsvpUrl,
      // Explicit mode wins; otherwise a Canva link means external, none means closed.
      rsvpMode: event.rsvpMode ?? (rsvpUrl ? "external" : "closed"),
      inviteOnly: !!event.inviteOnly,
      capacity: event.capacity,
      status: "published",
      featured: normalizeFeatured(event.featured) ?? [],
    });
    return await adminLists(ctx);
  },
});

// Full replace of the editable fields. `featured` is only touched when the
// caller sends it, so a partial save cannot silently wipe the lineup.
export const update = internalMutation({
  args: { id: v.id("events"), event: eventInput },
  handler: async (ctx, { id, event }) => {
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("event not found");

    const title = clamp(event.title, 120);
    const date = clamp(event.date, 10);
    validate(title, date);
    const rsvpUrl = httpUrl(event.rsvpUrl);
    const featured = normalizeFeatured(event.featured);
    if (featured) await deleteDroppedImages(ctx, existing.featured, featured);

    await ctx.db.patch(id, {
      title,
      subtitle: clamp(event.subtitle, 160) || undefined,
      date,
      start: clamp(event.start, 20) || undefined,
      end: clamp(event.end, 20) || undefined,
      location: clamp(event.location, 200) || undefined,
      parking: clamp(event.parking, 300) || undefined,
      notes: clamp(event.notes, 500) || undefined,
      rsvpUrl,
      rsvpMode: event.rsvpMode ?? (rsvpUrl ? "external" : "closed"),
      inviteOnly: !!event.inviteOnly,
      capacity: event.capacity,
      ...(featured ? { featured } : {}),
    });
    return await adminLists(ctx);
  },
});

// Archive / restore. Archiving pulls the event off the public page without
// destroying it or its RSVPs — this is what the back-office archive lists.
export const setStatus = internalMutation({
  args: {
    id: v.id("events"),
    status: v.union(v.literal("published"), v.literal("archived")),
  },
  handler: async (ctx, { id, status }) => {
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("event not found");
    await ctx.db.patch(id, { status });
    return await adminLists(ctx);
  },
});

// Permanent delete. Refuses while RSVPs exist so a guest list can't be lost by
// a stray click — archive is the reversible option the UI steers toward.
export const remove = internalMutation({
  args: { id: v.id("events") },
  handler: async (ctx, { id }) => {
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("event not found");

    const rsvp = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", id))
      .first();
    if (rsvp) {
      throw new Error(
        "this event has RSVPs — archive it instead of deleting so the guest list is kept",
      );
    }

    for (const f of existing.featured ?? []) {
      if (f.imageId) await ctx.storage.delete(f.imageId).catch(() => {});
    }
    await ctx.db.delete(id);
    return await adminLists(ctx);
  },
});
