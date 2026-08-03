import {z} from 'zod'; 

// OpenAI message schema: role + content, other fields like {tool_calls / tool_call_id / name ...} directly pass through 

export const IRMessageSchema = z 
    .object({
        role: z.enum(['system', 'user', 'assistant', 'tool']), 
        content: z.union([z.string(), z.array(z.any()), z.null()]), 
    })
    .passthrough(); 


export const IRChatRequestSchema = z.object({
    model: z.string().min(1), 
    messages: z.array(IRMessageSchema).min(1), 
    temperature: z.number().optional(), 
    max_tokens: z.number().int().positive().optional(), 
    top_p: z.number().optional(), 
    stream: z.boolean().optional(), 
    stream_options: z.object({
        include_usage: z.boolean().optional()
    }).passthrough().optional(), 
    tools: z.array(z.any()).optional(),  
    tool_choice: z.any().optional()
}); 

export type IRMessage = z.infer<typeof IRMessageSchema>; 
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>; 

// tool chain message for OpenAI role=tool 
export interface ToolResultMessage {
    tool_call_id: string; 
    content: string | unknown; 
}

export interface IRChatResponse {
    id: string; 
    object: 'chat.completion',
    created: number; 
    model: string; 
    choices: Array<{
        index: number; 
        message: {
            role: 'assistant', 
            content: string | null, 
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
    // upstream passthrough fields 
    [key: string]: unknown; 
}