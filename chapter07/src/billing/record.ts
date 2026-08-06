import { desc, eq } from 'drizzle-orm'; 
import { getDb } from '../db/client.js';
import { UsageRecord, usageRecords } from '../db/schema.js';

export function findByTraceId(traceId: string): UsageRecord | null {
    const db = getDb(); 
    const rows = db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.traceId, traceId))
        .limit(1)
        .all(); 
    return rows.length > 0 ? rows[0]! : null; 
}

// fetch recently top N records by given keyId
export function listByKey(keyId: number, limit = 50): UsageRecord[] {
    const db = getDb(); 
    return db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.keyId, keyId))
        .orderBy(desc(usageRecords.createdAt))
        .limit(limit)
        .all(); 
}

// fetch by create at timestamp and query user id 
export function listByUser(userId: number, limit = 50): UsageRecord[] {
    const db = getDb();
    return db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.userId, userId))
      .orderBy(desc(usageRecords.createdAt))
      .limit(limit)
      .all();
  }
  
  export { type UsageRecord };
  