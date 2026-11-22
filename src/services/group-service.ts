import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { groups } from '../db/schema.js';
import type { GroupModel } from '../types/index.js';

export class GroupService {
  async createGroup(
    ownerId: string,
    data: { name: string; description?: string; retentionHours?: number },
  ): Promise<GroupModel> {
    const [group] = await db
      .insert(groups)
      .values({
        ownerId,
        name: data.name,
        description: data.description,
        retentionHours: data.retentionHours ?? 72,
        status: 'active',
        nextSequenceNumber: 1,
      })
      .returning();

    return group as GroupModel;
  }

  async getGroup(ownerId: string, groupId: string): Promise<GroupModel | null> {
    const [group] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
      .limit(1);

    return (group as GroupModel) ?? null;
  }

  async listGroups(ownerId: string): Promise<GroupModel[]> {
    const list = await db
      .select()
      .from(groups)
      .where(eq(groups.ownerId, ownerId))
      .orderBy(groups.createdAt);

    return list as GroupModel[];
  }

  async getOrCreateGroupByName(
    ownerId: string,
    name: string,
    description = 'Imported from ChatGPT',
  ): Promise<GroupModel> {
    const list = await this.listGroups(ownerId);
    const existing = list.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    return await this.createGroup(ownerId, { name, description });
  }

  async updateGroup(
    ownerId: string,
    groupId: string,
    updates: { name?: string; description?: string; retentionHours?: number },
  ): Promise<GroupModel | null> {
    const [updated] = await db
      .update(groups)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
      .returning();

    return (updated as GroupModel) ?? null;
  }

  /**
   * Concurrency-safe atomic allocation of next sequence number for a group.
   * Atomically locks and increments the group's counter.
   */
  async allocateNextSequenceNumber(ownerId: string, groupId: string): Promise<number> {
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(groups)
        .set({
          nextSequenceNumber: sql`${groups.nextSequenceNumber} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
        .returning({ allocated: sql<number>`${groups.nextSequenceNumber} - 1` });

      if (!updated) {
        throw new Error(`Group not found or unauthorized: ${groupId}`);
      }
      return updated.allocated;
    });

    return result;
  }
}
