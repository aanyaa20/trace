import { env } from '../env.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';

/**
 * Second provider behind the same interface, proving the agent loop holds no
 * Gemini-specific assumptions.
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(model: string = env.OPENAI_MODEL) {
    super({
      name: 'openai',
      baseUrl: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
      model,
      rpm: env.LLM_RPM,
    });
  }
}
