import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Writing Prompts table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const writingPrompts = sqliteTable("writing_prompts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").unique().notNull(),
  level: text("level").notNull(),
  kind: text("kind").notNull(),
  prompt: text("prompt").notNull(),
  modelAnswer: text("model_answer").notNull(),
  requiredTokens: text("required_tokens"),
  vocabFocus: text("vocab_focus"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});