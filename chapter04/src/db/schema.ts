import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

// ======================================
// orgs: tenant / organization
// - enterprise: a department or business line
// - personal / sell-token: a paying customer
// org:user => 1:N, user:key => 1:N
// ======================================
export const orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // null = enabled; non-null = disabled timestamp
  disableAt: integer('disable_at'),
  createdAt: integer('created_at').notNull(),
});

// ======================================
// users: end users under an org
// - enterprise: one employee = one user
// - personal / sell-token: one developer account = one user
// ======================================
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // foreign key to orgs
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id),
    // display name for UI / logging attribution, not used for auth
    name: text('name').notNull(),
    // email for notifications and deduplication (not wired in this chapter)
    email: text('email'),
    disabledAt: integer('disabled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    // email unique within an org; null is not deduplicated (SQLite behavior)
    uniqueIndex('users_org_email_idx').on(table.orgId, table.email),
  ],
);

// ============================================================
// keys: internal API Key
//   - Store only sha256 hash + prefix + last 4 chars for UI display (e.g. sk-gw-...x9k2)
//   - Plaintext is never persisted; it appears once in the issueKey() return value
//   - Metadata:
//     - name: user-chosen label ("CI Bot Key" / "Production")
//     - scopes: comma-separated string, e.g. "chat,embeddings"; reserved for later chapters
//     - expiresAt: null = never expires; non-null expired keys are rejected at auth time
//     - disabledAt: immediate revoke flag; complements expiresAt (active vs passive)
//     - lastUsedAt: display only, not used in auth; refreshed on each successful call
// ============================================================
export const keys = sqliteTable(
  'keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    /**
     * sha256 hex of sk-gw-<random 43 chars>, length 64.
     * uniqueIndex both prevents duplicates and lets auth queries use a B-tree.
     */
    keyHash: text('key_hash').notNull(),
    /** Display prefix, e.g. sk-gw-...x9k2. Not used for auth; need not be unique. */
    keyPreview: text('key_preview').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').notNull().default('chat'),
    /** unix ms; null = never expires */
    expiresAt: integer('expires_at'),
    /** unix ms; null = not revoked; non-null = when immediate revoke took effect */
    disabledAt: integer('disabled_at'),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('keys_key_hash_idx').on(table.keyHash),
    index('keys_user_idx').on(table.userId),
  ],
);


// ==========================================================================================
// Runtime type. Inferred from the schema by Drizzle; no hand-written interface needed. 
// ==========================================================================================
export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Key = typeof keys.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type NewUser = typeof users.$inferInsert;
export type NewKey = typeof keys.$inferInsert; 