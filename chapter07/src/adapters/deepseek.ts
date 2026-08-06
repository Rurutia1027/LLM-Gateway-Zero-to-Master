import { OpenAIAdapter, type OpenAICompatibleOptions } from "./openai.js";

export class DeepSeekAdapter extends OpenAIAdapter {
    constructor(opts: Omit<OpenAICompatibleOptions, 'name'> & { name?: string }) {
      super({ name: opts.name ?? 'deepseek', baseURL: opts.baseURL, apiKey: opts.apiKey });
    }
  }