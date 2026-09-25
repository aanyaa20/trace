import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDatabase, db } from './client.js';
import { logger } from '../logger.js';
import { toError } from '../errors.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (invokedDirectly) {
  runMigrations()
    .then(async () => {
      logger.info({ migrationsFolder }, 'migrations applied');
      await closeDatabase();
    })
    .catch(async (cause: unknown) => {
      logger.error({ err: toError(cause) }, 'migration failed');
      await closeDatabase();
      process.exit(1);
    });
}
