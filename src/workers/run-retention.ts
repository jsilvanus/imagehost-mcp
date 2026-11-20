import { loadConfig } from '../config.js';
import { S3StorageService } from '../storage/s3.js';
import { RetentionWorker } from './retention-worker.js';
import { sqlClient } from '../db/index.js';

async function main() {
  const config = loadConfig();
  const storage = new S3StorageService(config);
  const worker = new RetentionWorker(storage, config.retentionWorkerIntervalSeconds);

  console.log('Running one-off retention cleanup...');
  const result = await worker.runOnce();
  console.log('Retention cleanup complete:', result);

  if (process.argv.includes('--daemon')) {
    console.log('Starting daemon retention worker...');
    worker.start();

    const shutdown = async () => {
      console.log('Stopping retention worker daemon...');
      worker.stop();
      await sqlClient.end();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    await sqlClient.end();
    process.exit(0);
  }
}

main().catch(async (err) => {
  console.error('Retention worker fatal error:', err);
  await sqlClient.end();
  process.exit(1);
});
