import { de } from "zod/v4/locales";
import { stopReasonToFinishReason } from "../adapters/anthropic-map.js";
import type { OpenAIDeltaChunk } from "../types/ir.js";

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
        usage: { input_tokens: number; output_tokens: number}; 
    }; 
}

interface AnthropicContentBlockStartEvent {
    type: 'content_block_start'; 
    index: number; 
    content_block:
    | {type: 'text'; text: string}
    | {type: 'tool_use'; id: string; name: string; input: Record<string, unknown>}
    | {type: 'thinking'; thinking: string }; 
}

interface AnthropicContentBlockDeltaEvent {
    type: 'content_block_delta'; 
    index: number; 
    delta: 
        | { type: 'text_delta'; text: string}
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
    usage: {output_tokens: number}; 
}

interface AnthropicMessageStopEvent {
    type: 'message_stop'; 
}

interface AnthropicPingEvent {
    type: 'ping'; 
}

interface AnthropicErrorEvent {
    type: 'error'; 
    error: {type: string; message: string}; 
}

export interface NormalizedOutput {
    chunks: OpenAIDeltaChunk[]; 
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
                }
            ],
        }; 
        if (opts.usage) chunk.usage = opts.usage; 
        return chunk; 
    }

    push(event: AnthropicStreamEvent): NormalizedOutput {
        switch(event.type) {
            case 'ping': 
                return {chunks: [], done: false}; 

            case 'message_start': 
              this.id = event.message.id; 
              this.model = event.message.model; 
              this.created = Math.floor(Date.now() / 1000); 
              this.promptTokens = event.message.usage.input_tokens; 
              return {
                chunks: [this.makeChunk({delta: {role: 'assistant', content: ''}, finish_reason: null})], 
                done: false, 
              }; 

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
                return {chunks: [chunk], done: false}; 
            }
            case 'message_stop': 
              return {chunks: [], done: true}; 
            case 'error': 
                return {
                    chunks: [
                        this.makeChunk({
                            delta: {content: ''}, 
                            finish_reason: event.error?.type ?? 'error', 
                        })
                    ], 
                    done: true, 
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
                                            function: {name: block.name, arguments: ''}, 
                                        }, 
                                    ], 
                                }, 
                                finish_reason: null, 
                            }), 
                        ], 
                        done: false, 
                    }; 
                }
                return {chunks: [], done: false}; 
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
                  // thinking 映射到 reasoning_content (与 DeepSeek reasoner 同一通路)
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
                return {chunks: [], done: false}; 
            default: 
                return {chunks: [], done: false};  
        }
    }
}

export function parseAnthropicSSELine(line: string): AnthropicStreamEvent | null {
    const trimmed = line.trim(); 
    if (!trimmed.startsWith('data:')) return null; 
    const json = trimmed.slice(5).trim(); 
    if (json.length === 0 || json === '[DONE]')  return null; 
    try {
        return JSON.parse(json) as AnthropicStreamEvent; 
    } catch {
        return null; 
    }
}