import { httpRouter } from "convex/server";
import { httpAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { checkPassword } from "./auth";
import { inviteOrigin } from "./events";
import { resend } from "./email";
import { verifyUnsubToken } from "./lib/unsub";
import { rsvpToken, verifyRsvpToken } from "./lib/rsvpToken";
import { json, preflight, clean, corsHeaders, csvCell, htmlPage } from "./lib/http";

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
  // Hand back a signed manage token on success so the page that just took the
  // RSVP can offer "edit or cancel" instead of a second RSVP form. The rsvpId
  // itself is never exposed, only the signed token, same as the email link.
  //
  // Stripping the id is not tidiness: the bare rsvp id is exactly what the door
  // QR encodes, so anything that hands it to a browser has handed out a working
  // door code. Signing needs UNSUB_SECRET, and this used to fall through to
  // returning the mutation result verbatim when it was unset, which leaked that
  // id to every visitor and left the page with no code to show. Now the id is
  // dropped on every path and a missing secret answers as the failure it is.
  //
  // A 500, not a 200 with a flag: the RSVP row is already committed, so the
  // guest really is on the list, but they have no way to reach their pass and
  // no page copy can fix that. The error text says both halves, and the log
  // line is what tells the operator which env var to set. The end-to-end test
  // only asserts the happy path, so this branch has no test guarding it.
  if (result?.ok && (result as any).rsvpId) {
    const { rsvpId, ...rest } = result as any;
    const secret = process.env.UNSUB_SECRET;
    if (!secret) {
      console.error("rsvp: UNSUB_SECRET is unset, no manage token could be issued");
      return json(
        {
          ok: false,
          status: rest.status,
          error:
            "You're on the list, but we could not create your pass link. Please contact the host so they can send it to you.",
        },
        500,
      );
    }
    const t = await rsvpToken(secret, String(rsvpId));
    return json({ ...rest, manageToken: t }, 200);
  }
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
    // checkedInAt is appended rather than slotted in beside status, so every
    // column an existing saved sheet or import already points at keeps its
    // position. It is the column that answers "who actually came".
    const header =
      "name,email,phone,guests,status,source,notes,createdAt,confirmationSentAt,checkedInAt";
    const rows = data.rsvps.map((r) =>
      [r.name, r.email, r.phone, r.guests, r.status, r.source, r.notes, r.createdAt, r.confirmationSentAt, r.checkedInAt]
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


// --- guest self-service ------------------------------------------------------
// One signed token (lib/rsvpToken.ts) opens all of this: the Wallet pass, the
// QR the door scans, and the ability to cancel or resize a booking. A guest who
// cannot come has to have a way to say so, or the door list quietly rots.

// The "Pass unavailable" page in the one case where the guest still has a way
// in: the QR link for their own token.
//
// Deliberately not `htmlPage` from lib/http.ts, and it is the same markup on
// purpose so the guest sees the identical page: that helper escapes its
// message, so it cannot carry a tappable link, and a guest standing at a door
// is not going to retype a 90-character URL off a phone screen. lib/http.ts is
// shared with the other endpoints and is left exactly as it is.
function passFallbackPage(message: string, qrUrl: string, status: number): Response {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Pass unavailable</title></head>
<body style="margin:0;background:#0B0B0D;color:#EDEAE3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
<div style="max-width:480px;margin:16vh auto 0;padding:34px;background:#141419;border:2px solid #2A2A32;border-top:6px solid #EC1C24;">
<div style="font-family:'Helvetica Neue Condensed Bold',Impact,sans-serif;font-size:30px;font-weight:800;letter-spacing:.01em;text-transform:uppercase;color:#EC1C24;">MIX<span style="color:#EDEAE3;">&amp;</span>GREET</div>
<h1 style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;margin:20px 0 10px;color:#EDEAE3;">Pass unavailable</h1>
<p style="margin:0;color:#8B8B94;line-height:1.7;font-size:14px;">${esc(message)}</p>
<p style="margin:26px 0 0;"><a href="${esc(qrUrl)}" style="display:inline-block;border:2px solid #EC1C24;background:#EC1C24;color:#FFFFFF;text-decoration:none;padding:12px 24px;font-size:12px;letter-spacing:.22em;text-transform:uppercase;font-weight:700;">Show my QR code</a></p>
</div></body></html>`;
  return new Response(body, {
    status,
    headers: corsHeaders({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    }),
  });
}

// GET /api/pass?t=<token> -> the .pkpass, served with Apple's MIME type so iOS
// offers "Add to Apple Wallet" rather than downloading a zip.
const walletPass = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const token = clean(url.searchParams.get("t"), 200);
  let out: any;
  try {
    out = await ctx.runAction(internal.wallet.serve.buildForToken, { token });
  } catch (err: any) {
    // Building a pass signs it with the Apple certificate held in the
    // environment, so an unset or expired certificate throws here rather than
    // returning an error, and it used to reach the guest as an unstyled Convex
    // 500 with no way forward. Nothing the guest can do fixes a certificate,
    // but the same code is served as a PNG from this very host, and that gets
    // them through the door on any phone, so hand them that instead. Logged
    // because a silently expired certificate is otherwise only discovered by a
    // guest at the door.
    console.error("pass build failed:", String(err?.message || err));
    return passFallbackPage(
      "Apple Wallet passes are not being issued right now. Your code still works: open it below and show that at the door.",
      `${url.origin}/api/qr?t=${encodeURIComponent(token)}`,
      503,
    );
  }
  if (!out?.ok) {
    return htmlPage(
      "Pass unavailable",
      out?.error === "cancelled"
        ? "This RSVP was cancelled, so its pass is no longer valid."
        : "That pass link is not valid. Open the link from your confirmation email.",
      404,
    );
  }
  const body = Uint8Array.from(atob(out.b64), (c) => c.charCodeAt(0));
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.pkpass",
      "content-disposition": 'attachment; filename="MixAndGreet.pkpass"',
      "cache-control": "no-store",
    },
  });
});
http.route({ path: "/api/pass", method: "GET", handler: walletPass });

// GET  /api/rsvp/manage?t=  -> the guest's current booking
// POST /api/rsvp/manage     -> { t, action: "cancel" | "guests", guests? }
const manageRsvp = httpAction(async (ctx, req) => {
  const secret = process.env.UNSUB_SECRET;
  if (!secret) return json({ error: "server not configured" }, 500);

  let token = "";
  let action = "";
  let guests = 1;
  if (req.method === "GET") {
    token = clean(new URL(req.url).searchParams.get("t"), 200);
  } else {
    const body = await req.json().catch(() => ({}) as any);
    token = clean(body.t, 200);
    action = clean(body.action, 20);
    guests = Number(body.guests) || 1;
  }

  const rsvpId = await verifyRsvpToken(secret, token);
  // Same response for a bad signature and a missing row: a valid-looking token
  // must not be distinguishable from an invalid one.
  if (!rsvpId) return json({ error: "not found" }, 404);
  const data: any = await ctx.runQuery(internal.rsvps.getForToken, { rsvpId });
  if (!data) return json({ error: "not found" }, 404);

  if (req.method === "GET") {
    return json({
      ok: true,
      name: data.rsvp.name,
      email: data.rsvp.email,
      guests: data.rsvp.guests,
      status: data.rsvp.status,
      event: {
        title: data.event.title,
        subtitle: data.event.subtitle,
        date: data.event.date,
        start: data.event.start,
        end: data.event.end,
        location: data.event.location,
        slug: data.event.slug,
      },
    });
  }

  if (action !== "cancel" && action !== "guests") {
    return json({ error: "unknown action" }, 400);
  }
  const res: any = await ctx.runMutation(internal.rsvps.updateByGuest, {
    rsvpId,
    action: action as "cancel" | "guests",
    guests,
  });
  // A refusal carries a `reason` ("checked_in", "cancelled", "full") and is
  // answered 409: the request was perfectly well formed, the RSVP is simply in
  // a state this action must not touch. The guest's real status and party size
  // ride along so the page can show what the booking actually is, rather than
  // reporting a change that did not happen. `error` is already a sentence
  // written for the guest, so it can be displayed as-is. Anything without a
  // reason is the old failure and stays a 400.
  if (!res?.ok) {
    return json(
      {
        ok: false,
        error: res?.error || "failed",
        reason: res?.reason || "",
        status: res?.status || "",
        guests: res?.guests ?? 0,
      },
      res?.reason ? 409 : 400,
    );
  }
  return json({ ok: true, status: res.status, guests: res.guests });
});
http.route({ path: "/api/rsvp/manage", method: "GET", handler: manageRsvp });
http.route({ path: "/api/rsvp/manage", method: "POST", handler: manageRsvp });
http.route({
  path: "/api/rsvp/manage",
  method: "OPTIONS",
  handler: httpAction(async () => preflight()),
});


// --- door check-in -----------------------------------------------------------
// Admin-token gated: this is staff-operated, and it mutates attendance.
// Accepts either a scanned pass token or a raw rsvp id, because a Bluetooth
// scanner in HID mode types whatever is encoded and staff may also pick a name
// off the list by hand.
const checkin = httpAction(async (ctx, req) => {
  if (!(await isAdmin(ctx, req))) return json({ error: "unauthorized" }, 401);
  const secret = process.env.UNSUB_SECRET;
  if (!secret) return json({ error: "server not configured" }, 500);

  const body = await req.json().catch(() => ({}) as any);
  const scanned = clean(body.code, 200);
  const undo = body.undo === true;
  // Which event is being run tonight, as a slug or a raw id, resolved the same
  // way every other admin route resolves one. Optional: without it the scan is
  // unscoped, which is how manual entry and older callers still behave.
  const eventKey = clean(body.eventId, 120);
  const eventId = eventKey ? await resolveEventKey(ctx, eventKey) : "";

  // A scan carries "<rsvpId>.<hmac>"; only a verified signature is trusted.
  // Falling back to a bare id keeps manual entry working for staff.
  let rsvpId = await verifyRsvpToken(secret, scanned);
  if (!rsvpId && /^[a-z0-9]{20,40}$/i.test(scanned)) rsvpId = scanned;
  if (!rsvpId) return json({ error: "unrecognised code" }, 404);

  const res: any = await ctx.runMutation(internal.rsvps.checkIn, {
    rsvpId,
    undo,
    eventId: eventId || undefined,
  });
  if (!res?.ok) return json({ error: res?.error || "failed" }, 404);
  return json(res);
});
http.route({ path: "/api/admin/checkin", method: "POST", handler: checkin });
http.route({
  path: "/api/admin/checkin",
  method: "OPTIONS",
  handler: httpAction(async () => preflight()),
});

// Live door numbers: expected heads against heads actually through.
const doorStats = httpAction(async (ctx, req) => {
  if (!(await isAdmin(ctx, req))) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const eventId = await resolveEventKey(ctx, clean(url.searchParams.get("eventId"), 120));
  const out = await ctx.runQuery(internal.rsvps.doorStats, { eventId });
  if (!out) return json({ error: "event not found" }, 404);
  return json(out);
});
http.route({ path: "/api/admin/door", method: "GET", handler: doorStats });
http.route({
  path: "/api/admin/door",
  method: "OPTIONS",
  handler: httpAction(async () => preflight()),
});


// Remove an RSVP outright. Cancelling is what a guest does; this is the
// operator's eraser for test rows and mistakes.
const deleteRsvp = httpAction(async (ctx, req) => {
  if (!(await isAdmin(ctx, req))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}) as any);
  const res: any = await ctx.runMutation(internal.rsvps.removeByAdmin, {
    rsvpId: clean(body.rsvpId, 120),
  });
  return json(res, res?.ok ? 200 : 404);
});
http.route({ path: "/api/admin/rsvp/delete", method: "POST", handler: deleteRsvp });
http.route({
  path: "/api/admin/rsvp/delete",
  method: "OPTIONS",
  handler: httpAction(async () => preflight()),
});


// GET /api/qr?t=<token> -> the door QR as a PNG, for guests without Wallet.
const doorQr = httpAction(async (ctx, req) => {
  const t = clean(new URL(req.url).searchParams.get("t"), 200);
  const out: any = await ctx.runAction(internal.wallet.qr.renderForToken, { token: t });
  if (!out?.ok) return json({ error: out?.error || "not found" }, 404);
  const body = Uint8Array.from(atob(out.b64), (c) => c.charCodeAt(0));
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      // A guest's own code: never cached by a shared proxy.
      "cache-control": "private, max-age=300",
      "access-control-allow-origin": process.env.SITE_ORIGIN || "*",
    },
  });
});
http.route({ path: "/api/qr", method: "GET", handler: doorQr });

export default http;
