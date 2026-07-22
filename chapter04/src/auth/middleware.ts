import type {Context, MiddlewareHandler} from 'hono'; 
import {eq} from 'drizzle-orm'; 

import {getDb} from '../db/client.js'; 
import {keys, orgs, users} from '../db/schema.js'; 
import {hashKey, isWellFormedKey} from './key.js'; 

export interface AuthContext {
    keyId: number; 
    userId: number; 
    orgId: number; 
    scopes: string[]; 
}

export type AuthVariables = {auth: AuthContext}; 

export const requireGatewayKey: MiddlewareHandler<{
    Variables: AuthVariables; 
}> = async (c, next) => {
    const plaintext = extractBearerToken(c); 
    if (!plaintext) {
        return c.json({error: {message: 'missing or malformed Authorization header'}}, 401); 
    }

    if (!isWellFormedKey(plaintext)) {
        return c.json({
            error: {message: 'key format invalid; expected prefix sk-gw-'}
        }, 401); 
    }

    const keyHash = hashKey(plaintext); 
    const db = getDb(); 

    const rows = db
        .select({
            keyId: keys.id, 
            keyDisabledAt: keys.disabledAt, 
            keyExpiresAt: keys.expiresAt, 
            scopes: keys.scopes, 
            userId: users.id, 
            userDisabledAt: users.disabledAt, 
            orgId: orgs.id, 
            orgDisabledAt: orgs.disabledAt, 
        })
        .from(keys)
        .innerJoin(users, eq(users.id, keys.userId))
        .innerJoin(orgs, eq(orgs.id, users.orgId))
        .where(eq(keys.keyHash, keyHash))
        .all(); 

    if (rows.length === 0) {
        return c.json({error: {message: 'invalid key'}}, 401); 
    }
    const row = rows[0]!; 
    const now = Date.now(); 

    // key, user, org disabled or key is revoked
    // will all result in authorization failure 
    if (row.keyDisabledAt !== null) {
        return c.json({ error: { message: 'key has been revoked' } }, 401);
    }
    if (row.keyExpiresAt !== null && row.keyExpiresAt <= now) {
        return c.json({ error: { message: 'key has expired' } }, 401);
    }
    if (row.userDisabledAt !== null) {
        return c.json({ error: { message: 'user is disabled' } }, 403);
    }
    if (row.orgDisabledAt !== null) {
        return c.json({ error: { message: 'org is disabled' } }, 403);
    }

    setImmediate(() => {
        try {
            db.update(keys).set({lastUsedAt: now}).where(eq(keys.id, row.keyId)).run();
        } catch {
            // ignore 
        }
    }); 

    const auth: AuthContext =  {
        keyId: row.keyId, 
        userId: row.userId, 
        orgId: row.orgId, 
        scopes: parseScopes(row.scopes), 
    }; 
    c.set('auth', auth); 
    await next(); 
}; 

export function requireAdminToken(): MiddlewareHandler {
    return async (c, next) => {
        const required = process.env.ADMIN_TOKEN ?? ''; 
        if (!required) {
            return c.json({
                error: {message: 'ADMIN_TOKEN env var is not configured on server'}
            }, 500); 
        }
        const provided = extractBearerToken(c); 
        if (!provided) {
            return c.json({error: {message: 'missing Authorization header'}}, 401); 
        }

        const {constantTimeEqual} = await import('./key.js'); 
        if (!constantTimeEqual(provided, required)) {
            return c.json({error: {message: 'invalid admin token'}}, 401); 
        }
        await next(); 
    }; 
}

function extractBearerToken(c: Context): string | null {
    const auth = c.req.header('Authorization'); 
    if (!auth) return null; 
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? m[1]!.trim() : null;
}

function parseScopes(scopes: string | null): string[] {
    if (!scopes) return []; 
    return scopes.split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0); 
}