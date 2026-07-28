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



    reset(): void {
        this.store.clear(); 
    }
}