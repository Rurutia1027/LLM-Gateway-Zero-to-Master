import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { getDb } from '../../db/client.js';
import { prices, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

import {
    createTempDbDir, 
    destroyTempDbDir, 
    resetTestDb, 
    seedUserKeyPrice
} from '../../billing/__tests__/helpers.js'; 
import { invalidatePriceCache } from '../../billing/prices.js';
import { MULTIPLIER_SCALE, resolveMultipler } from '../registry.js';
import { create } from 'node:domain';

describe('resolveMultipler', () => {
    let dir: string; 

    before(() => {
        dir = createTempDbDir('ch07-mul-');  
    }); 

    after(() => {
        destroyTempDbDir(dir);  
    }); 


    // every test case, create new db instance, and load seed data to db 
    beforeEach(() => {
        resetTestDb(dir); 
    }); 


    it ('returns 1.0x when user and model multiplers are baseline', () => {
        const fx = seedUserKeyPrice({userMultiplier: 1000, modelMultiplier: 1000}); 
        const mul = resolveMultipler({
            userId: fx.userId, 
            model: 'gpt-4o-mini',  
            provider: 'openai', 
        }); 

        
        assert.equal(mul.user, 1000);
        assert.equal(mul.channel, MULTIPLIER_SCALE);
        assert.equal(mul.model, 1000);
        assert.equal(mul.combinedScale1e9, 1000 * 1000 * 1000);
        assert.equal(mul.combinedFloat, 1);
    }); 

    it('applies user discount (0.8x) into combinedFloat', () => {
        const fx = seedUserKeyPrice({userMultiplier: 800, modelMultiplier: 1000});
        const mul = resolveMultipler({
            userId: fx.userId, 
            model: 'gpt-4o-mini',  
            provider: 'openai', 
        });  
        assert.equal(mul.user, 800);
        // user-mul, model-mul, channel-mul are 800, 1000, 1000 respectively
        // channel-mul is always 1000 if not specify it in constructor 
        assert.equal(mul.combinedScale1e9, 800 * 1000 * 1000);
        assert.equal(mul.combinedFloat, 0.8);
    }); 

    it('composes user × model multipliers', () => {
        const fx = seedUserKeyPrice({userMultiplier: 800, modelMultiplier: 1500});
        const mul = resolveMultipler({
            userId: fx.userId, 
            model: 'gpt-4o-mini', 
            provider: 'openai', 
        }); 

        assert.equal(mul.user, 800); 
        assert.equal(mul.model, 1500); 
        assert.equal(mul.channel, 1000); // default val 
        assert.equal(mul.combinedScale1e9, 800 * 1500 * 1000); 
        assert.equal(mul.combinedFloat, (800 * 1500 * 1000) / (1_000_000_000)); 
    }); 

    it('defaults user multipler to 1.0x when user id is missing', () => {
        seedUserKeyPrice({modelMultiplier: 1000}); 
        const mul = resolveMultipler({
            userId: 999_999, 
            model: 'gpt-4o-mini', 
            provider: 'openai', 
        }); 
        assert.equal(mul.user, MULTIPLIER_SCALE); 

        // user-mul, model-mul, channel-mul are 1000, 1000, 1000 respectively
        // float = user-mul * model-mul * channel-mul / 1e9 = 1000 * 1000 * 1000 / 1e9 = 1 
        assert.equal(mul.combinedFloat, 1); 
    }); 

    it('picks up updated userMultipler after admin-style change', () => {
        const fx = seedUserKeyPrice({userMultiplier: 1000}); 
        getDb()
                .update(users)
                .set({userMultiplier: 500})
                .where(eq(users.id, fx.userId))
                .run(); 
        
        const mul = resolveMultipler({
            userId: fx.userId, 
            model: 'gpt-4o-mini', 
            provider: 'openai', 
        }); 

        assert.equal(mul.user, 500);  
        // user-mul, model-mul, channel-mul are 500, 1000, 1000 respectively 
        assert.equal(mul.combinedFloat, (500 * 1000 * 1000) / (1_000_000_000)); 
    }); 

    it('picks up updated modelMultiplier after cache invalidate', () => {
        const fx = seedUserKeyPrice({modelMultiplier: 1000});  
        getDb() 
            .update(prices)
            .set({modelMultiplier: 2000})
            .where(eq(prices.id, fx.priceId))
            .run(); 
        
        // clean cache, so our next round resolveMultiper func invocation
        // cannot fetch expired price records from mem cache, 
        // it has to fetch price from db record (which has already been update by the above db update operation) 
        invalidatePriceCache(); 

        const mul = resolveMultipler({
            userId: fx.userId, 
            model: 'gpt-4o-mini', 
            provider: 'openai', 
        }); 

        assert.equal(mul.model, 2000); 
        // float = 2 
        assert.equal(mul.combinedFloat, (1000 * 2000 * 1000) / (1_000_000_000)); 
    }); 
}); 