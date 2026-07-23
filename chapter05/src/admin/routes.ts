// Admin HTTP API: create org / user / issue Key / list Key / revoke Key
//                 + v0.5 TODO: adjust balance / user multiplier / list+set prices / query usage
//
// All routes are protected by requireAdminToken(); callers put ADMIN_TOKEN in Authorization.
//
// v0.4 routes (already implemented):
//   POST   /admin/orgs                  create org
//   POST   /admin/users                 create user
//   POST   /admin/keys                  issue Key
//   GET    /admin/keys?userId=          list Keys (redacted)
//   DELETE /admin/keys/:id              revoke Key
//
// v0.5 TODO routes:
//   POST   /admin/users/:id/balance     adjust balance (body: { deltaCny } or { setCny })
//   POST   /admin/users/:id/multiplier  set user multiplier (body: { multiplier: 0.0-10.0 })
//   GET    /admin/prices                list price table
//   POST   /admin/prices                add / change price (auto-close old effective_to)
//   GET    /admin/usage                 query ledger (query: userId / keyId / traceId / limit)
//
// Also TODO(ch05) on POST /admin/users:
//   accept optional balanceCny / userMultiplier; default INITIAL_BALANCE_CNY / 1.0x

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client.js';
import { keys, orgs, users } from '../db/schema.js';
import { generateKey } from '../auth/key.js';
import { requireAdminToken } from '../auth/middleware.js';
// TODO(ch05): import { prices, usageRecords } from '../db/schema.js';
// TODO(ch05): import { invalidatePriceCache } from '../billing/prices.js';

export function createAdminRouter(): Hono {
  const app = new Hono();
  app.use('*', requireAdminToken());

  // const INITIAL_BALANCE_CNY = Number(process.env.INITIAL_BALANCE_CNY ?? 100);

  // --- orgs ---
  app.post('/orgs', async (c) => {
    const schema = z.object({ name: z.string().min(1).max(100) });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid request', detail: parsed.error.format() } }, 400);
    }

    const db = getDb();
    const now = Date.now();
    const rows = db.insert(orgs).values({ name: parsed.data.name, createdAt: now }).returning().all();
    return c.json(rows[0], 201);
  });

  // --- users ---
  // TODO(ch05): extend body with balanceCny? / userMultiplier?; write balanceMicro on insert
  app.post('/users', async (c) => {
    const schema = z.object({
      orgId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      email: z.string().email().optional(),
      // balanceCny: z.number().nonnegative().optional(),
      // userMultiplier: z.number().positive().max(10).optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const orgExists = db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, parsed.data.orgId)).all();
    if (orgExists.length === 0) {
      return c.json({ error: { message: `org ${parsed.data.orgId} not found` } }, 404);
    }

    const now = Date.now();
    const rows = db
      .insert(users)
      .values({
        orgId: parsed.data.orgId,
        name: parsed.data.name,
        email: parsed.data.email,
        createdAt: now,
        // balanceMicro: Math.round((parsed.data.balanceCny ?? INITIAL_BALANCE_CNY) * 1_000_000),
        // userMultiplier: Math.round((parsed.data.userMultiplier ?? 1.0) * 1000),
      })
      .returning()
      .all();
    return c.json(rows[0], 201);
  });

  // TODO(ch05): POST /users/:id/balance
  // TODO(ch05): POST /users/:id/multiplier

  // --- keys ---
  app.post('/keys', async (c) => {
    const schema = z.object({
      userId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      expiresInDays: z.number().int().positive().max(3650).optional(),
      scopes: z.string().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }

    const db = getDb();
    const userExists = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, parsed.data.userId))
      .all();
    if (userExists.length == 0) {
      return c.json({ error: { message: `user ${parsed.data.userId} not found` } }, 404);
    }

    const generated = generateKey();
    const now = Date.now();
    const expiresAt =
      parsed.data.expiresInDays !== undefined
        ? now + parsed.data.expiresInDays * 24 * 60 * 60 * 1000
        : null;

    const rows = db
      .insert(keys)
      .values({
        userId: parsed.data.userId,
        keyHash: generated.hash,
        keyPreview: generated.preview,
        name: parsed.data.name,
        scopes: parsed.data.scopes ?? 'chat',
        expiresAt,
        createdAt: now,
      })
      .returning()
      .all();

    return c.json(
      {
        id: rows[0]!.id,
        plaintext: generated.plaintext,
        preview: generated.preview,
        name: rows[0]!.name,
        scopes: rows[0]!.scopes,
        expiresAt: rows[0]!.expiresAt,
        createdAt: rows[0]!.createdAt,
        warning: 'Save this plaintext now. It will never be shown again.',
      },
      201,
    );
  });

  app.get('/keys', async (c) => {
    const userIdRaw = c.req.query('userId');
    let userId: number | undefined;
    if (userIdRaw !== undefined && userIdRaw !== '') {
      userId = Number(userIdRaw);
      if (!Number.isInteger(userId) || userId <= 0) {
        return c.json({ error: { message: 'invalid userId' } }, 400);
      }
    }
    const db = getDb();
    const query = db
      .select({
        id: keys.id,
        userId: keys.userId,
        preview: keys.keyPreview,
        name: keys.name,
        scopes: keys.scopes,
        expiresAt: keys.expiresAt,
        disabledAt: keys.disabledAt,
        lastUsedAt: keys.lastUsedAt,
        createdAt: keys.createdAt,
      })
      .from(keys);
    const rows = userId !== undefined ? query.where(eq(keys.userId, userId)).all() : query.all();
    return c.json({ data: rows });
  });

  app.delete('/keys/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { message: 'invalid id' } }, 400);
    }
    const db = getDb();
    const now = Date.now();
    const updated = db
      .update(keys)
      .set({ disabledAt: now })
      .where(and(eq(keys.id, id)))
      .returning()
      .all();
    if (updated.length === 0) {
      return c.json({ error: { message: `key ${id} not found` } }, 404);
    }
    return c.json({ id, disabledAt: now });
  });

  // TODO(ch05): GET  /prices
  // TODO(ch05): POST /prices  (INSERT new row; close previous effective_to; invalidatePriceCache)
  // TODO(ch05): GET  /usage?userId=&keyId=&traceId=&limit=

  return app;
}
