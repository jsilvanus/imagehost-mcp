import { eq, and, sql, desc, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { images, imageVariants, tags, imageTags, eventOutbox, groups } from '../db/schema.js';
import type {
  ImageModel,
  VariantType,
  PresignedDownloadUrl,
  EventOutboxModel,
} from '../types/index.js';
import type { S3StorageService } from '../storage/s3.js';
import type { ImageProcessor } from './image-processor.js';
import type { GroupService } from './group-service.js';

export class ImageService {
  constructor(
    private s3: S3StorageService,
    private processor: ImageProcessor,
    private groupService: GroupService,
  ) {}

  /**
   * Helper to format human-friendly 3-digit sequence number (001, 002)
   */
  formatSequence(seq: number): string {
    return String(seq).padStart(3, '0');
  }

  /**
   * Initiates an upload session, reserving sequence number and creating presigned upload URL
   */
  async createUploadSession(
    ownerId: string,
    groupId: string,
    data: {
      filename: string;
      mediaType: string;
      byteSize: number;
      description?: string;
      tagsList?: string[];
    },
  ) {
    const group = await this.groupService.getGroup(ownerId, groupId);
    if (!group) {
      throw new Error('Group not found');
    }

    const sequenceNumber = await this.groupService.allocateNextSequenceNumber(ownerId, groupId);

    const [created] = await db
      .insert(images)
      .values({
        groupId,
        ownerId,
        sequenceNumber,
        originalFilename: data.filename,
        mediaType: data.mediaType,
        byteSize: data.byteSize,
        description: data.description,
        status: 'pending',
        deletionState: 'active',
      })
      .returning();

    const storageKey = `users/${ownerId}/images/${created.id}/original`;
    const uploadUrl = await this.s3.createPresignedUploadUrl(storageKey, data.mediaType, 900);

    // Record original variant key in DB
    await db.insert(imageVariants).values({
      imageId: created.id,
      variantType: 'original',
      storageKey,
      mediaType: data.mediaType,
      byteSize: data.byteSize,
    });

    if (data.tagsList && data.tagsList.length > 0) {
      await this.addTags(ownerId, created.id, data.tagsList);
    }

    return {
      uploadId: created.id,
      uploadUrl,
      sequenceNumber,
      formattedSequence: this.formatSequence(sequenceNumber),
      expiresInSeconds: 900,
    };
  }

  /**
   * Complete an upload: reads original from S3, generates derivatives via Sharp, saves them to S3 and updates image state to ready
   */
  async completeUpload(ownerId: string, imageId: string): Promise<ImageModel> {
    const [image] = await db
      .select()
      .from(images)
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
      .limit(1);

    if (!image) {
      throw new Error('Image not found');
    }

    // Mark status processing
    await db
      .update(images)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(images.id, imageId));

    try {
      const originalKey = `users/${ownerId}/images/${imageId}/original`;
      const originalBuffer = await this.s3.getObjectBuffer(originalKey);

      const processed = await this.processor.processImage(originalBuffer);

      // Upload generated variants
      for (const variant of processed.variants) {
        const variantKey = `users/${ownerId}/images/${imageId}/${variant.variantType}.webp`;
        await this.s3.putObject(variantKey, variant.buffer, variant.mediaType);

        await db
          .insert(imageVariants)
          .values({
            imageId,
            variantType: variant.variantType,
            storageKey: variantKey,
            mediaType: variant.mediaType,
            width: variant.width,
            height: variant.height,
            byteSize: variant.byteSize,
          })
          .onConflictDoUpdate({
            target: [imageVariants.imageId, imageVariants.variantType],
            set: {
              storageKey: variantKey,
              mediaType: variant.mediaType,
              width: variant.width,
              height: variant.height,
              byteSize: variant.byteSize,
            },
          });
      }

      // Update image status to ready with dimensions
      await db.transaction(async (tx) => {
        await tx
          .update(images)
          .set({
            status: 'ready',
            width: processed.originalWidth,
            height: processed.originalHeight,
            updatedAt: new Date(),
          })
          .where(eq(images.id, imageId));

        // Emit durable outbox event
        await tx.insert(eventOutbox).values({
          eventType: 'image.processing.completed',
          ownerId,
          groupId: image.groupId,
          imageId: image.id,
          payload: {
            imageId: image.id,
            sequenceNumber: image.sequenceNumber,
            status: 'ready',
          },
        });
      });

      return (await this.getImage(ownerId, imageId))!;
    } catch (err) {
      await db
        .update(images)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(images.id, imageId));

      await db.insert(eventOutbox).values({
        eventType: 'image.processing.failed',
        ownerId,
        groupId: image.groupId,
        imageId: image.id,
        payload: {
          imageId: image.id,
          error: String(err),
        },
      });

      throw err;
    }
  }

  async getImage(ownerId: string, imageId: string): Promise<ImageModel | null> {
    const [image] = await db
      .select()
      .from(images)
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
      .limit(1);

    if (!image) return null;

    const imgTags = await db
      .select({ name: tags.name })
      .from(imageTags)
      .innerJoin(tags, eq(imageTags.tagId, tags.id))
      .where(eq(imageTags.imageId, imageId));

    return {
      ...(image as ImageModel),
      tags: imgTags.map((t) => t.name),
    };
  }

  async listGroupImages(
    ownerId: string,
    groupId: string,
    options?: { limit?: number; cursor?: number; includePendingDeletion?: boolean },
  ): Promise<{ items: ImageModel[]; nextCursor: number | null }> {
    const limit = options?.limit ?? 50;

    const rows = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.ownerId, ownerId),
          eq(images.groupId, groupId),
          options?.includePendingDeletion
            ? sql`${images.deletionState} != 'deleted'`
            : eq(images.deletionState, 'active'),
          options?.cursor ? sql`${images.sequenceNumber} > ${options.cursor}` : undefined,
        ),
      )
      .orderBy(images.sequenceNumber)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows) as ImageModel[];
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].sequenceNumber : null;

    if (items.length > 0) {
      const ids = items.map((i) => i.id);
      const tagRows = await db
        .select({ imageId: imageTags.imageId, name: tags.name })
        .from(imageTags)
        .innerJoin(tags, eq(imageTags.tagId, tags.id))
        .where(inArray(imageTags.imageId, ids));

      const tagMap = new Map<string, string[]>();
      for (const row of tagRows) {
        const list = tagMap.get(row.imageId) ?? [];
        list.push(row.name);
        tagMap.set(row.imageId, list);
      }
      for (const item of items) {
        item.tags = tagMap.get(item.id) ?? [];
      }
    }

    return {
      items,
      nextCursor,
    };
  }

  /**
   * Search images across user's library by query string, group, or tags
   */
  async searchImages(
    ownerId: string,
    options?: {
      query?: string;
      groupId?: string;
      tags?: string[];
      limit?: number;
      cursor?: string;
      includePendingDeletion?: boolean;
    },
  ): Promise<{ items: ImageModel[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);

    let tagImageIds: string[] | undefined;
    if (options?.tags && options.tags.length > 0) {
      const matchingTags = await db
        .select({ imageId: imageTags.imageId })
        .from(imageTags)
        .innerJoin(tags, eq(imageTags.tagId, tags.id))
        .where(and(eq(tags.ownerId, ownerId), inArray(tags.name, options.tags)));

      tagImageIds = matchingTags.map((r) => r.imageId);
      if (tagImageIds.length === 0) {
        return { items: [], nextCursor: null };
      }
    }

    let cursorDate: Date | undefined;
    let cursorId: string | undefined;
    if (options?.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (decoded.createdAt && decoded.id) {
          cursorDate = new Date(decoded.createdAt);
          cursorId = decoded.id;
        }
      } catch {
        // ignore malformed cursor
      }
    }

    const conditions = [
      eq(images.ownerId, ownerId),
      options?.includePendingDeletion
        ? sql`${images.deletionState} != 'deleted'`
        : eq(images.deletionState, 'active'),
    ];

    if (options?.groupId) {
      conditions.push(eq(images.groupId, options.groupId));
    }

    if (tagImageIds) {
      conditions.push(inArray(images.id, tagImageIds));
    }

    if (options?.query && options.query.trim().length > 0) {
      const q = `%${options.query.trim()}%`;
      conditions.push(
        sql`(${images.description} ILIKE ${q} OR ${images.originalFilename} ILIKE ${q})`,
      );
    }

    if (cursorDate && cursorId) {
      conditions.push(
        sql`(${images.createdAt} < ${cursorDate} OR (${images.createdAt} = ${cursorDate} AND ${images.id} < ${cursorId}))`,
      );
    }

    const rows = await db
      .select()
      .from(images)
      .where(and(...conditions))
      .orderBy(desc(images.createdAt), desc(images.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows) as ImageModel[];

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
      ).toString('base64url');
    }

    if (items.length > 0) {
      const ids = items.map((i) => i.id);
      const tagRows = await db
        .select({ imageId: imageTags.imageId, name: tags.name })
        .from(imageTags)
        .innerJoin(tags, eq(imageTags.tagId, tags.id))
        .where(inArray(imageTags.imageId, ids));

      const tagMap = new Map<string, string[]>();
      for (const row of tagRows) {
        const list = tagMap.get(row.imageId) ?? [];
        list.push(row.name);
        tagMap.set(row.imageId, list);
      }
      for (const item of items) {
        item.tags = tagMap.get(item.id) ?? [];
      }
    }

    return {
      items,
      nextCursor,
    };
  }

  async updateDescription(
    ownerId: string,
    imageId: string,
    description: string,
  ): Promise<ImageModel | null> {
    const [updated] = await db
      .update(images)
      .set({ description, updatedAt: new Date() })
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
      .returning();

    if (!updated) return null;

    await db.insert(eventOutbox).values({
      eventType: 'image.metadata.updated',
      ownerId,
      groupId: updated.groupId,
      imageId: updated.id,
      payload: { description },
    });

    return await this.getImage(ownerId, imageId);
  }

  async addTags(ownerId: string, imageId: string, tagNames: string[]): Promise<ImageModel | null> {
    const image = await this.getImage(ownerId, imageId);
    if (!image) return null;

    for (const rawName of tagNames) {
      const name = rawName.trim().toLowerCase();
      if (!name) continue;

      let [existingTag] = await db
        .select()
        .from(tags)
        .where(and(eq(tags.ownerId, ownerId), eq(tags.name, name)))
        .limit(1);

      if (!existingTag) {
        [existingTag] = await db.insert(tags).values({ ownerId, name }).returning();
      }

      await db.insert(imageTags).values({ imageId, tagId: existingTag.id }).onConflictDoNothing();
    }

    await db.insert(eventOutbox).values({
      eventType: 'image.tags.updated',
      ownerId,
      groupId: image.groupId,
      imageId: image.id,
      payload: { tags: tagNames },
    });

    return await this.getImage(ownerId, imageId);
  }

  async removeTags(
    ownerId: string,
    imageId: string,
    tagNames: string[],
  ): Promise<ImageModel | null> {
    const image = await this.getImage(ownerId, imageId);
    if (!image) return null;

    for (const rawName of tagNames) {
      const name = rawName.trim().toLowerCase();
      const [existingTag] = await db
        .select()
        .from(tags)
        .where(and(eq(tags.ownerId, ownerId), eq(tags.name, name)))
        .limit(1);

      if (existingTag) {
        await db
          .delete(imageTags)
          .where(and(eq(imageTags.imageId, imageId), eq(imageTags.tagId, existingTag.id)));
      }
    }

    return await this.getImage(ownerId, imageId);
  }

  /**
   * Soft deletion requested: marks image pending_deletion with deadline derived from group retention hours
   */
  async requestDeletion(
    ownerId: string,
    imageId: string,
    requestedBy = 'agent',
  ): Promise<ImageModel | null> {
    const image = await this.getImage(ownerId, imageId);
    if (!image) return null;

    const group = await this.groupService.getGroup(ownerId, image.groupId);
    const retentionHours = group?.retentionHours ?? 72;

    const now = new Date();
    const deadline = new Date(now.getTime() + retentionHours * 3600 * 1000);

    const [updated] = await db
      .update(images)
      .set({
        deletionState: 'pending_deletion',
        deletionRequestedAt: now,
        deletionDeadline: deadline,
        deletionRequestedBy: requestedBy,
        updatedAt: now,
      })
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
      .returning();

    await db.insert(eventOutbox).values({
      eventType: 'image.deletion.requested',
      ownerId,
      groupId: image.groupId,
      imageId: image.id,
      payload: {
        deletionDeadline: deadline.toISOString(),
        requestedBy,
      },
    });

    return await this.getImage(ownerId, imageId);
  }

  /**
   * Restore a pending-deletion image before its deadline
   */
  async restoreImage(ownerId: string, imageId: string): Promise<ImageModel | null> {
    const [updated] = await db
      .update(images)
      .set({
        deletionState: 'active',
        deletionRequestedAt: null,
        deletionDeadline: null,
        deletionRequestedBy: null,
        updatedAt: new Date(),
      })
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
      .returning();

    if (!updated) return null;

    await db.insert(eventOutbox).values({
      eventType: 'image.restored',
      ownerId,
      groupId: updated.groupId,
      imageId: updated.id,
      payload: { imageId: updated.id },
    });

    return await this.getImage(ownerId, imageId);
  }

  /**
   * Generates a 1-hour presigned GET URL for an image variant
   */
  async getDownloadUrl(
    ownerId: string,
    imageId: string,
    variant: VariantType = 'preview',
  ): Promise<PresignedDownloadUrl> {
    const image = await this.getImage(ownerId, imageId);
    if (!image) {
      throw new Error('Image not found');
    }
    if (image.status !== 'ready') {
      throw new Error(`Image is not ready (status: ${image.status})`);
    }
    if (image.deletionState !== 'active') {
      throw new Error('Image is pending deletion or deleted');
    }

    const [imgVariant] = await db
      .select()
      .from(imageVariants)
      .where(and(eq(imageVariants.imageId, imageId), eq(imageVariants.variantType, variant)))
      .limit(1);

    if (!imgVariant) {
      throw new Error(`Variant ${variant} not found for image`);
    }

    const ttlSeconds = 3600; // Fixed 1 hour per product specification
    const url = await this.s3.createPresignedDownloadUrl(imgVariant.storageKey, ttlSeconds);

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return {
      imageId,
      variant,
      url,
      expiresAt,
      expiresInSeconds: ttlSeconds,
      mediaType: imgVariant.mediaType,
      byteSize: imgVariant.byteSize,
    };
  }

  /**
   * Batch issues presigned download URLs with independent authorization per item
   */
  async getBatchDownloadUrls(
    ownerId: string,
    items: Array<{ imageId: string; variant?: VariantType }>,
  ) {
    const results = [];
    for (const item of items) {
      try {
        const downloadInfo = await this.getDownloadUrl(
          ownerId,
          item.imageId,
          item.variant ?? 'preview',
        );
        results.push({
          imageId: item.imageId,
          variant: item.variant ?? 'preview',
          url: downloadInfo.url,
          expiresAt: downloadInfo.expiresAt,
        });
      } catch (err: any) {
        results.push({
          imageId: item.imageId,
          variant: item.variant ?? 'preview',
          error: err.message || 'Failed to issue URL',
        });
      }
    }
    return results;
  }

  /**
   * Catch up on durable events using cursor
   */
  async getChanges(
    ownerId: string,
    afterCursor = 0,
    limit = 100,
  ): Promise<{ changes: EventOutboxModel[]; lastCursor: number }> {
    const rows = await db
      .select()
      .from(eventOutbox)
      .where(and(eq(eventOutbox.ownerId, ownerId), sql`${eventOutbox.cursor} > ${afterCursor}`))
      .orderBy(eventOutbox.cursor)
      .limit(limit);

    const changes = rows as EventOutboxModel[];
    const lastCursor = changes.length > 0 ? changes[changes.length - 1].cursor : afterCursor;

    return { changes, lastCursor };
  }
}
