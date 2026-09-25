import fp from 'fastify-plugin';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { unauthorized } from '../errors.js';

export const AUTH_COOKIE = 'trace_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface SessionPayload {
  sub: string;
  email: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionPayload;
    user: SessionPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    issueSession: (reply: FastifyReply, payload: SessionPayload) => void;
    clearSession: (reply: FastifyReply) => void;
  }
  interface FastifyRequest {
    session: SessionPayload;
  }
}

export default fp(
  async (app) => {
    await app.register(fastifyCookie, { secret: env.JWT_SECRET });
    await app.register(fastifyJwt, {
      secret: env.JWT_SECRET,
      cookie: { cookieName: AUTH_COOKIE, signed: false },
      sign: { expiresIn: SESSION_TTL_SECONDS },
    });

    app.decorate('issueSession', (reply: FastifyReply, payload: SessionPayload) => {
      void reply.setCookie(AUTH_COOKIE, app.jwt.sign(payload), {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.COOKIE_SECURE,
        path: '/',
        maxAge: SESSION_TTL_SECONDS,
      });
    });

    app.decorate('clearSession', (reply: FastifyReply) => {
      void reply.clearCookie(AUTH_COOKIE, { path: '/' });
    });

    app.decorate('requireAuth', async (request: FastifyRequest) => {
      try {
        request.session = await request.jwtVerify<SessionPayload>();
      } catch {
        // The jwt library's message leaks token internals; a caller only needs
        // to know the session is unusable.
        throw unauthorized('session missing or expired');
      }
    });
  },
  { name: 'trace-auth' },
);
