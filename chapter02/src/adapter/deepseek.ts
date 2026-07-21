// DeepSeek adapter
//
// DeepSeek's official API is 100% compatible with the OpenAI Chat Completions protocol:
//   - endpoint: https://api.deepseek.com/v1/chat/completions
//   - auth:     Authorization: Bearer ${apiKey}     (identical to OpenAI)
//   - request:  identical to OpenAI
//   - response: identical to OpenAI (extra reasoning_content fields can be passed through)
//
// So the implementation is simply "extend OpenAIAdapter, swap the baseURL". This
// demonstrates the value of an OpenAI-compatible base class: adding a new OpenAI-
// compatible upstream (Moonshot / Zhipu / StepFun / Together / SiliconFlow ...)
// only takes a few lines of config.
//
// References:
//   - one-api: relay/adaptor/deepseek/constants.go is only a 5-line ModelList;
//     the adapter reuses relay/adaptor/openai/adaptor.go (see CompatibleChannels
//     in compatible.go — DeepSeek is one of them).
//   - LiteLLM: litellm/llms/deepseek/chat/transformation.py (~123 lines);
//     `class DeepSeekChatConfig(OpenAIGPTConfig)` only overrides thinking /
//     reasoning_effort.
//   - Portkey v1.15.2: src/providers/deepseek/api.ts only declares baseURL and
//     the Authorization header.

import { OpenAIAdapter, type OpenAICompatibleOptions } from './openai';

export class DeepSeekAdapter extends OpenAIAdapter {
  constructor(opts: Omit<OpenAICompatibleOptions, 'name'> & { name?: string }) {
    super({ name: opts.name ?? 'deepseek', baseURL: opts.baseURL, apiKey: opts.apiKey });
  }
}

// For a third OpenAI-compatible upstream (e.g. Moonshot), you only need:
//
//   export class MoonshotAdapter extends OpenAIAdapter {
//     constructor(opts) {
//       super({ name: 'moonshot', baseURL: 'https://api.moonshot.cn', apiKey: opts.apiKey });
//     }
//   }
//
// Truly complex adapters are left for Anthropic in Ch3.
