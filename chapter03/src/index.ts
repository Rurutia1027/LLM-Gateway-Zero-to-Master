import { Hono } from "hono";
import {serve} from '@hono/node-server'; 
import pino from 'pino'; 
import 'dotenv/config'; 

import {IRChatRequestSchema} from './types/ir.js'; 
import {OpenAIAdapter} from './adaptors/openai.js'; 
import {DeepSeekAdapter} from './adaptors/deepseek.js'; 
import {AnthropicAdapter} from './adaptors/anthropic.js';  
import {ModelRouter} from './router.js';

const logger = pino({transport: {target: 'pino-pretty'}}); 

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
  

const app = new Hono();



// main entry point 
app.post('/v1/chat/completions', async (c) => {
    const raw = await c.req.json().catch(() => null); 
    const parsed = IRChatRequestSchema.safeParse(raw);  

    if (!parsed.success) {
        return c.json({error: {message: 'invalid_request', detail: parsed.error.format()}}, 400); 
    }

    const ir = parsed.data; 

    if (ir.stream) {
        return c.json(
          {
            error: {
              message:
                'streaming is not supported in v0.3; the event normalizer is ready in streaming/anthropic-events.ts and will be wired into SSE main loop in Ch7',
            },
          },
          400,
        );
      }

      const adapter = router.resolve(ir.model); 
      if (!adapter) {
        return c.json({
            error: {
                message: `no provider matched for model: ${ir.model}`, 
                available: router.describe(), 
            }, 
        }, 400); 
      }
      const endpoint = adapter.getEndpoint(ir);  
      const { headers, body } = adapter.buildRequest(ir);

      const start = Date.now(); 
      let upstreamResp: Response; 
      try {
        upstreamResp = await fetch(endpoint, {method: 'POST', headers, body}); 
      } catch (err) {
        logger.error(
            {provider: adapter.name, model: ir.model, error: (err as Error).message, }, 
            'upstream_network_error', 
        ); 
        return c.json({error: {message: 'upstream network error'}}, 502); 
      }

      const rawBody = await upstreamResp.text(); 

      logger.info(
        {
            provider: adapter.name,
            model: ir.model,
            status: upstreamResp.status,
            latency_ms: Date.now() - start,
        },
        'relay',
      ); 

      if (!upstreamResp.ok) {
        return new Response(rawBody, {status: upstreamResp.status, 
            headers: {'Content-Type': 'application/json'}, 
        }); 
      }

      const irResponse = await adapter.parseResponse(upstreamResp, rawBody); 
      return c.json(irResponse, 200); 
}); 



// entry point for anthropic messages
app.post('/v1/messages', async (c) => {
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
        { route: '/v1/messages', err: (err as Error).message },
        'upstream_network_error',
      );
      return c.json({ error: { message: 'upstream network error' } }, 502);
    }
  
    if (rawBody.includes('"stream":true') || rawBody.includes('"stream" : true')) {
      return c.json(
        {
          error: {
            message:
              '/v1/messages streaming passthrough is not implemented in v0.3, will be added in Ch7',
          },
        },
        400,
      );
    }
  
    const respText = await upstreamResp.text();
    logger.info(
      {
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


// health check 
app.get('/healthz', (c) =>
    c.json({
      ok: true,
      version: 'v0.3',
      routes: router.describe(),
      extra_endpoints: ['/v1/messages (Anthropic passthrough)'],
    }),
  );
  
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  logger.info(`Gateway v0.3 listening on http://localhost:${port}`);