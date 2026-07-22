// Admin HTTP API: create org / create user / issue Key / list Key / revoke Key
//
// All routes are protected by requireAdminToken(); callers put ADMIN_TOKEN in Authorization.
//
// Route design (REST-ish, kept flat on purpose so readers don't need nested resources first):
//   POST   /admin/orgs                  create org
//   POST   /admin/users                 create user (body: { orgId, name, email? })
//   POST   /admin/keys                  issue Key  (body: { userId, name, expiresInDays?, scopes? })
//   GET    /admin/keys?userId=          list Keys (redacted — no plaintext)
//   DELETE /admin/keys/:id              revoke Key (soft delete: set disabled_at, do not remove the row)
//
// The plaintext field appears only once in POST /admin/keys; no later endpoint can return it.

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client.js';
import { keys, orgs, users } from '../db/schema.js';
import { generateKey } from '../auth/key.js';
import { requireAdminToken } from '../auth/middleware.js';

export function createAdminRouter(): Hono {
  const app = new Hono();
  app.use('*', requireAdminToken());

  // --- orgs ---
  app.post('/orgs', async (c) => {
    const schema = z.object({name: z.string().min(1).max(100)}); 
    const parsed = schema.safeParse(await c.req.json().catch(() => null)); 
    if (!parsed.success) {
        return c.json({error: {message: 'invalid request', detail: parsed.error.format()}}, 400); 
    }

    const db = getDb(); 
    const now = Date.now(); 
    const rows = db.insert(orgs).values({name: parsed.data.name, createdAt: now}).returning().all(); 
    return c.json(rows[0], 201); 
  });

  // --- users ---
  app.post('/users', async (c) => {
    const schema = z.object({
        orgId: z.number().int().positive(), 
        name: z.string().min(1).max(100), 
        email: z.string().email().optional(), 
    }); 
    const parsed = schema.safeParse(await c.req.json().catch(() => null)); 
    if (!parsed.success) {
        return c.json({error: {message: 'invalid request', detail: parsed.error.format()}}, 400); 
    }
    const db = getDb(); 
    const orgExists = db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, parsed.data.orgId)).all();
    if (orgExists.length === 0) {
        return c.json({error: {message: `org ${parsed.data.orgId} not found`}}, 404); 
    }

    const now = Date.now(); 
    const rows = db
        .insert(users)
        .values({
            orgId: parsed.data.orgId, 
            name: parsed.data.name, 
            email: parsed.data.email, 
            createdAt: now, 
        })
        .returning()
        .all(); 
    return c.json(rows[0], 201); 
  });

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
        return c.json({error: {message: 'invalid_request', detail: parsed.error.format()}}, 400); 
    }

    const db = getDb(); 
    const userExists = db.select({id: users.id}).from(users).where(eq(users.id, parsed.data.userId)).all(); 
    if (userExists.length == 0) {
        return c.json({error: {message: `user ${parsed.data.userId} not found`}}, 404); 
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

    return c.json({
        id: rows[0]!.id,
        plaintext: generated.plaintext, 
        preview: generated.preview,
        name: rows[0]!.name, 
        scopes: rows[0]!.scopes, 
        expiresAt: rows[0]!.expiresAt, 
        createdAt: rows[0]!.createdAt, 
        warning: 'Save this plaintext now. It will never be shown again.', 
    }, 201); 
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

  return app;
}
