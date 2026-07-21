-- Drizzle Migration 0001: first schema for the three-layer model (orgs / users / keys)
--
-- Naming: drizzle/<4-digit-number>_<description>.sql
--   - Later chapters add tables with increasing numbers (Ch5 = 0002_*, Ch6 = 0003_*, ...);
--   - migrate.ts applies them in order; applied ones are recorded in __drizzle_migrations
--     and are not re-run;
--   - After changing schema.ts, generate the next migration with `npm run drizzle:generate`.
--     Do not hand-edit migrations that have already been published.

CREATE TABLE `orgs` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `name` text NOT NULL,
    `disabled_at` integer,
    `created_at` integer NOT NULL
);

CREATE TABLE `users` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `org_id` integer NOT NULL,
    `name` text NOT NULL,
    `email` text,
    `disabled_at` integer,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `users_org_email_idx` ON `users` (`org_id`, `email`);

CREATE TABLE `keys` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `user_id` integer NOT NULL,
    `key_hash` text NOT NULL,
    `key_preview` text NOT NULL,
    `name` text NOT NULL,
    `scopes` text DEFAULT 'chat' NOT NULL,
    `expires_at` integer,
    `disabled_at` integer,
    `last_used_at` integer,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `keys_key_hash_idx` ON `keys` (`key_hash`);
CREATE INDEX `keys_user_idx` ON `keys` (`user_id`);
