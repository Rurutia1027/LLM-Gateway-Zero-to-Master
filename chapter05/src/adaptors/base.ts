import type {IRChatRequest, IRChatResponse} from '../types/ir.js'; 
export interface ProviderAdapter {
    readonly name: string; 

    getEndpoint(ir: IRChatRequest): string;  

    buildRequest(ir: IRChatRequest): {headers: Record<string, string>; body: string}; 

    parseResponse(upstreamResp: Response, rawBody: string): Promise<IRChatResponse>; 
}
