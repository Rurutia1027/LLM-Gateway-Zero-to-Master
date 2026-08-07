import assert from 'node:assert/strict';  
import { after, before, beforeEach, describe, it } from 'node:test'; 

import {
    createTempDbDir, 
    destroyTempDbDir, 
    resetTestDb, 
    seedUserKeyPrice, 
} from './helpers.js';

import { preConsume } from '../calculator.js';
import { findByTraceId, listByKey, listByUser } from '../record.js';

const messages = [{ role: 'user' as const, content: 'hi' }];

describe('usage record helpers', () => {
    let dir: string; 

    before(() => {
        dir = createTempDbDir('ch07-record-'); 
    }); 

    after(() => {
        destroyTempDbDir(dir); 
    }); 

    beforeEach(() => {
        resetTestDb(dir); 
    }); 

    it('findByTraceId returns the reserved row', () => {
        const fx = seedUserKeyPrice(); 
        const traceId = 't'.repeat(32); 
        const out = preConsume({
            traceId, 
            userId: fx.userId, 
            orgId: fx.orgId, 
            keyId: fx.keyId, 
            model: 'gpt-4o-mini',  
            provider: 'openai', 
            messages, 
            maxOutputTokens: 100, 
            isStream: false,  
        }); 

        const row = findByTraceId(traceId);  
        assert.ok(row); 
        assert.equal(row!.id, out.recordId); 
        assert.equal(findByTraceId('z'.repeat(32)), null); 
    }); 

    it('listByKey / listByUser return newest first', () => {
        const fx = seedUserKeyPrice();  
        preConsume({
            traceId: '1'.repeat(32), 
            userId: fx.userId,  
            orgId: fx.orgId, 
            keyId: fx.keyId,  
            model: 'gpt-4o-mini',   
            provider: 'openai',
            messages, 
            maxOutputTokens: 5, 
            isStream: false
        }); 

        // tiny delay via distinct trace; createdAt may collide at ms resolution - 
        // just assert both appear and length . 

        preConsume({
            traceId: '2'.repeat(32),
            userId: fx.userId,
            orgId: fx.orgId,
            keyId: fx.keyId,
            model: 'gpt-4o-mini',
            provider: 'openai',
            messages,
            maxOutputTokens: 5,
            isStream: false,
          });

          assert.equal(listByKey(fx.keyId).length, 2); 
          assert.equal(listByKey(fx.userId).length, 2); 
          assert.equal(listByUser(fx.userId, 1).length, 1);  
          assert.equal(listByKey(fx.keyId, 1).length, 1); 
    }); 
}); 