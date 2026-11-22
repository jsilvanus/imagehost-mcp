import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Database } from '../db/index.js';
import { db as defaultDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getOrCreateUser } from './users.js';
import type { UserStore } from '../oauth/storage.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function getRemoteJWKSet(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

export function clearJWKSCache(): void {
  jwksCache.clear();
}

export interface ResolveUserOptions {
  db?: Database;
  userStore?: UserStore;
  resolveUser?: (
    sub: string,
    issuer?: string,
    claims?: Record<string, unknown>,
  ) => Promise<string | null>;
}

export async function resolveUserBySub(
  sub: string,
  issuer?: string,
  claims?: Record<string, unknown>,
  options?: ResolveUserOptions,
): Promise<string | null> {
  if (options?.resolveUser) {
    const custom = await options.resolveUser(sub, issuer, claims);
    if (custom) return custom;
  }

  const database = options?.db ?? defaultDb;

  try {
    if (issuer) {
      const rows = await database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSub, sub)))
        .limit(1);
      if (rows[0]?.id) return rows[0].id;
    }

    const idRows = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.oidcSub, sub))
      .limit(1);
    if (idRows[0]?.id) return idRows[0].id;

    if (UUID_REGEX.test(sub)) {
      const userRows = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, sub))
        .limit(1);
      if (userRows[0]?.id) return userRows[0].id;
    }

    if (issuer) {
      const created = await getOrCreateUser(issuer, sub, {
        email: claims?.email as string | undefined,
        displayName: (claims?.name || claims?.displayName) as string | undefined,
      });
      return created.id;
    }
  } catch {
    // Database lookup failed (e.g. mock DB / in-memory test)
  }

  if (options?.userStore) {
    const memUser = await options.userStore.getUser(sub);
    if (memUser) return memUser.id;
  }

  return sub;
}

export interface VerifyTunnusTokenOptions {
  oidcIssuer: string;
  jwksUri?: string;
  publicUrl: string;
  jwks?: JWTVerifyGetKey;
  db?: Database;
  userStore?: UserStore;
  resolveUser?: (
    sub: string,
    issuer?: string,
    claims?: Record<string, unknown>,
  ) => Promise<string | null>;
}

export interface VerifiedTunnusAuth {
  userId: string;
  clientId: string;
  scopes: string[];
  extra?: Record<string, unknown>;
}

export async function verifyTunnusToken(
  token: string,
  options: VerifyTunnusTokenOptions,
): Promise<VerifiedTunnusAuth> {
  const normIssuer = options.oidcIssuer.replace(/\/+$/, '');
  const jwksUri = options.jwksUri || `${normIssuer}/jwks`;
  const jwks = options.jwks ?? getRemoteJWKSet(jwksUri);

  const { payload } = await jwtVerify(token, jwks, {
    issuer: [options.oidcIssuer, normIssuer],
    algorithms: ['RS256'],
  });

  // Audience validation: aud === publicUrl || aud === publicUrl + '/mcp'
  const normPublic = options.publicUrl.replace(/\/+$/, '');
  const allowedAudiences = new Set([
    options.publicUrl,
    normPublic,
    `${options.publicUrl}/mcp`,
    `${normPublic}/mcp`,
  ]);

  const tokenAudiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];

  const hasAudience = tokenAudiences.some((a) => allowedAudiences.has(a));
  if (!hasAudience) {
    throw new Error('invalid_audience');
  }

  // Scope validation: scope must contain 'images:read' or 'mcp'
  const rawScope = payload.scope;
  const scopes =
    typeof rawScope === 'string'
      ? rawScope.split(' ').filter(Boolean)
      : Array.isArray(rawScope)
        ? rawScope.filter((s): s is string => typeof s === 'string')
        : [];

  const hasRequiredScope = scopes.includes('images:read') || scopes.includes('mcp');
  if (!hasRequiredScope) {
    throw new Error('insufficient_scope');
  }

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('missing_sub');
  }

  const userId = await resolveUserBySub(payload.sub, normIssuer, payload as Record<string, unknown>, {
    db: options.db,
    userStore: options.userStore,
    resolveUser: options.resolveUser,
  });

  if (!userId) {
    throw new Error('user_not_found');
  }

  const clientId =
    (typeof payload.client_id === 'string' ? payload.client_id : undefined) ??
    (typeof payload.azp === 'string' ? payload.azp : undefined) ??
    'tunnus-client';

  return {
    userId,
    clientId,
    scopes,
    extra: {
      userId,
      sub: payload.sub,
    },
  };
}
