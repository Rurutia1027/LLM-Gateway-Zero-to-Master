// Chapter 5: billing tables on top of Ch4 orgs / users / keys
//
// New fields / tables (implement below — see drizzle/0002_billing.sql):
//   - users.balanceMicro     : balance in micro-yuan (1e-6 CNY). Integer avoids float drift.
//                              1 CNY = 1_000_000 micro-yuan.
//   - users.userMultiplier   : user discount as per-mille integer. Baseline 1.0 = 1000.
//   - prices                 : price table (model × provider × time window). Hot-reloadable.
//   - usage_records          : per-request ledger (trace_id / status / cost).
//
// Design notes:
//   - Inspired by one-api model/log.go (single Log table) — we split input/output
//     unit prices and costs into separate columns.
//   - Inspired by new-api billingexpr — v0.5 hard-codes three multipliers instead
//     of an AST; prices already reserves time-window hot reload for Ch10.
//
// Money design:
//   1. All money fields are integer micro-yuan, never real/float. SQLite REAL is
//      IEEE 754; 0.1 + 0.2 != 0.3 blows up monthly aggregates.
//   2. prices.effective_from / effective_to are unix ms. Vendor or ops price
//      changes INSERT a new row (do not UPDATE old rows) so historical
//      usage_records always reflect "the price at that time".
//   3. usage_records.status lifecycle: reserved -> finalized / refunded / failed.
//      reserved means pre-debit happened; finalized means postConsume finished.
//
// TODO(ch05):
//   1. Add balanceMicro + userMultiplier columns on users
//   2. Define prices table
//   3. Define usageRecords table
//   4. Export Price / UsageRecord inferred types

import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

// ============================================================
// orgs: same as Ch4
// ============================================================
export const orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // null = enabled; non-null = disabled timestamp
  disabledAt: integer('disabled_at'),
  createdAt: integer('created_at').notNull(),
});

// ============================================================
// users: Ch4 base — TODO(ch05) add balanceMicro + userMultiplier
//
//   balanceMicro: balance in 1e-6 CNY. preConsume -= cost;
//                 postConsume += (preReserved - actualCost) to settle delta.
//
//   userMultiplier: per-mille integer. 1000 = 1.0x, 800 = 0.8x, 1500 = 1.5x.
//     final_cost = base × user × channel × model multipliers.
// ============================================================
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    email: text('email'),
    disabledAt: integer('disabled_at'),
    createdAt: integer('created_at').notNull(),
    
    // ----- Added in v0.5 -----
    /** Balance in 1e-6 CNY (micro-yuan). Default: INITIAL_BALANCE_CNY × 1_000_000. */
    balanceMicro: integer('balance_micro').notNull().default(0),
    /** User multiplier as a milli-integer. Default 1000 = 1.0x. */
    userMultiplier: integer('user_multiplier').notNull().default(1000), 
  },
  (table) => [
    uniqueIndex('users_org_email_idx').on(table.orgId, table.email),
  ],
);

// ============================================================
// keys: same as Ch4
// ============================================================
export const keys = sqliteTable(
  'keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    keyHash: text('key_hash').notNull(),
    keyPreview: text('key_preview').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').notNull().default('chat'),
    expiresAt: integer('expires_at'),
    disabledAt: integer('disabled_at'),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('keys_key_hash_idx').on(table.keyHash),
    index('keys_user_idx').on(table.userId),
  ],
);

