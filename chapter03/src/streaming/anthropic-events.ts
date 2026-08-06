// Anthropic streaming event normalizer
//
// Anthropic Messages API streaming has 6 event types:
//   1. message_start          - message begins; carries id / model / initial usage.input_tokens
//   2. content_block_start    - a content block starts (text / tool_use / thinking)
//   3. content_block_delta    - content block delta (text_delta / input_json_delta / thinking_delta)
//   4. content_block_stop     - content block ends
//   5. message_delta          - message-level delta; carries stop_reason and final output_tokens
//   6. message_stop           - message ends
//
// OpenAI streaming has a single event shape
// (data: {choices:[{delta:{...}}]}\n\n + data: [DONE]\n\n).
//
// This normalizer collapses the 6 Anthropic events into a sequence of OpenAI chunks:
//   message_start         -> {delta:{role:'assistant',content:''}}
//   content_block_start   -> for tool_use, emit a delta with tool_calls[].id / function.name;
//                            for text, emit nothing yet (wait for content_block_delta)
//   content_block_delta   - text_delta       -> {delta:{content:'...'}}
//                         - input_json_delta -> {delta:{tool_calls:[{function:{arguments:'...'}}]}}
//                         - thinking_delta   -> {delta:{reasoning_content:'...'}} (passthrough field)
//   content_block_stop    -> no standalone chunk
//   message_delta         -> {delta:{},finish_reason:'...',usage:{...}}
//   message_stop          -> '[DONE]'
//
// This logic is wired into the SSE main loop in Ch7. This chapter implements it first
// so non-streaming entry points can also use it (e.g. mock tests in this chapter).
//
// References:
//   - one-api: relay/adaptor/anthropic/main.go StreamResponseClaude2OpenAI (lines 149-208)
//   - Portkey v1.15.2: src/providers/anthropic/chatComplete.ts
//     getAnthropicStreamChunkTransform (from line 636, includes streamState state machine)
//   - LiteLLM: litellm/llms/anthropic/chat/handler.py ModelResponseIterator.chunk_parser (from line 775)

import { stopReasonToFinishReason } from '../adaptors/anthropic.js';

// ---------- Anthropic streaming event types ----------

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent;

interface AnthropicMessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    role: 'assistant';
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };
}

interface AnthropicContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'thinking'; thinking: string };
}

interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string };
}

interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

interface AnthropicMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

interface AnthropicMessageStopEvent {
  type: 'message_stop';
}

interface AnthropicPingEvent {
  type: 'ping';
}

interface AnthropicErrorEvent {
  type: 'error';
  error: { type: string; message: string };
}

// ---------- OpenAI streaming chunk ----------

export interface OpenAIDeltaChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
      // Passthrough reasoning_content (DeepSeek-compatible; Anthropic thinking uses this path)
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------- Normalizer: state machine ----------

/**
 * The normalizer must keep state across events, so it is a class rather than a pure function:
 *   - id / model / created / promptTokens: captured at message_start, reused by later chunks
 *   - blockTypes[index]: whether each content block is text / tool_use / thinking, so
 *                        content_block_delta can dispatch to the right OpenAI field
 *   - toolIndexByBlock[index]: index of this tool_use in OpenAI tool_calls (increments by appearance)
 *
 * Each push of an Anthropic event yields 0..N OpenAI chunks plus an optional [DONE] flag.
 */
export interface NormalizedOutput {
  chunks: OpenAIDeltaChunk[];
  /** true means the stream is finished; caller should emit data: [DONE]\n\n and close */
  done: boolean;
}

export class AnthropicEventNormalizer {
  private id = '';
  private model = '';
  private created = Math.floor(Date.now() / 1000);
  private promptTokens = 0;
  private blockTypes = new Map<number, 'text' | 'tool_use' | 'thinking'>();
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;

