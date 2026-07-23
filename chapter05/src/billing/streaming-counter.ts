// Streaming token counter
//
// Scenario: during SSE streaming the client may disconnect mid-flight. Tokens
// already emitted must be billed (upstream already spent compute); unsent tokens
// must not.
//
// Mode of operation:
//   1. On each delta (content fragment), call ingestDelta();
//   2. Counter runs tiktoken for the current model and accumulates completionTokens;
//   3. If upstream sends a usage event, call ingestUsage() to calibrate;
//   4. On stream end (including client abort), call finalize() → (input, output)
//      tokens for postConsume.
//
// Critical: on client disconnect the main loop must catch abort and immediately
// finalize() + postConsume(), otherwise the reserved row stays reserved forever
// and the balance stays locked.
//
// Unused while streaming is disabled (pre-Ch7), but the API is stable for Ch7.
//
// vs one-api:
//   - one-api StreamHandler reads usage from upstream events only (no local fallback);
//   - StreamingTokenCounter supports both upstream usage events and local tiktoken.
//
// TODO(ch05 optional / ch07): implement StreamingTokenCounter.

export interface StreamingFinalize {
  /** Real prompt tokens from upstream usage (preferred) or preConsume local estimate */
  promptTokens: number;
  /** Accumulated completion tokens (upstream preferred, else local) */
  completionTokens: number;
  /** true → main loop should postConsume immediately */
  abortedByClient: boolean;
}

export class StreamingTokenCounter {
  constructor(
    private readonly _model: string,
    private readonly _fallbackPromptTokens: number,
  ) {}

  /** Accumulate a completion text delta (SSE choices[0].delta.content). */
  ingestDelta(_deltaText: string): void {
    throw new Error('TODO(ch05/ch07): implement StreamingTokenCounter.ingestDelta');
  }

  /** Upstream usage event (OpenAI stream_options.include_usage / Anthropic message_delta). */
  ingestUsage(_usage: { prompt_tokens?: number; completion_tokens?: number }): void {
    throw new Error('TODO(ch05/ch07): implement StreamingTokenCounter.ingestUsage');
  }

  /** Client cancelled mid-stream. Idempotent. */
  markAborted(): void {
    throw new Error('TODO(ch05/ch07): implement StreamingTokenCounter.markAborted');
  }

  finalize(): StreamingFinalize {
    throw new Error('TODO(ch05/ch07): implement StreamingTokenCounter.finalize');
  }
}
