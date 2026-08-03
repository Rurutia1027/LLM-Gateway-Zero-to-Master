import type { IRChatRequest, IRChatResponse, OpenAIDeltaChunk } from "../types/ir.js";

export type StreamState = Record<string, unknown>; 

export interface StreamChunkOutput {
    chunks: OpenAIDeltaChunk[]; 
    done: boolean; 
}

export interface ProviderAdapter {
    readonly name: string; 

    getEndpoint(ir: IRChatRequest): string; 

    buildRequest(ir: IRChatRequest): {headers: Record<string, string>; body: string}; 

    parseResponse(upstreamResp: Response, rawBody: string): Promise<IRChatResponse>; 

    buildStreamRequest(ir: IRChatRequest): {headrs: Record<string, string>; body: string}; 

    newStreamState(): StreamState; 

    parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput; 
}