import { and, eq, lte } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { images, imageVariants, auditLog, eventOutbox } from '../db/schema.js';
import type { S3StorageService } from '../storage/s3.js';

export interface RetentionCleanupResult {
  scanned: number;
  purged: number;
  failed: number;
  errors: Array<{ imageId: string; error: string }>;
}

export class RetentionWorker {
  private timer?: NodeJS.Timeout;
  private isProcessing = false;
  private db: typeof defaultDb;

  constructor(
    private storageService: S3StorageService,
    private intervalSeconds = 60,
    dbInstance?: typeof defaultDb,
  ) {
    this.db = dbInstance ?? defaultDb;
  }

  /**
   * Scans for expired pending_deletion images and permanently removes their storage assets,
   * updates the image record to 'deleted', records in audit_log, and emits 'image.deleted' event.
   */
  async runOnce(options?: { now?: Date; limit?: number }): Promise<RetentionCleanupResult> {
    if (this.isProcessing) {
      return { scanned: 0, purged: 0, failed: 0, errors: [] };
    }

    this.isProcessing = true;
    const now = options?.now ?? new Date();
    const limit = options?.limit ?? 100;

    const result: RetentionCleanupResult = {
      scanned: 0,
      purged: 0,
      failed: 0,
      errors: [],
    };

    try {
      const expiredImages = await this.db
        .select()
        .from(images)
        .where(and(eq(images.deletionState, 'pending_deletion'), lte(images.deletionDeadline, now)))
        .limit(limit);

      result.scanned = expiredImages.length;

      for (const image of expiredImages) {
        try {
          // 1. Look up all associated variant storage keys
          const variants = await this.db
            .select()
            .from(imageVariants)
            .where(eq(imageVariants.imageId, image.id));

          const storageKeys = variants.map((v) => v.storageKey);

          // 2. Safely delete objects from S3 storage
          if (storageKeys.length > 0) {
            await this.storageService.deleteObjects(storageKeys);
          }

          // 3. Atomically finalize DB state: purge variants, mark image deleted, write audit & outbox
          await this.db.transaction(async (tx) => {
            // Delete variant rows so storage keys are no longer referenced
            await tx.delete(imageVariants).where(eq(imageVariants.imageId, image.id));

            // Retain image record and sequential number so numbering is never reused
            await tx
              .update(images)
              .set({
                deletionState: 'deleted',
                updatedAt: new Date(),
              })
              .where(eq(images.id, image.id));

            // Record in audit_log
            await tx.insert(auditLog).values({
              userId: image.ownerId,
              action: 'image.permanently_deleted',
              targetType: 'image',
              targetId: image.id,
              details: {
                sequenceNumber: image.sequenceNumber,
                groupId: image.groupId,
                deletedKeys: storageKeys,
              },
              actorType: 'system',
            });

            // Emit image.deleted event in event_outbox
            await tx.insert(eventOutbox).values({
              eventType: 'image.deleted',
              ownerId: image.ownerId,
              groupId: image.groupId,
              imageId: image.id,
              payload: {
                imageId: image.id,
                sequenceNumber: image.sequenceNumber,
                groupId: image.groupId,
              },
            });
          });

          result.purged++;
        } catch (err: any) {
          result.failed++;
          result.errors.push({
            imageId: image.id,
            error: err.message || String(err),
          });
          console.error(`Failed to permanently delete image ${image.id}:`, err);
          // Do not update DB state; next worker run will retry safely
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return result;
  }

  /**
   * Start recurring background retention worker.
   */
  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(this.intervalSeconds, 1) * 1000;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        console.error('RetentionWorker background execution failed:', err);
      });
    }, intervalMs);
    console.log(`RetentionWorker started with interval ${this.intervalSeconds}s.`);
  }

  /**
   * Stop recurring background retention worker.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log('RetentionWorker stopped.');
    }
  }
}
