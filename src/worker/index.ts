import { Hono } from "hono";

// Phase 0: worker serves the SPA shell (via static assets) plus a
// minimal /api/status endpoint to verify the D1 binding end-to-end.
// Real endpoints arrive in Phase 1 (see API.md).
//
// P1.7: routes are registered by CHAINING off the constructor — that
// is what puts them into `typeof app` and therefore into `AppType`
// below, which the PWA feeds to `hc<AppType>` (hono/client). Registering
// with a separate `app.get(...)` statement would leave `typeof app` at
// hono's empty `BlankSchema` and silently type the client as `unknown`.
// Every route added in P1.8–P1.11 extends this chain and carries
// `zValidator("json", <schema from api-types.ts>)`, so its
// request/response types become compile-time checked on the client
// (DECISIONS D11).
const app = new Hono<{ Bindings: Cloudflare.Env }>().get(
  "/api/status",
  async (c) => {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return c.json({ ok: row?.ok === 1 });
  },
);

export type AppType = typeof app;

export default app;
