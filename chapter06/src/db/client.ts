// SQLite connection + Drizzle instance
//
// Why better-sqlite3:
//   - Sync API — no await scattered everywhere; better for teaching
//     (see research/ts-stack-selection.md);
//   - Native module, single-file DB, zero extra services — works after npm install;
//   - First-class Drizzle support (drizzle-orm/better-sqlite3).
//
// Singleton: one Database and one Drizzle instance per process.
// SQLite is single-writer / multi-reader by default; better-sqlite3 serializes
// writes, so concurrent write conflicts do not surface.

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as schema from './schema.js';

let _db: BetterSQLite3Database<typeof schema> | null = null; 
let _sqlite: Database.Database | null = null; 

export function getDb(): BetterSQLite3Database<typeof schema> {
    if (_db) return _db; 
    _sqlite = openSqlite(); 
    _db = drizzle(_sqlite, {schema}); 
    return _db 
}

export function getRawSqlite(): Database.Database {
    if (_sqlite) return _sqlite; 
    _sqlite = openSqlite(); 
    _db = drizzle(_sqlite, {schema}); 
    return _sqlite; 
}

function openSqlite(): Database.Database {
    const url = process.env.DATABASE_URL ?? './data/gateway.db';
    const absPath = resolve(process.cwd(), url);
    mkdirSync(dirname(absPath), { recursive: true });
    const sqlite = new Database(absPath);
    // enable WAL mode: no write blocking, performance benefit for single thread 
    sqlite.pragma('journal_mode = WAL');
    // enable foreign keys (SQLite default is OFF, otherwise it's useless)
    sqlite.pragma('foreign_keys = ON');
    return sqlite;
  }
  
  export { schema };
  