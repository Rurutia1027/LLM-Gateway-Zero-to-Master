// Chapter 6 schema: on top of Ch5's orgs / users / keys / prices / usage_records,
// only adds 5 fields to keys for rate limits + monthly quota (see 0003_quota.sql).
//
// users / orgs / prices / usage_records are unchanged: rate limiting is a new dimension.
// QPS state lives in process memory (sliding window), TPM reservations live in process memory
// (60s rolling window). For monthly quota caps (key-level cumulative usage), we only need to
// persist two columns: "quota limit + cumulative used".
// Second-/minute-level QPS/TPM window state itself is not stored in DB
// (reset on restart; single-process memory is enough).
//
// Historical fields kept:
//   - users.balanceMicro / userMultiplier : already in Ch5
//   - prices / usage_records              : already in Ch5
//
// Design references:
//   - one-api model/log.go (single-dimension Log table) -> this book splits finer:
//     separate input/output pricing + separate input/output cost columns
//   - new-api pkg/billingexpr/expr.md (expression-based billing) -> Ch5 in this book
//     simplifies with "hardcoded three multipliers", no AST evaluation; however,
//     the prices table schema already reserves "time-window hot reload", so in Ch10
//     it can switch to expression billing for cost optimization seamlessly.
//
// Key design points:
//   1. All monetary fields use integer (micro-units), not real/float. SQLite REAL is IEEE-754
//      double precision; pitfalls like 0.1 + 0.2 != 0.3 get amplified when accumulating monthly bills;
//   2. effective_from / effective_to in price rows are unix milliseconds, used for exact time-window matching.
//      Upstream price changes or ops price updates insert a new row instead of UPDATE-ing old rows, so
//      historical usage_records always resolve to "the price at that time";
//   3. usage_records.status spans the full lifecycle: reserved -> finalized / refunded / failed.
//      Writing a reserved row means pre-consume happened; finalized is the terminal state after postConsume.

import {integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'; 

// reuse orgs from ch04
export const orgs = sqliteTable('orgs', {
    id: integer('id').primaryKey({autoIncrement: true}), 
    name: text('name').notNull(), 
    disabledAt: integer('disabled_at'), 
    createdAt: integer('created_at').notNull(), 
}); 

// users: based on Ch4 add balanceMicro + userMultiplier 
// balanceMicro: balance, unit 1e-6. 1 usd = 1_000_000 micro balance 
// userMultiplier: pricing multiplier, 1.0 = base price  
export const users = sqliteTable('users', {
    id: integer('id').primaryKey({autoIncrement: true}), 
    orgId: integer('org_id').notNull().references(() => orgs.id), 
    name: text('name').notNull(), 
    email: text('email'),
    disabledAt: integer('disabled_at'), 
    createdAt: integer('created_at').notNull(), 
    balanceMicro: integer('balance_micro').notNull().default(0),  
    userMultiplier: integer('user_multiplier').notNull().default(1000),  
}, 
(table) => ({
    emailIdx: uniqueIndex('users_org_email_idx').on(table.orgId, table.email), 
}), 
); 

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

        // --- Added in v0.6 ---- 
        /** Max requests per second (checked by sliding window). 0 = unlimited. */
        qpsLimit: integer('qps_limit').notNull().default(0), 


        /**  Max tokens per minute (input + output 0 = unlimited.*/
        tpmLimit: integer('tpm_limit').notNull().default(0), 

          /** Monthly quota cap, in micro-CNY. 0 = unlimited. Exceeding it returns 402. */
        monthlyQuotaMicro: integer('monthly_quota_micro').notNull().default(0), 

        /** Cumulative amount used in the current month, in micro-CNY. Incremented in postConsume; reset across months. */
        monthlyUsedMicro: integer('monthly_used_micro').notNull().default(0), 

        /** Unix ms of the last quota reset (month change). */
        quotaResetAt: integer('quota_reset_at').notNull().default(0), 
    }, 
    (table) => ({
        keyHashIdx: uniqueIndex('keys_key_hash_idx').on(table.keyHash), 
        userIdx: index('keys_user_idx').on(table.userId), 
    }), 
); 

// ===============================================
// prices: price table 
// One row = "input + output" unit prices under a (model, provider, effective time window) tuple. 
// On repricing, insert a new row instead of UPDATE-ing the old row; set old row's effective_to 
// to the new row's effective_from. 
// 
// Unit price unit: CNY / 1M tokens (how mainstream providers publish prices), stored as micro-CNY / 1M tokens: 
// 1 CNY = 1_000_000 micro-CNY; inputPriceMicroPer1M = CNY * 1_000_000 . 
// Example: gpt-4o-mini input public price is about 1.05 CNY / 1M -> store 1_050_000. 
// 
// Time window: effective_to = null means "still active as of now". 
// ===============================================

