import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

function createSqlClient() {
  // If discrete database options are provided, use them directly (prevents URL-parsing issues with special chars in passwords)
  if (
    process.env.DB_HOST &&
    (process.env.DB_USER || process.env.PGUSER) &&
    (process.env.DB_PASSWORD !== undefined || process.env.PGPASSWORD !== undefined)
  ) {
    return postgres({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'imagehost',
      username: process.env.DB_USER || process.env.PGUSER || 'imagehost_user',
      password: process.env.DB_PASSWORD ?? process.env.PGPASSWORD ?? '',
      max: 10,
    });
  }

  const connectionString =
    process.env.DATABASE_URL ||
    'postgres://imagehost_user:imagehost_pass@localhost:5432/imagehost';

  return postgres(connectionString, { max: 10 });
}

export const sqlClient = createSqlClient();
export const db = drizzle(sqlClient, { schema });
export type Database = typeof db;
export { schema };
