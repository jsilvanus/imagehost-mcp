import { loadConfig } from './config.js';
import { SessionService } from './auth/session.js';
import { OidcClientService } from './auth/oidc.js';
import { S3StorageService } from './storage/s3.js';
import { ImageProcessor } from './services/image-processor.js';
import { GroupService } from './services/group-service.js';
import { ImageService } from './services/image-service.js';
import { SubscriptionManager } from './services/subscription-manager.js';
import { OutboxDispatcher } from './services/outbox-dispatcher.js';
import { RetentionWorker } from './workers/retention-worker.js';
import { buildApp } from './app.js';
import { sqlClient } from './db/index.js';

async function main() {
  const config = loadConfig();

  const sessionService = new SessionService(config.sessionSecret);
  const oidcService = new OidcClientService(config, `${config.baseUrl}/v1/auth/callback`);
  const storageService = new S3StorageService(config);
  const processor = new ImageProcessor(config.imageMaxPixels);
  const groupService = new GroupService();
  const imageService = new ImageService(storageService, processor, groupService);

  const subscriptionManager = new SubscriptionManager();
  const outboxDispatcher = new OutboxDispatcher(subscriptionManager);
  const retentionWorker = new RetentionWorker(
    storageService,
    config.retentionWorkerIntervalSeconds,
  );

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
    subscriptionManager,
    outboxDispatcher,
    retentionWorker,
  });

  // Start background schedulers if enabled
  if (config.enableRetentionWorker) {
    retentionWorker.start();
  }
  if (config.enableOutboxDispatcher) {
    outboxDispatcher.start(config.outboxDispatcherIntervalMs);
  }

  // Graceful shutdown handling
  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}, initiating graceful shutdown...`);
    retentionWorker.stop();
    outboxDispatcher.stop();
    await app.close();
    await sqlClient.end();
    console.log('Cleanup finished, process exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

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
