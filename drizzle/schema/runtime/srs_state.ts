import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SRS State table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const srsState = sqliteTable(
  "srs_state",
  {
    itemKey: text("item_key").primaryKey(),
    kind: text("kind").notNull(),
    ease: real("ease").notNull().default(2.5),
    intervalDays: real("interval_days").notNull().default(0),
    dueAt: text("due_at").notNull(),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    suspended: integer("suspended").notNull().default(0),
    lastGrade: text("last_grade"),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
  },
  (t) => [ index("idx_srs_due").on(t.dueAt, t.suspended) ],
);