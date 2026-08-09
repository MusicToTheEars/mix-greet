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

// Minimal branded page for endpoints a human lands on (e.g. /unsubscribe).
export function htmlPage(title: string, message: string, status = 200): Response {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#0B0B0D;color:#EDEAE3;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:18vh auto 0;padding:32px;background:#141419;border:1px solid #2A2A32;border-radius:14px;border-top:4px solid #FFB300;">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;">MIX<span style="color:#EC1C24;">&amp;</span>GREET</div>
<h1 style="font-size:18px;margin:18px 0 8px;">${esc(title)}</h1>
<p style="margin:0;color:#8B8B94;line-height:1.6;">${esc(message)}</p>
</div></body></html>`;
  return new Response(body, {
    status,
    headers: corsHeaders({ "content-type": "text/html; charset=utf-8" }),
  });
}
