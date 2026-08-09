import { defineApp } from "convex/server";
import resend from "@convex-dev/resend/convex.config";

// Register the official Resend component. It provides durable email queueing,
// retries, idempotency, rate limiting, and signed-webhook verification.
// Used in Phase 2 (RSVP confirmations); registered now so schema/codegen is stable.
const app = defineApp();
app.use(resend);

export default app;
