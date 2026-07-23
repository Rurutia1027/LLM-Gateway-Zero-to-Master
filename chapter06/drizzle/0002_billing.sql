-- Drizzle Migration 0002: v0.5 billing pipeline
--
-- Changes:
--   1. Add balance_micro / user_multiplier columns on users;
--   2. Create prices table (model × provider × time-window unit prices);
--   3. Create usage_records table (per-request ledger).
--
-- Note: SQLite ALTER TABLE can only ADD COLUMN (no ALTER/DROP COLUMN).
-- That is why columns from 0001 are not rewritten here — only additive changes.

-- ----- users: add columns -----
ALTER TABLE `users` ADD COLUMN `balance_micro` integer NOT NULL DEFAULT 0;
ALTER TABLE `users` ADD COLUMN `user_multiplier` integer NOT NULL DEFAULT 1000;

-- ----- prices -----
CREATE TABLE `prices` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `model` text NOT NULL,
    `provider` text NOT NULL,
    `input_price_micro_per_1m` integer NOT NULL,
    `output_price_micro_per_1m` integer NOT NULL,
    `model_multiplier` integer NOT NULL DEFAULT 1000,
    `effective_from` integer NOT NULL,
    `effective_to` integer,
    `created_at` integer NOT NULL
);
CREATE INDEX `prices_model_provider_idx` ON `prices` (`model`, `provider`);

-- ----- usage_records -----
CREATE TABLE `usage_records` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `trace_id` text NOT NULL,
    `user_id` integer NOT NULL,
    `org_id` integer NOT NULL,
    `key_id` integer NOT NULL,
    `model` text NOT NULL,
    `provider` text NOT NULL,
    `prompt_tokens` integer NOT NULL DEFAULT 0,
    `completion_tokens` integer NOT NULL DEFAULT 0,
    `estimated_prompt_tokens` integer NOT NULL DEFAULT 0,
    `prompt_cost` integer NOT NULL DEFAULT 0,
    `completion_cost` integer NOT NULL DEFAULT 0,
    `final_cost` integer NOT NULL DEFAULT 0,
    `pre_reserved_cost` integer NOT NULL DEFAULT 0,
    `multiplier_snapshot` integer NOT NULL DEFAULT 1000000000,
    `status` text NOT NULL DEFAULT 'reserved',
    `is_stream` integer NOT NULL DEFAULT 0,
    `error_message` text,
    `created_at` integer NOT NULL,
    `finalized_at` integer
);
CREATE UNIQUE INDEX `usage_records_trace_idx` ON `usage_records` (`trace_id`);
CREATE INDEX `usage_records_user_time_idx` ON `usage_records` (`user_id`, `created_at`);
CREATE INDEX `usage_records_key_time_idx` ON `usage_records` (`key_id`, `created_at`);
CREATE INDEX `usage_records_model_time_idx` ON `usage_records` (`model`, `created_at`);
CREATE INDEX `usage_records_status_idx` ON `usage_records` (`status`);
