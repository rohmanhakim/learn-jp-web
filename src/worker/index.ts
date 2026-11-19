import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  type SessionStartRequest,
  type SessionStartResponse,
  type StatusResponse,
  sessionStartRequestSchema,
} from "./api-types";
import { startSession } from "./session-start";
import { statusPayload } from "./status";

// The worker serves the SPA shell (via static assets) plus the REST API
// (API.md). P1.8 lands `GET /api/status`, P1.9 `POST /api/session/start`;
// P1.10-P1.11 add the remaining two routes.
//
// P1.7: routes are registered by CHAINING off the constructor — that
// is what puts them into `typeof app` and therefore into `AppType`
// below, which the PWA feeds to `hc<AppType>` (hono/client). Registering
// with a separate `app.get(...)` statement would leave `typeof app` at
// hono's empty `BlankSchema` and silently type the client as `unknown`.
// P1.9: `POST /api/session/start` carries `zValidator("json",
// sessionStartRequestSchema)` on the way in and a typed payload on the
// way out, so its request/response types are compile-time checked on the
// client (DECISIONS D11). P1.10-P1.11 extend this chain the same way.
// `GET /api/status` has no request body to validate — its typing comes
// from `c.json<StatusResponse>` below, and tests parse the served body
// with `statusResponseSchema` at runtime.
//
// Errors normalize into API.md's {"error": {code, message}} envelope
// (errorSchema in api-types.ts), so `hc<AppType>` hands the client the
// 200 and 500 branches as a typed union instead of hono's plain 500.
// zValidator's DEFAULT 400 body is zod's error, not that envelope (P1.7
// Notes item 10) — the validator hook below rewrites it to
// `invalid_request`, so every branch the client can decode follows the
// same contract.
const app = new Hono<{ Bindings: Cloudflare.Env }>().get(
  "/api/status",
  async (c) => {
    try {
      const payload: StatusResponse = await statusPayload(c.env.DB, new Date());
      return c.json<StatusResponse>(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "status unavailable";
      return c.json({ error: { code: "internal_error", message } }, 500);
    }
  },
).post(
  "/api/session/start",
  zValidator("json", sessionStartRequestSchema, (result, c) => {
    if (result.success) return;
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return c.json({ error: { code: "invalid_request", message: detail } }, 400);
  }),
  async (c) => {
    try {
      const request: SessionStartRequest = c.req.valid("json");
      const payload: SessionStartResponse = await startSession(c.env.DB, new Date(), request);
      return c.json<SessionStartResponse>(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "session start unavailable";
      return c.json({ error: { code: "internal_error", message } }, 500);
    }
  },
);

export type AppType = typeof app;

export default app;
