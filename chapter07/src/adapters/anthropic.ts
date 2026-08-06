// Anthropic Messages API adaptor
//
// New in this chapter. AnthropicAdaptor implements ProviderAdapter and handles
// translation in both directions:
//
//   1) Inbound OpenAI protocol -> upstream Anthropic protocol  (buildRequest)
//      - Lift system to top-level
//      - Reshape messages (role=tool -> wrap back into user.tool_result; assistant
//        tool_calls become tool_use blocks in the content array)
//      - tools[].function.parameters -> tools[].input_schema
//      - Rename tool_choice (auto/required/none/object -> auto/any/none/tool)
//      - max_tokens is required: default fallback 4096
//      - Auth switches to x-api-key + anthropic-version
//
//   2) Upstream Anthropic response -> OpenAI protocol  (parseResponse)
//      - Flatten content blocks into message.content + tool_calls
//      - tool_use.input (object) -> tool_calls[].function.arguments (JSON string)
//      - Map stop_reason: end_turn/stop_sequence -> stop, max_tokens -> length,
//                          tool_use -> tool_calls
//      - usage.input_tokens/output_tokens -> prompt_tokens/completion_tokens
//
// Design references:
//   - one-api: relay/adaptor/anthropic/main.go ConvertRequest / ResponseClaude2OpenAI
//   - Portkey v1.15.2: src/providers/anthropic/chatComplete.ts
//   - LiteLLM: litellm/llms/anthropic/chat/transformation.py
//
// Stream event normalization lives in ../streaming/anthropic-events.ts;
// this adaptor only handles non-streaming.

import type { ProviderAdapter, StreamChunkOutput, StreamState } from './base.js';
import { stopReasonToFinishReason } from './anthropic-map.js';
import type { IRChatRequest, IRChatResponse, IRMessage } from '../types/ir.js';
import {
  AnthropicEventNormalizer,
  type AnthropicStreamEvent,
} from '../streaming/anthropic-events.js';

// Mapping helpers remain re-exported from this module (admin / test entrypoints unchanged)
export { stopReasonToFinishReason } from './anthropic-map.js';
export type { AnthropicStopReason } from './anthropic-map.js';

export interface AnthropicAdaptorOptions {
  /** Channel name, default 'anthropic' */
  name?: string;
  /** Upstream base URL, default https://api.anthropic.com */
  baseURL: string;
  /** Anthropic API Key */
  apiKey: string;
  /** anthropic-version header, default 2023-06-01 */
  anthropicVersion?: string;
  /** Fallback for Anthropic Messages required max_tokens, default 4096 */
  defaultMaxTokens?: number;
}

// ---------- Anthropic protocol types (subset, fields match official docs) ----------

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ---------- Main: AnthropicAdaptor ----------

export class AnthropicAdaptor implements ProviderAdapter {
  readonly name: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicAdaptorOptions) {
    this.name = opts.name ?? 'anthropic';
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  getEndpoint(_ir: IRChatRequest): string {
    // Diff #endpoint: OpenAI uses /v1/chat/completions; Anthropic uses /v1/messages
    return `${this.baseURL}/v1/messages`;
  }

  buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
    const body = irToAnthropicRequest(ir, this.defaultMaxTokens);
    return {
      headers: {
        // Diff #auth: OpenAI uses Authorization Bearer; Anthropic uses x-api-key + anthropic-version
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    };
  }

  async parseResponse(_upstreamResp: Response, rawBody: string): Promise<IRChatResponse> {
    const parsed = JSON.parse(rawBody) as AnthropicResponse;
    return anthropicResponseToIR(parsed);
  }

  // ---------- v0.7 streaming ----------

  buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
    const body = irToAnthropicRequest({ ...ir, stream: true }, this.defaultMaxTokens);
    body.stream = true;
    return {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    };
  }

  newStreamState(): StreamState {
    // Anthropic streaming keeps state across events (id / model / promptTokens / block type map),
    // so we hang a normalizer instance on state.
    return { normalizer: new AnthropicEventNormalizer() };
  }

  parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput {
    const line = rawLine.trim();
    if (line.length === 0 || line === '[DONE]') {
      // Anthropic upstream does not send [DONE]; it uses message_stop as the terminal signal.
      // The sse-proxy main loop appends [DONE] itself after done=true, so receiving it here is safe.
      return { chunks: [], done: line === '[DONE]' };
    }
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(line) as AnthropicStreamEvent;
    } catch {
      return { chunks: [], done: false };
    }
    const normalizer = state.normalizer as AnthropicEventNormalizer;
    const out = normalizer.push(event);
    return { chunks: out.chunks, done: out.done };
  }
}

