import type { ProviderAdapter, StreamChunkOutput, StreamState } from "./base.js";
import { IRChatRequest, IRChatResponse, IRMessage } from '../types/ir.js';
import {
    AnthropicEventNormalizer, 
    type AnthropicStreamEvent, 
} from '../streaming/anthropic-events.js'; 

export { stopReasonToFinishReason } from './anthropic-map.js'; 
export type { AnthropicStopReason } from './anthropic-map.js'; 

export interface AnthropicAdapterOptions {
    name?: string; 
    baseURL: string; 
    apiKey: string; 
    anthropicVersion?: string; 
    defaultMaxTokens?: number; 
}

export interface AnthropicTool {
    name: string; 
    description?: string; 
    input_schema: {
        type: 'object', 
        properties?: Record<string, unknown>; 
        required?: string[]; 
        [k: string]: unknown; 
    }; 
}

export type AnthropicToolChoice = 
| { type: 'auto' }
| { type: 'any' }
| { type: 'none' }
| { type: 'tool' ; name: string}; 


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
    rol: 'user' | 'assistant'; 
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



// -- Anthropic Adapter -- 
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
        // diff OpenAI: /v1/chat/completions
        // anthropic: /v1/messages 
        return `${this.baseURL}/v1/messages`; 
    }

    buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string; } {
        const body = irToAnthropicRequest(ir, this.defaultMaxTokens); 
        return {
            headers: {

            }, 
            body: JSON.stringify(body), 
        }; 
    }

    async parseResponse(response: Response, rawBody: string): Promise<IRChatResponse> {
        const parsed = JSON.parse(rawBody) as AnthropicResponse;  
        return anthropicResponseToIR(parsed); 
    }


} // class AnthropicAdapter 

export function irToAnthropicRequest(ir: IRChatRequest, defaultMaxTokens: number, ): AnthropicRequest {
    const systemParts: string[] = []; 
    const restMessages: IRMessage [] = []; 
    for (const m of ir.messages) {
        if (m.role === 'system') {
            if (typeof m.content === 'string' && m.content.length > 0) {
                systemParts.push(m.content); 
            } else if (Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part && typeof part === 'object' && (part as {type?: string}).type === 'text') {
                        const text = (part as {text?: string}).text; 
                        if (typeof text === 'string' && text.length > 0) systemParts.push(text); 
                    }
                }
            }
        }  else {
            restMessages.push(m); 
        }
    }
}

export function anthropicResponseToIR(resp: AnthropicResponse): IRChatResponse {
    let text = ''; 
    const toolCalls: NonNullable<IRChatResponse['choices'][number]['message']['tool_calls']> = []; 

    for (const block of resp.content?? []) {
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

}


