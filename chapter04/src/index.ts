// Chapter 4 v0.4: internal Key system + first persistence layer
//
// Core changes vs v0.3:
//   1. On startup, auto-run migrations under drizzle/ to create orgs / users / keys;
//   2. Wrap both /v1/chat/completions and /v1/messages with requireGatewayKey middleware;
//   3. Add /admin/* management APIs, protected by ADMIN_TOKEN, for creating users /
//      issuing keys / revoking keys;
//   4. Add src/cli/issue-key.ts so you can mint the first Key when bootstrapping the server.
//
// Two separate Key systems:
//   - Upstream (external) keys: OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY,
//     still from env vars; used by the gateway against provider accounts;
//     Ch8 will move them into a channels table, but lifecycle stays with gateway ops.
//   - Downstream (internal) keys: sk-gw-..., stored in DB; used by clients as gateway users.
//
// Intentionally left open (later chapters):
//   - No billing — cannot attribute spend per Key (Ch5)
//   - No rate limits — one Key can burn upstream quota (Ch6)
//   - Streaming still off (Ch7); both paths reject stream:true
//   - Channel pool / failover (Ch8)
//   - Structured logs / dashboards (Ch9)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pino from 'pino';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
import { OpenAIAdapter } from './adaptors/openai.js';
import { DeepSeekAdapter } from './adaptors/deepseek.js';
import { AnthropicAdapter } from './adaptors/anthropic.js';
import { ModelRouter } from './router.js';
import { runMigrations } from './db/migrate.js';
import { requireGatewayKey, type AuthVariables } from './auth/middleware.js';
import { createAdminRouter } from './admin/routes.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// ============================================================
// Before serving: run migrations. Schema must exist before middleware can query.
// ============================================================
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  logger.info({ applied: migrationResult.applied }, 'db_migrations_applied');
}

// ============================================================
// Wire upstream adapters (same as v0.3; upstream keys still come from env)
// ============================================================
const anthropicAdapter = new AnthropicAdapter({
  baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicVersion: process.env.ANTHROPIC_VERSION ?? '2023-06-01',
});

const router = new ModelRouter([
  {
    prefix: 'deepseek-',
    adapter: new DeepSeekAdapter({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    }),
  },
  {
    prefix: 'claude-',
    adapter: anthropicAdapter,
  },
  {
    prefix: 'gpt-',
    adapter: new OpenAIAdapter({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  {
    prefix: 'o1-',
    adapter: new OpenAIAdapter({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  {
    prefix: 'o3-',
    adapter: new OpenAIAdapter({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
]);

const app = new Hono<{ Variables: AuthVariables }>();

// ============================================================
// Admin API: create org / user / issue Key / list Key / revoke Key
//   Protected by ADMIN_TOKEN; see src/admin/routes.ts.
// ============================================================
app.route('/admin', createAdminRouter());

// ============================================================
// Main path: /v1/chat/completions (inbound OpenAI protocol)
//   * New in this chapter: requireGatewayKey middleware *
//   Flow: auth -> validate IR -> route -> adapter translate -> upstream
//         -> adapter normalize -> response
// ============================================================
app.post('/v1/chat/completions', requireGatewayKey, async (c) => {
  const auth = c.get('auth');

  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  if (ir.stream) {
    return c.json(
      {
        error: {
          message: 'streaming is not supported in v0.4; will be added in Ch7',
        },
      },
      400,
    );
  }

  const adaptor = router.resolve(ir.model);
  if (!adaptor) {
    return c.json(
      {
        error: {
          message: `no provider matched for model: ${ir.model}`,
          available: router.describe(),
        },
      },
      400,
    );
  }

  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildRequest(ir);

  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    logger.error(
      {
        key_id: auth.keyId,
        user_id: auth.userId,
        provider: adaptor.name,
        model: ir.model,
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const rawBody = await upstreamResp.text();

  logger.info(
    {
      key_id: auth.keyId,
      user_id: auth.userId,
      org_id: auth.orgId,
      provider: adaptor.name,
      model: ir.model,
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay',
  );

  if (!upstreamResp.ok) {
    return new Response(rawBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  return c.json(irResponse, 200);
});

// ============================================================
// Side path: /v1/messages (Anthropic-native protocol passthrough)
//   Also requires auth — no bypass. Delivers on the Ch3 principle:
//   every publicly exposed endpoint shares the same auth layer.
// ============================================================
app.post('/v1/messages', requireGatewayKey, async (c) => {
  const auth = c.get('auth');
  const rawBody = await c.req.text();
  const baseURL = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(
    /\/+$/,
    '',
  );

  const clientVersion =
    c.req.header('anthropic-version') ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
  const clientBeta = c.req.header('anthropic-beta');

  const headers: Record<string, string> = {
    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
    'anthropic-version': clientVersion,
    'Content-Type': 'application/json',
  };
  if (clientBeta) headers['anthropic-beta'] = clientBeta;

  if (rawBody.includes('"stream":true') || rawBody.includes('"stream" : true')) {
    return c.json(
      {
        error: {
          message:
            '/v1/messages streaming passthrough is not implemented in v0.4, will be added in Ch7',
        },
      },
      400,
    );
  }

  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
  } catch (err) {
    logger.error(
      {
        key_id: auth.keyId,
        user_id: auth.userId,
        route: '/v1/messages',
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const respText = await upstreamResp.text();
  logger.info(
    {
      key_id: auth.keyId,
      user_id: auth.userId,
      org_id: auth.orgId,
      route: '/v1/messages',
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay_messages_passthrough',
  );

  return new Response(respText, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

// Health check (no auth — for external probes)
app.get('/healthz', (c) =>
  c.json({
    ok: true,
    version: 'v0.4',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)', '/admin/* (admin API)'],
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.4 listening on http://localhost:${port}`);
