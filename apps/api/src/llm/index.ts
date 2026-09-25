import { env } from '../env.js';
import { FallbackProvider } from './fallback.js';
import { GeminiProvider } from './gemini.js';
import { GroqProvider } from './groq.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './types.js';

let synthesis: LLMProvider | undefined;
let fast: LLMProvider | undefined;

type Slot = 'synthesis' | 'fast';

/** The model each provider uses for a given slot. The split exists because the
 *  classification path is high-volume and far less sensitive to model strength
 *  than the path whose output a person reads. */
function modelFor(provider: string, slot: Slot): string {
  switch (provider) {
    case 'groq':
      return slot === 'fast' ? env.GROQ_FAST_MODEL : env.GROQ_MODEL;
    case 'openai':
      return slot === 'fast' ? env.OPENAI_FAST_MODEL : env.OPENAI_MODEL;
    case 'ollama':
      return slot === 'fast' ? env.OLLAMA_FAST_MODEL : env.OLLAMA_MODEL;
    default:
      return slot === 'fast' ? env.GEMINI_FAST_MODEL : env.GEMINI_MODEL;
  }
}

function build(provider: string, slot: Slot): LLMProvider {
  const model = modelFor(provider, slot);
  switch (provider) {
    case 'groq':
      return new GroqProvider(model);
    case 'openai':
      return new OpenAIProvider(model);
    case 'ollama':
      return new OllamaProvider(model);
    default:
      return new GeminiProvider(model);
  }
}

/**
 * Wraps the hosted provider so an exhausted daily quota degrades to a local
 * model instead of failing the answer. Every guarantee survives the switch:
 * citation resolution and abstention happen after synthesis, so they do not
 * care which model produced the text.
 */
function create(slot: Slot): LLMProvider {
  const primary = build(env.LLM_PROVIDER, slot);
  if (env.LLM_FALLBACK_PROVIDER === 'none') return primary;

  return new FallbackProvider(
    primary,
    build(env.LLM_FALLBACK_PROVIDER, slot),
    env.LLM_FALLBACK_COOLDOWN_MINUTES * 60_000,
  );
}

/** The generation path: answer quality is what the user reads. */
export function llm(): LLMProvider {
  synthesis ??= create('synthesis');
  return synthesis;
}

/**
 * The classification path: query analysis and chunk grading. These are
 * structured, high-volume and far less sensitive to model strength, and on the
 * free tier they would otherwise exhaust the synthesis model's per-minute
 * quota before an answer could be produced.
 */
export function llmFast(): LLMProvider {
  fast ??= create('fast');
  return fast;
}

export { LLMError } from './types.js';
export type { GenerateOptions, LLMProvider } from './types.js';
