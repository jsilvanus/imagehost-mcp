import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import type { UserProfile } from '../types/index.js';

export async function getOrCreateUser(
  oidcIssuer: string,
  oidcSub: string,
  profile?: { email?: string; displayName?: string },
): Promise<UserProfile> {
  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, oidcIssuer), eq(users.oidcSub, oidcSub)))
    .limit(1);

  if (existing.length > 0) {
    const user = existing[0];
    if (
      (profile?.email && profile.email !== user.email) ||
      (profile?.displayName && profile.displayName !== user.displayName)
    ) {
      await db
        .update(users)
        .set({
          email: profile.email ?? user.email,
          displayName: profile.displayName ?? user.displayName,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    }
    return {
      id: user.id,
      oidcIssuer: user.oidcIssuer,
      oidcSub: user.oidcSub,
      email: profile?.email ?? user.email,
      displayName: profile?.displayName ?? user.displayName,
    };
  }

  const [created] = await db
    .insert(users)
    .values({
      oidcIssuer,
      oidcSub,
      email: profile?.email,
      displayName: profile?.displayName,
    })
    .returning();

  return {
    id: created.id,
    oidcIssuer: created.oidcIssuer,
    oidcSub: created.oidcSub,
    email: created.email,
    displayName: created.displayName,
  };
}
