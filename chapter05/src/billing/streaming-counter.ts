// Streaming Token Counter 
// 
// Use case: 
// During an SSE streaming response, the client may disconnect before the stream
// finishes. At that point, tokens that have already been sent must still be billed 
// because the upstream provider has already consumed the corresponding compute resources. 
// Tokens that have not been generated or sent should not be charged. 
// 
// Workflow: 
// 1. The SSE main loop calls ingestDelta() whenever it receives a delta containing a content text fragment. 
// 2. The counter uses tiktoken with the current model to estimate the token count and accumulates completion Tokens. 
// 3. If the upstream provider sends a usage event, call ingestUsage() to calibrate the local estimate with the actual usage reported by the provider; 
// 4. When the stream ends (including a client disconnect), call finalize() to obtain the accumulated (input, output) token counts and use them as the input for postConsume(). 

// Important: 
// When the client disconnects, the main loop must detect the abort signal and immediately 
// call finalize() + postConsume(). Otherwise, the reserved record for this request 
// will remain stuck in the "reserved" state and the user's balance will remain locked. 
// 
// This class is not needed in the current chapter because the system is still operating in a "non-streaming + streaming disabled" mode before CH7.
// However, the API is already stable, so Ch7 can import and integrate it directly. 
// 
// Comparision with one-api: 
// - one-api's Anthropic StreamHandler (relay/adapter/anthropic/main.go:287)
//   reads usage.input_tokens / output_tokens from each message_delta event 
//   and accumulates the values. It relies entirely on usage events from the upstream 
//   provider and does not provide a local fallback; 
// - This chapter's StreamingTokenCounter supports both upstream usage events and local tiktoken estimation. 
//   ingestDelta() uses local estimaiton first, and the counter is calibrated with the actual 
//   upstream usage when a usage event is received. 

import { estimateCompletionTokens } from './tokenizer.js';

export interface StreamingFinalize {
  // Actual prompt tokens reported by the upstream usage event ,
  // or the locally estimated value from the preConsume stage as a fallback
  promptTokens: number;

  // Accumulated completion tokens.
  // The upstream usage value takes priority; otherwise, use the locally accumulated estimate.
  completionTokens: number;

  // Whether the client disconnected before the stream completed.
  // If true, the main loop should immediately call postConsume().
  abortedByClient: boolean;
}

export class StreamingTokenCounter {
  private readonly model: string;

  // prompt token count estimated during preConsume, used as a fallback value
  private readonly fallbackPromptTokens: number;

  private upstreamPromptTokens: number | null = null;
  private upstreamCompletionTokens: number | null = null;

  // Locally accumulated completion text received from streaming deltas.
  private localCompletionText = '';

  // Locally estimated completion token count accumulated from each delta.
  // Each delta is encoded separately. The final full-text encoding can be used
  // as a more accurate local estimate if needed.
  private localCompletionTokens = 0;

  private aborted = false;

  constructor(model: string, fallbackPromptTokens: number) {
    this.model = model;
    this.fallbackPromptTokens = fallbackPromptTokens;
  }

  // Process a completion text delta received from the upstream (the literal content fragments from SSE choices[0].delta.content)
  // and accumulate the locally estimated completion token count.
  // Performance note:
  // Encoding each delta takes O(len(delta))
  // Accumulating the token count incrementally avoids re-encoding the entire
  // completion text after every delta.
  ingestDelta(deltaText: string): void {
    if (!deltaText) return;
    this.localCompletionText += deltaText;

    // Simplified approach: estimate each delta independently and accumulate the results.
    // In rare cases, this may differ from encoding the complete text by 1-2 tokens.
    // This level of error is acceptable for billing purposes because postConsume()
    // uses the upstream usage value to correct the local estimate when available.
    this.localCompletionTokens += estimateCompletionTokens(deltaText, this.model);
  }

  /**
   * Process a usage event sent by the upstream provider.
   * Example:
   *  - OpenAI: stream_options.include_usage
   *  - Anthropic: message_delta.usage
   *
   * Upstream usage values take priority over local estimates.
   */
  ingestUsage(usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
  }): void {
    if (typeof usage.prompt_tokens === 'number') {
      this.upstreamPromptTokens = usage.prompt_tokens;
    }

    if (typeof usage.completion_tokens === 'number') {
      this.upstreamCompletionTokens = usage.completion_tokens;
    }
  }

  /**
   * Mark the stream as aborted by the client.
   *
   * This method is idempotent and can be called multiple times safely.
   */
  markAborted(): void {
    this.aborted = true;
  }

  /**
   * Finalize the token count when the stream ends.
   *
   * This applies to both normal stream completion ([DONE])
   * and client-side disconnection.
   *
   * Returns the final prompt and completion token counts,
   * which are passed to postConsume() for final billing settlement.
   */
  finalize(): StreamingFinalize {
    const promptTokens = this.upstreamPromptTokens ?? this.fallbackPromptTokens;

    const completionTokens =
      // Prefer the upstream usage value because it is the most accurate.
      // Fall back to the locally accumulated estimate if the upstream stream
      // was interrupted before a usage event could be received.
      this.upstreamCompletionTokens ?? this.localCompletionTokens;

    return {
      promptTokens,
      completionTokens,
      abortedByClient: this.aborted,
    };
  }
}
