import assert from 'node:assert/strict'; 
import { describe, it } from 'node:test'; 

import {
    AnthropicAdapter, 
    anthropicResponseToIR, 
    irToAnthropicRequest, 
    type AnthropicResponse, 
} from '../anthropic.js';

import {AnthropicEventNormalizer} from '../../streaming/anthropic-events.js'; 
import type { IRChatRequest } from '../../types/ir.js';

describe("irToAnthropicRequest", () => {
    it('lifts system messages to top-level system and defaults max_tokens', () => {
        const ir: IRChatRequest = {
            model: 'claude-sonnet-4-5', 
            messages: [
                { role: 'system', content: 'you are helpful'}, 
                { role: 'user', content: 'hi'}, 
            ], 
        }; 
        const req = irToAnthropicRequest(ir, 4096);  
        assert.equal(req.system, 'you are helpful'); 
        assert.equal(req.max_tokens, 4096); 
        assert.deepEqual(req.messages, [{role: 'user', content: [{type: 'text', text: 'hi'}]}]); 
    }); 

    it('renames tools.parameters -> input_schema and tool_choice required -> any', () => {
        const ir: IRChatRequest = {
            model: 'claude-sonnet-4-5', 
            messages: [{role: 'user', content: 'call tool'}], 
            max_tokens: 128, 
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_weather', 
                        description: 'weather',
                        parameters: {
                            type: 'object', 
                            properties: {city: {type: 'string'}}, 
                            required: ['city'], 
                        }, 
                    }, 
                }, 
            ], 
            tool_choice: 'required', 
        }; 

        const req = irToAnthropicRequest(ir, 4096);  
        assert.equal(req.tools?.[0]?.name, 'get_weather');
        assert.equal(req.tools?.[0]?.input_schema.type, 'object'); 
        assert.deepEqual(req.tool_choice, {type: 'any'}); 
    }); 

    it('wraps OpenAI role=tool into user tool_result blocks', () => {
        const ir: IRChatRequest = {
            model: 'claude-sonnet-4-5',
            max_tokens: 64,
            messages: [
              { role: 'user', content: 'weather?' },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"SF"}' },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 'call_1', content: '{"temp":18}' },
            ],
        }; 

        const req = irToAnthropicRequest(ir, 4096); 
        assert.equal(req.messages.length,  3); 
        const assistant = req.messages[1]; 
        assert.equal(assistant.role, 'assistant');
        assert.equal(assistant.content[0]?.type, 'tool_use');
        const toolResultMsg = req.messages[2]!;
        assert.equal(toolResultMsg.role, 'user');
        assert.equal(toolResultMsg.content[0]?.type, 'tool_result');
    });     
}); 

describe('anthropicResponseToIR', () => {
    it('flattens text + tool_use and maps usage / stop_reason', () => {
        // this is the resonse message received from anthropic 
        const resp: AnthropicResponse = {
            id: 'msg_1', 
            type: 'message', 
            role: 'assistant', 
            model: 'claude-sonnet-4-5', 
            content: [
                { type: 'text', text: 'result'}, 
                {
                    type: 'tool_use', 
                    id: 'toolu_1', 
                    name: 'get_weather', 
                    input: {city : 'SF'}, 
                }, 
            ], 
            stop_reason: 'tool_use', 
            stop_sequence: null, 
            usage: { input_tokens: 10, output_tokens: 5}, 
        }; 

        // here we invoke function convert recv anthropic response into IRChatResponse(our gateway provided generic struct)    
        const ir = anthropicResponseToIR(resp); 

        assert.equal(ir.object, 'chat.completion'); 
        assert.equal(ir.choices[0]?.message.content, 'result'); 
        assert.equal(ir.choices[0]?.finish_reason, 'tool_calls'); 
        assert.equal(ir.choices[0]?.message.tool_calls?.[0]?.function.name, 'get_weather'); 
        assert.equal(ir.choices[0]?.message.tool_calls?.[0]?.function.arguments, '{"city":"SF"}'); 
        assert.deepEqual(ir.usage, {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          });
    }); 
}); 


