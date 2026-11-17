import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Vocabulary Table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const vocabulary = sqliteTable(
  "vocabulary",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: text("item_id").unique().notNull(),
    content: text("content").notNull(),
    reading: text("reading"),
    meaning: text("meaning").notNull(),
    level: text("level").notNull(),
    partOfSpeech: text("part_of_speech"),
    source: text("source"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (t) => [index("idx_vocab_level").on(t.level)],
);
