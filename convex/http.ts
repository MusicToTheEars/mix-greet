import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkPassword } from "./auth";
import { resend } from "./email";
import { verifyUnsubToken } from "./lib/unsub";
import { json, preflight, clean, corsHeaders, csvCell, htmlPage } from "./lib/http";

const http = httpRouter();

// --- Admin login: exchange the shared password for a 12h session token ------
const login = httpAction(async (ctx, req) => {
  const body = await req.json().catch(() => ({}));
  const password = req.headers.get("x-admin-pass") || (body as any).password || "";
  if (!checkPassword(clean(password, 200))) {
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

// --- Events: public GET, admin POST (create/delete/verify) ------------------
const events = httpAction(async (ctx, req) => {
  if (req.method === "GET") {
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
    // Back office lists: { published: [...], archived: [...] }.
    if (action === "list") {
      return json(await ctx.runQuery(internal.events.listAll, {}));
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
    eventId: clean(body.eventId, 64),
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
    eventId: clean(url.searchParams.get("eventId"), 64),
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
// GET serves the link click; POST serves RFC 8058 one-click (List-Unsubscribe-Post).
const unsubscribe = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const email = clean(url.searchParams.get("e"), 200).toLowerCase();
  const token = clean(url.searchParams.get("t"), 128);
  const secret = process.env.UNSUB_SECRET;
  if (!secret || !email || !token || !(await verifyUnsubToken(secret, email, token))) {
    return htmlPage(
      "Invalid link",
      "This unsubscribe link is invalid or has been tampered with. No changes were made.",
      400,
    );
  }
  await ctx.runMutation(internal.email.unsubscribe, { email });
  return htmlPage(
    "You're unsubscribed",
    "You won't receive further emails about Mix & Greet events.",
  );
});

http.route({ path: "/unsubscribe", method: "GET", handler: unsubscribe });
http.route({ path: "/unsubscribe", method: "POST", handler: unsubscribe });

export default http;
