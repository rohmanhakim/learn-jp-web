CREATE TABLE `kanji` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`character` text NOT NULL,
	`on_reading` text,
	`kun_reading` text,
	`meanings` text,
	`level` text NOT NULL,
	`stroke_count` integer,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kanji_item_id_unique` ON `kanji` (`item_id`);--> statement-breakpoint
CREATE TABLE `passage_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`passage_key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`prompt` text NOT NULL,
	`choices` text NOT NULL,
	`answer_index` integer NOT NULL,
	`explanation` text,
	`vocab_focus` text,
	FOREIGN KEY (`passage_key`) REFERENCES `passages`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `passages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`level` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`created_by` text DEFAULT 'seed',
	`curated` integer DEFAULT 0,
	`status` text DEFAULT 'selectable',
	`profile_hash` text,
	`generated_at` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passages_key_unique` ON `passages` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_passages_profile` ON `passages` (`profile_hash`) WHERE "passages"."profile_hash" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`client_uuid` text NOT NULL,
	`prompt_key` text NOT NULL,
	`item_key` text,
	`answer` text,
	`grade` text NOT NULL,
	`self_grade` text,
	`bucket` text NOT NULL,
	`latency_ms` integer,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `responses_client_uuid_unique` ON `responses` (`client_uuid`);--> statement-breakpoint
CREATE INDEX `idx_resp_session` ON `responses` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_resp_created` ON `responses` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_uuid` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`snapshot` text NOT NULL,
	`stats` text,
	`duration_sec` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_client_uuid_unique` ON `sessions` (`client_uuid`);--> statement-breakpoint
CREATE TABLE `srs_state` (
	`item_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ease` real DEFAULT 2.5 NOT NULL,
	`interval_days` real DEFAULT 0 NOT NULL,
	`due_at` text NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`suspended` integer DEFAULT 0 NOT NULL,
	`last_grade` text,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_srs_due` ON `srs_state` (`due_at`,`suspended`);--> statement-breakpoint
CREATE TABLE `unknown_words` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text,
	`surface` text NOT NULL,
	`reading` text,
	`meaning` text,
	`source_passage` text,
	`status` text DEFAULT 'queued',
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `user_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `vocabulary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`content` text NOT NULL,
	`reading` text,
	`meaning` text NOT NULL,
	`level` text NOT NULL,
	`part_of_speech` text,
	`source` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vocabulary_item_id_unique` ON `vocabulary` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_vocab_level` ON `vocabulary` (`level`);--> statement-breakpoint
CREATE TABLE `writing_evaluations` (
	`response_uuid` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`feedback` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`response_uuid`) REFERENCES `responses`(`client_uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `writing_prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`model_answer` text NOT NULL,
	`required_tokens` text,
	`vocab_focus` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `writing_prompts_key_unique` ON `writing_prompts` (`key`);