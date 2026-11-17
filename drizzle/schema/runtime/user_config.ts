import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// User Config table Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

export const userConfig = sqliteTable("user_config", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});
