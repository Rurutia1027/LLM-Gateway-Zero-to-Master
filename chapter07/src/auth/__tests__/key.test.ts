import assert from 'node:assert/strict'; 
import { createHash } from 'node:crypto';
import { describe, it} from 'node:test'; 

import {
    KEY_PREFIX, 
    constantTimeEqual, 
    generateKey, 
    hashKey, 
    isWellFormedKey, 
} from '../key.js'; 

describe('generateKey', () => {
    it('returns plaintext with sk-gw- prefix, matching hash and preview', () => {
        const key = generateKey(); 

        assert.ok(key.plaintext.startsWith(KEY_PREFIX)); 
        assert.equal(key.hash, hashKey(key.plaintext)); 
        assert.equal(key.hash.length, 64); 
        assert.match(key.hash, /^[0-9a-f]+$/);

        const tail = key.plaintext.slice(-4); 
        assert.equal(key.preview, `${KEY_PREFIX}...${tail}`); 
    }); 

    it('produces unique keys across calls', () => {
        const a = generateKey(); 
        const b = generateKey(); 

        assert.notEqual(a.plaintext, b.plaintext); 
        assert.notEqual(a.hash, b.hash); 
    }); 

    it('plaintext is well-formed', () => {
        assert.equal(isWellFormedKey(generateKey().plaintext), true); 
    }); 
}); 

describe('hashKey', () => {
    it('returns sha256 hex of the plaintext', () => {
      const plaintext = 'sk-gw-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
      const expected = createHash('sha256').update(plaintext).digest('hex');
      assert.equal(hashKey(plaintext), expected);
    });
});

describe('isWellFormedKey', () => {
    it('accepts a freshly generated key', () => {
      assert.equal(isWellFormedKey(generateKey().plaintext), true);
    });
  
    it('rejects missing prefix', () => {
      assert.equal(isWellFormedKey('sk-openai-' + 'a'.repeat(43)), false);
    });
  
    it('rejects tail shorter than 40', () => {
      assert.equal(isWellFormedKey(`${KEY_PREFIX}${'a'.repeat(39)}`), false);
    });
  
    it('rejects tail longer than 64', () => {
      assert.equal(isWellFormedKey(`${KEY_PREFIX}${'a'.repeat(65)}`), false);
    });
  
    it('rejects non-base64url characters in the tail', () => {
      assert.equal(isWellFormedKey(`${KEY_PREFIX}${'a'.repeat(42)}!`), false);
      assert.equal(isWellFormedKey(`${KEY_PREFIX}${'a'.repeat(20)} ${'b'.repeat(22)}`), false);
    });
  
    it('accepts boundary lengths 40 and 64 with base64url charset', () => {
      assert.equal(isWellFormedKey(`${KEY_PREFIX}${'A'.repeat(40)}`), true);
      assert.equal(isWellFormedKey(`${KEY_PREFIX}${'Zz09_-'}${'a'.repeat(58)}`), true);
    });
});

describe('constantTimeEqual', () => {
    it('returns true for identical strings', () => {
      assert.equal(constantTimeEqual('secret-token', 'secret-token'), true);
    });
  
    it('returns false for different content of same length', () => {
      assert.equal(constantTimeEqual('secret-token', 'secret-tokem'), false);
    });
  
    it('returns false for different lengths without throwing', () => {
      assert.equal(constantTimeEqual('short', 'longer-value'), false);
      assert.equal(constantTimeEqual('', 'x'), false);
    });
  });
  