import * as jose from 'jose';
import type { UserProfile } from '../types/index.js';

export interface SessionPayload {
  userId: string;
  oidcIssuer: string;
  oidcSub: string;
  email?: string;
  displayName?: string;
}

export class SessionService {
  private key: Uint8Array;
  private revokedUsers = new Map<string, number>();

  constructor(secret: string) {
    // Ensure key is 32 bytes or hash it
    this.key = new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32));
  }

  async signSession(payload: SessionPayload): Promise<string> {
    return await new jose.SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(this.key);
  }

  async verifySession(token: string): Promise<SessionPayload | null> {
    try {
      const { payload } = await jose.jwtVerify(token, this.key);
      const session = payload as unknown as SessionPayload & { iat?: number };
      const revokedAt = this.revokedUsers.get(session.userId);
      if (revokedAt !== undefined && session.iat !== undefined && session.iat * 1000 <= revokedAt) {
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  revokeUser(userId: string): void {
    this.revokedUsers.set(userId, Date.now());
  }

  revokeAllSessions(userId: string): void {
    this.revokeUser(userId);
  }
}
