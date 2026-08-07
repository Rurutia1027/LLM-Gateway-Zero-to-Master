import { eq, sql } from 'drizzle-orm'; 
import { getDb } from '../db/client.js';
import { keys } from '../db/schema.js';

export interface QuotaCheckResult {
    ok: boolean; 

    // quota limit in micro unit  
    limit: number; 

    // estimated used cost in micro unit 
    used: number; 

    // preReservedCost 
    reserving: number; 
}

/**
 * Check a key's monthly quota. Call after preConsume succeeds. 
 * 
 * Design: 
 * - limit = 0 means unlimited -> immediately ok; 
 * - usage (used) is incremented in postConsume, and reset to zero across months; 
 * - this function only reads + decides; it does not write usage 
 *   (used += finalCost is left to postConsume). 
 * 
 * Month rollover: compare quota_reset_at with the start of the current calendar month. 
 * If behind, zero usage and update reset_at. 
 * Done in a single SQL statement (CASE WHEN) to avoid read-modify-write races. 
*/
export function checkMonthlyQuota(keyId: number, reservingMicro: number): QuotaCheckResult {
    const db = getDb(); 
    const now = Date.now(); 
    const monthStart = startOfCurrentMonth(now); 

    // cross month all should be reset to 0
    // let sqlite checkout this via inner CASE WHEN 
    // IF quota_reset_at < monthStart THEN monthly_used = 0, quota_reset_at = now 
    db.update(keys)
        .set({
            monthlyUsedMicro: sql`CASE WHEN ${keys.quotaResetAt} < ${monthStart} THEN 0 ELSE ${keys.monthlyQuotaMicro} END`, 
            quotaResetAt: sql`CASE WHEN ${keys.quotaResetAt} < ${monthStart} THEN ${now} ELSE ${keys.quotaResetAt} END`, 
        })
        .where(eq(keys.id, keyId))
        .run(); 

    const rows = db 
        .select({
            monthlyQuotaMicro: keys.monthlyQuotaMicro, 
            monthlyUsedMicro: keys.monthlyUsedMicro,  
        })
        .from(keys)
        .where(eq(keys.id, keyId))
        .all(); 

    // no db records found, return blank response 
    if (rows.length === 0) {
        return {ok: false, limit: 0, used: 0, reserving: reservingMicro};
    }

    const { monthlyQuotaMicro: limit, monthlyUsedMicro: used } = rows[0];  

    // no limit, immediately ok  
    if (limit <= 0) {
        return {ok: true, limit: 0, used, reserving: reservingMicro}
    }

    // checkout out whether reserved + already used still within limit  
    const ok = used + reservingMicro <= limit; 

    return {ok, limit, used, reserving: reservingMicro}; 
}

/**
 *  After a successful postConsume, add finalCost to monthly_used. 
 * Call only when finalCost > 0. 
 * Done with a single SQL UPDATE - same pattern as Ch5's optimistic lock balance debit. 
*/
export function commitMonthlyUsage(keyId: number, finalCostMicro: number) {
    if(finalCostMicro <= 0) return; 
    const db = getDb(); 
    db.update(keys)
        .set({monthlyUsedMicro: sql`${keys.monthlyUsedMicro} + ${finalCostMicro}` })
        .where(eq(keys.id, keyId))
        .run(); 
}

/**
 * Unix ms for 00:00 UTC on the 1st of the current UTC month. 
 * 
 * Boundary used for month-rollover resets. Uses the UTC month to avoid local 
 * timezone drift (in production, pin to UTC or a fixed server timezone). 
*/
export function startOfCurrentMonth(now: number): number {
    const d = new Date(now); 
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); 
}
