import { z } from 'zod';

export const createKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateKnowledgeBaseRequest = z.infer<typeof createKnowledgeBaseRequestSchema>;

export const knowledgeBaseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;

export const knowledgeBaseListSchema = z.object({
  knowledgeBases: z.array(knowledgeBaseSchema),
});
export type KnowledgeBaseList = z.infer<typeof knowledgeBaseListSchema>;
