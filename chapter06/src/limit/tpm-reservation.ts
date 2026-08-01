import { inspect } from "util";
import type {LimitKey, TpmReserveResult} from "./types.js"; 

const DEFAULT_WINDOWS_MS = 60_000; 

interface Bucket {
    windowStartMs: number; 
    tokenCount: number; 
}

export class TpmReservationLimiter {
    private readonly store = new Map<LimitKey, Bucket>(); 
    private readonly windowMs: number; 

    constructor(windowMs: number = DEFAULT_WINDOWS_MS) {
        this.windowMs = windowMs; 
    }

    // reserve tokens for a key , if limit = 0 ignore 
    reserve(key: LimitKey, tokens: number, limit: number): TpmReserveResult {
        if (limit <= 0) {
            // no limit 
            return {
                ok: true, 
                retryAfterMs: 0, 
                currentTokens: 0, 
                limit: 0, 
                reservedTokens: tokens}; 
        }

        const now = Date.now(); 
        let bucket = this.store.get(key); 
        if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
            // bucket start ms is expired or bucket doesn't exist --> create a new bucket 
            bucket = {windowStartMs: now, tokenCount: 0}; 
            this.store.set(key, bucket); 
        }

        if (bucket.tokenCount + tokens > limit) {
            // in this time window, 
            // current bucket's token exceeded , refuse to reserve any more tokens 
            const retryAfterMs = Math.max(1, bucket.windowStartMs + this.windowMs - now); 
            return { 
                ok: false, 
                retryAfterMs, 
                currentTokens: bucket.tokenCount, 
                limit, 
                reservedTokens: 0
            }; 
        }

        bucket.tokenCount += tokens; 
        return {
            ok: true, 
            retryAfterMs: 0,  
            currentTokens: bucket.tokenCount, 
            limit, 
            reservedTokens: tokens, 
        }; 
    }

    
   commit(key: LimitKey, reservedTokens: number, actualTokens: number): void {
    const delta = actualTokens - reservedTokens; 
    if (delta === 0) return; 

    const bucket = this.store.get(key); 
    const now = Date.now(); 

    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
        // bucket is already expired, or doesn't exist --> create a new bucket  
        if (actualTokens > 0) {
            this.store.set(key, {windowStartMs: now, tokenCount: actualTokens}); 
        }
        return 
    }

    bucket.tokenCount = Math.max(0, bucket.tokenCount + delta); 
   }

    // release all reserved tokens(upstream invoke failed)
    // this operation = commit(key, reserved, 0)
    release(key: LimitKey, reservedTokens: number): void {
        this.commit(key, reservedTokens, 0); 
    }

    inspectTokens(key: LimitKey): number {
        const bucket = this.store.get(key); 
        if (!bucket) return 0; 
        const now = Date.now(); 
        if (now - bucket.windowStartMs >= this.windowMs) {
            // bucket start ms is expired , reset the bucket  
            return 0; 
        }
        return bucket.tokenCount; 
    }



    reset(): void {
        this.store.clear(); 
    }
}