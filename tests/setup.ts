// Applies the Drizzle-generated migrations to the test D1 database
// before each test file (same SQL that `wrangler d1 migrations apply` runs).
//
// Migrations are loaded with Vite's import.meta.glob — deliberately NOT
// with readD1Migrations() from the plugin root: importing that entry inside
// the test runtime (workerd) pulls miniflare/undici into the worker graph
// and crashes the pool when undici does require('node:console').
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";

const files = import.meta.glob("../drizzle/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Drizzle separates statements with `--> statement-breakpoint`.
const migrations: D1Migration[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([filePath, contents]) => ({
    name: (filePath.split("/").pop() ?? filePath).replace(/\.sql$/, ""),
    queries: contents
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter((query) => query.length > 0),
  }));

await applyD1Migrations(env.DB, migrations);
