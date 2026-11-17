import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Kanji table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const kanji = sqliteTable("kanji", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: text("item_id").unique().notNull(),
  character: text("character").notNull(),
  onReading: text("on_reading"),
  kunReading: text("kun_reading"),
  meanings: text("meanings"),
  level: text("level").notNull(),
  strokeCount: integer("stroke_count"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
