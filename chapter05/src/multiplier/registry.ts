// Multiplier registry
//
// final_cost = base_cost
//            × (user_multiplier    / 1000)   // user discount / markup (users.userMultiplier)
//            × (channel_multiplier / 1000)   // channel markup (hardcoded until Ch8)
//            × (model_multiplier   / 1000)   // model multiplier (prices.modelMultiplier)
//
// Why multipliers instead of mutating list prices:
//   - Price table = upstream fact (ops maintain official rates) — keep it clean;
//   - Multiplier layer isolates pricing policy (VIP / reseller / model skew)
//     from cost accounting — change policy without rewriting unit prices;
//   - Same customer can see different effective prices across channels via
//     channel_multiplier (hung on Channel in Ch8).
//
// Per-mille integer storage:
//   - Range ~0.001x–10x; per-mille is enough for teaching (production may use 1e4);
//   - Integer multiply stays exact. Product of three multipliers is a 9-digit int;
//     divide by 1_000_000_000 = 1.0x.
//
// vs one-api:
//   - one-api modelRatio / groupRatio are float64 maps compiled into the binary
//     (restart to change);
//   - groupRatio ≈ our userMultiplier; no explicit channelMultiplier;
//   - v0.5: integer per-mille + DB, three dimensions; expression billing → Ch10.
//
// TODO(ch05): implement resolveMultiplier.

export interface MultiplierContext {
  userId: number;
  model: string;
  provider: string;
}

export interface CombinedMultiplier {
  /** user multiplier (per-mille integer) */
  user: number;
  /** channel multiplier (per-mille). v0.5 default 1000; Ch8 reads channels table */
  channel: number;
  /** model multiplier (per-mille integer) */
  model: number;
  /** product of the three (1e9 = 1.0x). Persist on usage_records.multiplier_snapshot */
  combinedScale1e9: number;
  /** float factor for cost (= combinedScale1e9 / 1e9) */
  combinedFloat: number;
}

/**
 * Combine the three multiplier dimensions.
 *
 * v0.5 target:
 *   - user: users.userMultiplier;
 *   - channel: hardcode 1.0x (Ch8: channels table);
 *   - model: prices.modelMultiplier.
 */
export function resolveMultiplier(_ctx: MultiplierContext): CombinedMultiplier {
  throw new Error('TODO(ch05): implement resolveMultiplier in multiplier/registry.ts');
}
