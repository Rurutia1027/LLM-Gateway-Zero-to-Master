import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeepSeekAdapter } from '../deepseek.js';
import { OpenAIAdapter } from '../openai.js';
import type { IRChatRequest } from '../../types/ir.js';

const ir: IRChatRequest = {
    model: 'deepseek-chat', 
    messages: [{role: 'user', content: 'ping'}], 
}; 

describe('DeepSeekAdapter', () => {
    it('extends OpenAIAdapter (OpenAI-compatible family)', () => {
        const adapter = new DeepSeekAdapter({
            baseURL: 'https://api.deepseek.com', 
            apiKey: 'sk-ds', 
        }); 

        assert.ok(adapter instanceof OpenAIAdapter); 
        assert.equal(adapter.name, 'deepseek'); 
    }); 

    it('reuse OpenAI endpoint/auth shape with DeepSeek baseURL', () => {
        const adapter = new DeepSeekAdapter({
            baseURL: 'https://api.deepseek.com', 
            apiKey: 'sk-ds', 
        }); 

        assert.equal(adapter.getEndpoint(ir), 'https://api.deepseek.com/v1/chat/completions'); 
        const {headers, body } = adapter.buildRequest(ir); 
        assert.equal(headers.Authorization, 'Bearer sk-ds'); 
        assert.equal(JSON.parse(body).model, 'deepseek-chat'); 
    }); 


  it('allows custom name override', () => {
    const adaptor = new DeepSeekAdapter({
      name: 'deepseek-reasoner-channel',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-ds',
    });
    assert.equal(adaptor.name, 'deepseek-reasoner-channel');
  });
}); 