// Local token estimation
//
// Use js-tiktoken offline to count input tokens. Why local estimation:
//   1. preConsume runs before the upstream call — no upstream usage yet.
//      Local prompt-token estimate is required to reserve balance and reject
//      insufficient-balance requests;
//   2. Upstream may omit usage (OpenAI streaming without stream_options.include_usage;
//      some OpenAI-compatible providers never return usage). Local estimate is
//      the last fallback;
//   3. Dual ledger: store local estimate and upstream usage in separate columns
//      so monthly audits can catch inflated upstream token reports.
//
// Why js-tiktoken instead of tiktoken (Rust binding):
//   - tiktoken needs napi-rs native bindings (not Cloudflare Workers friendly);
//   - js-tiktoken is pure JS — npm install and go; fast enough (<1ms / message);
//   - Accuracy is fine for billing; local vs upstream usually differs ~1–3%,
//     absorbed by multipliers.
//
// About Anthropic / Claude:
//   - Claude has no public BPE tokenizer for exact local counts;
//   - Industry practice: estimate with cl100k_base + a fudge factor (~1.0–1.2x);
//   - This chapter estimates with cl100k directly; postConsume corrects with real usage.
//
// TODO(ch05): implement estimatePromptTokens / estimateCompletionTokens
//   (see OpenAI cookbook num_tokens_from_messages for the message overhead formula).

import type { IRMessage } from '../types/ir.js';

/** Estimate prompt tokens for a chat message list under the given model. */
export function estimatePromptTokens(_messages: IRMessage[], _model: string): number {
  throw new Error('TODO(ch05): implement estimatePromptTokens in billing/tokenizer.ts');
}

/** Estimate completion tokens for a text fragment (streaming / fallback). */
export function estimateCompletionTokens(_text: string, _model: string): number {
  throw new Error('TODO(ch05): implement estimateCompletionTokens in billing/tokenizer.ts');
}
