import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIAdapter } from "../openai.js";
import type { IRChatRequest } from "../../types/ir.js";

const sampleIR: IRChatRequest = {
    model: 'gpt-4o-mini', 
    messages: [
        {role: 'system', content: 'be brief'},         
        {role: 'user', content: 'hello'}
    ], 
    temperature: 0.2, 
    max_tokens: 64, 
}; 

describe('OpenAIAdapter', () => {
    const adapter = new OpenAIAdapter({
        name: 'openai', 
        baseURL: 'https://api.openai.com', 
        apiKey: 'sk-test', 
    }); 

    it('strips trailing slash and builds chat completions endpoint', () => {
        assert.equal(adapter.getEndpoint(sampleIR), 'https://api.openai.com/v1/chat/completions'); 
    }); 

    it('buildRequest uses Bearer auth and passthrough IR body', ()=> {
        const {headers, body} = adapter.buildRequest(sampleIR); 
        assert.equal(headers.Authorization, 'Bearer sk-test'); 
        assert.equal(headers['Content-Type'], 'application/json'); 
        assert.deepEqual(JSON.parse(body), sampleIR); 
    }); 

    it('buildStreamRequest forces stream + include_usage without mutating input', ()=> {
        const ir = {...sampleIR, stream: false}; 
        const { body }  = adapter.buildStreamRequest(ir); 
        const parsed = JSON.parse(body); 
        assert.equal(ir.stream, false); 
        assert.equal(parsed.stream, true); 
        assert.equal(parsed.stream_options.include_usage, true)
    }); 

    it('parseResponse returns OpenAI JSON as IR', async () => {
        const upstream = {
            id: 'chatcmpl-1', 
            object: 'chat.completion', 
            created: 1, 
            model: 'gpt-4o-mini', 
            choices: [
                {
                    index: 0, 
                    message: { role: 'assistant', content: 'hi'}, 
                    finish_reason: 'stop', 
                }, 
            ], 
            usage: {
                prompt_tokens: 3, 
                completion_tokens: 1, 
                total_tokens: 4
            }, 
        }; 

        const ir = await adapter.parseResponse(new Response(), JSON.stringify(upstream)); 
        assert.equal(ir.choices[0]?.message.content, 'hi'); 
        assert.equal(ir.usage?.total_tokens, 4); 
    }); 

    it('parseStreamChunk returns done on [DONE]', () => {
        assert.deepEqual(adapter.parseStreamChunk('[DONE]', {}), {chunks: [], done: true}); 
    }); 

    it('parseStreamChunk passes through delta chunks', () => {
        const line = JSON.stringify({
            id: 'chatcmpl-1', 
            object: 'chat.completion.chunk', 
            created: 1, 
            model: 'gpt-4o-mini', 
            choices: [{index: 0, delta: {content: 'hi'}, finish_reason: null}], 
        }); 

        const out = adapter.parseStreamChunk(line, adapter.newStreamState()); 
        assert.equal(out.done, false); 
        assert.equal(out.chunks.length, 1)
        assert.equal(out.chunks[0]?.choices[0]?.delta.content, 'hi'); 
    }); 

    it('parseStreamChunk ignores malformed lines', () => {
        assert.deepEqual(adapter.parseStreamChunk('not-json', {}), { chunks: [], done: false });
      });
}); 