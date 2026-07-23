// Two-Phase Billing Core 
// 
// preConsume: Reserve the estimated cost before entering the main request flow
// 1. Use tiktoken to estimate the prompt token count; 
// 2. Use request.max_tokens (or DEFAULT_MAX_TOKENS) as the maximum output token limit; 
// 3. Load the current price and multipliers, then calculate the reserved amount in micro-CNY; 
// 4. Deduct users.balance_micro using optimistic locking: 
//    UPDATE WHERE balance_micro >= cost. 
//    If the update fails, the user's balance is insufficient and HTTP 402
//    should be returned to the client; 
// 5. Insert a usage_records row with status=reserved as a placeholder. 
// 
// postConsume: Finalize billing after the upstream provider returns: 
// 1. Obtain the actual usage (prompt_tokens / completion_tokens); 
// 2. Recalculate final_cost using the same price and multiplier configuration
//   (read multiplier_snapshot from the reserved record to ensure consistent billing); 
// 3. Calculate delta = (preReservedCost - finalCost); 
//   delta > 0: refund the excess amount; 
//   delta < 0: charge the remaining amount 
//  (the balance may become negative; the exact business policy determines how this is handled)
// 4. Update the usage_records row to status=finalized and persist the actual token usage; 
//    final cost, and multiplier snapshot.
// 
// refund: Fully refund the reserved amount when the upstream request fails.
// Examples include upstream 5xx errors, network errors, or authentication failures. 
// No charge is applied. 
// 1. UPDATE users.balance += preservedCost; 
// 2. UPDATE usage_records SET status=refunded, finalCost = 0

// About Optimistic Locking: 
// - In SQLite,UPDATE ... WHERE balance >= cost combined with RETURNING performs 
//    the "check-and-deduct" operation atomically in a single statement. 
//   Two concurrent requests cannot both deduct the balance and cause it go to negative; 
// - If the updaet affects 0 rows (changes() == 0), another concurrent request may have 
//   already deducted the balance, or the balance was insufficient from the beginning; 
// - Compare with "SELECT first, then UPDATE", this approach saves one round trip 
//   and avoids race conditions such as: 
///  "Read balance = 100, decide to deduct 80, but another request deducts the blaance to 30 before the UDPATE
// executes, and the current request still deducts 80, resulting in a negative balance."

// 
// Comparision with one-api
// - one-api's preconsumeQuota (relay / controller / helper.go: 68) deducts directly from 
// user.Quota without creating a "reserved" placeholder record. 
// This implementation creates a reserved record, making billing status visible for dashboards and auditing; 
// - one-api's postConsumeQuota (relay/controller/helper.go:97) calculates 
// quotaDelta = quota - preConsumed and calls PostConsumeTokenQuoa(tokenId, quotaDelta).
// The delta direction in this implementation is reserved because we use a "refund excess, charge the difference model":
// preReservedCost - finalCost 
// The semantics are equivalent. 

import {eq, sql} from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {usageRecords, users, type UsageRecord} from '../db/schema.js';
import { getCurrentPrice, PriceNotFoundError } from './prices.js';
import { resolveMultiplier } from '../multiplier/registry.js';
import { estimatePromptTokens } from './tokenizer.js';
import { IRMessage } from '../types/ir.js';

export interface PreConsumeInput {
  traceId: string; 
  userId: number; 
  orgId: number; 
  keyId: number; 
  model: string; 
  provider: string; 
  messages: IRMessage[]; 
  // client side max_tokens; default value set as DEFAULT_MAX_TOKENS 
  maxOutputTokens: number; 
  isStream: boolean; 
}

export interface PreConsumeOutput {
  recordId: number; 
  preReservedCost: number; 
  estimatedPromptTokens: number; 
}

export class InsufficientBalanceError extends Error {
  constructor(public required: number, public available: number) {
    super(`insufficient balance: need ${required} micro CNY, have ${available}`); 
    this.name = 'InsufficientBalanceError';  
  }
}


