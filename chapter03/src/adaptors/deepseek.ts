import {OpenAIAdapter, type OpenAICompatibleOptions} from './openai.js'; 


export class DeepSeekAdaptor extends OpenAIAdapter {
    constructor(opts: Omit<OpenAICompatibleOptions, 'name'> & { name?: string }) {
      super({ name: opts.name ?? 'deepseek', baseURL: opts.baseURL, apiKey: opts.apiKey });
    }
  }