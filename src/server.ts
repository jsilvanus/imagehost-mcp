import { loadConfig } from './config.js';
import { SessionService } from './auth/session.js';
import { OidcClientService } from './auth/oidc.js';
import { S3StorageService } from './storage/s3.js';
import { ImageProcessor } from './services/image-processor.js';
import { GroupService } from './services/group-service.js';
import { ImageService } from './services/image-service.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();

  const sessionService = new SessionService(config.sessionSecret);
  const oidcService = new OidcClientService(config, `${config.baseUrl}/v1/auth/callback`);
  const storageService = new S3StorageService(config);
  const processor = new ImageProcessor(config.imageMaxPixels);
  const groupService = new GroupService();
  const imageService = new ImageService(storageService, processor, groupService);

  // Auto-ensure S3 bucket exists
  await storageService.ensureBucket().catch((err) => {
    console.warn('Storage bucket initialization warning:', err.message);
  });

  const app = buildApp({
    config,
    sessionService,
    oidcService,
    storageService,
    processor,
    groupService,
    imageService,
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`ImageHost server listening at http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
