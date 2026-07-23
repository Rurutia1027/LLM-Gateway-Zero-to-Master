// Multiplier System 
// final_cost = base_cost 
//    x (user_multiplier / 1000) // User discount / markup (from users.userMultiplier)
//    x (channel_multiplier / 1000) // Channel markup (will replace the hardcoded value after the channel pool is introduced in Ch8)
//    x (model_multiplier / 1000)  // Model multiplier (from prices.modelMultiplier)
// 
// Why use "multipliers" instead of directly modifying the price: 
// - The price table represents the upstream source-of-truth pricing, maintained by 
// operations based on official pricing. It should not be pollued by business rules; 
// - The multiplier layer separates "pricing strategies" (user-group discounts, 
//   channel distribution markups, and model-level adjustments) from "cost calculation". 
//   Changing the base price does not affect pricing strategies, and changing pricing strategies does not require modifying the base price. 
// - The same customer can receive different effective prices through different channels. 
//   Multipliers naturally support this use case.  The channel multiplier will be associated with a Channel 
//   in the Channel pool introduced in Ch8. 
// 
// Integer Storage with Thousandth Precision: 
// - The multiplier range is 0.001x to 10x. Thousandth precision is sufficient for 
//   this educational project (production systems could use ten-thousandth precision); 
// - Integer arithmetic avoids floating-point precision loss. After multiplying the three multipliers, 
//   the result is nine-digit integer (0.001x to 10x), which is then divided by 
//   1,000,000,000 to obtain the final multiplier. 

// Comparison with one-api: 
// - one-api stores modelRatio and groupRatio directly as float64 values in a Go map complied into the binary (relay/billing/ratio/model.go:13), 
//   so changing prices requires restarting the serivce; 
// - one-api's "group-multiplier" (groupRatio) is equivalent to this project's userMultiplier; 
// - one-api does not have an explicit channelMultiplier. Instead it indirectly models this concept 
//   by associating different Models with different Channels. 
// - This project's v0.5 uses integer thousandth-based multipliers stored in the database 
//   and separates the three dimensions: channel x model x user. This aligned with the direction of new-api
//   , but does not yet introduce expresison-based billing (defferred to Ch10). 

import {eq} from 'drizzle-orm'; 
import {getDb} from '../db/client.js'; 
import {users} from '../db/schema.js'; 
import { getCurrentPrice } from '../billing/prices.js';

const MULTIPLIER_SCALE = 1000; 

export interface MultiplierContext {
  userId: number; 
  model: string; 
  provider: string; 
}

export interface CombinedMultiplier {
  // user multiplier (integer in thousandths)
  user: number; 

  // channel multiplier (integer in thousandths)
  // default to 1000 in v0.5 
  // will be loaded from the channels table after the channel pool is introduced in Ch8
  channel: number; 

  // model multiplier (integer in thousandths)
  model: number; 

  // product of all three multipliers (1e9 = 1.0x). 
  // stored directly as a snapshot in usage_records.multiplier_snapshot. 
  combinedScale1e9: number; 

  // floating-point multiplier used for cost calculation. 
  // (= combinedScale1e9 / 1e9)
  combinedFloat: number; 
}

/**
 * Resolves and combines multipliers across three dimensions. 
 * 
 * v0.5 implementation: 
 * - user: loaded from users.userMultiplier; 
 * - channel: temporarily hardcoded to 1.0x (will be loaded from channels.weight after the channel table is introduced in Ch8); 
 * - model: loaded from prices.modelMultiplier; 
*/
export function resolveMultiplier(ctx: MultiplierContext): CombinedMultiplier {
  const db = getDb(); 
  const userRows = db
    .select({m: users.userMultiplier})
    .from(users)
    .where(eq(users.id, ctx.userId))
    .all(); 

    const userMul = userRows.length > 0 ? userRows[0]!.m : MULTIPLIER_SCALE; 
    const price = getCurrentPrice(ctx.model, ctx.provider); 
    const modelMul = price.modelMultiplier; 

    // v0.5: The channel multiplier is hardcoded to 1.0x 
    // In Ch8, this will be replaced with a channel-specific lookup. 
    const channelMul = MULTIPLIER_SCALE; 
    
    const combined = userMul * channelMul * modelMul; 

    return {
      user: userMul, 
      channel: channelMul, 
      model: modelMul, 
      combinedScale1e9: combined,
      combinedFloat: combined / (MULTIPLIER_SCALE * MULTIPLIER_SCALE * MULTIPLIER_SCALE),
    }; 
}

export {MULTIPLIER_SCALE}; 