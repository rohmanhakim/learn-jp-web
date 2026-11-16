import { Hono } from "hono";

// Phase 0: worker serves the SPA shell (via static assets) plus a
// minimal /api/status endpoint to verify the D1 binding end-to-end.
// Real endpoints arrive in Phase 1 (see API.md).
const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.get("/api/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1 });
});

export default app;
