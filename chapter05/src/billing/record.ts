/**
 * Helper utilities for inserting and querying UsageRecord. 
 * 
 * The INSERT / UPDATE operations for preConsume / postConsume / refund 
 * are already implemented in calculators.ts.
 * This module centralizes read-only queries, such as: 
 * - Looking up a record by trace_id; 
 * - Listing the most recent N records for a given keyId. 
 * 
 * The three aggregation queries (by user / by model / by day)
 * are written directly in SQL using Drizzle's sql template. 
*/
import {desc, eq} from 'drizzle-orm'; 
import {getDb} from '../db/client.js'; 
import {usageRecords, type UsageRecord} from '../db/schema.js'; 

// trace search 
export function findByTraceId(traceId: string): UsageRecord | null {
  const db = getDb(); 
  const rows = db 
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.traceId, traceId))
    .all(); 

  return rows.length > 0 ? rows[0]! : null; 
}

// list by keyId the most recent N records (for admin dashboard /admin/usage?keyId=...)
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


// list by userId recently top  N records 
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
