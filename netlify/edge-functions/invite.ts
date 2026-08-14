// Per-event link previews for /i/<key>.
//
// WHY THIS EXISTS. rsvp.html is one static file that fetches its event in the
// browser, so every invite link previewed identically: same title, same
// description, same site-wide /social-card.jpg. Link-preview bots — iMessage,
// WhatsApp, Slack, Facebook, Twitter — read the raw HTML and stop. They do not
// run JavaScript. So the only way an invite can preview as ITS event is for
// something to put that event's tags in the HTML before the bot sees it.
//
// WHY AN EDGE FUNCTION AND NOT A REWRITE TO CONVEX. rsvp.html stays the single
// source of truth and Netlify's CDN still serves it; this only rewrites six
// meta tags in the response on the way past. Serving the page from Convex
// instead would have meant maintaining the invite markup in two places.
//
// ORDERING. `_redirects` rewrites /i/* to /rsvp.html?event=:splat. Netlify runs
// edge functions ahead of redirects, and `context.next()` continues into the
// normal pipeline — so this reads the rewritten static page, not a 404.
//
// FAILING OPEN IS THE POINT. Every error path returns the untouched page. A
// guest opening an invitation must never be shown an error because a preview
// image could not be resolved; the worst outcome allowed here is the generic
// card the site had before.

import type { Config, Context } from "https://edge.netlify.org";

// The deployment that owns the events. Same origin the static pages call.
const CONVEX = "https://good-labrador-980.convex.site";

// Bots ask once and cache hard, so a slow answer is a preview that never
// appears. Better to serve the generic card than to hold the request open.
const TIMEOUT_MS = 2500;

const esc = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// "2026-08-29" -> "08-29-26", the one date format the rest of the product uses.
function numericDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${m[2]}-${m[3]}-${m[1].slice(2)}` : String(iso ?? "");
}

export default async function invite(request: Request, context: Context) {
  const res = await context.next();

  // Only rewrite HTML. The same path can serve a 404 body or, on a bad deploy,
  // something else entirely, and blindly string-replacing that is worse than
  // doing nothing.
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/html")) return res;

  const key = decodeURIComponent(
    new URL(request.url).pathname.replace(/^\/i\//, "").replace(/\/+$/, ""),
  );
  if (!key) return res;

  let ev: Record<string, unknown> | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(
      `${CONVEX}/api/events?event=${encodeURIComponent(key)}`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (r.ok) ev = await r.json();
  } catch {
    return res;
  }
  if (!ev || typeof ev !== "object" || !ev.title) return res;

  const origin = new URL(request.url).origin;
  const title = `${ev.title}${ev.subtitle ? ` · ${ev.subtitle}` : ""} · Mix & Greet`;

  const when = [
    numericDate(String(ev.date ?? "")),
    ev.start ? `${ev.start}${ev.end ? ` – ${ev.end}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Street only, never the suite. This string goes to a public preview card
  // that gets pasted into group chats; the full address belongs in the
  // confirmation email, which only a confirmed guest receives.
  const street = String(ev.location ?? "").split(",")[0].trim();
  const description = [when, street, "Academix BEAT Lab · Downtown Los Angeles"]
    .filter(Boolean)
    .join(" · ");

  // The event's own card when it has one, the site-wide card otherwise, and
  // ABSOLUTE either way — several crawlers drop a relative og:image silently,
  // which is why the previous static tag showed no picture at all on some
  // platforms.
  const image =
    typeof ev.socialCardUrl === "string" && ev.socialCardUrl
      ? ev.socialCardUrl
      : `${origin}/social-card.jpg`;

  const tags: Record<string, string> = {
    "og:title": title,
    "og:description": description,
    "og:image": image,
    "og:url": `${origin}/i/${key}`,
    "twitter:title": title,
    "twitter:description": description,
    "twitter:image": image,
  };

  let html = await res.text();
  for (const [name, value] of Object.entries(tags)) {
    // property= for the og:* tags, name= for the twitter:* ones, matching how
    // the file already declares them. Anchored on the exact attribute so a
    // stray og:image:width is never rewritten to the URL.
    const attr = name.startsWith("og:") ? "property" : "name";
    const re = new RegExp(
      `<meta\\s+${attr}="${name}"\\s+content="[^"]*"\\s*/?>`,
      "i",
    );
    const tag = `<meta ${attr}="${name}" content="${esc(value)}">`;
    html = re.test(html) ? html.replace(re, tag) : html.replace(/<\/head>/i, `${tag}\n</head>`);
  }

  const headers = new Headers(res.headers);
  // The card changes when the operator re-saves the event, and a bot that
  // cached a stale one will not come back for hours. Short and revalidating is
  // the compromise: the CDN still absorbs the traffic, and an edit is visible
  // to the next scrape rather than the next day.
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  headers.delete("content-length");

  return new Response(html, { status: res.status, headers });
}

export const config: Config = { path: "/i/*" };
