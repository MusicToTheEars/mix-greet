"use node";

// Renders the door QR as a PNG.
//
// This exists so the door works even when a guest has no Apple Wallet — an
// Android phone, a declined pass, or Wallet declining to draw the code. The
// same rsvp id the pass encodes is rendered here, so the same scan at
// /api/admin/checkin records the same attendance either way.

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { verifyRsvpToken } from "../lib/rsvpToken";
import QRCode from "qrcode";

export const renderForToken = internalAction({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; b64?: string; error?: string }> => {
    const secret = process.env.UNSUB_SECRET;
    if (!secret) return { ok: false, error: "server not configured" };
    const rsvpId = await verifyRsvpToken(secret, args.token);
    if (!rsvpId) return { ok: false, error: "bad token" };

    const data: any = await ctx.runQuery(internal.rsvps.getForToken, { rsvpId });
    if (!data) return { ok: false, error: "not found" };
    if (data.rsvp.status === "cancelled") return { ok: false, error: "cancelled" };

    // The payload is the bare rsvp id, exactly what the Wallet pass encodes.
    // High error correction because this gets scanned off a phone screen at a
    // door: glare and fingerprints eat modules, and H survives about 30% loss.
    const png: Buffer = await QRCode.toBuffer(rsvpId, {
      type: "png",
      errorCorrectionLevel: "H",
      margin: 2,
      scale: 10,
      color: { dark: "#0B0B0DFF", light: "#FFFFFFFF" },
    });
    return { ok: true, b64: png.toString("base64") };
  },
});
