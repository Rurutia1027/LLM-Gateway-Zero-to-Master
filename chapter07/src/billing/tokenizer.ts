import { Tiktoken, getEncodingNameForModel, TiktokenEncoding, type TiktokenBPE } from "js-tiktoken/lite";
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

import type { IRMessage } from "../types/ir.js";
import { en } from "zod/v4/locales";

const ENCODERS = new Map<TiktokenEncoding, Tiktoken>(); 

function getEncoder(name: TiktokenEncoding): Tiktoken {
    let enc = ENCODERS.get(name); 
    if (enc) return enc; 
    const ranks = name === 'o200k_base' ? o200k_base : cl100k_base;  
    enc = new Tiktoken(ranks);  
    ENCODERS.set(name, enc); 
    return enc; 
}

function pickEncoding(model: string): TiktokenEncoding {
    try {
      return getEncodingNameForModel(model as never);
    } catch {
      // if cannot find proper encoder, take cl100k_base as default one 
      if (/^(o1|o3|gpt-4o|gpt-5)/.test(model)) return 'o200k_base';
      return 'cl100k_base';
    }
}

export function estimatePromptTokens(messages: IRMessage[], model: string): number {
    const enc = getEncoder(pickEncoding(model)); 
    let tokens = 0; 
    for (const m of messages) {
        tokens += 4;

        // role 
        tokens += enc.encode(m.role).length; 

        // content can either be string or an array of string
        const c = m.content; 
        if (typeof c === 'string') {
            tokens += enc.encode(c).length; 
        } else if (Array.isArray(c)) {
            for (const part of c as Array<{type?: string; text?: string}>) {
                if (part && part.type === 'text' && typeof part.text === 'string') {
                    tokens += enc.encode(part.text).length;
                } else {
                    tokens += 85; // if c is neither string nor array, it's likely a function call  
                }
            }
        }
    }

    tokens += 2; 
    return tokens; 
}

export function estimateResponseTokens(text: string, model: string): number {
    if (!text) return 0;  
    const enc = getEncoder(pickEncoding(model));  
    return enc.encode(text).length; 
}