// ---------- Request direction: IR (OpenAI) -> Anthropic ----------

/**
 * Translate IR (OpenAI Chat Completions) into an Anthropic Messages request.
 * Six critical diffs show up here:
 *   1. Lift system to top-level
 *   2. Reshape messages (wrap tool_result back into user)
 *   3. tools[].function.parameters -> tools[].input_schema
 *   4. Rename tool_choice
 *   5. (response-direction stop_reason mapping is not here)
 *   6. (stream normalization is not here either)
 */
export function irToAnthropicRequest(
  ir: IRChatRequest,
  defaultMaxTokens: number,
): AnthropicRequest {
  // 1) Extract system: scan messages and join all role=system into a top-level system string
  const systemParts: string[] = [];
  const restMessages: IRMessage[] = [];
  for (const m of ir.messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content.length > 0) {
        systemParts.push(m.content);
      } else if (Array.isArray(m.content)) {
        // OpenAI system may also be [{type:'text', text:'...'}]; join all text parts
        for (const part of m.content) {
          if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
            const text = (part as { text?: string }).text;
            if (typeof text === 'string' && text.length > 0) systemParts.push(text);
          }
        }
      }
    } else {
      restMessages.push(m);
    }
  }

  // 2) Reshape messages
  const anthropicMessages = transformMessages(restMessages);

  // 3) Translate tools
  const tools = ir.tools ? transformTools(ir.tools) : undefined;
  // 4) Translate tool_choice
  const toolChoice =
    ir.tool_choice !== undefined ? transformToolChoice(ir.tool_choice) : undefined;

  const req: AnthropicRequest = {
    model: ir.model,
    // max_tokens is required (one of the diffs): fall back when IR omits it
    max_tokens: ir.max_tokens ?? defaultMaxTokens,
    messages: anthropicMessages,
  };
  if (systemParts.length > 0) req.system = systemParts.join('\n\n');
  if (typeof ir.temperature === 'number') req.temperature = ir.temperature;
  if (typeof ir.top_p === 'number') req.top_p = ir.top_p;
  if (typeof ir.stream === 'boolean') req.stream = ir.stream;
  if (tools && tools.length > 0) req.tools = tools;
  if (toolChoice) req.tool_choice = toolChoice;
  // OpenAI uses `stop`; Anthropic uses `stop_sequences`. Pass through only when IR sets it explicitly.
  const irAny = ir as unknown as { stop?: string | string[] };
  if (irAny.stop !== undefined) {
    req.stop_sequences = Array.isArray(irAny.stop) ? irAny.stop : [irAny.stop];
  }

  return req;
}

/**
 * Core message reshape logic:
 *   - role=user      : string content -> [{type:'text',text}]; arrays dispatched by type
 *                      (this demo only covers text)
 *   - role=assistant : plain text as text block; if tool_calls present, append tool_use
 *                      blocks (parse arguments JSON string back to object for input)
 *   - role=tool      : must wrap back into user role with
 *                      [{type:'tool_result', tool_use_id, content}]; consecutive tool
 *                      messages are aggregated into one user message (Anthropic's
 *                      recommended pattern).
 */
