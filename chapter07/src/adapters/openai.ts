import { IRChatRequest } from "../types/ir";
import type { ProviderAdapter, StreamChunkOutput, StreamState } from "./base";

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
        return ''; 
    }

    buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string; } {
        return { headers: {}, body: '' }; 
    }

    async parseResponse(_upstreamResp: Response, rawBody: string): Promise<IRChatResponse> {}


    // v0.7 stream  
    // buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
        
    // }

    // openai doesn't need stream 
    newStreamState(): StreamState {
        return {}; 
    }

    parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput {
        return { chunks: [], done: false }; 
    }
}