  /** Handle a single Anthropic event; return 0..N OpenAI chunks */
  push(event: AnthropicStreamEvent): NormalizedOutput {
    switch (event.type) {
      case 'ping':
        return { chunks: [], done: false };

      case 'message_start':
        this.id = event.message.id;
        this.model = event.message.model;
        this.created = Math.floor(Date.now() / 1000);
        this.promptTokens = event.message.usage.input_tokens ?? 0;
        // First chunk: role:'assistant' + empty content, matching OpenAI's first chunk
        return {
          chunks: [this.makeChunk({ delta: { role: 'assistant', content: '' }, finish_reason: null })],
          done: false,
        };

      case 'content_block_start': {
        const block = event.content_block;
        this.blockTypes.set(event.index, block.type);
        if (block.type === 'tool_use') {
          const toolIdx = this.nextToolIndex++;
          this.toolIndexByBlock.set(event.index, toolIdx);
          return {
            chunks: [
              this.makeChunk({
                delta: {
                  tool_calls: [
                    {
                      index: toolIdx,
                      id: block.id,
                      type: 'function',
                      function: { name: block.name, arguments: '' },
                    },
                  ],
                },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        // text / thinking blocks emit no chunk on start; wait for delta
        return { chunks: [], done: false };
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          return {
            chunks: [this.makeChunk({ delta: { content: delta.text }, finish_reason: null })],
            done: false,
          };
        }
        if (delta.type === 'input_json_delta') {
          const toolIdx = this.toolIndexByBlock.get(event.index);
          if (toolIdx === undefined) return { chunks: [], done: false };
          return {
            chunks: [
              this.makeChunk({
                delta: {
                  tool_calls: [
                    {
                      index: toolIdx,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        if (delta.type === 'thinking_delta') {
          // Map thinking onto reasoning_content (same path as DeepSeek reasoner)
          return {
            chunks: [
              this.makeChunk({
                delta: { reasoning_content: delta.thinking },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        return { chunks: [], done: false };
      }

      case 'content_block_stop':
        // OpenAI has no "block boundary" concept; drop this event
        return { chunks: [], done: false };

      case 'message_delta': {
        const finishReason = stopReasonToFinishReason(event.delta.stop_reason);
        const outputTokens = event.usage?.output_tokens ?? 0;
        const chunk = this.makeChunk({
          delta: {},
          finish_reason: finishReason,
          usage: {
            prompt_tokens: this.promptTokens,
            completion_tokens: outputTokens,
            total_tokens: this.promptTokens + outputTokens,
          },
        });
        return { chunks: [chunk], done: false };
      }

      case 'message_stop':
        // Time to emit [DONE]; no more chunks here
        return { chunks: [], done: true };

      case 'error':
        // Error event: terminating chunk with finish_reason; caller appends [DONE]
        return {
          chunks: [
            this.makeChunk({
              delta: { content: '' },
              finish_reason: event.error?.type ?? 'error',
            }),
          ],
          done: true,
        };

      default:
        return { chunks: [], done: false };
    }
  }

  private makeChunk(opts: {
    delta: OpenAIDeltaChunk['choices'][number]['delta'];
    finish_reason: string | null;
    usage?: OpenAIDeltaChunk['usage'];
  }): OpenAIDeltaChunk {
    const chunk: OpenAIDeltaChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: opts.delta,
          finish_reason: opts.finish_reason,
        },
      ],
    };
    if (opts.usage) chunk.usage = opts.usage;
    return chunk;
  }
}

// ---------- SSE line parsing ----------

/**
 * An Anthropic SSE frame looks like:
 *   event: content_block_delta\n
 *   data: {"type":"content_block_delta","index":0,"delta":{...}}\n
 *   \n
 *
 * Only data: lines carry JSON. event: lines can be ignored (data already has type).
 * Ch7's SSE relay will do full line scanning; this chapter provides a minimal parser
 * for unit tests and reuse in Ch7.
 */
export function parseAnthropicSSELine(line: string): AnthropicStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const json = trimmed.slice(5).trim();
  if (json.length === 0 || json === '[DONE]') return null;
  try {
    return JSON.parse(json) as AnthropicStreamEvent;
  } catch {
    return null;
  }
}
