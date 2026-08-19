import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";

// --- Hosted invite link ------------------------------------------------------
// Every event gets a short public slug at creation, and the shareable invite URL
// is that slug on the public site. Creating an event therefore mints a working
// link; pasting an external URL is an override, not the only way to open RSVPs.
//
// URL SHAPE. The minted string is the product here: it gets texted, pasted into
// a group chat, and rendered by link-preview bots. So it is a clean path on the
// brand domain and carries no query string:
//
//     https://mixandgreet.com/i/mix-and-greet-vol-2-k7fq
//
// not `.../rsvp?event=<slug>`. A query string is what SMS clients and preview
// cards truncate first, and it is the half of a URL people distrust.
//
// DEPLOY CONTRACT, and it is load-bearing: nothing in rsvp.html reads the path.
// That page's only key reader is `new URLSearchParams(location.search).get(
// 'event')`. `/i/<key>` therefore resolves for exactly one reason — the host
// rewrites it to `/rsvp.html?event=<key>` before the page runs.
//
// THE SITE IS ON NETLIFY. That rewrite lives in `_redirects` at the repo root:
//
//     /i/*    /rsvp.html?event=:splat    200
//
// and `_redirects` is where it has to stay. It is in the publish root on
// purpose — redirects declared in netlify.toml have been dropped silently on
// this account before, which for this rule means every invite link in
// circulation 404s with nothing in the build log to say why.
//
// `vercel.json` is also still tracked and declares the same rewrite. It is
// inert: Netlify never reads it. Left in place rather than deleted so a future
// move back is a config choice rather than an archaeology exercise, but it is
// NOT the file to edit — an earlier version of this comment named it as the
// only one that mattered, which was true for exactly as long as the site was on
// Vercel and is a good way to spend an afternoon editing a file nothing reads.
//
// Links minted before this change pointed straight at `/rsvp?event=<key>` and
// still work: same reader, no rewrite needed.
//
// This shape is effectively permanent: the slug is deliberately immutable so
// circulating links keep working, which means links already in the wild can
// never be reshaped. Changing it later is not an option, so it is right now.
const INVITE_PATH = "/i/";

// Host to print in invite links. Deliberately its OWN env var, separate from
// SITE_ORIGIN: SITE_ORIGIN is the CORS allow-origin (see lib/http.ts) and must
// match the host the browser actually serves the site from, which today is
// www.mixandgreet.com. The link we hand a human is the bare apex, which Vercel
// 308s to www with the path intact. Tying the two together would mean choosing
// between a pretty link and a working fetch. SITE_ORIGIN is still honoured as a
// fallback so a single-variable setup keeps working.
const DEFAULT_INVITE_ORIGIN = "https://mixandgreet.com";

// The resolved origin AND where it came from. The second half matters: with
// neither env var set this function still returns a confident, correct-looking
// absolute URL, and the back office would render minted-but-dead links as if
// nothing were wrong. `source: "fallback"` is what the back office raises a
// warning on, so a misconfigured deployment is visible before a link is texted.
export type InviteOriginInfo = {
  origin: string;
  source: "INVITE_ORIGIN" | "SITE_ORIGIN" | "fallback";
};

export function inviteOriginInfo(): InviteOriginInfo {
  const candidates = [
    ["INVITE_ORIGIN", process.env.INVITE_ORIGIN],
    ["SITE_ORIGIN", process.env.SITE_ORIGIN],
  ] as const;
  for (const [name, candidate] of candidates) {
    const raw = String(candidate ?? "").trim().replace(/\/+$/, "");
    // "*" is a legitimate CORS value but not a URL, so it must not leak in here.
    if (/^https?:\/\/[^\s*]+$/i.test(raw)) return { origin: raw, source: name };
  }
  return { origin: DEFAULT_INVITE_ORIGIN, source: "fallback" };
}

export function inviteOrigin(): string {
  return inviteOriginInfo().origin;
}

