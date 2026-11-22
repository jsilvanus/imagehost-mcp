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

  async signUploadToken(userId: string, uploadId: string, expiresIn = '15m'): Promise<string> {
    return await new jose.SignJWT({ uploadId, purpose: 'upload' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.key);
  }

  async verifyUploadToken(token: string, uploadId: string): Promise<{ userId: string } | null> {
    try {
      const { payload } = await jose.jwtVerify(token, this.key);
      if (payload.purpose !== 'upload' || payload.uploadId !== uploadId || !payload.sub) {
        return null;
      }
      return { userId: payload.sub as string };
    } catch {
      return null;
    }
  }

  async signDownloadToken(
    userId: string,
    imageId: string,
    variant: string,
    expiresIn = '24h',
  ): Promise<string> {
    return await new jose.SignJWT({ imageId, variant, purpose: 'download' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.key);
  }

  async verifyDownloadToken(
    token: string,
    imageId: string,
    variant?: string,
  ): Promise<{ userId: string } | null> {
    try {
      const { payload } = await jose.jwtVerify(token, this.key);
      if (payload.purpose !== 'download' || payload.imageId !== imageId || !payload.sub) {
        return null;
      }
      if (variant && payload.variant && payload.variant !== variant) {
        return null;
      }
      return { userId: payload.sub as string };
    } catch {
      return null;
    }
  }
}