// ============================================================
// prices — unit price table
//
//   One row = (model, provider, effective window) with input + output unit prices.
//   On price change: INSERT new row; set old row effective_to = new effective_from.
//   Unit: CNY / 1M tokens, stored as micro-CNY / 1M tokens:
//     inputPriceMicroPer1M = yuan × 1_000_000
//     e.g. gpt-4o-mini input ≈ 1.05 CNY / 1M → store 1_050_000
//   effective_to null = still active.
// ============================================================
export const prices = sqliteTable(
  'prices', 
  {
    id: integer('id').primaryKey({autoIncrement: true}), 
    model: text('model').notNull(), 
    provider: text('provider').notNull(), 
    inputPriceMicroPer1M: integer('input_price_micro_per_1m').notNull(), 
    outputPriceMicroPer1M: integer('output_price_micro_per_1m').notNull(), 
    modelMultiplier: integer('model_multiplier').notNull().default(1000), 
    effectiveFrom: integer('effective_from').notNull(), 
    effectiveTo: integer('effective_to'), 
    createdAt: integer('created_at').notNull(),  
  }, 
  (table) => ({
    modelProviderIdx: uniqueIndex('prices_model_provider_idx').on(table.model, table.provider), 
  }), 
); 

// ============================================================
// usage_records — per-request ledger
//
//   Status lifecycle:
//     reserved  -> preConsume done, balance reserved, waiting upstream
//     finalized -> postConsume done, real usage settled
//     refunded  -> upstream failed; full reservation returned; no charge
//     failed    -> postConsume error; reservation already taken (manual reconcile)
//
//   Key fields:
//     trace_id, pre_reserved_cost, final_cost,
//     prompt_cost / completion_cost, prompt_tokens / completion_tokens,
//     estimated_prompt_tokens, multiplier_snapshot (user × channel × model product)
// ============================================================
export const usageRecords = sqliteTable('usage_records', { 
  id: integer('id').primaryKey({autoIncrement: true}), 

  // trace id 
  traceId: text('trace_id').notNull(), 

  userId: integer('user_id').notNull(), 

  orgId: integer('org_id').notNull(), 

  keyId: integer('key_id').notNull(), 

  // model / provider  
  model: text('model').notNull(), 
  provider: text('provider').notNull(), 

  // real token number (upstream received; accumulate based on streaming)
  promptTokens: integer('prompt_tokens').notNull().default(0), 
  completionTokens: integer('completion_tokens').notNull().default(0), 

  // local tiktoken estimated input token (for reconciliation)
  estimatedPromptTokens: integer('estimated_prompt_tokens').notNull().default(0), 

  // cost decompose (unit=micro-CNY) 
  promptCost: integer('prompt_cost').notNull().default(0), 
  completionCost: integer('completion_cost').notNull().default(0), 
  finalCost: integer('final_cost').notNull().default(0), 


  // pre-reserved cost (before postConsume) 
  preReservedCost: integer('pre_reserved_cost').notNull().default(0), 

  // user × channel × model product (for reconciliation)
  multiplierSnapshot: integer('multiplier_snapshot').notNull().default(1_000_000_000), 

  // status: reserved / finalized / refunded / failed 
  status: text('status').notNull().default('reserved'), 

  // stream, this is used in streaming purchase 
  isStream: integer('is_stream', {mode: 'boolean'}).notNull().default(false), 

  // error message (status = failed only)
  errorMessage: text('error_message'), 

  createdAt: integer('created_at').notNull(), 

  // finalized time (status = reserved -> finalized only)
  finalizedAt: integer('finalized_at'), 
}, 
(table) => ({
  traceIdx: uniqueIndex('usage_records_trace_idx').on(table.traceId), 
  userTimeIdx: index('usage_records_user_time_idx').on(table.userId, table.cratedAt), 
  keyTimeIdx: index('usage_records_key_time_idx').on(table.keyId, table.createdAt), 
  modelTimeIdx: index('usage_records_model_time_ids').on(table.model, table.createdAt), 
  statusIdx: index('usage_records_status_idx').on(table.status), 
  }), 
);

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Key = typeof keys.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type NewUser = typeof users.$inferInsert;
export type NewKey = typeof keys.$inferInsert;
export type Price = typeof prices.$inferSelect; 
export type NewPrice = typeof prices.$inferInsert
export type UsageRecord = typeof usageRecords.$inferSelect; 
export type NewUsageRecord = typeof usageRecords.$inferInsert; 
