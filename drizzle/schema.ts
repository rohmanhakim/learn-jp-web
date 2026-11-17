import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Schema per docs/DATA-MODEL.md — semantics must match the DDL there;
// only mechanical D1/SQLite adjustments are allowed.

// ─── content tables (seeded, immutable) ─────────────────────────────

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

export const passages = sqliteTable(
  "passages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").unique().notNull(),
    level: text("level").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    createdBy: text("created_by").default("seed"),
    curated: integer("curated").default(0),
    status: text("status").default("selectable"),
    profileHash: text("profile_hash"),
    generatedAt: text("generated_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (t) => [
    // D13 pool dedup: one generated story per mastery profile.
    uniqueIndex("uq_passages_profile")
      .on(t.profileHash)
      .where(sql`${t.profileHash} IS NOT NULL`),
  ],
);

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

// ─── runtime tables ─────────────────────────────────────────────────

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

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientUuid: text("client_uuid").unique().notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  snapshot: text("snapshot").notNull(),
  stats: text("stats"),
  durationSec: integer("duration_sec"),
});

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

export const unknownWords = sqliteTable("unknown_words", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: text("item_id"),
  surface: text("surface").notNull(),
  reading: text("reading"),
  meaning: text("meaning"),
  sourcePassage: text("source_passage"),
  status: text("status").default("queued"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

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

export const userConfig = sqliteTable("user_config", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});
