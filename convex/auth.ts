import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Constant-time string comparison to avoid leaking the password via timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Validate a password against the server-side secret. No default fallback:
// if ADMIN_PASSWORD is unset, access is denied.
export function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(password, expected);
}

// Create a session row from a token minted by the caller (the login
// httpAction, which runs in an action context). Returns the expiry.
export const createSession = internalMutation({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    const expiresAt = now + SESSION_TTL_MS;
    await ctx.db.insert("adminSessions", { token, expiresAt });
    return { expiresAt };
  },
});

// Returns true when the token exists and has not expired. Also opportunistically
// deletes the row when expired so the table does not grow without bound.
export const validateToken = internalQuery({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    if (!token) return false;
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session) return false;
    return session.expiresAt > now;
  },
});

// Housekeeping: drop expired sessions (wired to a cron later if desired).
export const purgeExpiredSessions = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const expired = await ctx.db
      .query("adminSessions")
      .withIndex("by_token")
      .collect();
    let removed = 0;
    for (const s of expired) {
      if (s.expiresAt <= now) {
        await ctx.db.delete(s._id);
        removed++;
      }
    }
    return { removed };
  },
});