// `key` is the slug when the event has one, otherwise its document id. Both
// resolve, so links minted before slugs existed keep working forever.
export function inviteUrl(key: string): string {
  return `${inviteOrigin()}${INVITE_PATH}${encodeURIComponent(key)}`;
}

// Lowercase alphanumerics minus the glyphs that get misread aloud or in print
// (0/o, 1/l/i). The slug is an identifier, not a secret: /api/events already
// publishes every event, so it is generated for legibility plus collision
// avoidance, and uniqueness is enforced against the by_slug index below.
const SLUG_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const randomChars = (n: number) =>
  Array.from(
    { length: n },
    () => SLUG_CHARS[Math.floor(Math.random() * SLUG_CHARS.length)],
  ).join("");

// "Mix & Greet Vol. 2" -> "mix-and-greet-vol-2"
//
// The stem is capped at 28 characters, and the cut lands on a word boundary.
// A hard slice produces fragments: "Mix & Greet Vol. 3 — Spring Session" used
// to mint `mix-and-greet-vol-3-spring-b`, and that dangling "-b" is not a
// cosmetic problem — it is in the string that gets texted, read aloud and
// rendered by link-preview bots. Trim back to the last "-" instead. A single
// word longer than the cap has no boundary to fall back to, so it is still
// sliced rather than dropped.
//
// Tag-shaped runs are removed first, for the same reason. Titles are rendered
// as literal text everywhere (the back office builds every node with
// textContent), so a title really can contain "<b>Session</b>" — and left in,
// the angle brackets become separators and mint `...-b-session-b`. Two junk
// one-letter tokens in a URL people read aloud. This only strips a run that has
// both brackets, so a title like "Under <5 minutes" keeps its text.
const SLUG_STEM_MAX = 28;

// Accented Latin is FOLDED, not deleted, and that is the same bug as the
// dangling "-b" rather than a nicety. `[^a-z0-9]+` on its own does not strip an
// accent, it strips the letter: "Sesión de Verano · Año Nuevo" minted
// `sesi-n-de-verano-a-o-nuevo`, "Mixtape Café" minted `mixtape-caf`, and the
// word-boundary logic below never gets a chance because the damage happens
// character by character before it runs. Unlike a bad truncation this one is
// permanent — the slug is minted once and NEVER rewritten (see `update`), so
// the event carries that URL for life. This venue is in Los Angeles.
//
// NFD splits "é" into "e" plus a combining accent; dropping the combining
// marks keeps the letter. The short table below covers the handful of Latin
// letters NFD does not decompose at all (ß, æ, ø, ...), which would otherwise
// still vanish. Anything outside Latin (Cyrillic, Greek, CJK, emoji) has no
// meaningful ASCII fold, so it still washes out and `mintSlug` falls back to a
// pure random token — a short opaque slug, never a mangled one.
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const LATIN_DIGRAPHS: Record<string, string> = {
  "æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "þ": "th",
  "đ": "d", "ð": "d", "ł": "l", "ħ": "h", "ŧ": "t", "ı": "i",
};

export function foldLatin(lowercased: string): string {
  return lowercased
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/[æœøßþđðłħŧı]/g, (c) => LATIN_DIGRAPHS[c] ?? c);
}

function slugifyTitle(title: string): string {
  const full = foldLatin(title.toLowerCase())
    .replace(/<[^<>]*>/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= SLUG_STEM_MAX) return full;

  const cut = full.slice(0, SLUG_STEM_MAX);
  // The cut already landed on a boundary — the next character is the separator,
  // so every word in `cut` is whole and trimming back would lose one for free.
  if (full[SLUG_STEM_MAX] === "-") return cut.replace(/-+$/g, "");

  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

async function slugTaken(ctx: MutationCtx, slug: string): Promise<boolean> {
  const hit = await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
  return hit !== null;
}

// "2026-08-29" -> "08-29-26". The invite link a guest is handed reads as the
// night they are being invited to, which is the one fact they already know and
// the only one that makes a texted URL self-evidently current.
//
// US order, because the audience is Los Angeles and the rest of the product
// prints "AUG 15" rather than "15 AUG".
export function dateSlug(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || "").trim());
  if (!m) return "";
  return `${m[2]}-${m[3]}-${m[1].slice(2)}`;
}