/**
 * preConsume: Reserve the estimated cost and create a placeholder record. 
 * 
 * The process strictly follows the order of "deduct balance first, then create the record"
 * to ensure that the balance deduction is the single source of truth. 
 * 
 * Even if the usage reocrd insertion fails, the balance has already been deducted.
 * A subsequent postConsume operation can reconcile the balance if necessary. 
*/
export function preConsume(input: PreConsumeInput): PreConsumeOutput {
  const db = getDb(); 

  // 1. Estimate prompt tokens locally. 
  const estimatedPromptTokens = estimatePromptTokens(input.messages, input.model); 

  // 2. Load the current price and resolve the combined multiplier.
  const price = getCurrentPrice(input.model, input.provider); 
  const multiplier = resolveMultiplier({
    userId: input.userId, 
    model: input.model, 
    provider: input.provider
  });
  
  // 3. Calculate the reserved amount: 
  // (estimated prompt tokens x input price + max output tokens x output price) * combined multiplier.
  // Round up to the nearest micro-CNY to avoid undercharging
  // due to fractional rounding.
  const baseCost = 
    estimatedPromptTokens * price.inputPricePerToken + 
    input.maxOutputTokens * price.outputPricePerToken; 
  
  const preReservedCost = Math.ceil(baseCost * multiplier.combinedFloat); 

  // 4. Deduct the balance using optimistic locking: 
  // UPDATE WHERE balance >= cost. 
  // Then the balance check and deduction are performed atomically. 
  const updated = db
    .update(users)
    .set({balanceMicro: sql`${users.balanceMicro} - ${preReservedCost}`})
    .where(sql`${users.id} = ${input.userId} AND ${users.balanceMicro} >= ${preReservedCost}`)
    .returning({balance: users.balanceMicro})
    .all(); 

    if (updated.length === 0) {
      // Query the current balance once to provide a more informative error message. 
      const cur = db
        .select({b: users.balanceMicro})
        .from(users)
        .where(eq(users.id, input.userId))
        .all(); 

      const have = cur.length > 0 ? cur[0]!.b : 0; 
      throw new InsufficientBalanceError(preReservedCost, have);  
    }

    // 5. Insert a placeholder usage record with status=reserved. 
    const now = Date.now(); 
    const rows = db 
      .insert(usageRecords)
      .values({
        traceId: input.traceId, 
        userId: input.userId, 
        orgId: input.orgId, 
        keyId: input.keyId, 
        model: input.model, 
        provider: input.provider, 
        promptTokens: 0, 
        completionTokens: 0, 
        estimatedPromptTokens, 
        promptCost: 0, 
        completionCost: 0, 
        finalCost: 0, 
        preReservedCost, 
        multiplierSnapshot: multiplier.combinedScale1e9, 
        status: 'reserved', 
        isStream: input.isStream, 
        createdAt: now, 
      })
      .returning({id: usageRecords.id})
      .all(); 

  return {
    recordId: rows[0]!.id, 
    preReservedCost, 
    estimatedPromptTokens, 
  };
}

// --- post consume --- 
export interface PostConsumeInput {
  recordId: number; 
  userId: number; 
  model: string; 
  provider: string; 
  realPromptTokens: number; 
  realCompletionTokens: number; 
}

export interface PostConsumeOutput {
  recordId: number; 
  promptCost: number; 
  completionCost: number; 
  finalCost: number; 
  balanceDelta: number; 
}