describe('AnthropicAdapter (class surface)', () => {
    // here we create a adapter instance of anthropic 
    const adapter = new AnthropicAdapter({
        baseURL: 'https://api.anthropic.com', 
        apiKey: 'sk-ant-test', 
    }); 

    // here we test the adapter instance 
    // let it convert anthropic request/response <-> local ir request / ir response 
    it('uses /v1/messages and x-api-key auth', () => {
        // create an instance of local ir request body 
        const ir: IRChatRequest = {
            model: 'claude-sonnet-4-5', 
            messages: [{ role: 'user', content: 'hi'}],             
        }; 

        // here we use adapter fetch ir request inner endpoint 
        assert.equal(adapter.getEndpoint(ir), 'https://api.anthropic.com/v1/messages'); 

        // use anthropic adapter create request body + header 
        const {headers, body} = adapter.buildRequest(ir); 
        
        // anthropic adapter create header from ir, should contains the api key value 
        assert.equal(headers['x-api-key'], 'sk-ant-test');
        assert.ok(headers['anthropic-version']); 
        assert.equal(headers.Authorization, undefined); 
        const parsed = JSON.parse(body); 
        assert.equal(parsed.model, 'claude-sonnet-4-5'); 
        assert.equal(parsed.max_tokens, 4096); 
    }); 

    it('buildStreamRequest sets stream:true and Accept event-stream', () => {
        const ir: IRChatRequest = {
            model: 'claude-sonnet-4-5', 
            messages: [{ role: 'user', content: 'hi'}],  
        }; 

        const {headers, body} = adapter.buildStreamRequest(ir);  
        assert.equal(headers.Accept, 'text/event-stream'); 
        assert.equal(JSON.parse(body).stream, true); 
    }); 
    it('parseStreamChunk drives AnthropicEventNormalizer via stream state', () => {
        const state = adapter.newStreamState();
        assert.ok((state as { normalizer: AnthropicEventNormalizer }).normalizer);
    
        const start = adapter.parseStreamChunk(
          JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_1',
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              usage: { input_tokens: 7, output_tokens: 0 },
            },
          }),
          state,
        );
        assert.equal(start.done, false);
        assert.equal(start.chunks[0]?.choices[0]?.delta.role, 'assistant');
    
        const delta = adapter.parseStreamChunk(
          JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' },
          }),
          state,
        );
        // text_delta alone needs content_block_start first for blockTypes in some paths,
        // but text_delta itself does not require blockTypes — it always emits content.
        assert.equal(delta.chunks[0]?.choices[0]?.delta.content, 'Hello');
    
        const stop = adapter.parseStreamChunk(JSON.stringify({ type: 'message_stop' }), state);
        assert.equal(stop.done, true);
        assert.equal(stop.chunks.length, 0);
      });
    });
    
    describe('AnthropicEventNormalizer (stream state machine)', () => {
      it('collapses text + message_delta + message_stop into OpenAI chunks', () => {
        const n = new AnthropicEventNormalizer();
    
        n.push({
          type: 'message_start',
          message: {
            id: 'msg_x',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        });
        n.push({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        const textOut = n.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        });
        assert.equal(textOut.chunks[0]?.choices[0]?.delta.content, 'Hi');
    
        const end = n.push({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        assert.equal(end.chunks[0]?.choices[0]?.finish_reason, 'stop');
        assert.equal(end.chunks[0]?.usage?.prompt_tokens, 3);
        assert.equal(end.chunks[0]?.usage?.completion_tokens, 1);
    
        const done = n.push({ type: 'message_stop' });
        assert.equal(done.done, true);
      });
    
      it('maps tool_use start + input_json_delta to OpenAI tool_calls deltas', () => {
        const n = new AnthropicEventNormalizer();
        n.push({
          type: 'message_start',
          message: {
            id: 'msg_t',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        });
        const start = n.push({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
        });
        assert.equal(start.chunks[0]?.choices[0]?.delta.tool_calls?.[0]?.id, 'toolu_1');
        assert.equal(start.chunks[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.name, 'get_weather');
    
        const args = n.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        });
        assert.equal(
          args.chunks[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.arguments,
          '{"city":',
        );
      });
});