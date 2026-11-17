import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Sessions table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientUuid: text("client_uuid").unique().notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  snapshot: text("snapshot").notNull(),
  stats: text("stats"),
  durationSec: integer("duration_sec"),
});
