// QPS sliding window (in-memory)
// Algorithm:
// 
// - One timestamp deque per key 
// - On check, shift out timestamps older than (now - windowMs); 
// - If queue length < limit, allow and push the current timestamp; 
// - If queue length >= limit, reject and return retryAfterMs; 
//      i.e. wait until the oldest entry leaves the window for a free slot. 

// vs fixed window (reset every second): at a window boundary a fixed window can allow 
// up to 2x limit (limit at the end of the previous window + limit at the start of the next).
// A sliding window avoids that edge effect: any rolling 1s window has request count <= limit. 

// Performance: queue length per key is capped at limit (rejects when full); shift/push are O(1) 
// (Array.shift is < 1us under V8 for this use). Fine for teaching (limit < 1000). 


// Memory clean up: a periodic GC every minute scans the store and deletes keys whose last 
// timestamp expired more than 60s ago, so long-idle keys to not hold memory forever. 
// Skipping GC does not leak forever either - cold keys are freeded on process restart. 

// Reference: one-api/common/rate-limit.go::InMemoryRateLimiter (Go sliding window).


import type { LimitKey, QpsCheckResult } from "./types.js";

// default window len = 1s.  
const DEFAULT_WINDOWS_MS = 1000; 

// GC clean task interval 60s 
const GC_INTERVAL_MS = 60_000;  

// key will be deleted when it has not been updated for 60s 
const GC_IDLE_MS = 60_000;   


export class SlidingWindowQpsLimiter {
    private readonly store = new Map<LimitKey, number[]>(); 
    private readonly windowMs: number; 
    private gcTimer: NodeJS.Timeout | null = null;  

    constructor(windowMs: number = DEFAULT_WINDOWS_MS) {
        this.windowMs = windowMs;  
    }

    check(key: LimitKey, limit: number): QpsCheckResult {
        if (limit <= 0) {
            // no limit 
            return {ok: true, retryAfterMs: 0, currentCount: 0, limit:0}; 
        }

        const now = Date.now(); 
        const cutoff = now - this.windowMs; 

        let queue = this.store.get(key); 
        if (!queue) {
            queue = []; 
            this.store.set(key, queue); 
        }

        // here we shift items from the current key's queue 
        // if the item#timestamp is already expired 
        while (queue.length > 0 && queue[0]! <= cutoff) {
            queue.shift(); 
        }

        const currentCount = queue.length; 
        if (currentCount >= limit) {
            // refuse
            const retryAfterMs = Math.max(1, queue[0]! + this.windowMs - now)
            return {ok: false, retryAfterMs, currentCount, limit}; 
        }

        queue.push(now); 
        return {ok: true, retryAfterMs: 0, currentCount: currentCount + 1, limit}; 
    }

    inspectCount(key: LimitKey): number {
        const queue = this.store.get(key);
        if (!queue) return 0;
        const cutoff = Date.now() - this.windowMs;
        while (queue.length > 0 && queue[0]! <= cutoff) queue.shift();
        return queue.length;
    }

    startGC(): void {
        if (this.gcTimer) return; 
        this.gcTimer = setInterval(() =>  
           this.gcOnce(), GC_INTERVAL_MS);
        this.gcTimer.unref();  
    }

    stopGc(): void {
        if (this.gcTimer) {
          clearInterval(this.gcTimer);
          this.gcTimer = null;
        }
    }

    private gcOnce(): void {
        const idleCutoff = Date.now() - GC_IDLE_MS; 
        for (const [key, queue] of this.store.entries()) {
            const last = queue[queue.length - 1]; 
            if (last === undefined || last < idleCutoff) {
                this.store.delete(key); 
            }
        }
    }

    reset(): void {
        this.store.clear();
    }
}
