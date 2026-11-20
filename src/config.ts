import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  baseUrl: z.string().default('http://localhost:3000'),

  // Database
  databaseUrl: z
    .string()
    .default('postgres://imagehost_user:imagehost_pass@localhost:5432/imagehost'),

  // Storage
  s3Endpoint: z.string().default('http://localhost:9000'),
  s3Region: z.string().default('us-east-1'),
  s3Bucket: z.string().default('imagehost'),
  s3AccessKeyId: z.string().default('minioadmin'),
  s3SecretAccessKey: z.string().default('minioadminpassword'),
  s3ForcePathStyle: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('true'),

  // OIDC (Tunnus)
  oidcIssuerUrl: z.string().default('https://kehitys.riihimaenseurakunta.fi/identity'),
  oidcClientId: z.string().default('kuva-mcp'),
  oidcClientSecret: z.string().optional().default(''),
  sessionSecret: z
    .string()
    .default('0123456789012345678901234567890123456789'),

  // Image Limits & Retention
  imageMaxUploadBytes: z.coerce.number().default(26214400), // 25 MB
  imageMaxPixels: z.coerce.number().default(50000000), // 50 MP
  defaultDeletionRetentionHours: z.coerce.number().default(72),
  signedUrlTtlSeconds: z.coerce.number().default(3600),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    port: process.env.PORT,
    host: process.env.HOST,
    nodeEnv: process.env.NODE_ENV,
    baseUrl: process.env.BASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Region: process.env.S3_REGION,
    s3Bucket: process.env.S3_BUCKET,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE,
    oidcIssuerUrl: process.env.OIDC_ISSUER_URL,
    oidcClientId: process.env.OIDC_CLIENT_ID,
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    imageMaxUploadBytes: process.env.IMAGE_MAX_UPLOAD_BYTES,
    imageMaxPixels: process.env.IMAGE_MAX_PIXELS,
    defaultDeletionRetentionHours: process.env.DEFAULT_DELETION_RETENTION_HOURS,
    signedUrlTtlSeconds: process.env.SIGNED_URL_TTL_SECONDS,
  });
}
