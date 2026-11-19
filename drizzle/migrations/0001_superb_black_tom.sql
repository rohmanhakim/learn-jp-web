PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`client_uuid` text NOT NULL,
	`prompt_key` text NOT NULL,
	`item_key` text,
	`answer` text,
	`grade` text,
	`self_grade` text,
	`kind_hint` text,
	`bucket` text NOT NULL,
	`latency_ms` integer,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_responses`("id", "session_id", "client_uuid", "prompt_key", "item_key", "answer", "grade", "self_grade", "kind_hint", "bucket", "latency_ms", "created_at") SELECT "id", "session_id", "client_uuid", "prompt_key", "item_key", "answer", "grade", "self_grade", "kind_hint", "bucket", "latency_ms", "created_at" FROM `responses`;--> statement-breakpoint
DROP TABLE `responses`;--> statement-breakpoint
ALTER TABLE `__new_responses` RENAME TO `responses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `responses_client_uuid_unique` ON `responses` (`client_uuid`);--> statement-breakpoint
CREATE INDEX `idx_resp_session` ON `responses` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_resp_created` ON `responses` (`created_at`);