import {Hono} from 'hono'; 
import {serve} from '@hono/node-server';
import {z} from 'zod'; 
import pino from 'pino'; 
import 'dotenv/config'; 

const logger = pino({transport: {target: 'pino-pretty'}}); 
const app = new Hono(); 

// message & model required, others are optional 
const ChatCompletionSchema = z.object({
    model: z.string().min(1), 
    messages: z
    .array(z.object({role: z.string(), content: z.any()}))
    .min(1), 
})
.passthrough(); 

app.post('/v1/chat/completions', async(c) => {
    const raw = await c.req.json().catch(() => null); 
    const parsed = ChatCompletionSchema.safeParse(raw); 
    if (!parsed.success) {
        return c.json({error: parsed.error.format()}, 400); 
    }

    const upstream = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com'; 
    const start = Date.now(); 
    const resp = await fetch(`${upstream}/v1/chat/completions`, {
        method: 'POST', 
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`, 
            'Content-Type': 'application/json', 
        }, 
        body: JSON.stringify(parsed.data), 
    }); 

    // logger 
    logger.info(
        {
            model: parsed.data.model, 
            status: resp.status, 
            latency_ms: Date.now() - start, 
        }, 
        'relay'
    ); 

    const body = await resp.text(); 
    return new Response(body, {
        status: resp.status, 
        headers: {'Content-Type': 'application/json'}, 
    }); 
}); 

// api health check 
app.get('/healthz', (c) => c.json({ok: true, version: 'v0.1'})); 
const port = Number(process.env.PORT ?? 3000); 
serve({fetch: app.fetch, port}); 
logger.info(`Gateway v0.1 listening on http://localhost:${port}`); 