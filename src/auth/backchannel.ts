import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Database } from '../db/index.js';
import type { SessionService } from './session.js';
import type { AuthStore, UserStore } from '../oauth/storage.js';
import { getRemoteJWKSet, resolveUserBySub } from './jwt-verify.js';

export interface BackchannelLogoutOptions {
  oidcIssuer: string;
  jwksUri?: string;
  oidcClientId?: string;
  publicUrl?: string;
  db?: Database;
  sessionService?: SessionService;
  authStore?: AuthStore;
  userStore?: UserStore;
  jwks?: JWTVerifyGetKey;
  resolveUser?: (sub: string, issuer?: string) => Promise<string | null>;
}

export async function processBackchannelLogout(
  logoutToken: string,
  options: BackchannelLogoutOptions,
): Promise<{ ok: boolean }> {
  const normIssuer = options.oidcIssuer.replace(/\/+$/, '');
  const jwksUri = options.jwksUri || `${normIssuer}/jwks`;
  const jwks = options.jwks ?? getRemoteJWKSet(jwksUri);

  const { payload } = await jwtVerify(logoutToken, jwks, {
    issuer: [options.oidcIssuer, normIssuer],
    algorithms: ['RS256'],
  });

  // OpenID Connect Back-Channel Logout 1.0 section 2.4:
  // Must NOT contain a nonce claim
  if (payload.nonce !== undefined) {
    throw new Error('nonce_claim_present');
  }

  // Must contain events claim with backchannel-logout or tunnus mcp-revoke
  if (!payload.events || typeof payload.events !== 'object') {
    throw new Error('missing_events_claim');
  }
  const events = payload.events as Record<string, unknown>;
  const hasBackchannelEvent =
    'http://schemas.openid.net/event/backchannel-logout' in events ||
    'https://tunnus.fi/event/mcp-revoke' in events;
  if (!hasBackchannelEvent) {
    throw new Error('invalid_events_claim');
  }

  // Validate audience if configured
  const allowedAudiences = new Set<string>();
  if (options.oidcClientId) allowedAudiences.add(options.oidcClientId);
  if (options.publicUrl) {
    const normPublic = options.publicUrl.replace(/\/+$/, '');
    allowedAudiences.add(options.publicUrl);
    allowedAudiences.add(normPublic);
    allowedAudiences.add(`${options.publicUrl}/mcp`);
    allowedAudiences.add(`${normPublic}/mcp`);
  }

  if (allowedAudiences.size > 0) {
    const tokenAudiences = Array.isArray(payload.aud)
      ? payload.aud
      : typeof payload.aud === 'string'
        ? [payload.aud]
        : [];
    const matchesAudience = tokenAudiences.some((a) => allowedAudiences.has(a));
    if (!matchesAudience) {
      throw new Error('invalid_audience');
    }
  }

  // Must have sub or sid
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
  if (!sub && !sid) {
    throw new Error('missing_sub_or_sid');
  }

  if (sub) {
    const userIdsToRevoke = new Set<string>();
    userIdsToRevoke.add(sub);

    const resolved = await resolveUserBySub(sub, normIssuer, undefined, {
      db: options.db,
      userStore: options.userStore,
      resolveUser: options.resolveUser,
    });
    if (resolved) userIdsToRevoke.add(resolved);

    for (const uid of userIdsToRevoke) {
      // 1. Revoke active sessions in sessionService
      options.sessionService?.revokeAllSessions?.(uid);

      // 2. Revoke active refresh tokens in authStore
      if (options.authStore?.revokeUserRefreshTokens) {
        await options.authStore.revokeUserRefreshTokens(uid);
      }
    }
  }

  return { ok: true };
}
