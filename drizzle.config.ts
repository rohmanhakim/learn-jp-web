import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into drizzle/migrations/, applied with
// `wrangler d1 migrations apply learn-jp` (local + remote).
export default defineConfig({
  // Split into per-table files under drizzle/schema/ (commit 64ad7bd);
  // drizzle-kit takes the glob over the whole tree.
  schema: "./drizzle/schema/**/*.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
  strict: true,
});
