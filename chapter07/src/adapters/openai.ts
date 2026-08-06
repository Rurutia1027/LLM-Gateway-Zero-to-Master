import { ca } from "zod/v4/locales";
import { IRChatRequest, IRChatResponse, OpenAIDeltaChunk } from "../types/ir";
import type { ProviderAdapter, StreamChunkOutput, StreamState } from "./base";
import { parse } from "path";

export interface OpenAICompatibleOptions {
    // channelname 
    name: string; 

    // upstream url 
    baseURL: string; 

    // upstream ai api key 
    apiKey: string; 
}

export class OpenAIAdapter implements ProviderAdapter {
    readonly name: string; 
    protected readonly baseURL: string; 
    protected readonly apiKey: string; 

    constructor(opts: OpenAICompatibleOptions) {
        this.name = opts.name; 
        this.baseURL = opts.baseURL; 
        this.apiKey = opts.apiKey;  
    }

    getEndpoint(ir: IRChatRequest): string {
        return `${this.baseURL}/v1/chat/completions`; 
    }

    buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string; } {
        return {
            headers: {
                Authorization: `Bearer ${this.apiKey}`, 
                'Content-Type': 'application/json', 
            }, 
            body: JSON.stringify(ir), 
        }; 
    }

    async parseResponse(_upstreamResp: Response, rawBody: string): Promise<IRChatResponse> {
        return JSON.parse(rawBody) as IRChatResponse; 
    }


    // v0.7 stream  
    buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
        const streamIR: IRChatRequest = {
            ...ir, 
            stream: true, 
            stream_options: { include_usage: true, ...(ir as {stream_options?: object}).stream_options }, 
        } as IRChatRequest;  
        return {
            headers: {
                Authorization: `Bearer ${this.apiKey}`, 
                'Content-Type': 'application/json', 
            }, 
            body: JSON.stringify(streamIR), 
        }; 
    }

    // openai doesn't need stream 
    newStreamState(): StreamState {
        // OpenAI stream doesn't need state of stream
        // each chunks contains {delta:required, finish_reason: required , usage: optional}
        return {}; 
    }

    parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput {
        const line = rawLine.trim(); 
        if(line.length === 0) return {chunks: [], done: false}; 
        if (line === '[DONE]') {
            return {
                chunks: [], done: true
            }; 
        }

        let parsed: OpenAIDeltaChunk; 
        try {
            parsed = JSON.parse(line) as OpenAIDeltaChunk; 
        } catch {
            return { chunks: [], done: false}; 
        }
        return { chunks: [parsed], done:false}; 
    }
}