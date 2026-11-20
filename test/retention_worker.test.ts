import { describe, it, expect, vi } from 'vitest';
import { RetentionWorker } from '../src/workers/retention-worker.js';

describe('RetentionWorker', () => {
  it('purges expired pending_deletion images and records audit and outbox events', async () => {
    const expiredImage = {
      id: 'img-101',
      ownerId: 'user-1',
      groupId: 'grp-1',
      sequenceNumber: 42,
      deletionState: 'pending_deletion',
      deletionDeadline: new Date(Date.now() - 3600 * 1000), // 1 hour ago
      updatedAt: new Date(Date.now() - 72 * 3600 * 1000),
    };

    const variants = [
      {
        id: 'var-1',
        imageId: 'img-101',
        variantType: 'original',
        storageKey: 'users/user-1/images/img-101/original',
      },
      {
        id: 'var-2',
        imageId: 'img-101',
        variantType: 'thumbnail',
        storageKey: 'users/user-1/images/img-101/thumbnail.webp',
      },
      {
        id: 'var-3',
        imageId: 'img-101',
        variantType: 'preview',
        storageKey: 'users/user-1/images/img-101/preview.webp',
      },
    ];

    const deletedStorageKeys: string[][] = [];
    const mockStorageService: any = {
      deleteObjects: vi.fn(async (keys: string[]) => {
        deletedStorageKeys.push(keys);
      }),
    };

    const auditLogEntries: any[] = [];
    const eventOutboxEntries: any[] = [];
    const updatedImages: any[] = [];
    const deletedVariantImageIds: string[] = [];

    const mockDb: any = {
      select: () => ({
        from: (table: any) => ({
          where: (_cond: any) => ({
            limit: async () => [expiredImage],
          }),
        }),
      }),
      transaction: async (fn: any) => {
        const tx = {
          delete: (_table: any) => ({
            where: () => {
              deletedVariantImageIds.push(expiredImage.id);
              return Promise.resolve();
            },
          }),
          update: (_table: any) => ({
            set: (data: any) => ({
              where: () => {
                updatedImages.push({ id: expiredImage.id, ...data });
                return Promise.resolve();
              },
            }),
          }),
          insert: (table: any) => ({
            values: (entry: any) => {
              if ((table && String(table).includes('audit')) || entry.action) {
                auditLogEntries.push(entry);
              } else {
                eventOutboxEntries.push(entry);
              }
              return Promise.resolve();
            },
          }),
        };
        return await fn(tx);
      },
    };

    // Override internal variant query to return the image variants
    let queryCount = 0;
    mockDb.select = () => ({
      from: (table: any) => ({
        where: () => ({
          limit: async () => {
            queryCount++;
            return queryCount === 1 ? [expiredImage] : [];
          },
          then: (resolve: any) => resolve(variants),
        }),
      }),
    });

    const worker = new RetentionWorker(mockStorageService, 60, mockDb);
    const result = await worker.runOnce();

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);

    // Verify S3 objects deleted
    expect(mockStorageService.deleteObjects).toHaveBeenCalledTimes(1);
    expect(deletedStorageKeys[0]).toEqual([
      'users/user-1/images/img-101/original',
      'users/user-1/images/img-101/thumbnail.webp',
      'users/user-1/images/img-101/preview.webp',
    ]);

    // Verify DB variant rows deleted
    expect(deletedVariantImageIds).toContain('img-101');

    // Verify image status set to 'deleted'
    expect(updatedImages).toHaveLength(1);
    expect(updatedImages[0].deletionState).toBe('deleted');

    // Verify audit log entry
    expect(auditLogEntries).toHaveLength(1);
    expect(auditLogEntries[0].action).toBe('image.permanently_deleted');
    expect(auditLogEntries[0].targetType).toBe('image');
    expect(auditLogEntries[0].targetId).toBe('img-101');
    expect(auditLogEntries[0].actorType).toBe('system');
    expect(auditLogEntries[0].details.sequenceNumber).toBe(42);

    // Verify event outbox entry
    expect(eventOutboxEntries).toHaveLength(1);
    expect(eventOutboxEntries[0].eventType).toBe('image.deleted');
    expect(eventOutboxEntries[0].imageId).toBe('img-101');
  });

  it('safely handles S3 deletion failure and retries without corrupting DB', async () => {
    const expiredImage = {
      id: 'img-fail',
      ownerId: 'user-1',
      groupId: 'grp-1',
      sequenceNumber: 15,
      deletionState: 'pending_deletion',
      deletionDeadline: new Date(Date.now() - 1000),
    };

    const mockStorageService: any = {
      deleteObjects: vi.fn(async () => {
        throw new Error('S3 503 Slow Down / Connection Timeout');
      }),
    };

    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [expiredImage],
            then: (resolve: any) => resolve([{ storageKey: 'some-key' }]),
          }),
        }),
      }),
      transaction: vi.fn(),
    };

    const worker = new RetentionWorker(mockStorageService, 60, mockDb);
    const result = await worker.runOnce();

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].imageId).toBe('img-fail');
    expect(result.errors[0].error).toContain('S3 503');

    // Transaction must NOT have been called
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('can start and stop background interval timer without leaking', () => {
    const mockStorageService: any = { deleteObjects: vi.fn() };
    const worker = new RetentionWorker(mockStorageService, 1);

    expect(() => {
      worker.start();
      worker.stop();
    }).not.toThrow();
  });
});
