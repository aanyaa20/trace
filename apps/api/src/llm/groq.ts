import { env } from '../env.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';

/**
 * Groq serves the `/chat/completions` shape, so it is the same client with a
 * different base URL and key.
 *
 * It is the default provider because of one number: the free tier allows on
 * the order of a thousand requests a day against roughly twenty for Gemini's.
 * That is the difference between an evaluation you can run and one you cannot
 * — twenty-one questions across two modes is about a hundred and thirty
 * requests, which does not fit in a day of Gemini's free tier and is a rounding
 * error against Groq's.
 *
 * The rate limit that does bite is per minute, which the token bucket already
 * handles, so LLM_RPM is set higher here by default than it is for Gemini.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(model: string = env.GROQ_MODEL) {
    super({
      name: 'groq',
      baseUrl: env.GROQ_BASE_URL,
      apiKey: env.GROQ_API_KEY,
      model,
      rpm: env.GROQ_RPM,
    });
  }
}
