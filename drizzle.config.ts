import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into drizzle/migrations/, applied with
// `wrangler d1 migrations apply learn-jp` (local + remote).
export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
  strict: true,
});
