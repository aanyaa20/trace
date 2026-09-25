import { z } from 'zod';

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(8080),

  DATABASE_URL: z.string().min(1),
  RUN_MIGRATIONS_ON_BOOT: booleanish.default('true'),
  REDIS_URL: z.string().min(1),

  QDRANT_URL: z.string().url(),
  QDRANT_COLLECTION: z.string().min(1).default('chunks'),

  ML_SERVICE_URL: z.string().url(),
  UPLOAD_DIR: z.string().min(1).default('/data/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(536_870_912),
  MAX_URL_BYTES: z.coerce.number().int().positive().default(2_097_152),
  ALLOW_PRIVATE_URLS: booleanish.default('false'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  COOKIE_SECURE: booleanish.default('false'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  LLM_PROVIDER: z.enum(['groq', 'gemini', 'openai']).default('groq'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_FAST_MODEL: z.string().default('gemini-3.1-flash-lite'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_FAST_MODEL: z.string().default('gpt-4o-mini'),

  GROQ_API_KEY: z.string().default(''),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_FAST_MODEL: z.string().default('llama-3.1-8b-instant'),
  /** Groq meters per minute, not per day at any level that matters here, so
   *  the bucket is set from its per-minute allowance rather than Gemini's. */
  GROQ_RPM: z.coerce.number().int().positive().default(28),
  /** Where the loop goes when the hosted daily quota is gone. 'none' keeps the
   *  current behaviour: a quota error surfaces to the user. */
  LLM_FALLBACK_PROVIDER: z.enum(['none', 'ollama', 'groq', 'gemini']).default('none'),
  OLLAMA_URL: z.string().url().default('http://ollama:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:4b'),
  OLLAMA_FAST_MODEL: z.string().default('qwen3:1.7b'),
  /** How long the breaker stays open before probing the hosted provider again.
   *  A daily allowance does come back; guessing which timezone it resets in
   *  would be worse than probing once an hour. */
  LLM_FALLBACK_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(60),
  LLM_RPM: z.coerce.number().int().positive().default(5),
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(4),

  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(5).default(3),
  SUFFICIENCY_MIN_RELEVANT_CHUNKS: z.coerce.number().int().min(1).default(2),
  SUFFICIENCY_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.55),
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(12),
  RETRIEVAL_PREFETCH_K: z.coerce.number().int().positive().default(40),
  WEB_SEARCH_PROVIDER: z.enum(['duckduckgo', 'tavily', 'none']).default('duckduckgo'),
  TAVILY_API_KEY: z.string().default(''),

  CHUNK_SIZE_CHARS: z.coerce.number().int().positive().default(800),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(150),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(2),

  /** How often a connected mailbox is polled. IMAP has no push without IDLE
   *  held open per connector, and a poll is cheap: it fetches UIDs above the
   *  watermark, which is usually an empty set. */
  MAILBOX_POLL_SECONDS: z.coerce.number().int().min(30).default(300),
  /** Messages per sync. Caps the first import of a large mailbox so one job
   *  cannot run for an hour; the remainder arrives on the next poll. */
  MAILBOX_BATCH_SIZE: z.coerce.number().int().positive().max(2000).default(200),
  MAILBOX_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(26_214_400),
  /** Off by default: a mailbox host is user-supplied, so it goes through the
   *  same address guard as a pasted URL. */
  ALLOW_PRIVATE_MAILBOX_HOSTS: booleanish.default('false'),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment configuration:\n${issues}`);
  }

  const value = parsed.data;
  if (value.CHUNK_OVERLAP_CHARS >= value.CHUNK_SIZE_CHARS) {
    throw new Error('CHUNK_OVERLAP_CHARS must be smaller than CHUNK_SIZE_CHARS');
  }
  if (value.RETRIEVAL_PREFETCH_K < value.RETRIEVAL_TOP_K) {
    throw new Error('RETRIEVAL_PREFETCH_K must be at least RETRIEVAL_TOP_K');
  }
  if (value.LLM_PROVIDER === 'groq' && !value.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is required when LLM_PROVIDER=groq');
  }
  if (value.LLM_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
  }
  // A fallback that cannot authenticate is worse than none: it turns a quota
  // error into an auth error at the moment the quota runs out.
  if (value.LLM_FALLBACK_PROVIDER === 'groq' && !value.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is required when LLM_FALLBACK_PROVIDER=groq');
  }
  if (value.LLM_FALLBACK_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required when LLM_FALLBACK_PROVIDER=gemini');
  }
  if (value.LLM_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
  }
  if (value.WEB_SEARCH_PROVIDER === 'tavily' && !value.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is required when WEB_SEARCH_PROVIDER=tavily');
  }
  return value;
}

export const env: Env = load();
