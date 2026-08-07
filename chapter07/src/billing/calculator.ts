// Two-phase billing core 
// 
// preConsume: reserve before the main flow 
// 1. Estimate prompt tokens with tiktoken; 
// 2. Use request.max_tokens (or DEFAULT_MAX_TOKENS) as the output upper bound; 
// 3. Take current price + multipliers -> pre-reserved amount (micro-CNY); 
// 4. Debit users.balance_micro with an optimistic lock: 
//    UPDATE WHERE balance_micro >= cost; failure = insufficient balance -> 402 to client; 
// 5. Insert a usage_records row (status = reserved) as a placeholder. 

// postConsume: settle after the upstrea response
// 1. Take real usage (prompt_tokens / completion_tokens); 
// 2. Recompute final_cost with the same price + multipliers 
//    (read multipler_snapshot from the reserved row so settlement price stays consistent); 
// 3. delta = preReservedCost - finalCost 
//        delta > 0: refund the over-charge (UPDATE balance += delta)
//        delta < 0: charge the shortfall (UPDATE balance -= |delta|; may go negative - product policy)
// 4. UPDATE the usage_records row to status=finalized, write token / cost / multiplier_snapshot. 
// 
// refund: on upstream 5xx / network error / auth failure, refund the full reserve — no charge
//   1. UPDATE users.balance += preReservedCost;
//   2. usage_records SET status=refunded, finalCost=0.
// 
// On the "optimistic lock":
//   - SQLite UPDATE WHERE balance >= cost with RETURNING atomically does
//     "check-and-debit" in one statement; two concurrent requests cannot both overdraw;
//   - failure (changes() = 0) means another concurrent request debited first, or balance was already short.
//   - Cheaper than SELECT-then-UPDATE (one less round trip), and avoids the race where
//     you read balance 100, decide to debit 80, then UPDATE after another request already
//     took it to 30 and still drive it negative.
//
// vs one-api:
//   - one-api preConsumeQuota (relay/controller/helper.go:68): debits user.Quota once,
//     without a "reserve placeholder" row; we write a reserved row for dashboards and audit;
//   - one-api postConsumeQuota (relay/controller/helper.go:97): quotaDelta = quota - preConsumed,
//     PostConsumeTokenQuota(tokenId, quotaDelta). Our delta points the other way (because we do
//     "refund overcharge / top up shortfall": reserved balance − settled balance), but is semantically equivalent.

import {eq, sql} from 'drizzle-orm'; 

import { getDb } from '../db/client.js';
import { usageRecords, users, type UsageRecord } from '../db/schema.js';
import { getCurrentPrice, PriceNotFoundError } from './prices.js';
import { resolveMultipler } from '../multiplier/registry.js'; 
import { estimatePromptTokens } from './tokenizer.js';
import type { IRMessage } from '../types/ir.js';
import { es } from 'zod/v4/locales';

export interface PreConsumeInput {
    traceId: string; 
    userId: number; 
    orgId: number; 
    keyId: number; 
    model: string; 
    provider: string; 
    messages: IRMessage[];  
    maxOutputTokens: number; 
    isStream: boolean; 
}

export interface PreConsumeOutput {
    // usage_records.id , final postConsume will be price by this record 
    recordId: number; 

    // pre-reserved cost in micro CNY 
    preReservedCost: number; 

    // estimated prompt tokens, used for reservation  
    estimatedPromptTokens: number;  
}

export class InsufficientBalanceError extends Error {
    constructor(public required: number, public available: number) {
        super( `insufficient balance: need ${required} micro CNY, have ${available}`); 
        this.name = 'InsufficientBalanceError'; 
    }
}

