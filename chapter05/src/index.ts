// Chapter 5 v0.5: two-phase billing + UsageRecord ledger
//
// Core changes vs v0.4:
//   1. prices / usage_records tables + users.balance_micro / user_multiplier
//      (see drizzle/0002_billing.sql + schema.ts);
//   2. /v1/chat/completions: preConsume → upstream → postConsume / refundReservation;
//   3. On startup, seedDefaultPricesIfEmpty() so cold start does not 400 on empty prices;
//   4. tiktoken estimate ↔ upstream usage dual ledger; StreamingTokenCounter API ready (Ch7).
//
// Intentionally left open (later chapters):
//   - No rate limits — one Key can burn upstream quota (Ch6)
//   - Streaming still off (Ch7); /v1/messages bypass has no billing yet (Ch7)
//   - Channel pool / failover (Ch8)
//   - Structured logs / dashboards (Ch9)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
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
import {
  preConsume,
  postConsume,
  refundReservation,
  markFailed,
  InsufficientBalanceError,
  PriceNotFoundError,
} from './billing/calculator.js';
import { seedDefaultPricesIfEmpty } from './billing/prices.js';
import { estimateCompletionTokens } from './billing/tokenizer.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// ============================================================
// Before serving: run migrations + seed default prices
// ============================================================
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  logger.info({ applied: migrationResult.applied }, 'db_migrations_applied');
}
const seedResult = seedDefaultPricesIfEmpty();
if (seedResult.inserted > 0) {
  logger.info({ inserted: seedResult.inserted }, 'default_prices_seeded');
}

const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS ?? 4096);

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
//   + balance / multiplier / prices / usage (v0.5)
// ============================================================
app.route('/admin', createAdminRouter());

// ============================================================
// Main path: /v1/chat/completions (inbound OpenAI protocol)
//   Flow: auth -> validate IR -> route
//         -> preConsume
//         -> adapter translate -> upstream
//         -> postConsume / refundReservation
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
          message: 'streaming is not supported in v0.5; will be added in Ch7',
        },
      },
      400,
    );
  }

  const adapter = router.resolve(ir.model);
  if (!adapter) {
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

  const traceId = randomBytes(16).toString('hex');
  const maxOutputTokens =
    typeof ir.max_tokens === 'number' && ir.max_tokens > 0 ? ir.max_tokens : DEFAULT_MAX_TOKENS;

  // ----- preConsume: reserve balance + write reserved row -----
  let reservation;
  try {
    reservation = preConsume({
      traceId,
      userId: auth.userId,
      orgId: auth.orgId,
      keyId: auth.keyId,
      model: ir.model,
      provider: adapter.name,
      messages: ir.messages,
      maxOutputTokens,
      isStream: false,
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      logger.warn(
        {
          trace_id: traceId,
          user_id: auth.userId,
          required: err.required,
          available: err.available,
        },
        'insufficient_balance',
      );
      return c.json(
        {
          error: {
            type: 'insufficient_quota',
            message: 'balance is not enough to cover the reservation',
            required_micro_cny: err.required,
            available_micro_cny: err.available,
          },
        },
        402,
      );
    }
    if (err instanceof PriceNotFoundError) {
      return c.json(
        {
          error: {
            type: 'price_not_configured',
            message: err.message,
          },
        },
        400,
      );
    }
    throw err;
  }

  logger.info(
    {
      trace_id: traceId,
      record_id: reservation.recordId,
      user_id: auth.userId,
      key_id: auth.keyId,
      model: ir.model,
      provider: adapter.name,
      est_prompt_tokens: reservation.estimatedPromptTokens,
      pre_reserved_micro_cny: reservation.preReservedCost,
    },
    'billing_pre_consumed',
  );

  const endpoint = adapter.getEndpoint(ir);
  const { headers, body } = adapter.buildRequest(ir);

  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    refundReservation(reservation.recordId, `network_error: ${(err as Error).message}`);
    logger.error(
      {
        trace_id: traceId,
        record_id: reservation.recordId,
        key_id: auth.keyId,
        user_id: auth.userId,
        provider: adapter.name,
        model: ir.model,
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const rawBody = await upstreamResp.text();
  const latencyMs = Date.now() - start;

  logger.info(
    {
      trace_id: traceId,
      record_id: reservation.recordId,
      key_id: auth.keyId,
      user_id: auth.userId,
      org_id: auth.orgId,
      provider: adapter.name,
      model: ir.model,
      status: upstreamResp.status,
      latency_ms: latencyMs,
    },
    'relay',
  );

  if (!upstreamResp.ok) {
    refundReservation(
      reservation.recordId,
      `upstream_${upstreamResp.status}: ${rawBody.slice(0, 200)}`,
    );
    logger.warn(
      {
        trace_id: traceId,
        record_id: reservation.recordId,
        provider: adapter.name,
        model: ir.model,
        status: upstreamResp.status,
        latency_ms: latencyMs,
      },
      'upstream_error_refunded',
    );
    return new Response(rawBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ----- postConsume: settle with real usage -----
  const irResponse = await adapter.parseResponse(upstreamResp, rawBody);
  const usage = irResponse.usage;
  if (!usage) {
    const fallbackCompletionText =
      typeof irResponse.choices?.[0]?.message?.content === 'string'
        ? (irResponse.choices[0].message.content as string)
        : '';
    try {
      const settle = postConsume({
        recordId: reservation.recordId,
        userId: auth.userId,
        model: ir.model,
        provider: adapter.name,
        realPromptTokens: reservation.estimatedPromptTokens,
        realCompletionTokens: estimateCompletionTokens(fallbackCompletionText, ir.model),
      });
      logger.warn(
        { trace_id: traceId, record_id: reservation.recordId, settle },
        'billing_settled_no_upstream_usage',
      );
    } catch (err) {
      markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
    }
  } else {
    try {
      const settle = postConsume({
        recordId: reservation.recordId,
        userId: auth.userId,
        model: ir.model,
        provider: adapter.name,
        realPromptTokens: usage.prompt_tokens,
        realCompletionTokens: usage.completion_tokens,
      });
      logger.info(
        {
          trace_id: traceId,
          record_id: reservation.recordId,
          provider: adapter.name,
          model: ir.model,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          est_prompt_tokens: reservation.estimatedPromptTokens,
          token_diff: usage.prompt_tokens - reservation.estimatedPromptTokens,
          final_cost_micro_cny: settle.finalCost,
          balance_delta_micro_cny: settle.balanceDelta,
          latency_ms: latencyMs,
        },
        'billing_settled',
      );
    } catch (err) {
      markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
    }
  }

  return c.json(irResponse, 200);
});

// ============================================================
// Side path: /v1/messages (Anthropic-native protocol passthrough)
//   Also requires auth — no bypass. Delivers on the Ch3 principle:
//   every publicly exposed endpoint shares the same auth layer.
//   Billing for this path lands in Ch7 with streaming.
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
            '/v1/messages streaming passthrough is not implemented in v0.5; billing+stream in Ch7',
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
    version: 'v0.5',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)', '/admin/* (admin API)'],
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.5 listening on http://localhost:${port}`);
