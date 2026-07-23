// CLI: issue an internal gateway Key
//
// Scenario: bootstrap a fresh server with no users/keys and no handy admin UI —
// point at the sqlite file and mint a Key for smoke tests.
//
// Usage:
//   npm run issue-key -- --org "My Company" --user "alice" --name "smoke-test"
//   npm run issue-key -- --user-id 1 --name "ci-bot"
//   npm run issue-key -- --org "X" --user "y" --name "k" --expires-days 30
//
// Prints plaintext Key to stdout — the only time it is visible.
//
// TODO(ch05): when creating a new user, set balanceMicro from INITIAL_BALANCE_CNY
//   (and optionally accept --balance-cny). Without this, new users start at 0
//   after schema adds the column default, or you rely on admin balance API.

import 'dotenv/config';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { keys, orgs, users } from '../db/schema.js';
import { generateKey } from '../auth/key.js';
import { runMigrations } from '../db/migrate.js';

interface Args {
  org?: string;
  user?: string;
  userId?: number;
  name: string;
  expiresInDays?: number;
  // TODO(ch05): balanceCny?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--org':
        args.org = v;
        i++;
        break;
      case '--user':
        args.user = v;
        i++;
        break;
      case '--user-id':
        args.userId = Number(v);
        i++;
        break;
      case '--name':
        args.name = v;
        i++;
        break;
      case '--expires-days':
        args.expiresInDays = Number(v);
        i++;
        break;
      // case '--balance-cny':
      //   args.balanceCny = Number(v);
      //   i++;
      //   break;
    }
  }
  if (!args.name) {
    throw new Error('--name is required');
  }
  if (args.userId === undefined && (!args.org || !args.user)) {
    throw new Error('either --user-id or both --org and --user are required');
  }
  return args as Args;
}

function main(): void {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const now = Date.now();
  // const INITIAL_BALANCE_CNY = Number(process.env.INITIAL_BALANCE_CNY ?? 100);

  let userId = args.userId;
  if (userId === undefined) {
    const orgRows = db.select().from(orgs).where(eq(orgs.name, args.org!)).all();
    let orgId: number;
    if (orgRows.length === 0) {
      const inserted = db
        .insert(orgs)
        .values({ name: args.org!, createdAt: now })
        .returning()
        .all();
      orgId = inserted[0]!.id;
      console.log(`[cli] created org #${orgId} "${args.org}"`);
    } else {
      orgId = orgRows[0]!.id;
    }
    const userInserted = db
      .insert(users)
      .values({
        orgId,
        name: args.user!,
        createdAt: now,
        // TODO(ch05):
        // balanceMicro: Math.round((args.balanceCny ?? INITIAL_BALANCE_CNY) * 1_000_000),
        // userMultiplier: 1000,
      })
      .returning()
      .all();
    userId = userInserted[0]!.id;
    console.log(`[cli] created user #${userId} "${args.user}" in org #${orgId}`);
  }

  const generated = generateKey();
  const expiresAt =
    args.expiresInDays !== undefined ? now + args.expiresInDays * 24 * 60 * 60 * 1000 : null;
  const inserted = db
    .insert(keys)
    .values({
      userId,
      keyHash: generated.hash,
      keyPreview: generated.preview,
      name: args.name,
      scopes: 'chat',
      expiresAt,
      createdAt: now,
    })
    .returning()
    .all();

  console.log('');
  console.log('=== Save this plaintext now. It will never be shown again. ===');
  console.log(`KEY_ID:     ${inserted[0]!.id}`);
  console.log(`USER_ID:    ${userId}`);
  console.log(`NAME:       ${args.name}`);
  console.log(`PREVIEW:    ${generated.preview}`);
  console.log(`EXPIRES:    ${expiresAt ? new Date(expiresAt).toISOString() : 'never'}`);
  console.log(`PLAINTEXT:  ${generated.plaintext}`);
  console.log('');
  console.log('Try it:');
  console.log(
    `  curl -H "Authorization: Bearer ${generated.plaintext}" http://localhost:3001/v1/chat/completions ...`,
  );
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
