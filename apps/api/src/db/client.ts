import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

// postgres.js pools per Sql instance: one per process, closed explicitly on
// shutdown so the container exits instead of hanging on open sockets.
const sql = postgres(env.DATABASE_URL, {
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