/**
 * preConsume: placeholder row + reserve balance. 
 * 
 * Order is strict: debit balance first, then write the record, so the debit is 
 * the single source of truth. Even if the record insert fails, balance is already 
 * taken (postConsume can reconcile against balance later). 
*/
export function preConsume(input: PreConsumeInput): PreConsumeOutput {
    const db = getDb(); 

    // 1. local estimated prompt tokens  
    const estimatedPromptTokens = estimatePromptTokens(input.messages, input.model);  

    // 2. pick up the current price, and the multiplers 
    const price = getCurrentPrice(input.model, input.provider); 
    const mul = resolveMultipler({
        userId: input.userId, 
        model: input.model, 
        provider: input.provider, 
    }); 

      // 3. Reserved amount = (prompt × inputPrice + max_output × outputPrice) × multiplier
      //    ceil so rounding never under-charges by 1 micro-CNY
    const baseCost = 
        estimatedPromptTokens * price.inputPricePerToken + 
        input.maxOutputTokens * price.outputPricePerToken; 
        // final = (tokens × micro unit) × (user  ×   channel   × model)
        //         └─   prices   ─┘        └──── resolveMultiplier ────┘

    // all our pre-defined multipler params will turn into one ratio
    // and use that ratio multiply the base cost to get the reserved amount 
    const preReservedCost = Math.ceil(baseCost * mul.combinedFloat); 

    // 4. modify db record with pre-condition: UPDATE WHERE balance >= cost, 
    // and db record will be modify only when pre-condition satisified -- optimistic lock  
    const updated = db
        .update(users)
        .set({ balanceMicro: sql`${users.balanceMicro} - ${preReservedCost}`})
        // same user account, and enough balance guarantee as the pre-condiiton 
        .where(sql`${users.id} = ${input.userId} AND ${users.balanceMicro} >= ${preReservedCost}`)
        .returning({balance: users.balanceMicro})
        .all(); 

    // no rows in db satisfy the pre-condition, no row modified 
    if(updated.length === 0) {
        // query db twice to fetch user's remaining balance, use remaining balance to fill to error message 
        const cur = db
            .select({b: users.balanceMicro})
            .from(users)
            .where(eq(users.id, input.userId))
            .all(); 
        const have = cur.length > 0 ? cur[0]!.b : 0;  
        throw new InsufficientBalanceError(preReservedCost, have); 
    }

    // 5. insert a usage_records row (status = reserved) as a placeholder 
    const now = Date.now(); 

    // save pre-reserved status to db table
    // and return id for future search & update  
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
            multiplierSnapshot: mul.combinedScale1e9,  
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
    // positive => refund; 
    // negative => charge; 
    balanceDelta: number; 
}

/**
 * postConsume: settle after the upstream response
 * 1. Take real usage (prompt_tokens / completion_tokens); 
 * 2. Recompute final_cost with the same price + multipliers 
 *    (read multipler_snapshot from the reserved row so settlement price stays consistent); 
 * 3. delta = preReservedCost - finalCost 
 *        delta > 0: refund the over-charge (UPDATE balance += delta)
 *        delta < 0: charge the shortfall (UPDATE balance -= |delta|; may go negative - product policy)
 * 4. UPDATE the usage_records row to status=finalized, write token / cost / multiplier_snapshot. 
 * 
*/
export function postConsume(input: PostConsumeInput): PostConsumeOutput {
    const db = getDb(); 
    const price = getCurrentPrice(input.model, input.provider); 
    const mul = resolveMultipler({
        userId: input.userId, 
        model: input.model, 
        provider: input.provider, 
    }); 

    const promptCost = Math.ceil(input.realPromptTokens * price.inputPricePerToken * mul.combinedFloat); 
    const completionCost = Math.ceil(
        input.realCompletionTokens * price.outputPricePerToken * mul.combinedFloat
    ); 
    const finalCost = promptCost + completionCost; 

    // then we query the previous reserved row to get the pre-reserved cost 
    // and calculate the delta value
    const rec = db 
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.id, input.recordId))
        .all(); 
    
    if (rec.length === 0) {
        throw new Error(`usage_record ${input.recordId} not found`); 
    }

    const row = rec[0];
    // state machine check, if status not match directly return  
    if (row.status !== 'reserved') {
        // duplicte invocation of postConsume, return !
        return {
            recordId: row.id, 
            promptCost: row.promptCost, 
            completionCost: row.completionCost, 
            finalCost: row.finalCost, 
            balanceDelta: 0, 
        }; 
    }

    // balanceDelta = preReserved - finalCost 
    //  > 0: refund, user account's balance += balanceDelta 
    // < 0: chart, user account's balance -= balanceDelta
    const balanceDelta = row.preReservedCost - finalCost;  
    if (balanceDelta !== 0)  {
        db.update(users)
            .set({ balanceMicro: sql`${users.balanceMicro} + ${balanceDelta}` })
            .where(eq(users.id, input.userId))
            .run();
    }

    // do not forget update db record by previous pre-reserved record id 
    // update db record status from 'reserved' into 'finalize'
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

    return { recordId: input.recordId, promptCost, completionCost, finalCost, balanceDelta }; 
}

