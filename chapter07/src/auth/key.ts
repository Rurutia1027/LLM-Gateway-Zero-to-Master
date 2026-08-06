import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { sha256 } from "hono/utils/crypto";

const KEY_PREFIX = 'sk-gw-'; 
const KEY_RANDOM_BYTES = 32; 

export interface GeneratedKey {
    plaintext: string; 
    hash: string; 
    preview: string; 
}

export function generateKey(): GeneratedKey {
    const random = randomBytes(KEY_RANDOM_BYTES).toString('base64url'); 
    const plaintext = `${KEY_PREFIX}${random}`; 
    const hash = sha256Hex(plaintext);
    const tail = plaintext.slice(-4); 
    const preview = `${KEY_PREFIX}...${tail}`; 
    return { plaintext, hash, preview }; 
}

export function hashKey(plaintext: string): string {
    return sha256Hex(plaintext);
}

// validation of key format, validate based on key's prefix and length 
export function isWellFormedKey(plaintext: string): boolean {
    if (!plaintext.startsWith(KEY_PREFIX)) return false;
    // base64url(32 bytes) = 43 chars, 但保守允许 40-64 区间
    const tail = plaintext.slice(KEY_PREFIX.length);
    return tail.length >= 40 && tail.length <= 64 && /^[A-Za-z0-9_-]+$/.test(tail);
}
  

export function constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
  
  function sha256Hex(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
  
  export { KEY_PREFIX };
  
