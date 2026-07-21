// Unified IR (Intermediate Representation)
// This book chooses the OpenAI Chat Completions protocol as the IR. 
// There are three reasons:
// - Industry standard: the OpenAI protocol is the default integration protocol supported by most client SDKs in the market. 
// - No additonal constraints: almost all upstream providers already offer an OpenAI-compatible mode; 
// - Extensibility: zod's passthrough feature allows unknow fields to be forwarded, and additional fields can be introduced in later chapters when needed. 

// Later chapters will incrementally add more fields to the IR 
// (e.g., top-level system messages in Ch3, billing metadata in Ch5, streaming support in CH7, etc.). 
// This chapter only defines the minimum required fields. 

import {z} from 'zod'; 

// OpenAI message: role and content form the protocol foundation. 
// Other fields are forwarded using passthrough.

export const IRMessageSchema = z
.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']), 
    content: z.union([z.string(), z.array(z.any()), z.null()]), 
})
.passthrough(); 

// IRChatRequest is the normalized internal structure used by the gateway 
// to represent a "chat completion request". 
// 
// Client -> Hono entry -> zod validation -> IRChatRequest 
// -> adapter.buildRequest -> upstream provider 
export const IRChatRequestSchema = z
.object({
    model: z.string().min(1), 
    messages: z.array(IRMessageSchema), 

    // Optional fields. Each adapter decides how to map them to the upstream API.
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(), 
    top_p: z.number().optional(), 

    // the stream field is defined here, but streaming is not supported in v0.2 of this chapter (deferred to CH7). 
    stream: z.boolean().optional(), 
})
.passthrough();

export type IRMessage = z.infer<typeof IRMessageSchema>; 
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>; 

// IRChatResponse is the internal representaiton after normalization an upstream 
// response into the OpenAI Chat Completions structure. 
// 
// For OpenAI-compatible upstream providers (including DeepSeek), this structure 
// is essential the raw upstream response passed through. 
// 
// For non-compatible upstream providers (e.g., Anthropic in CH3), 
// field mapping is required inside adaptor.parseResponse. 

export interface IRChatResponse {
    id: string; 
    object: 'chat.completion'; 
    created: number; 
    model: string; 
    choices: Array<{
        index: number; 

        message: {
            role: 'assistant'; 
            content: string | null; 
        }; 

        finish_reason: string | null; 
    }> ; 

    usage?: {
        prompt_tokens: number; 
        completion_tokens: number; 
        total_tokens: number; 
    }
}