// The date is the stem. A title stem is the fallback, and a random token the
// fallback to that, so minting can never fail for want of either.
//
// Two events CAN land on one date, whatever the calendar feels like: a matinee
// and an evening, or a new event on the day an archived one already used. The
// premise that dates never repeat is the reason to try the date first, not a
// reason to assume the second one away — an unsuffixed collision would hand two
// events the same public link, and the loser would be unreachable. The suffix
// is `-2`, `-3`, counting, rather than random, so the second event of a day
// still has a link somebody can read down the phone.
async function mintSlug(
  ctx: MutationCtx,
  title: string,
  date?: string,
): Promise<string> {
  const day = dateSlug(date ?? "");
  if (day) {
    if (!(await slugTaken(ctx, day))) return day;
    for (let n = 2; n <= 9; n++) {
      const candidate = `${day}-${n}`;
      if (!(await slugTaken(ctx, candidate))) return candidate;
    }
  }

  const stem = slugifyTitle(title);
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = stem ? `${stem}-${randomChars(4)}` : randomChars(10);
    if (!(await slugTaken(ctx, candidate))) return candidate;
  }
  // Six collisions on a table this size is not realistic; widen rather than throw.
  let wide = randomChars(16);
  while (await slugTaken(ctx, wide)) wide = randomChars(16);
  return wide;
}

// Rows created before the slug field existed get one the first time the back
// office touches them, so no migration script is needed and nothing breaks in
// the meantime (reads fall back to the document id).
//
// This adds a slug and NOTHING ELSE. It is deliberately not allowed to change
// how an event behaves. An earlier draft also flipped closed-with-no-URL rows
// to "hosted", on the reasoning that nobody could have meant to close an event
// before the UI offered the choice. That reasoning was wrong: the old admin
// field was labelled `RSVP link (leave empty to show "RSVP Opens Soon")`, so
// leaving it blank was the documented way to park an event. Repairing those
// rows automatically would silently re-open a parked event, as an unconfirmed
// production write fired by nothing more than someone loading the back office.
//
// Reopening is now an explicit, per-row, confirmed operator action:
// `setRsvpMode` below -> the `openRsvps` action in http.ts -> the "Open RSVPs"
// button rendered on every closed row by `linkCell` in admin.html.
async function backfillRow(ctx: MutationCtx, e: Doc<"events">): Promise<void> {
  if (e.slug) return;
  await ctx.db.patch(e._id, { slug: await mintSlug(ctx, e.title, e.date) });
}

// --- Output shape -----------------------------------------------------------
// Deliberately mirrors the old Netlify Blobs record (`id`, `rsvp`, `createdAt`)
// so the public page keeps working, plus the new fields the back office needs
// (`status`, `featured`, `slug`, `inviteUrl`). Storage ids are resolved to URLs
// at read time.
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
  // Slug when we have one, document id otherwise — /api/rsvp accepts either.
  const key = e.slug || e._id;
  const hosted = inviteUrl(key);
  return {
    id: e._id,
    slug: e.slug ?? "",
    title: e.title,
    subtitle: e.subtitle ?? "",
    date: e.date,
    start: e.start ?? "",
    end: e.end ?? "",
    location: e.location ?? "",
    parking: e.parking ?? "",
    notes: e.notes ?? "",
    // The canonical shareable link. Always present and always absolute, even
    // for external/closed events, so the back office can show it either way.
    inviteUrl: hosted,
    // The operator's own pasted override, kept separate so the edit form can
    // round-trip it without ever mistaking our own link for an external one.
    rsvpExternalUrl: e.rsvpUrl ?? "",
    // Read back so the edit form can round-trip the tags, and so the campaign
    // builder can propose an audience from the event it is already showing.
    interestTags: e.interestTags ?? [],
    // Legacy field name the public page reads to build its RSVP button. A
    // hosted event points it at our invite page; an external one keeps the
    // pasted URL; a closed one stays empty and the page shows "Opens Soon".
    // Driven by the mode, never by the mere presence of a URL, so a closed
    // event cannot hand the public page a live button through a stale field.
    rsvp:
      e.rsvpMode === "hosted"
        ? hosted
        : e.rsvpMode === "external"
          ? (e.rsvpUrl ?? "")
          : "",
    rsvpMode: e.rsvpMode,
    inviteOnly: e.inviteOnly,
    capacity: e.capacity ?? null,
    status: e.status,
    createdAt: e.legacyCreatedAt ?? new Date(e._creationTime).toISOString(),
    // Absolute, because the only consumer is an og:image tag and a crawler
    // will not resolve a relative one. Convex storage URLs already are.
    socialCardUrl: e.socialCardId
      ? await ctx.storage.getUrl(e.socialCardId)
      : null,
    featured,
  };
}

