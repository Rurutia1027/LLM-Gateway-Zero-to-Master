import assert from 'node:assert/strict'; 
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; 
import { join } from 'node:path'; 
import { after, before, beforeEach, describe, it } from 'node:test'; 

import { closeDb, getDb, getRawSqlite } from '../client.js';  
import { runMigrations } from '../migrate.js';  
import { keys, orgs, prices, usageRecords, users } from '../schema.js';  

describe('db migrations + schema CRUD', () => {
    let dir: string; 

    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'ch07-db-'));
        process.env.DATABASE_URL = join(dir, 'gateway-db'); 
    }); 

    after(() => {
        closeDb(); 
        rmSync(dir, { recursive: true, force: true}); 
    }); 

    beforeEach(() => {
        // Fresh file DB per test so migrations start from empty state 
        closeDb(); 
        process.env.DATABASE_URL = join(dir, `t-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    }); 

    it('applies all drizzle SQL files in order on an empty database', () => {
        const first = runMigrations(); 
        assert.deepEqual(first.applied, ['0001_init.sql', '0002_billing.sql', '0003_quota.sql']);
        assert.deepEqual(first.skipped, []); 

        const sqlite = getRawSqlite();  
        const tables = (
            sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY names`).all() as Array<{
                name: string
            }>
        ).map((r) => r.name); 

        for (const name of [      
            'orgs',
            'users',
            'keys',
            'prices',
            'usage_records',
            '__drizzle_migrations'
        ]) {
            assert.ok(tables.includes(name), `missing table ${name}`); 
        }
        const keyCols = sqlite.prepare(`PRAGMA table_info(keys)`).all() as Array<{name: string}>; 
        const colNameSet = new Set(keyCols.map((c) => c.name))
        for (const col of [
            'qps_limit',
            'tpm_limit',
            'monthly_quota_micro',
            'monthly_used_micro',
            'quota_reset_at',
        ]) {
            assert.ok(colNameSet.has(col), `missing keys.${col}`); 
        }
    }); 

    it('skips alreay-applied migrations on the second run', () => {
        const first = runMigrations();  
        assert.equal(first.applied.length, 3); 

        const second = runMigrations(); 
        assert.deepEqual(second.applied, []); 
        assert.deepEqual(second.skipped, ['0001_init.sql', '0002_billing.sql', '0003_quota.sql']); 
    }); 

    it('insert org / user / key with quota defaults via drizzle',  () => {
        runMigrations(); // db tables and seeded datasets already loaded to db instance 
        
        // get db instance 
        const db = getDb();
        const now = Date.now();  

        const [org] = db
        .insert(orgs)
        .values({name: 'acme', createdAt: now})
        .returning()
        .all(); 

        assert.ok(org?.id); 

        const [user] = db
        .insert(users)
        .values({
            orgId: org!.id, 
            name: 'alice', 
            email: 'alice@acme.com',
            createdAt: now, 
            balanceMicro: 1_000_000, 
        })
        .returning()
        .all(); 

        // default value should be equal 
        assert.equal(user?.userMultiplier, 1000); 
        assert.equal(user?.balanceMicro, 1_000_000); 

        const [key] = db
            .insert(keys)
            .values({
                userId: user!.id, 
                keyHash: 'hash-alice',
                keyPreview: 'sk-gw-****lice',
                name: 'default',
                createdAt: now, 
            })
            .returning()
            .all(); 
            
        assert.equal(key?.qpsLimit, 0);
        assert.equal(key?.tpmLimit, 0);
        assert.equal(key?.monthlyQuotaMicro, 0);
        assert.equal(key?.monthlyUsedMicro, 0);
        assert.equal(key?.quotaResetAt, 0);
        assert.equal(key?.scopes, 'chat');
    }); 

    it('enforces foreign keys (user without org fails', () => {
        // init db tables and insert seeds data to db of sqlite 
        runMigrations(); 

        // org id is users table fk,
        // insert a record of user and assign org id that doesn't exist in org db table will throw foreign key error  
        const sqlite = getRawSqlite();
        assert.throws(
            () => {
                sqlite.prepare(`INSERT INTO users (org_id, name, created_at, balance_micro, user_multiplier) VALUES (999, 'ghost', ?, 0, 1000)`).run(Date.now());
            },
            /FOREIGN KEY/i,
        );
    }); 

    it('enforces unique key_hash', () => {
        // create sqlite instance, and execute sql scripts under folder drizzle to sqllite instance
        runMigrations();  

        // fetch db handler 
        const db = getDb(); 
        const now = Date.now(); 

        // insert 1 record of org to db 
        const [org] = db.insert(orgs).values({name: 'o', createdAt: now}).returning().all(); 

        // insert 1 record of user to db, user inner org id is the org id that we have just inserted to db 
        const [user] = db.insert(users).values({orgId: org!.id, name: 'u', createdAt: now}).returning().all();  

        // insertn 1 record of key, key record's inner fk is user id that we have just inserted to db  
        // keys depends on user, user depends on org 
        db.insert(keys)
        .values({
            userId: user!.id, 
            keyHash: 'dup',
            keyPreview: 'sk-gw-****',
            name: 'a',
            createdAt: now, 
        })
        .returning()
        .run(); 

        assert.throws(() => {
            db.insert(keys)
            .values({
                userId: user!.id, 
                //  conflict by this unique id  keyHashIdx: uniqueIndex('keys_key_hash_idx').on(table.keyHash), 
                keyHash: 'dup', 
                keyPreview: 'sk-gw-****',
                name: 'b',
                createdAt: now, 
            })
        }, /UNIQUE/i); 
    }); 

    it('stores prices and usage_records with reserved status default', () => {
        runMigrations();
        const db = getDb();
        const now = Date.now();
    
        const [org] = db.insert(orgs).values({ name: 'o', createdAt: now }).returning().all();
        const [user] = db
          .insert(users)
          .values({ orgId: org!.id, name: 'u', createdAt: now })
          .returning()
          .all();
        const [key] = db
          .insert(keys)
          .values({
            userId: user!.id,
            keyHash: 'h1',
            keyPreview: 'sk-gw-****',
            name: 'k',
            createdAt: now,
          })
          .returning()
          .all();
    
        const [price] = db
          .insert(prices)
          .values({
            model: 'gpt-4o-mini',
            provider: 'openai',
            inputPriceMicroPer1M: 1_050_000,
            outputPriceMicroPer1M: 4_200_000,
            effectiveFrom: now,
            createdAt: now,
          })
          .returning()
          .all();
        assert.equal(price?.modelMultiplier, 1000);
        assert.equal(price?.effectiveTo, null);
    
        const [usage] = db
          .insert(usageRecords)
          .values({
            traceId: 'a'.repeat(32),
            userId: user!.id,
            orgId: org!.id,
            keyId: key!.id,
            model: 'gpt-4o-mini',
            provider: 'openai',
            preReservedCost: 1000,
            createdAt: now,
          })
          .returning()
          .all();
    
        assert.equal(usage?.status, 'reserved');
        assert.equal(usage?.isStream, false);
        assert.equal(usage?.finalCost, 0);
      });

    it('getDb returns the same singleton until closeDb', () => {
        runMigrations();
        const a = getDb();
        const b = getDb();
        assert.equal(a, b);
        closeDb();
        const c = getDb();
        assert.notEqual(a, c);
      });
}); 