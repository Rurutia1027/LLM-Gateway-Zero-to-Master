// Auto-run migrations on startup. 
// 
// Simplified implementations (good enough for Ch4+)
// - Maintain a __drizzle_migrations table that records applied filenames. 
// - Scan all .sql files under drizzle/, sort by filename; 
// - Run unapplied files in order, each wrapped in a transaction. 
// - Skip files that were already applied. 
// 
// Behavior matches drizzle-kit's built-in migrator, but without its internal 
// hash comparison. Filename ordering is enough for teaching. In production, 
// readers can replace this with 
//   import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
//   migrate(db, { migrationsFolder: './drizzle' });

import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getRawSqlite } from './client.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';
const MIGRATIONS_DIR = resolve(process.cwd(), 'drizzle');

export function runMigrations(): { applied: string[]; skipped: string[] } {
  const sqlite = getRawSqlite();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = sqlite
    .prepare<[], { filename: string }>(`SELECT filename FROM ${MIGRATIONS_TABLE}`)
    .all();
  const appliedSet = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  const insertStmt = sqlite.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (filename, applied_at) VALUES (?, ?)`,
  );

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      insertStmt.run(file, Date.now());
    });
    tx();
    applied.push(file);
  }

  return { applied, skipped };
}

// allow `npm run migrate` execute 
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate.ts') ||
  process.argv[1]?.endsWith('migrate.js');

if (invokedDirectly) {
  const result = runMigrations();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
}

