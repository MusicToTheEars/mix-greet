// Branded RSVP confirmation email for Mix & Greet.
// Plain-TS string template (no bundler). Email-client-safe: table layout, inlined
// CSS, ~600px, web-safe fonts, brand palette (near-black + amber + red).
// All merged values are HTML-escaped.

const BRAND = {
  bg: "#101014",
  panel: "#16161A",
  ink: "#F5F4F1",
  muted: "#9A9AA2",
  amber: "#FFB300",
  amberBright: "#FFD45E",
  red: "#EC1C24",
  line: "#2A2A30",
};

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ConfirmationVars = {
  name: string;
  eventTitle: string;
  whenLine: string; // e.g. "Saturday, July 11, 2026 · 1:00 PM – 4:00 PM"
  location: string;
  status: "confirmed" | "waitlist";
  parking?: string;
  notes?: string;
  unsubUrl?: string; // tokenized /unsubscribe link (also sent as List-Unsubscribe)
};

export function renderRsvpConfirmation(v: ConfirmationVars): {
  subject: string;
  html: string;
  text: string;
} {
  const first = esc((v.name || "there").split(/\s+/)[0]);
  const isWait = v.status === "waitlist";
  const badge = isWait ? "You're on the waitlist" : "You're on the list";
  const badgeColor = isWait ? BRAND.amber : BRAND.amber;
  const lead = isWait
    ? `Thanks for your RSVP, ${first}. ${esc(v.eventTitle)} is at capacity, so you're on the waitlist. We'll email you the moment a spot opens.`
    : `You're confirmed, ${first}. We can't wait to see you at ${esc(v.eventTitle)}.`;

  const subject = isWait
    ? `Waitlist: ${v.eventTitle}`
    : `You're confirmed: ${v.eventTitle}`;

  const detailRow = (label: string, value?: string) =>
    value
      ? `<tr>
           <td style="padding:6px 0;color:${BRAND.muted};font-size:12px;letter-spacing:.08em;text-transform:uppercase;width:120px;vertical-align:top;">${esc(label)}</td>
           <td style="padding:6px 0;color:${BRAND.ink};font-size:15px;line-height:1.5;">${esc(value)}</td>
         </tr>`
      : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:14px;overflow:hidden;">
      <tr><td style="height:4px;background:${BRAND.amber};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 32px 8px 32px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;letter-spacing:.02em;color:${BRAND.ink};">
          MIX<span style="color:${BRAND.red};">&amp;</span>GREET
        </div>
        <div style="margin-top:6px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.amber};">${esc(badge)}</div>
      </td></tr>
      <tr><td style="padding:8px 32px 0 32px;">
        <p style="margin:0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${BRAND.ink};">${esc(lead)}</p>
      </td></tr>
      <tr><td style="padding:20px 32px 0 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BRAND.line};padding-top:8px;">
          ${detailRow("Event", v.eventTitle)}
          ${detailRow("When", v.whenLine)}
          ${detailRow("Where", v.location)}
          ${detailRow("Parking", v.parking)}
          ${detailRow("Notes", v.notes)}
        </table>
      </td></tr>
      <tr><td style="padding:28px 32px 32px 32px;">
        <div style="border-top:1px solid ${BRAND.line};padding-top:16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${BRAND.muted};">
          You're receiving this because you RSVP'd to ${esc(v.eventTitle)}.<br>
          Academix BEAT Lab · 1933 S. Broadway, Suite 1202, Los Angeles, CA 90007${
            v.unsubUrl
              ? `<br><a href="${esc(v.unsubUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Unsubscribe</a>`
              : ""
          }
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    badge.toUpperCase(),
    "",
    lead.replace(/<[^>]+>/g, ""),
    "",
    `Event: ${v.eventTitle}`,
    `When: ${v.whenLine}`,
    `Where: ${v.location}`,
    v.parking ? `Parking: ${v.parking}` : "",
    v.notes ? `Notes: ${v.notes}` : "",
    "",
    "You're receiving this because you RSVP'd to this event.",
    "Academix BEAT Lab, 1933 S. Broadway, Suite 1202, Los Angeles, CA 90007",
    v.unsubUrl ? `Unsubscribe: ${v.unsubUrl}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { subject, html, text };
}
