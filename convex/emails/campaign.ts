// The branded wrapper for anything an operator writes by hand: a campaign to a
// matched slice of the list, or a one-to-one reply to a single lead.
//
// Deliberately plainer than rsvpConfirmation.ts, and that is a decision rather
// than a shortcut. A confirmation is a ticket and has to carry a door's worth of
// structured facts; this carries a person's own words. The template's whole job
// is to put a masthead above them, a rule under them, and an unsubscribe line at
// the bottom, then get out of the way. Anything more and every message this
// account sends starts reading like a newsletter.
//
// Same constraints as the other template: no bundler, no JSX, table layout,
// inlined CSS, 600px container, no web fonts, every merged value escaped.

const INK = "#EDEAE3";
const MUTED = "#8B8B94";
const BRAND = "#EC1C24";
const BRAND_INK = "#C8151C";
const BG = "#0B0B0D";
const SURFACE = "#F5F4F1";
const LINE_LT = "#E5E3DE";
const TEXT = "#16161A";
const TEXT_SOFT = "#3A3A42";

const DISPLAY = "'Big Shoulders Display',Impact,'Haettenschweiler','Arial Narrow Bold',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type CampaignEvent = {
  title: string;
  whenLine?: string;
  location?: string;
  inviteUrl?: string;
};

export type CampaignVars = {
  subject: string;
  // What the operator typed. Blank lines separate paragraphs; single newlines
  // are kept as line breaks, because someone typing an address or a short list
  // means the breaks they put in.
  body: string;
  // Merged into the greeting when we know it. No "Hi there" fallback: a
  // greeting addressed to nobody is worse than starting with the sentence.
  name?: string;
  event?: CampaignEvent;
  unsubUrl?: string;
  siteOrigin: string;
  // Off for a one-to-one reply. A person answering a question they were asked
  // does not append an unsubscribe footer to their own reply, and the footer is
  // what makes a written answer read as bulk mail.
  showUnsub: boolean;
};

// Blank-line-separated paragraphs, single newlines kept as <br>.
function paragraphs(body: string): string {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 16px;color:${TEXT_SOFT};font-family:${MONO};font-size:15px;line-height:1.75;">${esc(
          p,
        ).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function eventBlock(ev: CampaignEvent): string {
  const rows = [
    ["When", ev.whenLine],
    ["Where", ev.location],
  ]
    .filter(([, val]) => String(val || "").trim())
    .map(
      ([label, val]) =>
        `<tr><td style="padding:3px 14px 3px 0;font-family:${MONO};font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${MUTED};white-space:nowrap;vertical-align:top;">${esc(
          label,
        )}</td><td style="padding:3px 0;font-family:${MONO};font-size:14px;color:${TEXT};">${esc(val)}</td></tr>`,
    )
    .join("");

  const button = ev.inviteUrl
    ? `<tr><td style="padding:18px 0 0;"><a href="${esc(
        ev.inviteUrl,
      )}" style="display:inline-block;background:${BRAND};border:2px solid ${BRAND};color:#FFFFFF;text-decoration:none;padding:13px 26px;font-family:${MONO};font-size:12px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;white-space:nowrap;">See the invitation</a></td></tr>`
    : "";

  return `<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;background:#FFFFFF;border:2px solid ${LINE_LT};border-top:6px solid ${BRAND};margin:6px 0 22px;">
  <tr><td style="padding:20px 22px;">
    <div style="font-family:${DISPLAY};font-weight:800;text-transform:uppercase;font-size:26px;line-height:1;color:${TEXT};letter-spacing:.01em;">${esc(
      ev.title,
    )}</div>
    <table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:12px;">${rows}${button}</table>
  </td></tr>
</table>`;
}

export function renderCampaign(v: CampaignVars): { html: string; text: string } {
  const origin = v.siteOrigin.replace(/\/+$/, "");
  const greeting = String(v.name || "").trim()
    ? `<p style="margin:0 0 16px;color:${TEXT};font-family:${MONO};font-size:15px;line-height:1.75;">${esc(
        String(v.name).trim().split(/\s+/)[0],
      )},</p>`
    : "";

  const unsub = v.showUnsub && v.unsubUrl
    ? `<p style="margin:0;font-family:${MONO};font-size:11px;line-height:1.8;color:${MUTED};letter-spacing:.04em;">You are on this list because you RSVP'd to a Mix &amp; Greet or wrote to us about a partnership. <a href="${esc(
        v.unsubUrl,
      )}" style="color:${MUTED};">Unsubscribe</a>.</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;background:${BG};">
<tr><td align="center" style="padding:0;">
<table cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;border-collapse:collapse;">

  <tr><td style="padding:30px 26px 24px;background:${BG};">
    <div style="font-family:${DISPLAY};font-weight:800;text-transform:uppercase;font-size:34px;line-height:.9;letter-spacing:.01em;color:${BRAND};">MIX<span style="color:${INK};">&amp;</span>GREET</div>
    <div style="font-family:${MONO};font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:${MUTED};margin-top:8px;">Academix Beat Lab · Downtown Los Angeles</div>
  </td></tr>

  <tr><td style="padding:26px 26px 30px;background:${SURFACE};">
    ${greeting}
    ${v.event ? eventBlock(v.event) : ""}
    ${paragraphs(v.body)}
  </td></tr>

  <tr><td style="padding:22px 26px 34px;background:${BG};">
    <div style="border-top:4px solid #2A2A32;padding-top:18px;">
      <div style="font-family:${MONO};font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${INK};">BEAT LAB — ACADEMIX</div>
      <div style="font-family:${MONO};font-size:11px;line-height:1.8;color:${MUTED};margin-top:8px;"><a href="${esc(
        origin,
      )}" style="color:${BRAND};">mixandgreet.com</a></div>
      <div style="margin-top:12px;">${unsub}</div>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  const lines: string[] = [];
  if (String(v.name || "").trim()) lines.push(`${String(v.name).trim().split(/\s+/)[0]},`, "");
  if (v.event) {
    lines.push(v.event.title.toUpperCase());
    if (v.event.whenLine) lines.push(`When: ${v.event.whenLine}`);
    if (v.event.location) lines.push(`Where: ${v.event.location}`);
    if (v.event.inviteUrl) lines.push(v.event.inviteUrl);
    lines.push("");
  }
  lines.push(String(v.body || "").replace(/\r\n/g, "\n").trim(), "");
  lines.push("MIX&GREET · BEAT LAB — ACADEMIX", origin);
  if (v.showUnsub && v.unsubUrl) lines.push("", `Unsubscribe: ${v.unsubUrl}`);

  return { html, text: lines.join("\n") };
}
