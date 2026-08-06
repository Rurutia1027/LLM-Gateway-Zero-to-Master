import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { closeDb, getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { keys, orgs, users } from '../../db/schema.js';
import { generateKey } from '../key.js';
import {
  requireAdminToken,
  requireGatewayKey,
  type AuthVariables,
} from '../middleware.js';

type Fixture = {
  plaintext: string;
  keyId: number;
  userId: number;
  orgId: number;
};

function seedActiveKey(overrides: {
  scopes?: string;
  keyDisabledAt?: number | null;
  keyExpiresAt?: number | null;
  userDisabledAt?: number | null;
  orgDisabledAt?: number | null;
} = {}): Fixture {
  const db = getDb();
  const now = Date.now();
  const generated = generateKey();

  const [org] = db
    .insert(orgs)
    .values({
      name: `org-${now}`,
      createdAt: now,
      disabledAt: overrides.orgDisabledAt ?? null,
    })
    .returning()
    .all();

  const [user] = db
    .insert(users)
    .values({
      orgId: org!.id,
      name: 'alice',
      email: `alice-${now}@example.com`,
      createdAt: now,
      disabledAt: overrides.userDisabledAt ?? null,
    })
    .returning()
    .all();

  const [key] = db
    .insert(keys)
    .values({
      userId: user!.id,
      keyHash: generated.hash,
      keyPreview: generated.preview,
      name: 'default',
      scopes: overrides.scopes ?? 'chat,admin',
      createdAt: now,
      disabledAt: overrides.keyDisabledAt ?? null,
      expiresAt: overrides.keyExpiresAt ?? null,
    })
    .returning()
    .all();

  return {
    plaintext: generated.plaintext,
    keyId: key!.id,
    userId: user!.id,
    orgId: org!.id,
  };
}

function buildGatewayApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.get('/protected', requireGatewayKey, (c) => {
    return c.json({ ok: true, auth: c.get('auth') });
  });
  return app;
}

function buildAdminApp() {
  const app = new Hono();
  app.get('/admin', requireAdminToken(), (c) => c.json({ ok: true }));
  return app;
}

async function jsonBody(res: Response): Promise<{ error?: { message?: string } }> {
  return (await res.json()) as { error?: { message?: string } };
}

describe('requireGatewayKey', () => {
  let dir: string;
  let prevAdminToken: string | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ch07-auth-mw-'));
    prevAdminToken = process.env.ADMIN_TOKEN;
  });

  after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    if (prevAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prevAdminToken;
  });

  beforeEach(() => {
    closeDb();
    process.env.DATABASE_URL = join(
      dir,
      `t-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    runMigrations();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildGatewayApp();
    const res = await app.request('/protected');
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.match(body.error?.message ?? '', /missing or malformed/i);
  });

  it('returns 401 when Authorization is not Bearer', async () => {
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: 'Basic abc' },
    });
    assert.equal(res.status, 401);
  });

  it('returns 401 when key format is invalid', async () => {
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: 'Bearer not-a-gateway-key' },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.match(body.error?.message ?? '', /key format invalid/i);
  });

  it('returns 401 when key hash is unknown', async () => {
    const app = buildGatewayApp();
    const unknown = generateKey().plaintext;
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${unknown}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.error?.message, 'invalid key');
  });

  it('returns 401 when key has been revoked', async () => {
    const fixture = seedActiveKey({ keyDisabledAt: Date.now() });
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${fixture.plaintext}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.error?.message, 'key has been revoked');
  });

  it('returns 401 when key has expired', async () => {
    const fixture = seedActiveKey({ keyExpiresAt: Date.now() - 1_000 });
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${fixture.plaintext}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.error?.message, 'key has been expired');
  });

  it('returns 403 when user is disabled', async () => {
    const fixture = seedActiveKey({ userDisabledAt: Date.now() });
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${fixture.plaintext}` },
    });
    assert.equal(res.status, 403);
    const body = await jsonBody(res);
    assert.equal(body.error?.message, 'user is disabled');
  });

  it('returns 403 when org is disabled', async () => {
    const fixture = seedActiveKey({ orgDisabledAt: Date.now() });
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${fixture.plaintext}` },
    });
    assert.equal(res.status, 403);
    const body = await jsonBody(res);
    assert.equal(body.error?.message, 'org is disabled');
  });

  it('injects auth context and refreshes lastUsedAt on success', async () => {
    const fixture = seedActiveKey({ scopes: ' chat , admin , ' });
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${fixture.plaintext}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      auth: { keyId: number; userId: number; orgId: number; scopes: string[] };
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.auth, {
      keyId: fixture.keyId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      scopes: ['chat', 'admin'],
    });

    // lastUsedAt is written via setImmediate; wait one tick then assert.
    await delay(20);
    const row = getDb().select().from(keys).where(eq(keys.id, fixture.keyId)).get();
    assert.ok(row?.lastUsedAt != null);
    assert.ok(row!.lastUsedAt! > 0);
  });

  it('accepts bearer keyword case-insensitively and trims the token', async () => {
    const fixture = seedActiveKey();
    const app = buildGatewayApp();
    const res = await app.request('/protected', {
      headers: { Authorization: `bearer  ${fixture.plaintext}  ` },
    });
    assert.equal(res.status, 200);
  });
});

describe('requireAdminToken', () => {
  let prevAdminToken: string | undefined;

  before(() => {
    prevAdminToken = process.env.ADMIN_TOKEN;
  });

  after(() => {
    if (prevAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prevAdminToken;
  });

  it('returns 500 when ADMIN_TOKEN is not configured', async () => {
    delete process.env.ADMIN_TOKEN;
    const app = buildAdminApp();
    const res = await app.request('/admin', {
      headers: { Authorization: 'Bearer anything' },
    });
    assert.equal(res.status, 500);
    const body = await jsonBody(res);
    assert.match(body.error?.message ?? '', /ADMIN_TOKEN/i);
  });

  it('returns 401 when Authorization header is missing', async () => {
    process.env.ADMIN_TOKEN = 'admin-secret';
    const app = buildAdminApp();
    const res = await app.request('/admin');
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.match(body.error?.message ?? '', /missing Authorization/i);
  });

  it('returns 401 when admin token does not match', async () => {
    process.env.ADMIN_TOKEN = 'admin-secret';
    const app = buildAdminApp();
    const res = await app.request('/admin', {
      headers: { Authorization: 'Bearer wrong-secret' },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.error?.message, 'invalid admin token received from header');
  });

  it('allows the request when admin token matches', async () => {
    process.env.ADMIN_TOKEN = 'admin-secret';
    const app = buildAdminApp();
    const res = await app.request('/admin', {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });
});
