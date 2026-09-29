import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

// postgres.js pools per Sql instance: one per process, closed explicitly on
// shutdown so the container exits instead of hanging on open sockets.
/**
 * A hosted Postgres URL (Neon) carries channel_binding=require. postgres.js
 * passes unknown query parameters to the server as settings, and the server
 * rejects that one; SSL itself comes from sslmode, which is kept.
 */
function connectionUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.delete('channel_binding');
  return url.toString();
}

const sql = postgres(connectionUrl(env.DATABASE_URL), {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => undefined,
});

export const db: PostgresJsDatabase<typeof schema> = drizzle(sql, { schema });

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}

export { schema };
