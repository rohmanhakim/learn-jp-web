import { integer, sqliteTable, text, } from "drizzle-orm/sqlite-core";
import { passages } from "./passages";

// Passage Questions table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const passageQuestions = sqliteTable("passage_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  passageKey: text("passage_key")
    .notNull()
    .references(() => passages.key),
  ordinal: integer("ordinal").notNull(),
  prompt: text("prompt").notNull(),
  choices: text("choices").notNull(),
  answerIndex: integer("answer_index").notNull(),
  explanation: text("explanation"),
  vocabFocus: text("vocab_focus"),
});