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
    // NULL exactly when `kind_hint` is set (D-1 fast-skip / capture rows
    // carry nothing graded) — DATA-MODEL.md `responses` DDL.
    grade: text("grade"),
    selfGrade: text("self_grade"),
    // 'fast_skip' | 'unknown_word' | NULL (decision D-1) — rows with a
    // hint are excluded from bucket-accuracy queries (§3).
    kindHint: text("kind_hint"),
    bucket: text("bucket").notNull(),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (t) => [
    index("idx_resp_session").on(t.sessionId),
    index("idx_resp_created").on(t.createdAt),
  ],
);