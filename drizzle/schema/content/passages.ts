import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Passages table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const passages = sqliteTable(
  "passages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").unique().notNull(),
    level: text("level").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    createdBy: text("created_by").default("seed"),
    curated: integer("curated").default(0),
    status: text("status").default("selectable"),
    profileHash: text("profile_hash"),
    generatedAt: text("generated_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (t) => [
    // D13 pool dedup: one generated story per mastery profile.
    uniqueIndex("uq_passages_profile")
      .on(t.profileHash)
      .where(sql`${t.profileHash} IS NOT NULL`),
  ],
);