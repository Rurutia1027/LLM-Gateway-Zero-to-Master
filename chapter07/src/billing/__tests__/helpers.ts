import { mkdtempSync, rmSync } from 'node:fs'; 
import { tmpdir } from 'node:os'; 
import { join } from 'node:path';  

import { closeDb, getDb } from '../../db/client.js'; 
import { runMigrations } from '../../db/migrate.js';
import { keys, orgs, prices, users} from '../../db/schema.js';
import { invalidatePriceCache } from '../prices.js';  

export type BillingFixture = {
    orgId: number; 
    userId: number; 
    keyId: number; 
    priceId: number; 
}; 

// Fresh temp SQLite DB per suite; call from before() 
export function createTempDbDir(prefix = 'ch07-billing-'): string {
    return mkdtempSync(join(tmpdir(), prefix)); 
}


export function destroyTempDbDir(dir: string): void {
    closeDb(); 
    rmSync(dir, { recursive: true, force: true }); 
}


/** New DB file + migrations + cleared price cache. Call from beforeEach(). */
export function resetTestDb(dir: string): void {
    closeDb();
    invalidatePriceCache();
    process.env.DATABASE_URL = join(
      dir,
      `t-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    runMigrations();
}

// inject seed data into db  
export function seedUserKeyPrice(overrides: {
    balanceMicro?: number;
    userMultiplier?: number;
    modelMultiplier?: number;
    monthlyQuotaMicro?: number;
    monthlyUsedMicro?: number;
    quotaResetAt?: number;
    inputPriceMicroPer1M?: number;
    outputPriceMicroPer1M?: number;
    model?: string;
    provider?: string;
  } = {}): BillingFixture {
    const db = getDb();
    const now = Date.now();
    const model = overrides.model ?? 'gpt-4o-mini';
    const provider = overrides.provider ?? 'openai';
  
    const [org] = db.insert(orgs).values({ name: `org-${now}`, createdAt: now }).returning().all();
    const [user] = db
      .insert(users)
      .values({
        orgId: org!.id,
        name: 'alice',
        email: `alice-${now}@example.com`,
        createdAt: now,
        balanceMicro: overrides.balanceMicro ?? 10_000_000,
        userMultiplier: overrides.userMultiplier ?? 1000,
      })
      .returning()
      .all();
  
    const [key] = db
      .insert(keys)
      .values({
        userId: user!.id,
        keyHash: `hash-${now}-${Math.random().toString(16).slice(2)}`,
        keyPreview: 'sk-gw-...test',
        name: 'default',
        createdAt: now,
        monthlyQuotaMicro: overrides.monthlyQuotaMicro ?? 0,
        monthlyUsedMicro: overrides.monthlyUsedMicro ?? 0,
        quotaResetAt: overrides.quotaResetAt ?? 0,
      })
      .returning()
      .all();
  
    const [price] = db
      .insert(prices)
      .values({
        model,
        provider,
        // 1 CNY / 1M tokens → 1 micro-CNY per token after /1e6
        inputPriceMicroPer1M: overrides.inputPriceMicroPer1M ?? 1_000_000,
        outputPriceMicroPer1M: overrides.outputPriceMicroPer1M ?? 4_000_000,
        modelMultiplier: overrides.modelMultiplier ?? 1000,
        effectiveFrom: now - 1_000,
        effectiveTo: null,
        createdAt: now,
      })
      .returning()
      .all();
  
    invalidatePriceCache();
  
    return {
      orgId: org!.id,
      userId: user!.id,
      keyId: key!.id,
      priceId: price!.id,
    };
  }
  
