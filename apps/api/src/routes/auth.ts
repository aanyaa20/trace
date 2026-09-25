import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { loginRequestSchema, registerRequestSchema, type AuthResponse } from '@trace/contracts';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { conflict, unauthorized } from '../errors.js';

// OWASP-recommended argon2id settings that stay under ~100ms on a laptop core.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (request, reply) => {
    const { email, password } = registerRequestSchema.parse(request.body);
    const normalised = normaliseEmail(email);

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalised));
    if (existing.length > 0) {
      throw conflict('an account with that email already exists');
    }

    const [created] = await db
      .insert(users)
      .values({ email: normalised, passwordHash: await argon2.hash(password, HASH_OPTIONS) })
      .returning({ id: users.id, email: users.email, createdAt: users.createdAt });

    if (!created) throw conflict('account could not be created');

    app.issueSession(reply, { sub: created.id, email: created.email });
    const body: AuthResponse = {
      user: { id: created.id, email: created.email, createdAt: created.createdAt.toISOString() },
    };
    return reply.status(201).send(body);
  });

  app.post('/auth/login', async (request, reply) => {
    const { email, password } = loginRequestSchema.parse(request.body);

    const [found] = await db.select().from(users).where(eq(users.email, normaliseEmail(email)));

    // Verify against a dummy hash when the user is absent so a missing account
    // and a wrong password take the same time to reject.
    const hash = found?.passwordHash ?? (await argon2.hash('invalid', HASH_OPTIONS));
    const valid = await argon2.verify(hash, password).catch(() => false);

    if (!found || !valid) throw unauthorized('email or password is incorrect');

    app.issueSession(reply, { sub: found.id, email: found.email });
    const body: AuthResponse = {
      user: { id: found.id, email: found.email, createdAt: found.createdAt.toISOString() },
    };
    return reply.send(body);
  });

  app.post('/auth/logout', async (_request, reply) => {
    app.clearSession(reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: app.requireAuth }, async (request) => {
    const [found] = await db.select().from(users).where(eq(users.id, request.session.sub));
    if (!found) throw unauthorized('session refers to a deleted account');

    const body: AuthResponse = {
      user: { id: found.id, email: found.email, createdAt: found.createdAt.toISOString() },
    };
    return body;
  });
}
