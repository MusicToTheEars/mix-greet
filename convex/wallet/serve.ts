"use node";

// Serves one guest's Apple Wallet pass. Node runtime because the PKCS#7
// signature needs node-forge, which the default V8 isolate cannot run.

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { verifyRsvpToken } from "../lib/rsvpToken";
import { buildPkpass } from "./pkpass";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// "2026-08-15" + "1:00 PM" -> "2026-08-15T13:00:00-07:00". The venue is in Los
// Angeles and there is no timezone field on events, so the offset is derived
// from US Pacific DST rather than guessed.
function relevantIso(date: string, start: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return undefined;
  let h = 12, min = 0;
  const t = /^(\d{1,2}):(\d{2})\s*([AaPp])/.exec((start || "").trim());
  if (t) {
    h = parseInt(t[1], 10) % 12;
    min = parseInt(t[2], 10);
    if (/[Pp]/.test(t[3])) h += 12;
  }
  const y = +m[1], mo = +m[2], d = +m[3];
  // DST in the US runs Mar–Nov; a one-hour error here only shifts a lock-screen
  // hint, never the printed time, which comes from the event record verbatim.
  const pacific = mo > 3 && mo < 11 ? "-07:00" : "-08:00";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(min)}:00${pacific}`;
}

export const buildForToken = internalAction({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; b64?: string; error?: string }> => {
    const secret = process.env.UNSUB_SECRET;
    if (!secret) return { ok: false, error: "server not configured" };
    const rsvpId = await verifyRsvpToken(secret, args.token);
    if (!rsvpId) return { ok: false, error: "bad token" };

    const data: any = await ctx.runQuery(internal.rsvps.getForToken, { rsvpId });
    if (!data) return { ok: false, error: "not found" };
    if (data.rsvp.status === "cancelled") return { ok: false, error: "cancelled" };

    const ev = data.event;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ev.date || "");
    const dateShort = m ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : ev.date;
    const whenLabel = [dateShort, ev.start].filter(Boolean).join(" · ");
    // Everyone billed, not just the first: partners are excluded because a
    // logo is not a special guest, and the pass prints the people.
    const billed = (data.featured || []).filter(
      (f: any) => f && f.kind !== "company" && f.name,
    );
    const headliner = billed[0];
    const g = data.rsvp.guests || 1;


    // Street only on the face; the full address is on the back of the pass.
    const venueLine = (ev.location || "").split(",")[0].trim();

    const bytes = await buildPkpass({
      // Stable per RSVP: re-adding replaces the pass instead of stacking copies.
      serial: `mg-${data.rsvp.id}`,
      // The QR carries the bare rsvp id, not the signed token: 32 plain
      // alphanumerics instead of 65 with a dot, which is a far coarser code to
      // scan across a dark room. It is not a secret — /api/admin/checkin is
      // gated by the staff admin token, so possessing an id grants nothing.
      authToken: rsvpId,
      eventTitle: ev.title,
      subtitle: ev.subtitle || undefined,
      artists: billed.map((f: any) => String(f.name)),
      whenIso: relevantIso(ev.date, ev.start),
      whenLabel,
      dateShort,
      timeShort: ev.start || undefined,
      location: ev.location || "",
      guestName: data.rsvp.name,
      partyLabel: g > 1 ? `${g} guests` : "Just you",
      status: data.rsvp.status === "waitlist" ? "waitlist" : "confirmed",
      inviteUrl: undefined,
      venueLine,
    });
    // base64, not Array.from(bytes): a half-megabyte pass becomes ~500k JSON
    // numbers that way, which is orders of magnitude larger on the wire than
    // the bytes themselves and blew the action's return budget.
    return { ok: true, b64: Buffer.from(bytes).toString("base64") };
  },
});
