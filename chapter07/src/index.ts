import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import 'dotenv/config';

const logger = pino({transport: {target: 'pino-pretty'}}); 


// Before serving: run migrations + seed default prices

const app = new Hono();

// -- critical pathes -- 
app.post('/v1/chat/completions', async (c) => {}); 

app.post('/v1/messages', async (c) => {}); 

app.get('/healthz', (c) => {
    return c.json({status: 'ok'});
}); 


const port = Number(process.env.PORT ?? 3000); 
serve({fetch: app.fetch, port});
logger.info(`Gateway v0.7 listening `);  