import { Hono } from "hono";
import {serve} from '@hono/node-server'; 
import pino from 'pino'; 
import 'dotenv/config'; 

import { IRChatRequestSchema } from "./type/ir";
import { OpenAIAdapter } from './adapter/openai';
import { DeepSeekAdapter } from './adapter/deepseek';
import { ModelRouter } from './router'; 

const logger = pino({transport: {target: 'pino-pretty'}}); 

// loading route table, upstream configs are loaded from environment variables 
const router = new ModelRouter([
    {
        prefix: 'deepseek-', 
        adapter: new DeepSeekAdapter({
            baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', 
            apiKey: process.env.DEEPSEEK_API_KEY ?? '', 
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
        prefix: 'gpt-',
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
        })
    }, 
]); 

const app = new Hono(); 

app.post('/v1/chat/completions', async (c) => {
    // 1) passing parameter validation 
    const raw = await c.req.json().catch(() => null); 
    const parsed = IRChatRequestSchema.safeParse(raw); 
    if (!parsed.success) {
        return c.json({error: {message: 'invalid_request', detail: parsed.error.format()}}, 400); 
    }
    const ir = parsed.data; 

    // v0.2 does not support streaming for now, 
    if (ir.stream) {
        return c.json(
            {
                error: {message: 'streaming is not supported in v0.2, will be added in Ch7'}
            }, 
            400, 
        ); 
    }

    // 2) route based on model name 
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

    // 3) build request 
    const endpoint = adapter.getEndpoint(ir); 
    const {headers, body} = adapter.buildRequest(ir); 

    // 4) redirect normalized response
    const start = Date.now(); 
    let upstreamResp: Response; 
    try {
        upstreamResp = await fetch(endpoint, {method : 'POST', headers, body}); 
    } catch (err) {
        // network issue (DNS | TCP | TLS | Timeout), 
        logger.error({
            provider: adapter.name, model: ir.model, err: (err as Error).message}, 
            'upstream_network_error', 
        ); 
        return c.json({error: {message: 'upstream network error'}}, 502); 
    }

    const rawBody = await upstreamResp.text(); 

    // 5) struct log
    logger.info({
        provider: adapter.name, 
        model: ir.model, 
        status: upstreamResp.status, 
        latency_ms: Date.now() - start, 
    }, 'relay'); 


    // return 2xx then go through parseResponse normailization 
    // non 2xx directly passthrough to upper layer(client)
    if (!upstreamResp.ok) {
        return new Response(rawBody, {
            status: upstreamResp.status, 
            headers: {'Content-Type': 'application/json'}, 
        }); 
    }

    const irResponse = await adapter.parseResponse(upstreamResp, rawBody); 
    return c.json(irResponse, 200); 
}); 

// healthz 
app.get('/healthz', (c) => 
    c.json({ok: true, version: 'v0.2', routes: router.describe()})
); 

const port = Number(process.env.PORT ?? 3000); 
serve({fetch: app.fetch, port}); 

logger.info(`Gateway v0.2 listening on http://localhost:${port}`); 