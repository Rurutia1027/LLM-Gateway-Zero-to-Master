import type { Context, MiddlewareHandler } from "hono"; 
import {and, eq }  from 'drizzle-orm'; 
import { getDb } from "../db/client.js"; 
import { keys, orgs, users } from "../db/schema.js";  
import { hashKey, isWellFormedKey } from "./key.js";  
import { ca } from "zod/v4/locales";
import { raw } from "hono/html";

export interface AuthContext {
    keyId: number; 
    userId: number; 
    orgId: number; 
    scopes: string[]; 
}

export type AuthVariables = {
    auth: AuthContext; 
}; 

export const requireGatewayKey: MiddlewareHandler<{
    Variables: AuthVariables
}> = async (c, next) => {
    const plaintext = extractBearerToken(c); 
    if (!plaintext) {
        return c.json({error: {message: 'missing or malformed Authorization header'}}, 401);         
    }

    if (!isWellFormedKey(plaintext)) {
        return c.json({
            error: {message: 'key format invalid; expected prefix sk-gw-'}}, 401); 
    }

    const keyHash = hashKey(plaintext); 
    const db = getDb(); 

    // fetch key + user + org, via join sql query 
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
    // keyHash is the key value we extracted and parsed from request header cache  
    .where(eq(keys.keyHash, keyHash))
    .all(); 

    // no db records can be find --> authentication failure 
    if (rows.length === 0) {
        return c.json({error: {message: 'invalid key'}}, 401); 
    }

    // parsed value from queried result , continue validate queried db recods 
    const row = rows[0]; 
    const now = Date.now(); 

    // disabeld at not null means this key has been set disabled before 
    if (row.keyDisabledAt !== null) {
        return c.json({error: {message: 'key has been revoked'}}, 401); 
    }

    // checkout whether key has been expired 
    if (row.keyExpiresAt !== null && row.keyExpiresAt < now) {
        return c.json({error: {message: 'key has been expired'}}, 401); 
    }

    // user has been disabled  
    if (row.userDisabledAt !== null) {
        return c.json({ error: { message: 'user is disabled' } }, 403);
    }

    // org has been disabled   
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

    const auth: AuthContext = {
        keyId: row.keyId, 
        userId: row.userId, 
        orgId: row.orgId, 
        scopes: parseScopes(row.scopes), 
    }; 

    c.set('auth', auth); 
    await next(); 
}

function parseScopes(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
}

function extractBearerToken(c: Context): string | null {
    const auth = c.req.header('Authorization');
    if (!auth) return null;
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? m[1]!.trim() : null;
}
  
 
export function requireAdminToken(): MiddlewareHandler {
    return async (c, next) => {
        // in our current project admin token is loaed from local .env file 
        const required = process.env.ADMIN_TOKEN ?? ''; 
        if (!required) {
            return c.json(
              { error: { message: 'ADMIN_TOKEN env var is not configured on server' } },
              500,
            );
        }

        const provided = extractBearerToken(c); 
        // provided empty means request header cannnot extract bearer token 
        if (!provided) {
            return c.json({error: {message: 'missing Authorization header'}}, 401); 
        } 

        const {constantTimeEqual} = await import('./key.js'); 

        // here we checkout whether header bearer token is equal to the admin token (loaded from .env file)
        if (!constantTimeEqual(provided, required)) {
            return c.json({error: {message: 'invalid admin token received from header'}}, 401); 
        }

        // if toke match go to next middleware  
        await next(); 
    }; 
}