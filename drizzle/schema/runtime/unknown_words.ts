import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Unknown Words table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const unknownWords = sqliteTable("unknown_words", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: text("item_id"),
  surface: text("surface").notNull(),
  reading: text("reading"),
  meaning: text("meaning"),
  sourcePassage: text("source_passage"),
  status: text("status").default("queued"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});