export const prices = sqliteTable('prices', 
    {
        id: integer('id').primaryKey({autoIncrement: true}), 

        // Model literal (e.g., gpt-4o-mini / claude-3-5-sonnet-20241022), aligned with request body's model field. 
        model: text('model').notNull(), 

        // Provider identifier (e.g., openai / anthropic / google / azure / etc.), aligned with request body's provider field. 
        provider: text('provider').notNull(), 

        // input unit price: micro-CNY / 1M tokens 
        inputPriceMicroPer1M: integer('input_price_micro_per_1m').notNull(),  

        // output unit price: micro-CNY / 1M tokens ; usually input token * 3 ~5 
        outputPriceMicroPer1M: integer('output_price_micro_per_1m').notNull(), 

        // model-level multiplier (per-thousands). Example: if baseline is set to 1.2x, store 1200. 
        modelMultiplier: integer('model_multiplier').notNull().default(1000), 

        // Unix ms of the effective start time. 
        effectiveFrom: integer('effective_from').notNull(), 

        // Unix ms of the effective end time. null = still active as of now. 
        effectiveTo: integer('effective_to'),  

        createdAt: integer('created_at').notNull(),  
    }, 
    (table) => ({
        // hot path query: find current effective price by (model, provider)
        modelProviderIdx: uniqueIndex('prices_model_provider_idx').on(table.model, table.provider), 
    }), 
); 

// ============================================================
// usage_records: billing record per request
//
//   Lifecycle (status field):
//     reserved  -> preConsume completed, balance pre-deducted, waiting for upstream response
//     finalized -> postConsume completed, real usage settled, delta reconciled
//     refunded  -> upstream failed/rejected, full pre-deduction refunded, not billed
//     failed    -> exception during postConsume, but pre-deduction already happened (needs manual reconciliation)
//
//   Key fields:
//     trace_id          : request-wide trace id, used by Ch9 dashboard drill-down
//     pre_reserved_cost : actual amount deducted in preConsume (micro-CNY)
//     final_cost        : real cost computed in postConsume (micro-CNY); for interrupted streams,
//                         reflects the settled amount for tokens received so far
//     prompt_cost / completion_cost : stored separately for dimension-level auditing
//     prompt_tokens / completion_tokens : real tokens (from upstream usage; accumulated in streaming)
//     estimated_prompt_tokens : local tiktoken estimate of input tokens, for reconciliation vs upstream usage
//     multiplier_snapshot : per-request snapshot of combined multiplier (user × channel × model)
//                           (store integer product; do not store pointers/references, because ops changes
//                           later must not rewrite historical bills)
// ============================================================
export const usageRecords = sqliteTable(
    'usage_records',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      /** Trace ID, one per request. 32-char hex(16). */
      traceId: text('trace_id').notNull(),
      /** Attribution dimensions */
      userId: integer('user_id').notNull(),
      orgId: integer('org_id').notNull(),
      keyId: integer('key_id').notNull(),
      /** Model / provider channel */
      model: text('model').notNull(),
      provider: text('provider').notNull(),
      /** Real token counts (from upstream usage; accumulated for streams) */
      promptTokens: integer('prompt_tokens').notNull().default(0),
      completionTokens: integer('completion_tokens').notNull().default(0),
      /** Local tiktoken estimated input tokens (for reconciliation) */
      estimatedPromptTokens: integer('estimated_prompt_tokens').notNull().default(0),
      /** Cost breakdown (micro-CNY) */
      promptCost: integer('prompt_cost').notNull().default(0),
      completionCost: integer('completion_cost').notNull().default(0),
      finalCost: integer('final_cost').notNull().default(0),
      /** Pre-reserved amount (micro-CNY), used to compute delta in postConsume */
      preReservedCost: integer('pre_reserved_cost').notNull().default(0),
      /** Combined multiplier snapshot (user × channel × model per-thousand integers). 1_000_000_000 = 1.0x */
      multiplierSnapshot: integer('multiplier_snapshot').notNull().default(1_000_000_000),
      /** State machine: reserved / finalized / refunded / failed */
      status: text('status').notNull().default('reserved'),
      /** Streaming request? Used for Ch7 streaming billing loop reconciliation */
      isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
      /** Error message (filled when status = failed) */
      errorMessage: text('error_message'),
      createdAt: integer('created_at').notNull(),
      /** Settlement time (unix ms), when status transitions reserved -> finalized */
      finalizedAt: integer('finalized_at'),
    },
    (table) => ({
      traceIdx: uniqueIndex('usage_records_trace_idx').on(table.traceId),
      userTimeIdx: index('usage_records_user_time_idx').on(table.userId, table.createdAt),
      keyTimeIdx: index('usage_records_key_time_idx').on(table.keyId, table.createdAt),
      modelTimeIdx: index('usage_records_model_time_idx').on(table.model, table.createdAt),
      statusIdx: index('usage_records_status_idx').on(table.status),
    }),
  );

// ============================================================
// Runtime types
// ============================================================

