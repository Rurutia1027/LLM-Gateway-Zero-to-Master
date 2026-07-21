import type {ProviderAdapter} from './base.js'; 
import type {IRChatRequest, IRChatResponse} from '../types/ir.js'; 

export interface OpenAICompatibleOptions {
    name: string; 
    baseURL: string; 
    apiKey: string; 
}

export class OpenAIAdapter implements ProviderAdapter {
    readonly name: string; 
    protected readonly baseURL: string; 
    protected readonly apiKey: string; 

    constructor(opts: OpenAICompatibleOptions) {
        this.name = opts.name; 
        this.baseURL = opts.baseURL.replace(/\/+$/, '');
        this.apiKey = opts.apiKey;
    }

    getEndpoint(_ir: IRChatRequest): string {
        return `${this.baseURL}/v1/chat/completions`; 
    }

    buildRequest(ir: IRChatRequest): {headers: Record<string, string>; body: string} {
        return {
            headers: {
                Authorization: `Bearer ${this.apiKey}`, 
                'Content-Type': 'application/json', 
            }, 
            body: JSON.stringify(ir), 
        }; 
    }

    async parseResponse(response: Response, rawBody: string): Promise<IRChatResponse> {
        return JSON.parse(rawBody) as IRChatResponse; 
    }
}