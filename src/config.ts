import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  baseUrl: z.string().default('http://localhost:3000'),
  domainPath: z.string().default(''),
  brandName: z.string().default('ImageHost'),

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
  oidcIssuerUrl: z.string().optional().default('https://kehitys.riihimaenseurakunta.fi/identity'),
  oidcClientId: z.string().default('kuvarasto'),
  oidcClientSecret: z.string().optional().default(''),
  oidcJwksUri: z.string().optional(),
  sessionSecret: z.string().default('0123456789012345678901234567890123456789'),

  // Image Limits & Retention
  imageMaxUploadBytes: z.coerce.number().default(26214400), // 25 MB
  imageMaxPixels: z.coerce.number().default(50000000), // 50 MP
  defaultDeletionRetentionHours: z.coerce.number().default(72),
  signedUrlTtlSeconds: z.coerce.number().default(3600),

  // Workers & Schedulers
  retentionWorkerIntervalSeconds: z.coerce.number().default(60),
  enableRetentionWorker: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('true'),
  outboxDispatcherIntervalMs: z.coerce.number().default(2000),
  enableOutboxDispatcher: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('true'),
});

export type Config = z.infer<typeof configSchema>;

export function normalizeDomainPath(value?: string, baseUrl?: string): string {
  let path = value?.trim() ?? '';
  if (path === '' && baseUrl) {
    try {
      const parsed = new URL(baseUrl).pathname;
      if (parsed !== '/' && parsed !== '') {
        path = parsed;
      }
    } catch {
      // ignore invalid URL
    }
  }
  if (path === '' || path === '/') return '';
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[?#\s]/.test(path) ||
    path.includes('\\') ||
    path.includes('//') ||
    /%2f|%5c/i.test(path)
  ) {
    throw new Error('Invalid DOMAIN_PATH: use / or an absolute URL path such as /kuvarasto');
  }
  let normalized = path;
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (
    normalized
      .slice(1)
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid DOMAIN_PATH: empty, dot and dot-dot path segments are not allowed');
  }
  return normalized;
}

export function resolveBrandName(
  brandName?: string,
  appTitle?: string,
  appName?: string,
): string {
  const candidate = brandName?.trim() || appTitle?.trim() || appName?.trim();
  if (!candidate) return 'ImageHost';
  if (/^[a-z0-9_-]+$/.test(candidate)) {
    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }
  return candidate;
}

export function loadConfig(): Config {
  const baseUrl = process.env.BASE_URL;
  return configSchema.parse({
    port: process.env.PORT,
    host: process.env.HOST,
    nodeEnv: process.env.NODE_ENV,
    baseUrl,
    domainPath: normalizeDomainPath(process.env.DOMAIN_PATH, baseUrl),
    brandName: resolveBrandName(process.env.BRAND_NAME, process.env.APP_TITLE, process.env.APP_NAME),
    databaseUrl: process.env.DATABASE_URL,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Region: process.env.S3_REGION,
    s3Bucket: process.env.S3_BUCKET,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_KEY,
    s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE,
    oidcIssuerUrl: process.env.OIDC_ISSUER_URL ?? process.env.OIDC_ISSUER,
    oidcClientId: process.env.OIDC_CLIENT_ID,
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET,
    oidcJwksUri: process.env.OIDC_JWKS_URI,
    sessionSecret: process.env.SESSION_SECRET,
    imageMaxUploadBytes: process.env.IMAGE_MAX_UPLOAD_BYTES,
    imageMaxPixels: process.env.IMAGE_MAX_PIXELS,
    defaultDeletionRetentionHours: process.env.DEFAULT_DELETION_RETENTION_HOURS,
    signedUrlTtlSeconds: process.env.SIGNED_URL_TTL_SECONDS,
    retentionWorkerIntervalSeconds: process.env.RETENTION_WORKER_INTERVAL_SECONDS,
    enableRetentionWorker: process.env.ENABLE_RETENTION_WORKER,
    outboxDispatcherIntervalMs: process.env.OUTBOX_DISPATCH_INTERVAL_MS,
    enableOutboxDispatcher: process.env.ENABLE_OUTBOX_DISPATCHER,
  });
}
