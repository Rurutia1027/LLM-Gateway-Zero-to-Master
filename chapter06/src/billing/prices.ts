// Price Table Registration / Hot Reload / Query 
// 
// Design Intent: 
// - Store the price table in the database (price table), allowing operators
//   to update prices at runtime through the admin API without restarting the service. 
// - Load the bulit-in default prices at startup to prevent requests from failing 
//   when the database table is empty. 
// - Maintain a lightweight in-process cache of the current active prices 
//   within a TTL of 60 seconds, reducing the need to query the database on every request. 
// - Throw an error when no price is found instead of falling back to a default value. 
//   Otherwise, this could introduce a "free usage" vulnerability. 
// 
// Unit Convention: 
// - inputPriceMicroPer1M = CNY * 1,000,000 prefresenting the price per 1M tokens. 
//   For example, the input price for gpt-4o-mini is approximately 1.05 per 1M tokens -> 1,050,000.  
// - During calculation, divide by 1,000, 000 (1M) to convert the price
//  to "micro-CNY-per token", then multiply by the actual token count. 
// 
// Default Price Source: 
// - Official publicly available API pricing pages (prices published in May 2026); 
// - Prices are approximately converted using an exchange rate of 
//   1 USD = 7.2 CNY. Precise exchange-rate calculations are out of scope of this chapter. 
// - In a real production environment, prices should be adjusted based on 
//   the current exchange rate and any upstream distributor discounts. 
//   These changes can be applied dynamically through the admin API. 

import {eq, and, isNull, or, gt, lte, desc} from 'drizzle-orm'; 
import {getDb} from '../db/client.js'; 
import {prices} from '../db/schema.js'; 
 
export interface ResolvedPrice {
  /** input unit price: micro-yuan / token */
  inputPricePerToken: number;
  /** output unit price: micro-yuan / token */
  outputPricePerToken: number;
  /** model multiplier (per-mille integer) */
  modelMultiplier: number;
  /** price row id — persisted on usage_records for audit */
  priceId: number;
}

// process inner cache. key = `${model}::${provider}`, value = {price, expiresAt}
interface CacheEntry {
  price: ResolvedPrice; 
  expiresAt: number; 
}

const CACHE = new Map<string, CacheEntry>(); 
const CACHE_TTL_MS = 60_000; 

/**
 * 
 */
export function getCurrentPrice(model: string, provider: string): ResolvedPrice {
  const cacheKey = `${model}::${provider}`; 
  const now = Date.now(); 

  const cached = CACHE.get(cacheKey); 
  if (cached && cached.expiresAt > now) {
    return cached.price; 
  }

  const db = getDb(); 
  const rows = db 
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.model, model), 
        eq(prices.provider, provider), 
        lte(prices.effectiveFrom, now), 
        or(isNull(prices.effectiveTo), gt(prices.effectiveTo, now))
      ), 
    )
    .orderBy(desc(prices.effectiveFrom))
    .limit(1)
    .all(); 

  if (rows.length === 0) {
    throw new PriceNotFoundError(model, provider); 
  }

  const row = rows[0]; 
  const price: ResolvedPrice = {
    inputPricePerToken: row.inputPriceMicroPer1M / 1_000_000, 
    outputPricePerToken: row.outputPriceMicroPer1M / 1_000_000, 
    modelMultiplier: row.modelMultiplier, 
    priceId: row.id, 
  }; 
  CACHE.set(cacheKey, {price, expiresAt: now + CACHE_TTL_MS}); 
  return price; 
}

export class PriceNotFoundError extends Error {
  constructor(
    public model: string,
    public provider: string,
  ) {
    super(`no active price for model=${model} provider=${provider}`);
    this.name = 'PriceNotFoundError';
  }
}

// Seed the default price at startup to prevent the price table from being empty.
interface DefaultPriceSeed {
  model: string;
  provider: string;
  // CNY / 1 M tokens. convert into micro CNY in funcs calculation
  inputCnyPer1M: number;
  outputCnyPer1M: number;
  modelMultiplier?: number;
}

const DEFAULT_PRICES: DefaultPriceSeed[] = [
  // --- OPENAI ---
  { model: 'gpt-4o-mini', provider: 'openai', inputCnyPer1M: 1.05, outputCnyPer1M: 4.32 },
  { model: 'gpt-4o', provider: 'openai', inputCnyPer1M: 17.5, outputCnyPer1M: 70 },
  { model: 'gpt-4-turbo', provider: 'openai', inputCnyPer1M: 70, outputCnyPer1M: 215 },
  { model: 'o1-mini', provider: 'openai', inputCnyPer1M: 21, outputCnyPer1M: 84 },
  { model: 'o3-mini', provider: 'openai', inputCnyPer1M: 7.92, outputCnyPer1M: 31.68 },
  //-- DeepSeek (CNY)
  { model: 'deepseek-chat', provider: 'deepseek', inputCnyPer1M: 2, outputCnyPer1M: 8 },
  { model: 'deepseek-reasoner', provider: 'deepseek', inputCnyPer1M: 4, outputCnyPer1M: 16 },
  // -- Anthropic ---
  { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic', inputCnyPer1M: 21.6, outputCnyPer1M: 108 },
  { model: 'claude-3-5-haiku-20241022', provider: 'anthropic', inputCnyPer1M: 7.2, outputCnyPer1M: 28.8 },
  { model: 'claude-3-opus-20240229', provider: 'anthropic', inputCnyPer1M: 108, outputCnyPer1M: 540 },
];

/** Clear cache. Admin should call this after price changes. */
export function invalidatePriceCache(): void {
  CACHE.clear();
}

/**
 * Seed default prices when the table is empty.
 * Called once at process startup from index.ts.
 */
export function seedDefaultPricesIfEmpty(): { inserted: number, skipped: number} {
  const db = getDb(); 
  const existing = db.select({ id: prices.id }).from(prices).limit(1).all(); 
  if (existing.length > 0) {
    return {inserted: 0, skipped: DEFAULT_PRICES.length}
  }
  const now = Date.now(); 
  let inserted = 0; 
  for (const seed of DEFAULT_PRICES) {
    db.insert(prices)
    .values({
      model: seed.model, 
      provider: seed.provider, 
      inputPriceMicroPer1M: Math.round(seed.inputCnyPer1M * 1_000_000), 
      outputPriceMicroPer1M: Math.round(seed.outputCnyPer1M * 1_000_000), 
      modelMultiplier: seed.modelMultiplier?? 1000, 
      effectiveFrom: now, 
      effectiveTo: null, 
      createdAt: now, 
    })
    .run(); 
    inserted += 1; 
  }
  return {inserted, skipped: 0}
}
