// Shared HTTP helpers for the Convex httpAction API.

// Allowed origin for browser calls. SITE_ORIGIN is set as a Convex env var
// (e.g. https://mixandgreet.com). Falls back to "*" only if unset, so local
// testing works before the env var is configured.
export function corsHeaders(extra?: Record<string, string>): Record<string, string> {
  const origin = process.env.SITE_ORIGIN || "*";
  return {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, x-admin-pass, x-admin-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
    ...extra,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

// Standard preflight response body.
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// Trim and clamp an untrusted string.
export function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

// One CSV field: quoted, inner quotes doubled, and prefixed with a quote when
// it starts with a formula character (spreadsheet formula-injection guard).
export function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// Where the "back" button on a system page points. Same resolution order as
// convex/events.ts so a system page and an invite link never disagree.
function homeUrl(): string {
  for (const c of [process.env.INVITE_ORIGIN, process.env.SITE_ORIGIN]) {
    const raw = String(c ?? "").trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^\s*]+$/i.test(raw)) return raw;
  }
  return "https://mixandgreet.com";
}

// Minimal branded page for endpoints a human lands on (e.g. /unsubscribe).
export function htmlPage(title: string, message: string, status = 200): Response {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#0B0B0D;color:#EDEAE3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
<div style="max-width:480px;margin:16vh auto 0;padding:34px;background:#141419;border:2px solid #2A2A32;border-top:6px solid #EC1C24;">
<div style="font-family:'Helvetica Neue Condensed Bold',Impact,sans-serif;font-size:30px;font-weight:800;letter-spacing:.01em;text-transform:uppercase;color:#EC1C24;">MIX<span style="color:#EDEAE3;">&amp;</span>GREET</div>
<h1 style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;margin:20px 0 10px;color:#EDEAE3;">${esc(title)}</h1>
<p style="margin:0;color:#8B8B94;line-height:1.7;font-size:14px;">${esc(message)}</p>
<p style="margin:26px 0 0;"><a href="${esc(homeUrl())}" style="display:inline-block;border:2px solid #EC1C24;background:#EC1C24;color:#FFFFFF;text-decoration:none;padding:12px 24px;font-size:12px;letter-spacing:.22em;text-transform:uppercase;font-weight:700;">Back to Mix &amp; Greet</a></p>
</div></body></html>`;
  return new Response(body, {
    status,
    headers: corsHeaders({ "content-type": "text/html; charset=utf-8" }),
  });
}