// Re-read after a write so the returned copy carries whatever the mutation
// actually persisted (slug included) rather than the caller's input.
async function shapeById(ctx: MutationCtx, id: Id<"events">) {
  const e = await ctx.db.get(id);
  return e ? await shape(ctx, e) : null;
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
// (most recent first, since that list reads as a history), plus the host every
// invite link on the page was built from. `linkOrigin` rides along on EVERY
// admin response — list, create, update, mode change, archive, delete — because
// the moment it says "fallback" every link in both tables is suspect, and the
// operator has to learn that from the page rather than from a guest.
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
    linkOrigin: inviteOriginInfo(),
  };
}

export const listPublished = internalQuery({
  args: {},
  handler: async (ctx) => sortedPublished(ctx),
});

// What the back office calls. Same lists as `adminLists`, but it first mints
// slugs for any pre-slug rows, so simply opening the office backfills every
// invite link. Idempotent: once every event has a slug this writes nothing.
export const listAllAndBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const e of await ctx.db.query("events").collect()) {
      await backfillRow(ctx, e);
    }
    return await adminLists(ctx);
  },
});

// Look one event up by public key: its invite slug, or a raw document id from a
// link minted before slugs existed. The single place that mapping lives.
async function findByKey(
  ctx: QueryCtx | MutationCtx,
  key: string,
): Promise<Doc<"events"> | null> {
  const k = key.trim().slice(0, 120);
  if (!k) return null;
  const bySlug = await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", k))
    .first();
  if (bySlug) return bySlug;

  // A date key, "08-29-26", resolved against the event's own date.
  //
  // This is what lets the date link work on events minted before dates were
  // slugs, without rewriting a single stored slug. Rewriting them was the
  // obvious move and it is the wrong one: those links are already in
  // circulation — texted, pasted into threads, sitting in sent confirmations —
  // and schema.ts says plainly that a slug is never rewritten so a link already
  // out there stays valid for the life of the event. So both forms resolve, the
  // old one keeps working forever, and the date form starts working today on
  // every event rather than only on the next one created.
  const asDate = /^(\d{2})-(\d{2})-(\d{2})$/.exec(k);
  if (asDate) {
    const iso = `20${asDate[3]}-${asDate[1]}-${asDate[2]}`;
    const sameDay = await ctx.db
      .query("events")
      .withIndex("by_status_and_date", (q) =>
        q.eq("status", "published").eq("date", iso),
      )
      .collect();
    // Exactly one published event that day is the whole point of a date link.
    // Two is the case the premise says cannot happen, and if it ever does, the
    // bare date is genuinely ambiguous — answer with the one created first, the
    // same one that holds the unsuffixed slug, so the link and the lookup agree
    // rather than disagreeing silently.
    if (sameDay.length) {
      return sameDay.reduce((a, b) => (a._creationTime <= b._creationTime ? a : b));
    }
  }

  const id = ctx.db.normalizeId("events", k);
  return id ? await ctx.db.get(id) : null;
}