function transformMessages(messages: IRMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length > 0) {
      result.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      // tool result message -> wrap back into user.tool_result
      const toolCallId =
        typeof (m as IRMessage & { tool_call_id?: unknown }).tool_call_id === 'string'
          ? ((m as IRMessage & { tool_call_id?: string }).tool_call_id as string)
          : '';
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }

    // Before a non-tool message, flush aggregated tool_results into one user message
    flushPendingToolResults();

    if (m.role === 'user') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof m.content === 'string') {
        if (m.content.length > 0) blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object') {
            const p = part as { type?: string; text?: string };
            if (p.type === 'text' && typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text });
            }
            // Multimodal image_url -> Anthropic image is out of scope for v0.3; left for later chapters.
          }
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      result.push({ role: 'user', content: blocks });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object') {
            const p = part as { type?: string; text?: string };
            if (p.type === 'text' && typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text });
            }
          }
        }
      }
      // assistant tool_calls -> tool_use blocks
      const toolCalls = (m as IRMessage & { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== 'object') continue;
          const call = tc as {
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          let input: Record<string, unknown> = {};
          if (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0) {
            try {
              input = JSON.parse(call.function.arguments) as Record<string, unknown>;
            } catch {
              // Models occasionally emit truncated JSON; prefer an upstream 400 over silently swallowing
              input = { __raw: call.function.arguments };
            }
          }
          blocks.push({
            type: 'tool_use',
            id: call.id ?? '',
            name: call.function?.name ?? '',
            input,
          });
        }
      }
      if (blocks.length === 0) {
        // Anthropic rejects empty content; pad with an empty text block
        blocks.push({ type: 'text', text: '' });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }
  }

  // Flush any remaining tool_results at the end
  flushPendingToolResults();

  return result;
}

/**
 * OpenAI tools[].function.{name, description, parameters} -> Anthropic tools[].{name, description, input_schema}
 */
function transformTools(tools: unknown[]): AnthropicTool[] {
  const result: AnthropicTool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const tool = t as {
      type?: string;
      function?: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
    };
    if (tool.type !== 'function' || !tool.function?.name) continue;
    const params = tool.function.parameters ?? { type: 'object', properties: {} };
    result.push({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: {
        type: 'object',
        properties: (params as { properties?: Record<string, unknown> }).properties ?? {},
        required: (params as { required?: string[] }).required ?? [],
        ...Object.fromEntries(
          Object.entries(params).filter(([k]) => k !== 'type' && k !== 'properties' && k !== 'required'),
        ),
      },
    });
  }
  return result;
}

/**
 * OpenAI tool_choice -> Anthropic tool_choice
 *   - 'auto'    -> {type:'auto'}
 *   - 'required'-> {type:'any'}    (Anthropic uses 'any' for "must pick a tool")
 *   - 'none'    -> {type:'none'}
 *   - {type:'function',function:{name}} -> {type:'tool',name}
 */
function transformToolChoice(choice: unknown): AnthropicToolChoice | undefined {
  if (typeof choice === 'string') {
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    return undefined;
  }
  if (choice && typeof choice === 'object') {
    const c = choice as { type?: string; function?: { name?: string } };
    if (c.type === 'function' && c.function?.name) {
      return { type: 'tool', name: c.function.name };
    }
  }
  return undefined;
}

// ---------- Response direction: Anthropic -> IR (OpenAI) ----------

/**
 * Translate a non-streaming Anthropic response back to OpenAI Chat Completions shape.
 *   - Flatten content blocks: text joined into message.content; tool_use accumulated into tool_calls
 *   - usage.input_tokens / output_tokens -> prompt_tokens / completion_tokens
 *   - stop_reason -> finish_reason via stopReasonToFinishReason
 */
export function anthropicResponseToIR(resp: AnthropicResponse): IRChatResponse {
  let text = '';
  const toolCalls: NonNullable<IRChatResponse['choices'][number]['message']['tool_calls']> = [];

  for (const block of resp.content ?? []) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const finishReason = stopReasonToFinishReason(resp.stop_reason);

  const message: IRChatResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: text.length > 0 ? text : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: resp.id ?? '',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model ?? '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens:
        (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}
