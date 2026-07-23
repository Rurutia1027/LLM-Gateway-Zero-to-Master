// Two-phase billing core
//
// preConsume: reserve before the main flow
//   1. tiktoken → estimated prompt tokens;
//   2. request.max_tokens (or DEFAULT_MAX_TOKENS) as output upper bound;
//   3. current price + multipliers → reserved amount (micro-yuan);
//   4. optimistic lock: UPDATE users SET balance_micro -= cost WHERE balance_micro >= cost;
//      failure = insufficient balance → 402 to client;
//   5. INSERT usage_records (status=reserved).
//
// postConsume: settle after upstream returns
//   1. real usage (prompt_tokens / completion_tokens);
//   2. recompute final_cost with the same price + multiplier_snapshot from the reserved row;
//   3. delta = preReservedCost - finalCost
//        delta > 0: refund over-reserve (UPDATE balance += delta)
//        delta < 0: charge under-reserve (UPDATE balance -= |delta|; may go negative — policy)
//   4. UPDATE usage_records → status=finalized.
//
// refundReservation: upstream 5xx / network / auth failure → full refund, no charge
//   1. UPDATE users.balance += preReservedCost;
//   2. usage_records SET status=refunded, finalCost=0.
//
// Optimistic lock note:
//   SQLite UPDATE … WHERE balance >= cost + RETURNING atomically "check and debit".
//   Two concurrent requests cannot both overdraft. Prefer this over SELECT-then-UPDATE.
//
// vs one-api:
//   - one-api preConsumeQuota: debits user.Quota without a reserved placeholder row;
//     we write reserved rows for audit / dashboards;
//   - one-api postConsumeQuota quotaDelta = quota - preConsumed; our delta is the
//     inverse direction ("refund overcharge / charge undercharge") but equivalent.
//
// TODO(ch05): implement preConsume / postConsume / refundReservation / markFailed.

import type { IRMessage } from '../types/ir.js';

export interface PreConsumeInput {
  traceId: string;
  userId: number;
  orgId: number;
  keyId: number;
  model: string;
  provider: string;
  messages: IRMessage[];
  /** Client max_tokens; caller falls back to DEFAULT_MAX_TOKENS when omitted */
  maxOutputTokens: number;
  isStream: boolean;
}

export interface PreConsumeOutput {
  /** usage_records row id — locate it in postConsume */
  recordId: number;
  /** Reserved amount in micro-yuan */
  preReservedCost: number;
  /** Local estimated prompt tokens (already stored on the record) */
  estimatedPromptTokens: number;
}

export interface PostConsumeInput {
  recordId: number;
  promptTokens: number;
  completionTokens: number;
}

export interface PostConsumeOutput {
  finalCost: number;
  delta: number;
}

export class InsufficientBalanceError extends Error {
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`insufficient balance: need ${required} micro CNY, have ${available}`);
    this.name = 'InsufficientBalanceError';
  }
}

/** Re-export so index.ts can catch price misses without importing prices.ts */
export { PriceNotFoundError } from './prices.js';

/**
 * preConsume: placeholder row + reserve balance.
 * Order: debit balance first, then write record — balance is the single source of truth.
 */
export function preConsume(_input: PreConsumeInput): PreConsumeOutput {
  throw new Error('TODO(ch05): implement preConsume in billing/calculator.ts');
}

export function postConsume(_input: PostConsumeInput): PostConsumeOutput {
  throw new Error('TODO(ch05): implement postConsume in billing/calculator.ts');
}

export function refundReservation(_recordId: number, _errorMessage?: string): void {
  throw new Error('TODO(ch05): implement refundReservation in billing/calculator.ts');
}

export function markFailed(_recordId: number, _errorMessage: string): void {
  throw new Error('TODO(ch05): implement markFailed in billing/calculator.ts');
}
