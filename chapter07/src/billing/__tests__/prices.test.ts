import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { prices } from '../../db/schema.js';

import {
  createTempDbDir,
  destroyTempDbDir,
  resetTestDb,
  seedUserKeyPrice,
} from './helpers.js';
import {
  PriceNotFoundError,
  getCurrentPrice,
  invalidatePriceCache,
  seedDefaultPricesIfEmpty,
} from '../prices.js';

describe('prices', () => {
  let dir: string;

  before(() => {
    dir = createTempDbDir('ch07-prices-');
  });

  after(() => {
    destroyTempDbDir(dir);
  });

  beforeEach(() => {
    resetTestDb(dir);
  });

  it('getCurrentPrice converts micro-per-1M into per-token prices', () => {
    seedUserKeyPrice({
      inputPriceMicroPer1M: 1_050_000,
      outputPriceMicroPer1M: 4_200_000,
      modelMultiplier: 1000,
    });

    const price = getCurrentPrice('gpt-4o-mini', 'openai');
    assert.equal(price.inputPricePerToken, 1.05);
    assert.equal(price.outputPricePerToken, 4.2);
    assert.equal(price.modelMultiplier, 1000);
    assert.ok(price.priceId > 0);
  });

  it('throws PriceNotFoundError when no row matches', () => {
    assert.throws(
      () => getCurrentPrice('no-such-model', 'openai'),
      (err: unknown) => err instanceof PriceNotFoundError,
    );
  });

  it('prefers the newest effective_from among overlapping rows', () => {
    const db = getDb();
    const now = Date.now();
    db.insert(prices)
      .values({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputPriceMicroPer1M: 1_000_000,
        outputPriceMicroPer1M: 1_000_000,
        modelMultiplier: 1000,
        effectiveFrom: now - 10_000,
        effectiveTo: null,
        createdAt: now,
      })
      .run();
    db.insert(prices)
      .values({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputPriceMicroPer1M: 2_000_000,
        outputPriceMicroPer1M: 2_000_000,
        modelMultiplier: 1000,
        effectiveFrom: now - 1_000,
        effectiveTo: null,
        createdAt: now,
      })
      .run();
    invalidatePriceCache();

    const price = getCurrentPrice('gpt-4o-mini', 'openai');
    assert.equal(price.inputPricePerToken, 2);
  });

  it('ignores rows whose effective_to has already passed', () => {
    const db = getDb();
    const now = Date.now();
    db.insert(prices)
      .values({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputPriceMicroPer1M: 9_000_000,
        outputPriceMicroPer1M: 9_000_000,
        modelMultiplier: 1000,
        effectiveFrom: now - 10_000,
        effectiveTo: now - 1,
        createdAt: now,
      })
      .run();
    invalidatePriceCache();

    assert.throws(() => getCurrentPrice('gpt-4o-mini', 'openai'), PriceNotFoundError);
  });

  it('serves cached price until invalidatePriceCache', () => {
    const fx = seedUserKeyPrice({ inputPriceMicroPer1M: 1_000_000 });
    assert.equal(getCurrentPrice('gpt-4o-mini', 'openai').inputPricePerToken, 1);

    getDb()
      .update(prices)
      .set({ inputPriceMicroPer1M: 5_000_000 })
      .where(eq(prices.id, fx.priceId))
      .run();

    // Stale cache still returns the old value.
    assert.equal(getCurrentPrice('gpt-4o-mini', 'openai').inputPricePerToken, 1);

    invalidatePriceCache();
    assert.equal(getCurrentPrice('gpt-4o-mini', 'openai').inputPricePerToken, 5);
  });

  it('seedDefaultPricesIfEmpty inserts defaults once', () => {
    const first = seedDefaultPricesIfEmpty();
    assert.ok(first.inserted > 0);
    assert.equal(first.skipped, 0);

    const second = seedDefaultPricesIfEmpty();
    assert.equal(second.inserted, 0);
    assert.ok(second.skipped > 0);

    const price = getCurrentPrice('gpt-4o-mini', 'openai');
    assert.ok(price.inputPricePerToken > 0);
  });
});