/**
 * postConsume: Finalize the billing using the actual token usage returned by the upstream provider. 
 * 
 * The price and multiplier configuration should be consistent with the values used during preConsume. 
 * 
 * v0.5 simplification: 
 * - Re-fetch getCurrentPrice / resolveMultiplier. Since the price cache has a 60-second TTL, 
 *   the values will usually remain unchanged during a single request. 
 * 
 * - Strict production implementation: 
 *   Read the price and multiplier snapshots stored in the usage during preConsume 
 *   to guarantee that the same pricing configuration is used for final settlement. 
*/
export function postConsume(input: PostConsumeInput): PostConsumeOutput {
  const db = getDb(); 
  const price = getCurrentPrice(input.model, input.provider); 
  const multiplier = resolveMultiplier({
    userId: input.userId, 
    model: input.model, 
    provider: input.provider
  }); 

  const promptCost = Math.ceil(input.realPromptTokens * price.inputPricePerToken * multiplier.combinedFloat); 
  const completionCost = Math.ceil(
    input.realCompletionTokens * price.outputPricePerToken * multiplier.combinedFloat, 
  ); 
  const finalCost = promptCost + completionCost; 

  // fetch record via record id, and update record via received delta 
  const rec = db
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.id, input.recordId))
    .all(); 

    if (rec.length === 0) {
      throw new Error(`usage_record ${input.recordId} not found`); 
    }
    const row = rec[0]; 
    if (row.status != 'reserved') {
      // idempotency protection 
      return {
        recordId: row.id, 
        balanceDelta: 0, 
        finalCost: row.finalCost, 
        completionCost: row.completionCost, 
        promptCost: row.promptCost, 
      }; 
    }


    // balanceDelta = preReserved - finalCost 
    // > 0: refund, user account balance += delta 
    // < 0: deduction, user account balance -= |delta|
    const balanceDelta = row.preReservedCost - finalCost; 
    if (balanceDelta !== 0) {
      db.update(users)
        .set({balanceMicro: sql`${users.balanceMicro} + ${balanceDelta}`})
        .where(eq(users.id, input.userId))
        .run(); 
    }

    const now = Date.now(); 
    db.update(usageRecords)
      .set({
        promptTokens: input.realPromptTokens, 
        completionTokens: input.realCompletionTokens, 
        promptCost, 
        completionCost, 
        finalCost, 
        status: 'finalized', 
        finalizedAt: now, 
      })
      .where(eq(usageRecords.id, input.recordId))
      .run(); 

      return {recordId: input.recordId, promptCost, completionCost, finalCost, balanceDelta}; 
}

/**
 * refund: Fully refund the reserved amount when the upstream request fails. 
 * 
 * Examples include upstream errors, network failures, and authentication failures. 
 * The request is not charged. 
 * 
 * This operation is mutally exclusive with postConsume:
 * once a record is marked as refunded, it permanently remains in the refunded state
 * and must not be processed by postConsume. 
*/
export function refundReservation(recordId: number, errorMessage?: string): void {
  const db = getDb(); 
  const rec = db.select().from(usageRecords).where(eq(usageRecords.id, recordId)).all(); 
  if (rec.length === 0) return; 
  const row = rec[0]!; 
  if (row.status !== 'reserved') return;  // idempotency 

  db.update(users)
    .set({balanceMicro: sql`${users.balanceMicro} + ${row.preReservedCost}`})
    .where(eq(users.id, row.userId))
    .run(); 

  db.update(usageRecords)
    .set({
      status: 'refunded', 
      finalCost: 0, 
      finalizedAt: Date.now(), 
      errorMessage: errorMessage ?? null, 
    })
    .where(eq(usageRecords.id, recordId))
    .run(); 
}

/**
 * Mark the usage record as failed. 
 * 
 * Used when an exception occurs during postConsume. 
 * The already-deducted balance remains unchanged and must be reconciled manually
 * or by a subsequent reconcilation process. 
*/
export function markFailed(recordId: number, errorMessage: string): void {
  const db = getDb(); 
  db.update(usageRecords)
    .set({status: 'failed', errorMessage, finalizedAt: Date.now()})
    .where(eq(usageRecords.id, recordId))
    .run(); 
}

export {PriceNotFoundError}; 
export type {UsageRecord}; 