
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from "node:fs"; 
import {dirname, resolve} from 'node:path'; 
import * as schema from '../db/schema.js'; 

let _db: BetterSQLite3Database<typeof schema>  | null = null;  
let _sqlite:Database.Database | null = null; 

export function getDb(): BetterSQLite3Database<typeof schema> {
    if (_db) return _db;
    _sqlite = openSqlite(); 
    _db = drizzle(_sqlite, {schema}); 

    return _db; 
}

export function getRawSqlite(): Database.Database {
    if (_sqlite) return _sqlite;
    _sqlite = openSqlite(); 
    _db = drizzle(_sqlite, {schema}); 
    return _sqlite;  
}

function openSqlite(): Database.Database {
    const url = process.env.DATABASE_URL ?? './data/gateway.db'; 
    // In-memory DBs are useful for unit tests; skip mkdir / path resolve. 
    if (url === ':memory') {
        const sqlite = new Database(':memory:'); 
        sqlite.pragma('foreign_keys=ON'); 
        return sqlite;  
    }

    const absPath = resolve(process.cwd(), url); 
    mkdirSync(dirname(absPath), { recursive: true }); 
    const sqlite = new Database(absPath); 
    sqlite.pragma('journal_mode = WAL'); 
    sqlite.pragma('foreign_keys=ON'); 
    return sqlite; 
}

/** Close the shared connection (tests / graceful shutdown). Next getDb() reopens. */
export function closeDb(): void {
    if (_sqlite) {
      _sqlite.close();
    }
    _sqlite = null;
    _db = null;
}

export { schema }; 