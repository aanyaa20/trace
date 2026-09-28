import {
  embedImageRequestSchema,
  embedImageResponseSchema,
  embedQueryRequestSchema,
  embedQueryResponseSchema,
  embedTextRequestSchema,
  embedTextResponseSchema,
  extractRequestSchema,
  extractResponseSchema,
  mlHealthSchema,
  rerankRequestSchema,
  rerankResponseSchema,
  visionAnswerRequestSchema,
  visionAnswerResponseSchema,
  type EmbedImageRequest,
  type EmbedImageResponse,
  type EmbedQueryRequest,
  type EmbedQueryResponse,
  type EmbedTextRequest,
  type EmbedTextResponse,
  type ExtractRequest,
  type ExtractResponse,
  type MlHealth,
  type RerankRequest,
  type RerankResponse,
  type VisionAnswerRequest,
  type VisionAnswerResponse,
} from '@trace/contracts';
import type { ZodType, ZodTypeDef } from 'zod';
import { env } from '../env.js';
import { isAppError, toError, upstreamFailure } from '../errors.js';

// Extracting a long video is slower than everything else by an order of
// magnitude: whisper on CPU runs at roughly 1x realtime for the base model.
const TIMEOUTS_MS = {
  extract: 15 * 60 * 1000,
  embed: 2 * 60 * 1000,
  // Two providers, each with a 30-second ceiling, and a question is waiting.
  vision: 75_000,
  health: 5_000,
} as const;

async function call<TReq, TRes>(
  path: string,
  body: TReq,
  requestSchema: ZodType<TReq>,
  // Input left open: a response schema with defaults accepts fields the
  // service may omit, so its input type is looser than what it returns.
  responseSchema: ZodType<TRes, ZodTypeDef, unknown>,
  timeoutMs: number,
): Promise<TRes> {
  const payload = requestSchema.parse(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${env.ML_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw upstreamFailure(
        'ml',
        `POST ${path} returned ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    return responseSchema.parse(await response.json());
  } catch (cause) {
    if (controller.signal.aborted) {
      throw upstreamFailure('ml', `POST ${path} timed out after ${timeoutMs}ms`);
    }
    if (isAppError(cause)) throw cause;
    throw upstreamFailure('ml', `POST ${path} failed: ${toError(cause).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export const mlClient = {
  extract: (req: ExtractRequest): Promise<ExtractResponse> =>
    call('/extract', req, extractRequestSchema, extractResponseSchema, TIMEOUTS_MS.extract),

  embedText: (req: EmbedTextRequest): Promise<EmbedTextResponse> =>
    call('/embed/text', req, embedTextRequestSchema, embedTextResponseSchema, TIMEOUTS_MS.embed),

  embedImage: (req: EmbedImageRequest): Promise<EmbedImageResponse> =>
    call('/embed/image', req, embedImageRequestSchema, embedImageResponseSchema, TIMEOUTS_MS.embed),

  embedQuery: (req: EmbedQueryRequest): Promise<EmbedQueryResponse> =>
    call('/embed/query', req, embedQueryRequestSchema, embedQueryResponseSchema, TIMEOUTS_MS.embed),

  rerank: (req: RerankRequest): Promise<RerankResponse> =>
    call('/rerank', req, rerankRequestSchema, rerankResponseSchema, TIMEOUTS_MS.embed),

  visionAnswer: (req: VisionAnswerRequest): Promise<VisionAnswerResponse> =>
    call('/vision/answer', req, visionAnswerRequestSchema, visionAnswerResponseSchema, TIMEOUTS_MS.vision),

  async health(): Promise<MlHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUTS_MS.health);
    try {
      const response = await fetch(`${env.ML_SERVICE_URL}/healthz`, { signal: controller.signal });
      if (!response.ok) {
        throw upstreamFailure('ml', `GET /healthz returned ${response.status}`);
      }
      return mlHealthSchema.parse(await response.json());
    } finally {
      clearTimeout(timer);
    }
  },
};
