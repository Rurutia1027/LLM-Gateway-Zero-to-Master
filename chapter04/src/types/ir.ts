import { z } from 'zod'; 

// OpenAI message schema: role + content
export const IRMessageSchema = z
.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']), 
    content: z.union([z.string(), z.array(z.any()), z.null()]), 
})
.passthrough(); 

export const IRChatRequestSchema = z 
.object({
    model: z.string().min(1), 
    messages: z.array(IRMessageSchema).min(1), 
    temperature: z.number().optional(), 
    max_tokens: z.number().int().positive().optional(), 
    top_p: z.number().optional(), 
    stream: z.boolean().optional(), 
    // OpenAI's tool declaration will be translated to Anthropic's tool_use field in the future  
    tools: z.array(z.any()).optional(), 
    tool_choice: z.any().optional(), 
})
.passthrough(); 

export type IRMessage = z.infer<typeof IRMessageSchema>; 
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>; 


export interface ToolRequestMessage {
    tool_call_id: string; 
    content: string | unknown; 
}

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
            tool_calls?: Array<{
                id: string; 
                type: 'function'; 
                function: {name: string; arguments: string}; 
            }>; 
        }; 
        finish_reason: string | null; 
    }>; 
    usage?: {
        prompt_tokens: number; 
        completion_tokens: number; 
        total_tokens: number; 
    }; 
    [key: string]: unknown; 
}