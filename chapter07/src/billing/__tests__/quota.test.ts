import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { keys } from '../../db/schema.js';

import {
  createTempDbDir,
  destroyTempDbDir,
  resetTestDb,
  seedUserKeyPrice,
} from './helpers.js';
import {
  checkMonthlyQuota,
  commitMonthlyUsage,
  startOfCurrentMonth,
} from '../quota.js';

describe('startOfCurrentMonth', () => {
  it('returns UTC midnight on the 1st of the month', () => {
    // 2026-08-15 12:00 UTC
    const now = Date.UTC(2026, 7, 15, 12, 0, 0);
    assert.equal(startOfCurrentMonth(now), Date.UTC(2026, 7, 1));
  });

  it('stays on the 1st when already at month start', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    assert.equal(startOfCurrentMonth(now), now);
  });
});

describe('checkMonthlyQuota / commitMonthlyUsage', () => {
  let dir: string;

  before(() => {
    dir = createTempDbDir('ch07-quota-');
  });

  after(() => {
    destroyTempDbDir(dir);
  });

  beforeEach(() => {
    resetTestDb(dir);
  });

  it('treats limit=0 as unlimited', () => {
    const fx = seedUserKeyPrice({ monthlyQuotaMicro: 0, monthlyUsedMicro: 0 });
    const result = checkMonthlyQuota(fx.keyId, 1_000_000);
    assert.equal(result.ok, true);
    assert.equal(result.limit, 0);
  });

  it('rejects when used + reserving exceeds limit', () => {
    const fx = seedUserKeyPrice({
      monthlyQuotaMicro: 1_000,
      monthlyUsedMicro: 800,
      quotaResetAt: Date.now(),
    });
    const result = checkMonthlyQuota(fx.keyId, 300);
    assert.equal(result.ok, false);
    assert.equal(result.limit, 1_000);
    assert.equal(result.used, 800);
    assert.equal(result.reserving, 300);
  });

  it('allows when used + reserving is within limit', () => {
    const fx = seedUserKeyPrice({
      monthlyQuotaMicro: 1_000,
      monthlyUsedMicro: 700,
      quotaResetAt: Date.now(),
    });
    const result = checkMonthlyQuota(fx.keyId, 300);
    assert.equal(result.ok, true);
    assert.equal(result.used, 700);
  });

  it('returns ok=false for unknown keyId', () => {
    const result = checkMonthlyQuota(999_999, 100);
    assert.equal(result.ok, false);
    assert.equal(result.limit, 0);
    assert.equal(result.used, 0);
  });

  it('resets monthly_used when quota_reset_at is before this month', () => {
    const lastMonth = Date.UTC(2020, 0, 1);
    const fx = seedUserKeyPrice({
      monthlyQuotaMicro: 1_000,
      monthlyUsedMicro: 999,
      quotaResetAt: lastMonth,
    });

    const result = checkMonthlyQuota(fx.keyId, 100);
    assert.equal(result.ok, true);
    assert.equal(result.used, 0);

    const row = getDb().select().from(keys).where(eq(keys.id, fx.keyId)).get();
    assert.equal(row?.monthlyUsedMicro, 0);
    assert.ok((row?.quotaResetAt ?? 0) >= startOfCurrentMonth(Date.now()));
  });

  it('commitMonthlyUsage increments used; ignores non-positive amounts', () => {
    const fx = seedUserKeyPrice({
      monthlyQuotaMicro: 10_000,
      monthlyUsedMicro: 100,
      quotaResetAt: Date.now(),
    });

    commitMonthlyUsage(fx.keyId, 0);
    commitMonthlyUsage(fx.keyId, -5);
    let row = getDb().select().from(keys).where(eq(keys.id, fx.keyId)).get();
    assert.equal(row?.monthlyUsedMicro, 100);

    commitMonthlyUsage(fx.keyId, 250);
    row = getDb().select().from(keys).where(eq(keys.id, fx.keyId)).get();
    assert.equal(row?.monthlyUsedMicro, 350);
  });
});
