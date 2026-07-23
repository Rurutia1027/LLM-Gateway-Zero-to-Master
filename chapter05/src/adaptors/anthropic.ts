// Anthropic Messages API adapter
//
// New in this chapter. AnthropicAdapter implements ProviderAdapter and handles
// translation in both directions:
//
//   1) Inbound OpenAI protocol -> upstream Anthropic protocol  (buildRequest)
//      - Lift system messages to a top-level `system` field
//      - Reshape messages (role=tool -> wrap as user.tool_result; assistant
//        tool_calls -> tool_use content blocks)
//      - tools[].function.parameters -> tools[].input_schema
//      - Remap tool_choice (auto/required/none/object -> auto/any/none/tool)
//      - max_tokens is required: default to 4096 when missing
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
// Streaming event normalization lives in ../streaming/anthropic-events.ts;
// this adapter only handles non-streaming responses.

import type { ProviderAdapter } from './base.js';
import type { IRChatRequest, IRChatResponse, IRMessage } from '../types/ir.js';

export interface AnthropicAdapterOptions {
  /** Channel name, defaults to 'anthropic' */
  name?: string;
  /** Upstream base URL, defaults to https://api.anthropic.com */
  baseURL: string;
  /** Anthropic API Key */
  apiKey: string;
  /** anthropic-version header, defaults to 2023-06-01 */
  anthropicVersion?: string;
  /** Fallback for Anthropic Messages' required max_tokens, defaults to 4096 */
  defaultMaxTokens?: number;
}

// ---------- Anthropic protocol types (subset matching official docs) ----------

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

// ---------- stop_reason / finish_reason mapping ----------

/**
 * Anthropic stop_reason -> OpenAI finish_reason.
 * Simplest of the six protocol differences, but every branch is reused by
 * parseResponse and the streaming normalizer.
 */
export function stopReasonToFinishReason(
  stopReason: AnthropicResponse['stop_reason'] | undefined,
): string | null {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return stopReason;
  }
}

// ---------- Main: AnthropicAdapter ----------

export class AnthropicAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicAdapterOptions) {
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
}

// ---------- Request direction: IR (OpenAI) -> Anthropic ----------

/**
 * Translate IR (OpenAI Chat Completions) into an Anthropic Messages request.
 * Six key differences show up here:
 *   1. Lift system to a top-level field
 *   2. Reshape messages (wrap tool_result back into user)
 *   3. tools[].function.parameters -> tools[].input_schema
 *   4. Remap tool_choice
 *   5. (stop_reason mapping is response-side only)
 *   6. (streaming normalization is elsewhere)
 */
export function irToAnthropicRequest(
  ir: IRChatRequest,
  defaultMaxTokens: number,
): AnthropicRequest {
  // 1) Extract system: scan messages and join all role=system into top-level system
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
  // OpenAI uses `stop`; Anthropic uses `stop_sequences`. Pass through only when IR sets it.
  const irAny = ir as unknown as { stop?: string | string[] };
  if (irAny.stop !== undefined) {
    req.stop_sequences = Array.isArray(irAny.stop) ? irAny.stop : [irAny.stop];
  }

  return req;
}

/**
 * Core message reshaping:
 *   - role=user      : string content -> [{type:'text',text}]; array parts by type
 *                      (this demo only covers text)
 *   - role=assistant : plain text -> text blocks; tool_calls append tool_use blocks
 *                      (parse arguments JSON string back to object)
 *   - role=tool      : must wrap as user role with
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
      // Tool result message -> wrap as user.tool_result
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

    // Flush aggregated tool_results into one user message before a non-tool message
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
            // Multimodal image_url -> Anthropic image is out of scope for v0.3.
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
              // Model may emit truncated JSON; prefer upstream 400 over silently dropping it
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
 * OpenAI tools[].function.{name, description, parameters}
 *   -> Anthropic tools[].{name, description, input_schema}
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
 *   - 'auto'     -> {type:'auto'}
 *   - 'required' -> {type:'any'}    (Anthropic uses 'any' for "must pick a tool")
 *   - 'none'     -> {type:'none'}
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
 * Translate a non-streaming Anthropic response back to OpenAI Chat Completions.
 *   - Flatten content blocks: text -> message.content; tool_use -> tool_calls
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
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}
