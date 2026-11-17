import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessions } from "./sessions";

// Responses table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const responses = sqliteTable(
  "responses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id),
    clientUuid: text("client_uuid").unique().notNull(),
    promptKey: text("prompt_key").notNull(),
    itemKey: text("item_key"),
    answer: text("answer"),
    grade: text("grade").notNull(),
    selfGrade: text("self_grade"),
    bucket: text("bucket").notNull(),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (t) => [
    index("idx_resp_session").on(t.sessionId),
    index("idx_resp_created").on(t.createdAt),
  ],
);