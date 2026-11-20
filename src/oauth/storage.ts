import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface AuthStore {
  saveAuthorizationCode(record: AuthorizationCodeRecord): void;
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined;
  saveRefreshToken(record: RefreshTokenRecord): void;
  getRefreshToken(token: string): RefreshTokenRecord | undefined;
}

export interface McpUser {
  id: string;
  name: string;
  email?: string;
  passwordHash?: string;
  createdAt: number;
}

export interface UserStore {
  createUser(user: McpUser): Promise<void> | void;
  getUser(id: string): Promise<McpUser | undefined> | McpUser | undefined;
  getUserByEmail(email: string): Promise<McpUser | undefined> | McpUser | undefined;
}

export class MemoryAuthStore implements AuthStore {
  private codes = new Map<string, AuthorizationCodeRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();

  saveAuthorizationCode(record: AuthorizationCodeRecord): void {
    this.cleanExpired();
    this.codes.set(record.code, record);
  }

  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined {
    this.cleanExpired();
    const record = this.codes.get(code);
    if (!record) return undefined;
    this.codes.delete(code);
    if (Date.now() > record.expires) return undefined;
    return record;
  }

  saveRefreshToken(record: RefreshTokenRecord): void {
    this.cleanExpired();
    this.refreshTokens.set(record.token, record);
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    this.cleanExpired();
    const record = this.refreshTokens.get(token);
    if (!record) return undefined;
    if (Date.now() > record.expires) {
      this.refreshTokens.delete(token);
      return undefined;
    }
    return record;
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) {
      if (now > v.expires) this.codes.delete(k);
    }
    for (const [k, v] of this.refreshTokens) {
      if (now > v.expires) this.refreshTokens.delete(k);
    }
  }
}

export class DefaultUserStore implements UserStore {
  private memoryUsers = new Map<string, McpUser>();

  createUser(user: McpUser): void {
    this.memoryUsers.set(user.id, user);
    if (user.email) {
      this.memoryUsers.set(`email:${user.email.toLowerCase()}`, user);
    }
  }

  async getUser(id: string): Promise<McpUser | undefined> {
    const mem = this.memoryUsers.get(id);
    if (mem) return mem;

    try {
      const [u] = await db.select().from(users).where(eq(users.id, id));
      if (!u) return undefined;
      return {
        id: u.id,
        name: u.displayName || u.email || 'User',
        email: u.email || undefined,
        createdAt: u.createdAt.getTime(),
      };
    } catch {
      return undefined;
    }
  }

  async getUserByEmail(email: string): Promise<McpUser | undefined> {
    const mem = this.memoryUsers.get(`email:${email.toLowerCase()}`);
    if (mem) return mem;

    try {
      const [u] = await db.select().from(users).where(eq(users.email, email));
      if (!u) return undefined;
      return {
        id: u.id,
        name: u.displayName || u.email || 'User',
        email: u.email || undefined,
        createdAt: u.createdAt.getTime(),
      };
    } catch {
      return undefined;
    }
  }
}
