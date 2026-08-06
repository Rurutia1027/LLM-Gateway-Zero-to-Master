import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stopReasonToFinishReason } from '../anthropic-map.js';

describe('stopReasonToFinishReason', () => {
    it('maps Anthropic stop reasons to OpenAI finish reasons', () => {
        // anthropic , end_turn -> openai 'stop'
        // anthropic , 'stop_sequence -> openai 'stop'
        // anthropic, 'max_tokens', -> openai 'length;
        // anthropic, 'tool_use' -> openai 'tool_calls'
        assert.equal(stopReasonToFinishReason('end_turn'), 'stop'); 
        assert.equal(stopReasonToFinishReason('stop_sequence'), 'stop');
        assert.equal(stopReasonToFinishReason('max_tokens'), 'length');
        assert.equal(stopReasonToFinishReason('tool_use'), 'tool_calls');
        assert.equal(stopReasonToFinishReason(null), null);
        assert.equal(stopReasonToFinishReason(undefined), null);
    }); 
}); 