// Multiplier system
//
// final_cost = base_cost
//            × (user_multiplier   / 1000)   // user discount / markup (from users.userMultiplier)
//            × (channel_multiplier / 1000)  // channel markup (hardcoded until Ch8 channel pool replaces it)
//            × (model_multiplier   / 1000)  // model multiplier (from prices.modelMultiplier)
//
// Why multipliers instead of rewriting prices:
//   - The price table is upstream fact (ops maintain it from official lists) and should not
//     be polluted by business policy;
//   - The multiplier layer separates "pricing policy" (user-group discount / channel
//     distributor markup / per-model tweak) from "cost accounting" — change unit prices
//     without touching policy, and change policy without touching unit prices;
//   - The same customer can get different effective prices on different channels; composing
//     multipliers expresses that naturally (channel_multiplier hangs on Channel in the Ch8 pool).
//
// Stored as thousandths integers:
//   - Range 0.001x ~ 10x; thousandths precision is enough for teaching
//     (production can widen to ten-thousandths);
//   - Integer multiply stays exact. Product of three multipliers is a 9-digit integer,
//     then divide by 1_000_000_000 = 1.0x.
//
// vs one-api:
//   - one-api modelRatio / groupRatio are float64 in a Go map compiled into the binary
//     (relay/billing/ratio/model.go:13) — changing prices requires a restart;
//   - one-api "group ratio" (groupRatio) ≈ this book's userMultiplier;
//   - one-api has no explicit channelMultiplier; it expresses that indirectly by hanging
//     different Models on a Channel;
//   - Book v0.5 uses integer thousandths + DB storage and splits channel × model × user,
//     aligned with new-api's direction, without expression-based billing yet (deferred to Ch10).
// final = (tokens × micro unit) × (user  ×   channel   × model)
//          └─ prices ─┘           └──── resolveMultiplier ────┘

import { eq } from 'drizzle-orm'; 

import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { getCurrentPrice } from '../billing/prices.js';

const MULTIPLIER_SCALE = 1000; 

export interface MultiplierContext {
    userId: number; 
    model: string; 
    provider: string; 
}

export interface CombinedMultipler {
    // User multipler (thoudands integer)
    user: number; 

    // Channel multipler (thoudands integer); Default 1000 in v0.5; read from channels table after Ch8 channel pool replaces it 
    channel: number; 

    // Model multipler (thoudands integer) 
    model: number; 

    // Product of the three (1e9 = 1.0x). Written to usage_records.multipler_snapshot.
    combinedScale1e9: number; 
    // Real multipler applied to cost (= combinedScale1e9 / 1e9)
    combinedFloat: number; 
}

export function resolveMultipler(ctx: MultiplierContext): CombinedMultipler {
    const db = getDb(); 
    const userRows = db
        .select({m: users.userMultiplier})
        .from(users)
        .where(eq(users.id, ctx.userId))
        .all(); 

    const userMul = userRows.length > 0 ? userRows[0]!.m : MULTIPLIER_SCALE; 
    const price = getCurrentPrice(ctx.model, ctx.provider); 
    const modelMul = price.modelMultiplier; 
    const channelMul = MULTIPLIER_SCALE; 
    const combined = userMul * channelMul * modelMul

    return {
        user: userMul,
        channel: channelMul, 
        model: modelMul, 
        combinedScale1e9: combined, 
        combinedFloat: combined / (MULTIPLIER_SCALE * MULTIPLIER_SCALE * MULTIPLIER_SCALE),
    }; 
}

export { MULTIPLIER_SCALE };