// Resolve a public key to an event id. Returns null when it matches nothing.
export const resolveKey = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => (await findByKey(ctx, key))?._id ?? null,
});

// One published event by slug or id, shaped exactly like a list entry. Backs
// the invite page so it does not have to download and scan every event.
export const getPublicByKey = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const event = await findByKey(ctx, key);
    if (!event || event.status !== "published") return null;
    return await shape(ctx, event);
  },
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
  // What this event is FOR, in the brand questionnaire's own vocabulary. Read
  // by the campaign builder to propose an audience; see schema.ts.
  interestTags: v.optional(v.array(v.string())),
  // The link-preview card, already uploaded by the back office. An id, not
  // bytes: the browser PUTs the PNG straight to Convex storage and sends only
  // the handle, the same way featured[].imageId works.
  socialCardId: v.optional(v.id("_storage")),
});

const clamp = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

// Interest tags are matched against contacts by exact string, so they are
// trimmed and de-duplicated but never case-folded: the labels come from the
// questionnaire's own option lists and have to survive the round trip
// character for character or the match silently finds nobody.
function normalizeTags(tags?: string[]): string[] | undefined {
  if (!tags) return undefined;
  const out: string[] = [];
  for (const t of tags.slice(0, 60)) {
    const clean = clamp(t, 200);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}
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

// Explicit mode wins. Otherwise a pasted link means external and a blank field
// means hosted — creating an event mints a working invite rather than a dead
// "closed" one. "closed" is now only ever chosen deliberately.
function resolveMode(
  requested: "external" | "hosted" | "closed" | undefined,
  rsvpUrl: string | undefined,
): "external" | "hosted" | "closed" {
  if (requested === "external") return rsvpUrl ? "external" : "hosted";
  if (requested) return requested;
  return rsvpUrl ? "external" : "hosted";
}

// --- Mutations --------------------------------------------------------------
// Every admin mutation returns the refreshed back-office lists so the UI can
// re-render from one round trip. Create/update additionally return `saved`: the
// shaped event that was just written, which is how the UI gets its invite link.
// Attach a link-preview card to an event, and nothing else.
//
// Deliberately narrow. The obvious way to backfill cards for events that
// predate the feature is to re-run `update` with the event read back and one
// field added — and that round trip is exactly where a backfill goes wrong: it
// re-normalises featured rows, re-resolves rsvpMode from a URL, and re-clamps
// every string, so a script whose only job is to attach an image can silently
// rewrite an event's RSVP behaviour. This touches one field.
export const setSocialCard = internalMutation({
  args: { id: v.id("events"), socialCardId: v.id("_storage") },
  handler: async (ctx, { id, socialCardId }) => {
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("event not found");
    await ctx.db.patch(id, { socialCardId });
    // Same orphan cleanup the update path does: a replaced card is a file
    // nothing can reach again.
    if (existing.socialCardId && existing.socialCardId !== socialCardId) {
      await ctx.storage.delete(existing.socialCardId).catch(() => {});
    }
    return { ok: true as const, id, socialCardId };
  },
});

export const create = internalMutation({
  args: { event: eventInput },
  handler: async (ctx, { event }) => {
    const title = clamp(event.title, 120);
    const date = clamp(event.date, 10);
    validate(title, date);
    const rsvpUrl = httpUrl(event.rsvpUrl);
    const id = await ctx.db.insert("events", {
      title,
      slug: await mintSlug(ctx, title, date),
      subtitle: clamp(event.subtitle, 160) || undefined,
      date,
      start: clamp(event.start, 20) || undefined,
      end: clamp(event.end, 20) || undefined,
      location: clamp(event.location, 200) || undefined,
      parking: clamp(event.parking, 300) || undefined,
      notes: clamp(event.notes, 500) || undefined,
      rsvpUrl,
      rsvpMode: resolveMode(event.rsvpMode, rsvpUrl),
      inviteOnly: !!event.inviteOnly,
      capacity: event.capacity,
      status: "published",
      socialCardId: event.socialCardId,
      featured: normalizeFeatured(event.featured) ?? [],
      interestTags: normalizeTags(event.interestTags),
    });
    return { ...(await adminLists(ctx)), saved: await shapeById(ctx, id) };
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
    // A regenerated card replaces the old one, so the old file is now
    // unreachable. Deleted rather than left behind: these are ~200 KB each and
    // an event edited a dozen times would otherwise leave a dozen orphans that
    // nothing references and nothing will ever clean up.
    if (
      event.socialCardId &&
      existing.socialCardId &&
      existing.socialCardId !== event.socialCardId
    ) {
      await ctx.storage.delete(existing.socialCardId).catch(() => {});
    }

    await ctx.db.patch(id, {
      title,
      // The slug is minted once and never rewritten — a retitled event must not
      // break links that are already out in the world. Pre-slug rows get one here.
      slug: existing.slug ?? (await mintSlug(ctx, title, date)),
      subtitle: clamp(event.subtitle, 160) || undefined,
      date,
      start: clamp(event.start, 20) || undefined,
      end: clamp(event.end, 20) || undefined,
      location: clamp(event.location, 200) || undefined,
      parking: clamp(event.parking, 300) || undefined,
      notes: clamp(event.notes, 500) || undefined,
      rsvpUrl,
      rsvpMode: resolveMode(event.rsvpMode, rsvpUrl),
      inviteOnly: !!event.inviteOnly,
      capacity: event.capacity,
      // Only when a new one was generated. A save that did not regenerate the
      // card must not blank the one already stored — the back office omits the
      // field entirely in that case, and `undefined` here would erase it.
      ...(event.socialCardId ? { socialCardId: event.socialCardId } : {}),
      ...(featured ? { featured } : {}),
      // Same rule as featured: only touched when the caller sends it, so a save
      // from a form that predates the field cannot wipe the tags.
      ...(event.interestTags ? { interestTags: normalizeTags(event.interestTags) } : {}),
    });
    return { ...(await adminLists(ctx)), saved: await shapeById(ctx, id) };
  },
});

// Open or park RSVPs on one event, deliberately and one row at a time.
//
// This is the safe replacement for the automatic "repair" the backfill used to
// do. Events that predate the hosted-invite change are parked as "closed" with
// no external URL, and most of them want to be open — but that is a judgement
// call about a live event, so it is an operator's click with a confirm, not a
// side effect of loading a page.
//
// All three modes are reachable, and "external" has to be, because parking is
// not a one-way door. An earlier version accepted only hosted|closed and
// claimed in this comment that "`rsvpUrl` is left untouched, so parking an
// external event and reopening it later restores the same link" — untrue twice
// over: reopening could only ever produce "hosted", which quietly moves every
// guest off the operator's Eventbrite page and onto our form; and the only way
// to park an external event was the edit form, which used to send an empty
// `rsvpUrl` and delete the saved link on the way through.
//
// Both halves are fixed: the caller now names the mode it wants, the back
// office offers "Close RSVPs" directly on an external row, and the edit form
// only clears `rsvpUrl` when the operator explicitly chooses the hosted page.
// "external" is refused unless the row still carries a link to send guests to,
// so this can never mint a mode with nowhere to go.
export const setRsvpMode = internalMutation({
  args: {
    id: v.id("events"),
    mode: v.union(
      v.literal("hosted"),
      v.literal("closed"),
      v.literal("external"),
    ),
  },
  handler: async (ctx, { id, mode }) => {
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("event not found");
    if (mode === "external" && !httpUrl(existing.rsvpUrl)) {
      throw new Error(
        "no external RSVP link is saved on this event — edit it and paste one",
      );
    }
    await ctx.db.patch(id, {
      rsvpMode: mode,
      // A pre-slug row opened from here needs its invite link to exist now.
      slug: existing.slug ?? (await mintSlug(ctx, existing.title, existing.date)),
    });
    return { ...(await adminLists(ctx)), saved: await shapeById(ctx, id) };
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
