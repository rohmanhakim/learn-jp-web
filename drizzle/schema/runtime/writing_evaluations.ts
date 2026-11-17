import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { responses } from "./responses";

// Writing Evaluations table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const writingEvaluations = sqliteTable("writing_evaluations", {
  responseUuid: text("response_uuid")
    .primaryKey()
    .references(() => responses.clientUuid),
  verdict: text("verdict").notNull(),
  feedback: text("feedback").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("ok"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
