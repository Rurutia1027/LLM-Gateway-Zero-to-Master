// RateLimiter Interface
//
// Purpose:
// Separate the "rate-limiting policy" from its "storage / algorithm implementation"
// and define three interface contracts:
//
//   1. checkQps
//      Check the QPS limit.
//      If the request is rejected, return retryAfterMs.
//
//   2. reserveTpm
//      Reserve TPM capacity (token budget) in advance,
//      similar to preConsume() in Ch5.
//
//   3. releaseTpm
//      Release the reserved TPM capacity when the upstream request fails.
//
//   4. commitTpm
//      Finalize TPM usage using the actual token usage,
//      replacing the reserved amount with the actual usage.
//      If the reserved amount was higher than the actual usage,
//      release the difference.
//
// Why does TPM use "reserve + commit" instead of deducting everything
// after the request completes?
//
//   - A single request may consume thousands of tokens.
//     Before the response arrives, the gateway does not know the exact
//     number of tokens that will actually be consumed.
//
//   - The gateway must reserve the maximum possible token budget based on
//     max_tokens before forwarding the request.
//     Otherwise, when a Key is close to its TPM quota limit, multiple
//     requests could temporarily exceed the TPM quota before their actual
//     usage is known, allowing the upstream requests to continue.
//     This creates a race condition.
//
//   - This follows the same two-phase approach used by Ch5 billing:
//     reserve first, then finalize with the actual usage.
//
//   - Once postConsume() obtains the actual usage, releaseTpm() is used
//     to return any excess reserved capacity:
//     releaseTpm(reserved - actual).
//
// The default implementation uses in-memory storage with:
//   - a sliding window for QPS;
//   - a rolling 60-second TPM bucket.
//
// The interface is designed so that the implementation can later be replaced
// with a Redis adapter.
//
// The key difference in a Redis implementation is that both the sliding window
// and the TPM bucket would be implemented using Redis ZSETs + atomic Lua scripts.
//
// This chapter does not implement the Redis version.
// The README only documents the extension points for replacing the
// in-memory implementation with Redis.
//
// Comparison with Portkey:
//
//   - portkey-gateway/src/shared/services/cache/utils/rateLimiter.ts
//     uses Redis + Lua scripts to implement a "token bucket" algorithm.
//     It stores two values: tokens / lastRefill.
//     A single EVALSHA call atomically performs both check and consume.
//
//   - The in-memory implementation in this book is simplified into:
//       "sliding-window deque + TPM cumulative counter".
//
//     This is sufficient for a single-node educational environment,
//     while keeping the interface contract flexible enough to allow
//     the Redis implementation to be swapped in later without changing
//     the calling code.
//
// Comparison with one-api:
//
//   - one-api/common/rate-limit.go::InMemoryRateLimiter implements a
//     sliding-window algorithm based on a fixed-length queue and comparing
//     the timestamps at the head and tail.
//
//     This serves as the algorithmic reference for the sliding-window
//     implementation used in this book.
//
//   - However, one-api only handles the QPS dimension.
//     TPM is not implemented as a separate rate-limiting dimension,
//     because its equivalent functionality is handled by the two-phase
//     billing mechanism introduced in Ch5 rather than being extracted
//     into a standalone TPM limiter.

export type LimitKey = string; 

// QPS 
export interface QpsCheckResult {
    ok: boolean; 

    retryAfterMs: number; 

    currentCount: number; 

    limit: number; 
}

// TPM 
export interface TpmReserveResult {
    ok: boolean; 
    retryAfterMs: number; 

    currentTokens: number; 

    limit: number; 

    reservedTokens: number; 
}

export interface RateLimiter {
    checkQps(key: LimitKey, limit: number): QpsCheckResult; 
    
    reserveTpm(key: LimitKey, tokens: number, limit: number) : TpmReserveResult; 

    commitTpm(key: LimitKey, reservedTokens: number, actualToken: number): void; 

    releaseTpm(key: LimitKey, reservedTokens: number): void; 

    inspect(key: LimitKey): {
            qpsCount: number; 
            tpmTokens: number; 
    } | null; 
}