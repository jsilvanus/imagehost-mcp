import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://imagehost_user:imagehost_pass@localhost:5432/imagehost';

export const sqlClient = postgres(connectionString, { max: 10 });
export const db = drizzle(sqlClient, { schema });
export { schema };
