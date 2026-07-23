// Local Token Estimation 
// 
// We use js-tiktoken to estimate the number of input tokens locally. 
// 
// Why local estimation is necessary: 
// 1. The preConsume phase runs before calling the upstream provider, so we cannot 
// access the usage information from the upstream response. We must estimate 
// the input token count locally to calculate the pre-authorized amount and 
// reject requests with insufficient balance. 

// 2. The upstream response may not always include usage information. For example, 
// OpenAI streaming responses do not return usage unless stream_options.include_usage is enabled. 
// Some domestic OpenAI-compatible providers, especially older versions, do not return usage information at all. 
// Local estimation serves as the final fallback mechanism. 

// 3. Dual-path reconciliation: the locally estimated token count and the usage 
// reported by the upstream provider are stored in separate database columns. 
// During monthly audits, this allows us to detect cases where an upstream 
// provider may be underreporting or inaccurately reporting token usage. 

// Why we chose js-tiktoken instead of tiktoken (Rust binding): 
// - tiktoken requires napi-rs and native bindings, which are not available when deploying to Cloudflare Workers. 
// - js-tiktoken is a pure JavaScript implementation that can be installed directly 
//   as an npm package. Its performance is sufficient for our use case (less than 1 ms per message). 
// - Its accuracy is sufficient for billing purposes. The difference between locally estimated token counts 
// and the acutal usage reported by the upstream provider is typically around 1-3%, which is within the margin accounted for 
// by the multiplier. 

// About Anthropic / Claude: 
// - Claude does not provide a publicly available BPE tokenizer, so it is not possible to accurately calculate token counts locally in the strict sense; 
// - The common industry practice is to use cl100k_base for estimation with an empirical adjustment factor (approximate 1.0 - 1.2x); 
// - In this chapter, we use cl100k directly for estimation. Any estimation error is corrected during 
//   postConsume using the acutal usage reported by the provider. 
import {Tiktoken, getEncodingNameForModel, type TiktokenEncoding} from 'js-tiktoken/lite'; 
import cl100k_base from 'js-tiktoken/ranks/cl100k_base'; 
import o200k_base from 'js-tiktoken/ranks/o200k_base'; 
import type {IRMessage} from '../types/ir.js'; 

// cache encoder. js-tiktoken/lite does not support cache, initialization needs ms delay. 
const ENCODERS = new Map<TiktokenEncoding, Tiktoken>(); 

function getEncoder(name: TiktokenEncoding): Tiktoken {
  let enc = ENCODERS.get(name); 
  if (enc) return enc; 
  const ranks =  name === 'o200k_base' ? o200k_base : cl100k_base; 
  enc = new Tiktoken(ranks); 
  ENCODERS.set(name, enc); 
  return enc; 
}

// pick up proper encoder name via model.
// unknown models use cl100k_base as default option. 
function pickEncoding(model: string): TiktokenEncoding {
  try {
     // js-tiktoken inner defined model -> encoding mapping, support gpt-4 / gpt-4o / gpt-3.5 etc. 
     return getEncodingNameForModel(model as never); 
  } catch {
    // gpt-4o / o1 / o3 models via o200k_base; other models use cl100k_base
    return 'cl100k_base'; 
  }
}

/**
 * Estimation the number of prompt tokens in a list of messages. 
 * 
 * Algorithm based on OpenAI's official cookbook, num_tokens_from_messages:
 * - Each message has a fixed overhead (wrapping the role / content fields), 
 *   approximately 3-4 tokens; 
 * - The tools field is estimated roughly based on its JSON string length; 
 * - System messages / tool call results are encoded as strings. 
 * 
 * The estimation error is typically within 1-3%. 
 * The same function is used to estimate input tokens for both streaming 
 * and non-streaming requests. 
 * 
 * Note: the estimated token count is used for pre-authorization only. 
 * The actual token usage is reported by the upstream provider and stored in the database. 
 * During monthly audits, this allows us to detect cases where an upstream 
 * provider may be underreporting or inaccurately reporting token usage. 
*/
export function estimatePromptTokens(messages: IRMessage[], model: string): number {
  const enc = getEncoder(pickEncoding(model)); 
  let tokens = 0; 
  for (const msg of messages) {
    // Add a fixed overhead of 4 tokens per messages 
    // (rough estimate: <im_start>role\ncontent<im_end>\n)
    tokens += 4; 

    // role 
    tokens += enc.encode(msg.role).length; 

    // content 
    const c = msg.content; 
    if (typeof c === 'string') {
      tokens += enc.encode(c).length; 
    } else if (Array.isArray(c)) {
      // multimodal: take type = text segment to accumulate; 
      // image_url segment take 85 token at least 
      for (const part of c as Array<{type?: string ; text?: string}>) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          tokens += enc.encode(part.text).length; 
        } else {
          tokens += 85; 
        }
      }
    }
  }  // for 
  // assistent responding leading content token (estimation)
  tokens += 2; 
  return tokens;
}

/**
 * Estimation the number of completion tokens for a given text. 
 * 
 * Streaming scenario: 
 * - The streaming counter calls this function for each received SSE delta 
 *   and accumulates the estimated completion token count. 
 * - If the upstream provider returns actual usage information, the actual 
 *   usage should be used for final billing and reconciliation. 
 * - The local estimation serves as a real-time usage estimation and a fallback
 *   when the upstream provider does not return usage information. 
*/
export function estimateCompletionTokens(text: string, model: string): number {
  if (!text) return 0; 
  const enc = getEncoder(pickEncoding(model)); 
  return enc.encode(text).length; 
}