/**
 * postConsumeStream: streaming-only settlement. Same flow as postConsume; the only 
 * difference is the terminal `status`: 
 * - finalized: stream completed (upstream [DONE] / message_stop) - same as non-stream 
 * 
 * - canceled: client Ctrl + C / close the connection mid-flight; tokens already sent are **still billed**, status = canceled. 
 * 
 * - partial: upstream erred mid-stream or gateway aborted; tokens already received are billed, status = partial 
 * 
 * 
 * Why a separate function: non-stream semantics have no canceled / partial end states - 
 * a non-stream request is reserved, finalized, refunded, or failed. 
 * 
 * Streaming adds "stopped halfway but already consumed some tokens"; dashboards and reconcilation need to tell those apart. 
 * 
 * vs one-api: 
 * - one-api's StreamHandler stuffs accumulated usage back into ctx and reuses PostConsumeTokenQuota with no status split. 
 *   Mid-stream abort usage is just "what was received so far", implicitly finalized. 
 * - This book splits status explicitly so Ch9 dashboards can aggregate by state (canceled rate ~ client-side quality signal). 
*/
export function postConsumeStream(
    input: PostConsumeInput & { terminalStatus: 'finalized' | 'canceled' | 'partial' }, 
): PostConsumeOutput {
    const db = getDb(); 
    const price = getCurrentPrice(input.model, input.provider); 
    const mul = resolveMultipler({
        userId: input.userId, 
        model: input.model, 
        provider: input.provider, 
    }); 

    const promptCost = Math.ceil(input.realPromptTokens * price.inputPricePerToken * mul.combinedFloat); 
    const completionCost = Math.ceil(
        input.realCompletionTokens * price.outputPricePerToken * mul.combinedFloat 
    ); 

    const finalCost = promptCost + completionCost; 

    const rec = db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.id, input.recordId))
        .all(); 

    // no records found 
    if (rec.length === 0) {
        throw new Error(`usage_record ${input.recordId} not found`); 
    }

    // status not satisfied as expected , return empty resp 
    const row = rec[0]!; 
    if (row.status !== 'reserved') {
        return {
            recordId: row.id, 
            promptCost: row.promptCost, 
            completionCost: row.completionCost, 
            finalCost: row.finalCost, 
            balanceDelta: 0, 
        }; 
    }

    const balanceDelta = row.preReservedCost - finalCost; 
    if (balanceDelta !== 0) {
        db.update(users)
            .set({ balanceMicro: sql`${users.balanceMicro} + ${balanceDelta}` })
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
        status: input.terminalStatus,
        finalizedAt: now,
      })
      .where(eq(usageRecords.id, input.recordId))
      .run();
  
    return { recordId: input.recordId, promptCost, completionCost, finalCost, balanceDelta };
}

/**
 * when refund: upstream(AI side) error, timeout | network failure 
 * 
 * refundReservation should be conflict with postConsume.  when issue happen, then flow need to go refundReservation, after refunding 
 * final status value should be set to 'refunded' --> this is a terminated state 
 * 
 * delta = estimated_cost - real_cost > 0 this case not handled by this refundReservation func 
*/
export function refundReservation(recordId: number, errorMessage?: string): void {
    const db = getDb(); 
    const rec = db.select().from(usageRecords).where(eq(usageRecords.id, recordId)).all();  

    // no previous reservation record found in db 
    if (rec.length === 0) {
        return; 
    }

    const row = rec[0]!;  

    // idempotency guarantee, status not match means duplicated operations, return  
    if (row.status !== 'reserved') return; 

    // refund the full pre-reserved cost to user 
    db.update(users)
        .set({ balanceMicro: sql`${users.balanceMicro} + ${row.preReservedCost}` })
        .where(eq(users.id, row.userId))
        .run(); 
    
    // update db record status from 'reserved' into 'refunded' , idempotency guarantee 
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

// set record to failed, if anything goes wrong during postConsume period 
// deduced balance need manual reconcile 
export function markFailed(recordId: number, errorMessage?: string): void {
    const db = getDb();  
    db.update(usageRecords)
        .set({status: 'failed', errorMessage, finalizedAt: Date.now()})
        .where(eq(usageRecords.id, recordId))
        .run(); 
}

export { PriceNotFoundError }; 
export type { UsageRecord } ;