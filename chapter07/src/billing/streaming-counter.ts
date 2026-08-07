// Streaming token counter
//
// Context: during an SSE stream the client may disconnect mid-flight. Tokens already
// sent must still be billed (the upstream already spent the compute); unsent tokens do not.
//
// How it works:
//   1. On each SSE delta (with a content text fragment), the main loop calls ingestDelta();
//   2. Internally the counter runs tiktoken for the current model and accumulates completionTokens;
//   3. If the upstream emits a usage event, call ingestUsage() to calibrate with real values;
//   4. When the stream ends (including client abort), call finalize() to get accumulated
//      (input, output) tokens — those feed postConsume.
//
// Important: on client disconnect the main loop must catch the abort signal and immediately
// call finalize() + postConsume(); otherwise the reserved usage_records row stays reserved
// forever and the balance stays held down.
// This class is unused in the pre-Ch7 "non-streaming + streaming disabled" path, but the API
// is stable — Ch7 imports and wires it in directly.
//
// vs one-api:
//   - one-api's anthropic StreamHandler (relay/adaptor/anthropic/main.go:287) reads
//     usage.input_tokens / output_tokens on each message_delta and accumulates; it relies on
//     upstream events with no local fallback;
//   - this chapter's StreamingTokenCounter supports both upstream usage events and local
//     tiktoken estimates: ingestDelta estimates locally first; ingestUsage calibrates when
//     the upstream sends a usage event.
//

import { estimateCompletionTokens } from './tokenizer.js';

export interface StreamingFinalize {
    // real prompt tokens fetch from upstream response usage body 
    promptTokens: number; 

    // accumulated completion tokens (fetch from usage first, if cannot fetch from usage response body, then calculate & accmuluate locally)
    completionTokens: number;  

    // true if client aborted the request (via stream.close() or timeout) 
    abortedByClient: boolean; 
}

export class StreamingTokenCounter {
    private readonly model: string; 
    private readonly fallbackPromptTokens: number; 
    private upstreamPromptTokens: number | null = null; 
    private upstreamCompletionTokens: number | null = null; 
    private localCompletionText = ''; 
    private localCompletionTokens = 0; 
    private aborted = false; 

    constructor(model: string, fallbackPromptTokens: number) {
        this.model = model; 
        this.fallbackPromptTokens = fallbackPromptTokens; 
    }

    /**
     * Ingest a completion text delta (the literal from SSE choices[0].delta.content). 
     * Accumulates a local estimate. 
     * 
     * Perf note: encoding each delta is 0(len(delta)); accumulating avoids re-encoding the full text every time. 
    */
    ingestDelta(deltaText: string): void {
        if (!deltaText) return; 
        this.localCompletionText += deltaText; 
        // try to avoid re-encoding the full text every time, accumulate locally  
        this.localCompletionTokens += estimateCompletionTokens(deltaText, this.model); 
    }

    // real token usage {both prompt & completion} can be fetched from upstream delivered events
    // directly use that value to calibrate the local estimate  
    ingestUsage(usage: {prompt_tokens?: number; completion_tokens?: number}): void {
        if (typeof usage.prompt_tokens === 'number') {
            this.upstreamPromptTokens = usage.prompt_tokens;
        }

        if (typeof usage.completion_tokens === 'number') {
            this.upstreamCompletionTokens = usage.completion_tokens;
        }
    }

    markAborted(): void {
        this.aborted = true;
    }

    finalize(): StreamingFinalize {

        // we first fetch upstream delivered event parsed token usage value (more accurate)
        // if cannot fetch from upstream, then use the fallback value(based on local accumulated completion text + model + tiktoken lib)
        const promptTokens = this.upstreamPromptTokens ?? this.fallbackPromptTokens;  
        const completionTokens = this.upstreamCompletionTokens ?? this.localCompletionTokens;  

        return {
            promptTokens, 
            completionTokens, 
            abortedByClient: this.aborted, 
        }; 
    }
}