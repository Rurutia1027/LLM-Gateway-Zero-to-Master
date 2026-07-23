// UsageRecord read helpers
//
// INSERT / UPDATE for preConsume / postConsume / refund live in calculator.ts.
// This module holds read-only queries: by trace_id, recent N by keyId / userId.
//
// Aggregate queries (by user / model / day) can use drizzle sql templates.
// The chapter README has full SQL recipes.
//
// TODO(ch05): implement findByTraceId / listByKey / listByUser
//   (requires usageRecords in schema.ts first).

export function findByTraceId(_traceId: string): unknown | null {
  throw new Error('TODO(ch05): implement findByTraceId in billing/record.ts');
}

export function listByKey(_keyId: number, _limit = 50): unknown[] {
  throw new Error('TODO(ch05): implement listByKey in billing/record.ts');
}

export function listByUser(_userId: number, _limit = 50): unknown[] {
  throw new Error('TODO(ch05): implement listByUser in billing/record.ts');
}
