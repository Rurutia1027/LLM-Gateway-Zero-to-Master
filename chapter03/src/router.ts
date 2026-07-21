import type { ProviderAdapter } from './adaptors/base.js';

export interface RouteRule {
  prefix: string;
  adapter: ProviderAdapter;
}

export class ModelRouter {
  private readonly rules: RouteRule[];

  constructor(rules: RouteRule[]) {
    this.rules = rules;
  }

  resolve(model: string): ProviderAdapter | undefined {
    for (const rule of this.rules) {
      if (model.startsWith(rule.prefix)) {
        return rule.adapter;
      }
    }
    return undefined;
  }

  describe(): Array<{ prefix: string; provider: string }> {
    return this.rules.map((r) => ({ prefix: r.prefix, provider: r.adapter.name }));
  }
}
