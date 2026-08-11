import { httpRouter } from "convex/server";
import { httpAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { checkPassword } from "./auth";
import { inviteOrigin } from "./events";
import { resend } from "./email";
import { verifyUnsubToken } from "./lib/unsub";
import { json, preflight, clean, corsHeaders, csvCell } from "./lib/http";

const http = httpRouter();

// --- Login throttle -----------------------------------------------------------
// The two mutations below live in this module, not auth.ts, on purpose: they
// count HTTP requests to one route and answer 429. Nothing under the transport
// layer knows they exist, and auth.ts stays about what a valid credential is.
//
// Budget: 5 failures per caller per 15 minutes, then that caller is locked out
// for 15 minutes. A second counter with a much wider budget (40) sums every
// failure from every caller, so a spray across forged x-forwarded-for values —
// which is the only caller identity a Convex httpAction can see, and is
// trivially spoofable — still runs out of road. 40 wrong passwords in a quarter
// hour is nothing an operator with one shared password will ever produce.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_CLIENT = 5;
const LOGIN_MAX_GLOBAL = 40;
const LOGIN_GLOBAL_KEY = "global";

function loginClientKey(req: Request): string {
  const fwd = clean((req.headers.get("x-forwarded-for") || "").split(",")[0], 64);
  return fwd ? `ip:${fwd}` : "ip:unknown";
}

async function loginBucket(ctx: any, key: string) {
  return await ctx.db
    .query("adminLoginAttempts")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
}

// Checked BEFORE the password is compared, so a locked-out caller cannot even
// use the endpoint as a timing oracle. Also the only place stale rows are
// pruned, which keeps the write path free of housekeeping.
export const gateLogin = internalMutation({
  args: { clientKey: v.string(), now: v.number() },
  handler: async (ctx, { clientKey, now }) => {
    let retryAfter = 0;
    for (const key of [clientKey, LOGIN_GLOBAL_KEY]) {
      const row = await loginBucket(ctx, key);
      if (!row) continue;
      if (row.lockedUntil <= now && now - row.windowStart > LOGIN_WINDOW_MS) {
        await ctx.db.delete(row._id);
        continue;
      }
      if (row.lockedUntil > now) {
        retryAfter = Math.max(retryAfter, Math.ceil((row.lockedUntil - now) / 1000));
      }
    }
    return { allowed: retryAfter === 0, retryAfter };
  },
});

// Recorded AFTER the comparison, once, for both buckets.
export const settleLogin = internalMutation({
  args: { clientKey: v.string(), now: v.number(), ok: v.boolean() },
  handler: async (ctx, { clientKey, now, ok }) => {
    const buckets: Array<[string, number]> = [
      [clientKey, LOGIN_MAX_PER_CLIENT],
      [LOGIN_GLOBAL_KEY, LOGIN_MAX_GLOBAL],
    ];
    for (const [key, max] of buckets) {
      const row = await loginBucket(ctx, key);
      if (ok) {
        // A correct password clears that caller's record and nothing else. The
        // global counter deliberately survives: one operator logging in during
        // a spray must not hand the sprayer a fresh budget.
        if (key === clientKey && row) await ctx.db.delete(row._id);
        continue;
      }
      if (!row) {
        await ctx.db.insert("adminLoginAttempts", {
          key,
          windowStart: now,
          failures: 1,
          lockedUntil: 0,
        });
        continue;
      }
      // Window lapsed and no lock outstanding: start a fresh count in place.
      if (row.lockedUntil <= now && now - row.windowStart > LOGIN_WINDOW_MS) {
        await ctx.db.patch(row._id, { windowStart: now, failures: 1, lockedUntil: 0 });
        continue;
      }
      const failures = row.failures + 1;
      await ctx.db.patch(row._id, {
        failures,
        lockedUntil: failures >= max ? now + LOGIN_WINDOW_MS : row.lockedUntil,
      });
    }
  },
});

// --- Admin login: exchange the shared password for a 12h session token ------
const login = httpAction(async (ctx, req) => {
  const now = Date.now();
  const clientKey = loginClientKey(req);

  const gate = await ctx.runMutation(internal.http.gateLogin, { clientKey, now });
  if (!gate.allowed) {
    return new Response(
      JSON.stringify({ error: "too many attempts — try again later" }),
      {
        status: 429,
        headers: corsHeaders({ "retry-after": String(gate.retryAfter) }),
      },
    );
  }

  const body = await req.json().catch(() => ({}));
  const password = req.headers.get("x-admin-pass") || (body as any).password || "";
  const ok = checkPassword(clean(password, 200));
  await ctx.runMutation(internal.http.settleLogin, { clientKey, now, ok });
  if (!ok) {
    return json({ error: "unauthorized" }, 401);
  }
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const { expiresAt } = await ctx.runMutation(internal.auth.createSession, {
    token,
    now: Date.now(),
  });
  return json({ ok: true, token, expiresAt });
});

// Shared admin gate: returns true when the request carries a valid token.
async function isAdmin(ctx: any, req: Request): Promise<boolean> {
  const token = clean(req.headers.get("x-admin-token") || "", 200);
  if (!token) return false;
  return await ctx.runQuery(internal.auth.validateToken, {
    token,
    now: Date.now(),
  });
}

// A public event key: the invite slug, or a raw document id from a link minted
// before slugs existed. Resolved to a real id before it reaches a mutation.
async function resolveEventKey(ctx: any, key: string): Promise<string> {
  if (!key) return "";
  const id = await ctx.runQuery(internal.events.resolveKey, { key });
  // Unresolvable keys are passed through untouched so the downstream mutation
  // still answers with its own "event not found", not a different error.
  return id ?? key;
}

// --- Events: public GET, admin POST (create/delete/verify) ------------------
const events = httpAction(async (ctx, req) => {
  if (req.method === "GET") {
    // ?event=<slug|id> narrows to one published event, so the invite page can
    // fetch just the event it is showing. No param keeps the legacy array.
    const key = clean(new URL(req.url).searchParams.get("event"), 120);
    if (key) {
      const event = await ctx.runQuery(internal.events.getPublicByKey, { key });
      return event ? json(event) : json({ error: "event not found" }, 404);
    }
    const list = await ctx.runQuery(internal.events.listPublished, {});
    return json(list);
  }

  // POST: all mutating actions require a valid admin token.
  if (!(await isAdmin(ctx, req))) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = (await req.json().catch(() => ({}))) as any;
  const action = body.action;

  try {
    if (action === "verify") {
      return json({ ok: true });
    }
    // Back office lists: { published: [...], archived: [...] }. A mutation, not
    // a query, because it backfills invite slugs onto any pre-slug rows first.
    if (action === "list") {
      return json(await ctx.runMutation(internal.events.listAllAndBackfill, {}));
    }
    // Short-lived URL the browser POSTs a headshot/logo straight to, so image
    // bytes never pass through this action. Returns { storageId } to the caller.
    if (action === "uploadUrl") {
      return json({ uploadUrl: await ctx.storage.generateUploadUrl() });
    }
    if (action === "create") {
      return json(
        await ctx.runMutation(internal.events.create, { event: body.event || {} }),
      );
    }
    if (action === "update") {
      return json(
        await ctx.runMutation(internal.events.update, {
          id: body.id,
          event: body.event || {},
        }),
      );
    }
    // Open or park RSVPs on one event. Explicit, per-row, and confirmed in the
    // UI — the back office never changes an event's RSVP mode on its own.
    //
    // Three named actions rather than one action carrying a `mode` string: the
    // mode is decided here from a closed set, so no request body can name a
    // mode this route did not mean to expose. `openExternalRsvps` is how an
    // event parked from "external" goes back to the operator's own link instead
    // of being silently converted to a hosted one — the mutation refuses it if
    // the row has no saved link left.
    if (
      action === "openRsvps" ||
      action === "openExternalRsvps" ||
      action === "closeRsvps"
    ) {
      return json(
        await ctx.runMutation(internal.events.setRsvpMode, {
          id: body.id,
          mode:
            action === "openRsvps"
              ? "hosted"
              : action === "openExternalRsvps"
                ? "external"
                : "closed",
        }),
      );
    }
    if (action === "archive" || action === "restore") {
      return json(
        await ctx.runMutation(internal.events.setStatus, {
          id: body.id,
          status: action === "archive" ? "archived" : "published",
        }),
      );
    }
    if (action === "delete") {
      return json(await ctx.runMutation(internal.events.remove, { id: body.id }));
    }
  } catch (err: any) {
    return json({ error: String(err?.message || err) }, 400);
  }
  return json({ error: "unknown action" }, 400);
});

http.route({ path: "/api/admin/login", method: "POST", handler: login });
http.route({ path: "/api/admin/login", method: "OPTIONS", handler: httpAction(async () => preflight()) });

http.route({ path: "/api/events", method: "GET", handler: events });
http.route({ path: "/api/events", method: "POST", handler: events });
http.route({ path: "/api/events", method: "OPTIONS", handler: httpAction(async () => preflight()) });

// --- RSVP submission (public) ------------------------------------------------
const rsvp = httpAction(async (ctx, req) => {
  const body = (await req.json().catch(() => ({}))) as any;
  // Honeypot: bots fill the hidden "website" field. Success-shaped, stores nothing.
  if (clean(body.website, 20)) {
    return json({ ok: true, status: "confirmed" });
  }
  const result = await ctx.runMutation(internal.rsvps.submit, {
    // Accepts an invite slug or a document id; both land on the same event.
    eventId: await resolveEventKey(ctx, clean(body.eventId, 120)),
    name: clean(body.name, 120),
    email: clean(body.email, 200),
    phone: clean(body.phone, 40) || undefined,
    guests: Number(body.guests) || 1,
    notes: clean(body.notes, 500) || undefined,
  });
  return json(result, result.ok ? 200 : 400);
});

http.route({ path: "/api/rsvp", method: "POST", handler: rsvp });
http.route({ path: "/api/rsvp", method: "OPTIONS", handler: httpAction(async () => preflight()) });

// --- Admin guest list + CSV export (token-gated) -----------------------------
const adminRsvps = httpAction(async (ctx, req) => {
  if (!(await isAdmin(ctx, req))) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(req.url);
  const data = await ctx.runQuery(internal.rsvps.listForEvent, {
    eventId: await resolveEventKey(ctx, clean(url.searchParams.get("eventId"), 120)),
  });
  if (!data) return json({ error: "event not found" }, 404);

  if (url.pathname.endsWith(".csv")) {
    const header = "name,email,phone,guests,status,source,notes,createdAt,confirmationSentAt";
    const rows = data.rsvps.map((r) =>
      [r.name, r.email, r.phone, r.guests, r.status, r.source, r.notes, r.createdAt, r.confirmationSentAt]
        .map(csvCell)
        .join(","),
    );
    return new Response([header, ...rows].join("\r\n") + "\r\n", {
      status: 200,
      headers: corsHeaders({
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="rsvps-${data.event.date}.csv"`,
      }),
    });
  }
  return json(data);
});

http.route({ path: "/api/admin/rsvps", method: "GET", handler: adminRsvps });
http.route({ path: "/api/admin/rsvps", method: "OPTIONS", handler: httpAction(async () => preflight()) });
http.route({ path: "/api/admin/rsvps.csv", method: "GET", handler: adminRsvps });
http.route({ path: "/api/admin/rsvps.csv", method: "OPTIONS", handler: httpAction(async () => preflight()) });

// --- Resend webhook (Svix signature verified by the component) ---------------
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    return await resend.handleResendEventWebhook(ctx, req);
  }),
});

// --- One-click unsubscribe ----------------------------------------------------
// The page an unsubscribing guest actually lands on, so it is held to the same
// brand rules as the invite: square corners, 2px borders, Academix red, and NO
// amber — amber exists in exactly one place in this product, the LED/VU meter
// graphic, and every other appearance of it was deliberately removed.
//
// Deliberately NOT `htmlPage` from lib/http.ts: that helper renders a 14px
// border-radius, a 1px border, a `border-top:4px solid #FFB300` and a Georgia
// serif wordmark — four brand breaches on the one page an unhappy recipient
// sees. It is left in place for anything else that imports it.
//
// Every colour, border and metric is an inline style, so the page is correct
// with no stylesheet at all; brand.css is linked only to upgrade the two
// typefaces to the self-hosted originals, and it carries no rule that can
// outrank a style attribute. `esc` runs on both merge values.
function unsubPage(title: string, message: string, status = 200): Response {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const display = "'Big Shoulders',Impact,'Arial Narrow',sans-serif";
  const mono = "'Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace";
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Mix &amp; Greet</title>
<link rel="stylesheet" href="${esc(inviteOrigin())}/brand.css">
</head>
<body style="margin:0;background:#0B0B0D;color:#EDEAE3;font-family:${mono};line-height:1.6;">
<div style="max-width:560px;margin:0 auto;padding:44px 20px 56px;">
  <p style="margin:0;font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#EDEAE3;">Academix Beat Lab</p>
  <p style="margin:6px 0 0;font-family:${display};font-weight:800;font-size:40px;line-height:.9;letter-spacing:.005em;text-transform:uppercase;color:#EC1C24;">MIX<span style="color:#EDEAE3;">&amp;</span>GREET</p>
  <hr style="border:0;border-top:2px solid #2A2A32;margin:22px 0 0;">
  <div style="background:#F5F4F1;border:2px solid #E5E3DE;border-top:6px solid #EC1C24;border-radius:0;padding:28px;margin-top:28px;">
    <h1 style="margin:0;font-size:13px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:#C8151C;">${esc(title)}</h1>
    <p style="margin:14px 0 0;font-size:14px;color:#3A3A42;">${esc(message)}</p>
  </div>
  <hr style="border:0;border-top:4px solid #2A2A32;margin:34px 0 0;">
  <p style="margin:18px 0 0;font-size:11px;letter-spacing:.14em;color:#8B8B94;text-transform:uppercase;">Academix Beat Lab · 1933 S. Broadway, Suite 1202, Los Angeles, CA 90007</p>
</div>
</body></html>`;
  return new Response(body, {
    status,
    headers: corsHeaders({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    }),
  });
}

// GET serves the link click; POST serves RFC 8058 one-click (List-Unsubscribe-Post).
const unsubscribe = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const email = clean(url.searchParams.get("e"), 200).toLowerCase();
  const token = clean(url.searchParams.get("t"), 128);
  const secret = process.env.UNSUB_SECRET;
  if (!secret || !email || !token || !(await verifyUnsubToken(secret, email, token))) {
    return unsubPage(
      "Invalid link",
      "This unsubscribe link is invalid or has been tampered with. No changes were made.",
      400,
    );
  }
  await ctx.runMutation(internal.email.unsubscribe, { email });
  return unsubPage(
    "You're unsubscribed",
    "You won't receive further emails about Mix & Greet events.",
  );
});

http.route({ path: "/unsubscribe", method: "GET", handler: unsubscribe });
http.route({ path: "/unsubscribe", method: "POST", handler: unsubscribe });

export default http;
