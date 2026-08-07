// Design goals:
//   - Prices live in the DB (prices table) so ops can hot-update via admin APIs;
//   - On startup, seed built-in defaults (an empty table would make every request fail);
//   - Process-local cache of the currently effective price (TTL 60s) to cut per-request DB hits;
//   - Missing price throws instead of falling back — otherwise you get a "free ride" hole.
//
// Units:
//   - inputPriceMicroPer1M = CNY × 1_000_000, price per 1M tokens.
//     e.g. gpt-4o-mini input ≈ 1.05 CNY / 1M tokens → 1_050_000.
//   - At compute time, divide by 1_000_000 (1M) to get micro-CNY per token, then multiply by token count.
//
// Default price sources:
//   - Official public API price pages (as published May 2026);
//   - Rough FX conversion at 1 USD ≈ 7.2 CNY (this chapter does not do precise FX);
//   - Real ops should adjust for day's FX + upstream distributor discounts via admin hot-update.

import {eq, and, isNull, or, gt, lte, desc } from 'drizzle-orm'; 
import { getDb } from '../db/client.js'; 
import { prices } from '../db/schema.js';


export interface ResolvedPrice {
    // input micro CNY per token  
    inputPricePerToken: number; 

    // output micro CNY per token 
    outputPricePerToken: number; 

    // model self multiplier 
    modelMultipler: number; 

    // which price record in `usage_records`  this is based on 
    priceId: number; 
}

// process inner cache 
// key = `${model}::${provider}` ; value = {price, expiresAt}
interface CacheEntry {
    price: ResolvedPrice; 
    expiresAt: number; 
}

// memory inner cache 
const CACHE = new Map<string, CacheEntry>(); 
const CACHE_TTL_MS = 60_000; // 60s 

/**
 * Search the effective price for (model, provider) at the current timestamp(we wanna fetch the freshest price, not the oldest price). 
 * 
 * Row selection: 
 * - effective_from <= now and (effective_to is null or effective > now); 
 * - if multiple rows match, take the one with the largest effective_from (most recently effective).
 * - if none found, throw PriceNotFoundError - callers should return 400 to the client. 
*/
export function getCurrentPrice(model: string, provider: string): ResolvedPrice {
    const cacheKey = `${model}::${provider}`; 
    const now = Date.now(); 

    const cached = CACHE.get(cacheKey); 

    if (cached && cached.expiresAt > now) {
        return cached.price; 
    }

    // cannot find cache entry from mem, then query db 
    const db = getDb(); 
    const rows = db.select()
    .from(prices)
    .where(
        and(
            // condition 1,2:  modle name and provider name should be matched 
            eq(prices.model, model),
            eq(prices.provider, provider),
            // condition 3: effective from should be less than or equal to now 
            lte(prices.effectiveFrom, now),
            // condition 4: effective to should be > now, or null (means still effective)  
            or(isNull(prices.effectiveTo), gt(prices.effectiveTo, now)),
        ), 
    )
    .orderBy(desc(prices.effectiveFrom))
    .limit(1)
    .all();  

    // cannot find valid record from db, throw exception 
    if (rows.length === 0) {
        throw new PriceNotFoundError(model, provider); 
    }

    // here fetch 1 valid record from db, 
    const row = rows[0];
    const price: ResolvedPrice = {
        inputPricePerToken: row.inputPriceMicroPer1M / 1_000_000, 
        outputPricePerToken: row.outputPriceMicroPer1M / 1_000_000,  
        modelMultipler: row.modelMultiplier, 
        priceId: row.id, 
    }; 

    // do not forget set db queried record to cache 
    CACHE.set(cacheKey, {price, expiresAt: now + CACHE_TTL_MS});  
    return price; 
}

// clean cache, this should be invoked after modifying the prices db table via admin interface 
export function invalidatePriceCache(): void {
    CACHE.clear(); 
}

export class PriceNotFoundError extends Error {
    constructor(public model: string, public provider: string) {
      super(`no active price for model=${model} provider=${provider}`);
      this.name = 'PriceNotFoundError';
    }
}

// ----------------------------------------------------------------
// inject seed data into prices table on startup
// ----------------------------------------------------------------

interface DefaultPriceSeed {
    model: string; 
    provider: string; 
    inputCnyPer1M: number; 
    outputCnyPer1M: number; 
    modelMultiplier?: number;  
}

const DEFAULT_PRICES: DefaultPriceSeed[] = [
    // ----- OpenAI -----
    { model: 'gpt-4o-mini', provider: 'openai', inputCnyPer1M: 1.05, outputCnyPer1M: 4.32 },
    { model: 'gpt-4o', provider: 'openai', inputCnyPer1M: 17.5, outputCnyPer1M: 70 },
    { model: 'gpt-4-turbo', provider: 'openai', inputCnyPer1M: 70, outputCnyPer1M: 215 },
    { model: 'o1-mini', provider: 'openai', inputCnyPer1M: 21, outputCnyPer1M: 84 },
    { model: 'o3-mini', provider: 'openai', inputCnyPer1M: 7.92, outputCnyPer1M: 31.68 },
    // ----- DeepSeek (domestic CNY list price) -----
    { model: 'deepseek-chat', provider: 'deepseek', inputCnyPer1M: 2, outputCnyPer1M: 8 },
    { model: 'deepseek-reasoner', provider: 'deepseek', inputCnyPer1M: 4, outputCnyPer1M: 16 },
    // ----- Anthropic -----
    { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic', inputCnyPer1M: 21.6, outputCnyPer1M: 108 },
    { model: 'claude-3-5-haiku-20241022', provider: 'anthropic', inputCnyPer1M: 7.2, outputCnyPer1M: 28.8 },
    { model: 'claude-3-opus-20240229', provider: 'anthropic', inputCnyPer1M: 108, outputCnyPer1M: 540 },
    // ----- mock upstream (for v0.7 streaming demo) -----
    { model: 'mock-gpt-4o-mini', provider: 'mock', inputCnyPer1M: 1, outputCnyPer1M: 4 },
  ];

export function seedDefaultPricesIfEmpty(): {inserted: number, skipped: number} {
    const db = getDb(); 
    const existing = db.select({id: prices.id}).from(prices).limit(1).all(); 
    if (existing.length > 0) {
        return {inserted: 0, skipped: DEFAULT_PRICES.length}; 
    }

    const now = Date.now(); 
    let inserted = 0; 

    // here we begin iterate each col in DEFAULT_PRICES, and insert them into db
    // insert successfully, then increment the inserted count  
    for (const seed of DEFAULT_PRICES) {
        db.insert(prices)
        .values({
            model: seed.model,
            provider: seed.provider,
            inputPriceMicroPer1M: Math.round(seed.inputCnyPer1M * 1_000_000),
            outputPriceMicroPer1M: Math.round(seed.outputCnyPer1M * 1_000_000),
            modelMultiplier: seed.modelMultiplier ?? 1000,
            effectiveFrom: now,
            effectiveTo: null,
            createdAt: now,
        }).run(); 
        inserted += 1; 
    }

    return {inserted, skipped: DEFAULT_PRICES.length - inserted}; 
}