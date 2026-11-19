import { Hono } from "hono";
import { type StatusResponse } from "./api-types";
import { statusPayload } from "./status";

// The worker serves the SPA shell (via static assets) plus the REST API
// (API.md). P1.8 lands `GET /api/status`; P1.9-P1.11 add the rest.
//
// P1.7: routes are registered by CHAINING off the constructor — that
// is what puts them into `typeof app` and therefore into `AppType`
// below, which the PWA feeds to `hc<AppType>` (hono/client). Registering
// with a separate `app.get(...)` statement would leave `typeof app` at
// hono's empty `BlankSchema` and silently type the client as `unknown`.
// P1.9-P1.11 request routes extend this chain and carry
// `zValidator("json", <schema from api-types.ts>)`, so their
// request/response types become compile-time checked on the client
// (DECISIONS D11). `GET /api/status` has no request body to validate —
// its typing comes from `c.json<StatusResponse>` below, and tests
// parse the served body with `statusResponseSchema` at runtime.
//
// Errors normalize into API.md's {"error": {code, message}} envelope
// (errorSchema in api-types.ts), so `hc<AppType>` hands the client the
// 200 and 500 branches as a typed union instead of hono's plain 500.
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
);

export type AppType = typeof app;

export default app;
