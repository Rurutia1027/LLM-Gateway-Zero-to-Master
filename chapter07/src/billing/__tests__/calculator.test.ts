import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { keys, orgs, prices, usageRecords, users } from '../../db/schema.js';

import {
  createTempDbDir,
  destroyTempDbDir,
  resetTestDb,
  seedUserKeyPrice,
} from './helpers.js';
import {
  InsufficientBalanceError,
  markFailed,
  postConsume,
  postConsumeStream,
  preConsume,
  refundReservation,
} from '../calculator.js';

const messages = [{ role: 'user' as const, content: 'hello' }];

function balanceOf(userId: number): number {
    return getDb().select({ b: users.balanceMicro }).from(users).where(eq(users.id, userId)).get()!.b;
}


describe('calculator two-phase billing', () => {
    let dir: string;

    before(() => {
        dir = createTempDbDir('ch07-calc-');
      });
    
    after(() => {
        destroyTempDbDir(dir);
    });
    
    beforeEach(() => {
        resetTestDb(dir);
    });

    it('preConsume reserves balance and writes a reserved usage row', () => {
        const fx = seedUserKeyPrice({
            balanceMicro: 10_000_000,
            // 1 micro / token input, 4 micro / token output
            inputPriceMicroPer1M: 1_000_000,
            outputPriceMicroPer1M: 4_000_000,
            userMultiplier: 1000,
        });

        const before = balanceOf(fx.userId);
        const out = preConsume({
            traceId: 'a'.repeat(32),
            userId: fx.userId,
            orgId: fx.orgId,
            keyId: fx.keyId,
            model: 'gpt-4o-mini',
            provider: 'openai',
            messages,
            maxOutputTokens: 50,
            isStream: false,
        });

        assert.ok(out.recordId > 0);
        assert.ok(out.preReservedCost > 0);
        assert.ok(out.estimatedPromptTokens > 0);
        assert.equal(balanceOf(fx.userId), before - out.preReservedCost);
    
        const row = getDb().select().from(usageRecords).where(eq(usageRecords.id, out.recordId)).get();
        assert.equal(row?.status, 'reserved');
        assert.equal(row?.preReservedCost, out.preReservedCost);
        assert.equal(row?.multiplierSnapshot, 1_000_000_000);
    }); 

    it('preConsume throws InsufficientBalanceError when balance is too low', () => {
        const fx = seedUserKeyPrice({ balanceMicro: 1 });
        assert.throws(
          () =>
            preConsume({
              traceId: 'b'.repeat(32),
              userId: fx.userId,
              orgId: fx.orgId,
              keyId: fx.keyId,
              model: 'gpt-4o-mini',
              provider: 'openai',
              messages,
              maxOutputTokens: 50,
              isStream: false,
            }),
          (err: unknown) => err instanceof InsufficientBalanceError,
        );
        assert.equal(balanceOf(fx.userId), 1);
    });

    it('postConsume refunds the over-reserved delta and finalizes', () => {
        // inject data to db, and fetch ret value variable 
        const fx = seedUserKeyPrice({
            balanceMicro: 10_000_000,
            inputPriceMicroPer1M: 1_000_000,
            outputPriceMicroPer1M: 4_000_000,
        });

        const reserved = preConsume({
            traceId: 'c'.repeat(32),
            userId: fx.userId, // insert org, key, user db records' id to invoke pre-consume 
            orgId: fx.orgId,
            keyId: fx.keyId,
            model: 'gpt-4o-mini',
            provider: 'openai',
            messages,
            maxOutputTokens: 50,
            isStream: false,
        }); 

        // after reserve operation(preConsume) fetch user's balance by userId
        const afterReserve = balanceOf(fx.userId); 

        // then invoke postConsume to settle the usage record 
        const settle = postConsume({
            recordId: reserved.recordId, 
            userId: fx.userId, 
            model: 'gpt-4o-mini',
            provider: 'openai', 
            realPromptTokens: reserved.estimatedPromptTokens, 
            realCompletionTokens: 10, 
        }); 


        // assert the final cost is greater than 0
        // estimate cost > real cost, refund is triggered
        assert.ok(settle.finalCost > 0); 
        // estimate more, but real cost is less, so refund is triggered 
        assert.ok(settle.finalCost < reserved.preReservedCost); 
        assert.equal(settle.balanceDelta, reserved.preReservedCost - settle.finalCost); 
        assert.equal(balanceOf(fx.userId), afterReserve + settle.balanceDelta); 

        // useageRecord record status should be finalized --> the terminal status in state machine 
        const row = getDb().select().from(usageRecords).where(eq(usageRecords.id, reserved.recordId)).get();
        assert.equal(row?.status, 'finalized');
        assert.equal(row?.finalCost, settle.finalCost);
    }); 

    it('postConsume is idempotent when status is no longer reserved', () => {
        const fx = seedUserKeyPrice();
        const reserved = preConsume({
          traceId: 'd'.repeat(32),
          userId: fx.userId,
          orgId: fx.orgId,
          keyId: fx.keyId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages,
          maxOutputTokens: 20,
          isStream: false,
        });
    
        const first = postConsume({
          recordId: reserved.recordId,
          userId: fx.userId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          realPromptTokens: 5,
          realCompletionTokens: 2,
        });
        const bal = balanceOf(fx.userId);
    
        // when duplicate post consume invoke
        // state machine's finalize this status will forbid the further state transition  
        const second = postConsume({
          recordId: reserved.recordId,
          userId: fx.userId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          realPromptTokens: 999,
          realCompletionTokens: 999,
        });
    
        assert.equal(second.balanceDelta, 0);
        assert.equal(second.finalCost, first.finalCost);
        assert.equal(balanceOf(fx.userId), bal);
      });

      it('postConsumeStream writes the requested terminalStatus', () => {
        const fx = seedUserKeyPrice();
        const reserved = preConsume({
          traceId: 'e'.repeat(32),
          userId: fx.userId,
          orgId: fx.orgId,
          keyId: fx.keyId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages,
          maxOutputTokens: 20,
          isStream: true,
        });
    
        postConsumeStream({
          recordId: reserved.recordId,
          userId: fx.userId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          realPromptTokens: 5,
          realCompletionTokens: 3,
          terminalStatus: 'canceled',
        });
    
        const row = getDb().select().from(usageRecords).where(eq(usageRecords.id, reserved.recordId)).get();
        assert.equal(row?.status, 'canceled');
        assert.ok((row?.finalCost ?? 0) > 0);
    });

    it('refundReservation restores full preReservedCost', () => {
        const fx = seedUserKeyPrice({ balanceMicro: 5_000_000 });
        const before = balanceOf(fx.userId);
        const reserved = preConsume({
          traceId: 'f'.repeat(32),
          userId: fx.userId,
          orgId: fx.orgId,
          keyId: fx.keyId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages,
          maxOutputTokens: 20,
          isStream: false,
        });
    
        refundReservation(reserved.recordId, 'upstream 500');
        assert.equal(balanceOf(fx.userId), before);
    
        const row = getDb().select().from(usageRecords).where(eq(usageRecords.id, reserved.recordId)).get();
        assert.equal(row?.status, 'refunded');
        assert.equal(row?.finalCost, 0);
        assert.equal(row?.errorMessage, 'upstream 500');
    
        // idempotent
        refundReservation(reserved.recordId);
        assert.equal(balanceOf(fx.userId), before);
      });
    
      it('markFailed sets status without touching balance', () => {
        const fx = seedUserKeyPrice();
        const reserved = preConsume({
          traceId: 'g'.repeat(32),
          userId: fx.userId,
          orgId: fx.orgId,
          keyId: fx.keyId,
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages,
          maxOutputTokens: 10,
          isStream: false,
        });
        const afterReserve = balanceOf(fx.userId);
    
        markFailed(reserved.recordId, 'postConsume blew up');
        assert.equal(balanceOf(fx.userId), afterReserve);
    
        const row = getDb().select().from(usageRecords).where(eq(usageRecords.id, reserved.recordId)).get();
        assert.equal(row?.status, 'failed');
        assert.equal(row?.errorMessage, 'postConsume blew up');
    });

    it('applies userMultiplier when reserving (0.5x costs half of 1.0x)', () => {
        const db = getDb();
        const now = Date.now();
        const [org] = db.insert(orgs).values({ name: 'o', createdAt: now }).returning().all();
        const [u1] = db
          .insert(users)
          .values({
            orgId: org!.id,
            name: 'full',
            email: 'full@example.com',
            createdAt: now,
            balanceMicro: 10_000_000,
            userMultiplier: 1000,
          })
          .returning()
          .all();
        const [u2] = db
          .insert(users)
          .values({
            orgId: org!.id,
            name: 'half',
            email: 'half@example.com',
            createdAt: now,
            balanceMicro: 10_000_000,
            userMultiplier: 500,
          })
          .returning()
          .all();
        const [k1] = db
          .insert(keys)
          .values({
            userId: u1!.id,
            keyHash: 'h1',
            keyPreview: 'sk-gw-...1',
            name: 'k1',
            createdAt: now,
          })
          .returning()
          .all();
        const [k2] = db
          .insert(keys)
          .values({
            userId: u2!.id,
            keyHash: 'h2',
            keyPreview: 'sk-gw-...2',
            name: 'k2',
            createdAt: now,
          })
          .returning()
          .all();
        db.insert(prices)
          .values({
            model: 'gpt-4o-mini',
            provider: 'openai',
            inputPriceMicroPer1M: 1_000_000,
            outputPriceMicroPer1M: 4_000_000,
            modelMultiplier: 1000,
            effectiveFrom: now - 1,
            createdAt: now,
          })
          .run();
    
        const fullPrice = preConsume({
          traceId: 'h'.repeat(32),
          userId: u1!.id,
          orgId: org!.id,
          keyId: k1!.id,
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages,
          maxOutputTokens: 50,
          isStream: false,
        });
        const halfPrice = preConsume({
          traceId: 'i'.repeat(32),
          userId: u2!.id,
          orgId: org!.id,
          keyId: k2!.id,
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages,
          maxOutputTokens: 50,
          isStream: false,
        });
    
        assert.equal(halfPrice.preReservedCost * 2, fullPrice.preReservedCost);
    });
}); 