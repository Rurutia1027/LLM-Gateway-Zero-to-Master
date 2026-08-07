import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamingTokenCounter } from '../streaming-counter.js';

describe('StreamingTokenCounter', () => {
  it('falls back to preConsume prompt estimate when no upstream usage', () => {
    const counter = new StreamingTokenCounter('gpt-4o-mini', 42);
    counter.ingestDelta('Hello');
    counter.ingestDelta(' world');
    const out = counter.finalize();

    assert.equal(out.promptTokens, 42);
    assert.ok(out.completionTokens > 0);
    assert.equal(out.abortedByClient, false);
  });

  it('prefers upstream usage over local estimates', () => {
    const counter = new StreamingTokenCounter('gpt-4o-mini', 42);
    counter.ingestDelta('lots of local text that would estimate differently');
    counter.ingestUsage({ prompt_tokens: 10, completion_tokens: 7 });
    const out = counter.finalize();

    assert.equal(out.promptTokens, 10);
    assert.equal(out.completionTokens, 7);
  });

  it('ignores empty deltas', () => {
    const counter = new StreamingTokenCounter('gpt-4o-mini', 1);
    counter.ingestDelta('');
    const out = counter.finalize();
    assert.equal(out.completionTokens, 0);
  });

  it('markAborted is reflected in finalize and is idempotent', () => {
    const counter = new StreamingTokenCounter('gpt-4o-mini', 1);
    counter.markAborted();
    counter.markAborted();
    assert.equal(counter.finalize().abortedByClient, true);
  });

  it('partial upstream usage only overrides the provided fields', () => {
    const counter = new StreamingTokenCounter('gpt-4o-mini', 99);
    counter.ingestDelta('abc');
    counter.ingestUsage({ prompt_tokens: 12 });
    const out = counter.finalize();
    assert.equal(out.promptTokens, 12);
    assert.ok(out.completionTokens > 0);
  });
});
