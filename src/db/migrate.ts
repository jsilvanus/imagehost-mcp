import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './index.js';

export async function runMigrations() {
  console.log('Running database migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations completed successfully.');
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(async () => {
      await sqlClient.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await sqlClient.end();
      process.exit(1);
    });
}
