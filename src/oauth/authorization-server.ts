import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthStore, McpUser, UserStore } from './storage.js';
import { fetchCimdMetadata, isCimdClientId, type CimdMetadata } from './cimd.js';
import { randomToken, verifyS256 } from './pkce.js';
import { issueAccessToken } from './jwt.js';
import { contentSecurityPolicy, redirectSource } from './csp.js';

export type { CimdMetadata };

export interface AuthorizationServerOptions {
  /** Resolves a CIMD client_id to its metadata. Replaceable in tests. */
  fetchClientMetadata?: (clientId: string) => Promise<CimdMetadata>;
  oidcIssuerUrl?: string;
  oidcJwksUri?: string;
  jwks?: JWTVerifyGetKey;
  resolveUser?: (
    sub: string,
    issuer?: string,
    claims?: Record<string, unknown>,
  ) => Promise<string | null>;
  brandName?: string;
}

const LOGIN_TICKET_TTL = '10m';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHtml(title) +
    '</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;margin:0;padding:3rem 1rem;color:#1a202c}main{max-width:440px;margin:0 auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{margin-top:0;font-size:1.5rem}label{display:block;margin:.9rem 0 .35rem;font-weight:500;font-size:0.9rem}input{display:block;width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #cbd5e1;border-radius:7px;font-size:1rem}button{margin-top:1.25rem;padding:.75rem 1.25rem;border:0;border-radius:7px;cursor:pointer;font-weight:600;font-size:0.95rem;background:#2563eb;color:#fff}.secondary{margin-left:.75rem;background:#e2e8f0;color:#334155}.error{color:#dc2626;background:#fee2e2;padding:.5rem .75rem;border-radius:6px;font-size:0.9rem}.scope-badge{display:inline-block;background:#f1f5f9;color:#475569;padding:2px 8px;border-radius:4px;font-family:monospace;font-size:0.85rem;margin:2px}</style></head><body><main>' +
    body +
    '</main></body></html>'
  );
}

function loginPage(oauth: string, error?: string, brandName = 'ImageHost'): string {
  return page(
    'MCP Sign In',
    '<h1>Sign in to ' +
      escapeHtml(brandName) +
      '</h1><p style="color:#64748b;font-size:0.95rem">Authorize this MCP agent to access your photo library.</p>' +
      (error ? '<p class="error">' + escapeHtml(error) + '</p>' : '') +
      '<form method="post" action="/oauth/authorize">' +
      '<input type="hidden" name="oauth" value="' +
      escapeHtml(oauth) +
      '">' +
      '<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>' +
      '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>' +
      '<button type="submit">Sign in & Continue</button></form>' +
      '<div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #f1f5f9;font-size:0.85rem;color:#64748b">' +
      'Or <a href="/v1/auth/login" style="color:#2563eb">Sign in with Tunnus OIDC</a>' +
      '</div>',
  );
}

function consentPage(
  oauth: string,
  ticket: string,
  userName: string,
  clientName: string,
  scopes: string,
  brandName = 'ImageHost',
): string {
  const scopeList = scopes
    .split(' ')
    .filter(Boolean)
    .map((s) => '<span class="scope-badge">' + escapeHtml(s) + '</span>')
    .join(' ');

  return page(
    'Authorize MCP Client',
    '<h1>Authorize MCP Client</h1><p><strong>' +
      escapeHtml(clientName) +
      '</strong> wants to connect to your ' +
      escapeHtml(brandName) +
      ' library as <strong>' +
      escapeHtml(userName) +
      '</strong>.</p>' +
      '<div style="margin:1rem 0;padding:0.75rem;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">' +
      '<div style="font-size:0.85rem;font-weight:600;color:#64748b;margin-bottom:0.4rem">Requested Scopes:</div>' +
      scopeList +
      '</div>' +
      '<form method="post" action="/oauth/authorize">' +
      '<input type="hidden" name="oauth" value="' +
      escapeHtml(oauth) +
      '">' +
      '<input type="hidden" name="ticket" value="' +
      escapeHtml(ticket) +
      '">' +
      '<button type="submit" name="action" value="approve">Approve Access</button>' +
      '<button class="secondary" type="submit" name="action" value="deny">Deny</button></form>',
  );
}

function encodeOAuth(query: Record<string, string | undefined>): string {
  return Buffer.from(
    new URLSearchParams(
      Object.entries(query).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ).toString(),
  ).toString('base64url');
}

function decodeOAuth(value: string): Record<string, string | undefined> {
  return Object.fromEntries(new URLSearchParams(Buffer.from(value, 'base64url').toString('utf8')));
}

function sendHtml(reply: FastifyReply, html: string, formAction: string[] = [], status = 200) {
  return reply
    .code(status)
    .header('Content-Security-Policy', contentSecurityPolicy(formAction))
    .header('Cache-Control', 'no-store')
    .type('text/html')
    .send(html);
}

const oauthHash = (oauth: string) => createHash('sha256').update(oauth).digest('base64url');

export async function mountAuthorizationServer(
  app: FastifyInstance,
  issuer: string,
  resource: string,
  secret: Uint8Array,
  authStore: AuthStore,
  users: UserStore,
  options: AuthorizationServerOptions = {},
): Promise<void> {
  const fetchClientMetadata = options.fetchClientMetadata ?? fetchCimdMetadata;
  const ticketAudience = issuer + '/oauth/authorize';
  const brand = options.brandName || 'ImageHost';

  async function validateRequest(query: Record<string, string | undefined>) {
    if (
      query.response_type !== 'code' ||
      !query.client_id ||
      !query.redirect_uri ||
      !query.code_challenge ||
      query.code_challenge_method !== 'S256'
    ) {
      throw new Error('Invalid OAuth request');
    }
    if (!isCimdClientId(query.client_id)) throw new Error('Invalid client_id');
    const metadata = await fetchClientMetadata(query.client_id);
    if (!metadata.redirect_uris.includes(query.redirect_uri)) {
      throw new Error('Invalid redirect_uri');
    }
    return metadata;
  }

  function issueLoginTicket(user: McpUser, oauth: string): Promise<string> {
    return new SignJWT({ typ: 'login', oauth: oauthHash(oauth) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(issuer)
      .setAudience(ticketAudience)
      .setIssuedAt()
      .setExpirationTime(LOGIN_TICKET_TTL)
      .sign(secret);
  }

  async function verifyLoginTicket(ticket: string, oauth: string): Promise<McpUser | undefined> {
    try {
      const { payload } = await jwtVerify(ticket, secret, {
        algorithms: ['HS256'],
        issuer,
        audience: ticketAudience,
      });
      if (
        payload.typ !== 'login' ||
        payload.oauth !== oauthHash(oauth) ||
        typeof payload.sub !== 'string'
      ) {
        return undefined;
      }
      return await users.getUser(payload.sub);
    } catch {
      return undefined;
    }
  }

  async function showConsent(
    reply: FastifyReply,
    oauth: string,
    q: Record<string, string | undefined>,
    metadata: CimdMetadata,
    user: McpUser,
  ) {
    const ticket = await issueLoginTicket(user, oauth);
    const scopes = q.scope ?? 'images:read images:write images:delete groups:read groups:write';
    return sendHtml(
      reply,
      consentPage(oauth, ticket, user.name, metadata.client_name ?? q.client_id!, scopes, brand),
      [redirectSource(q.redirect_uri!)],
    );
  }

  app.get('/oauth/authorize', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;

    // Relay to central Tunnus if configured and direct local auth is not requested
    if (options.oidcIssuerUrl && q.local !== 'true' && q.direct !== 'true') {
      const authUrl = new URL(`${options.oidcIssuerUrl.replace(/\/+$/, '')}/auth`);
      for (const [key, value] of Object.entries(q)) {
        if (value !== undefined) {
          authUrl.searchParams.set(key, value);
        }
      }
      if (!authUrl.searchParams.has('resource')) {
        authUrl.searchParams.set('resource', resource);
      }
      return reply.redirect(authUrl.toString());
    }

    try {
      const metadata = await validateRequest(q);

      // If user has an active session in the browser, show consent directly
      if (request.user) {
        const currentUser = await users.getUser(request.user.userId);
        if (currentUser) {
          return showConsent(reply, encodeOAuth(q), q, metadata, currentUser);
        }
      }

      return sendHtml(reply, loginPage(encodeOAuth(q), undefined, brand));
    } catch {
      return sendHtml(
        reply,
        page('Invalid request', '<h1>Invalid authorization request</h1>'),
        [],
        400,
      );
    }
  });

  app.post('/oauth/authorize', async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;
    if (!body?.oauth) {
      return sendHtml(
        reply,
        page('Invalid request', '<h1>Invalid authorization request</h1>'),
        [],
        400,
      );
    }
    const oauth = body.oauth;

    let q: Record<string, string | undefined>;
    let metadata: CimdMetadata;
    try {
      q = decodeOAuth(oauth);
      metadata = await validateRequest(q);
    } catch {
      return sendHtml(
        reply,
        page('Invalid request', '<h1>Invalid authorization request</h1>'),
        [],
        400,
      );
    }

    // Step 1: sign in with credentials
    if (body.action === undefined) {
      if (!body.email || !body.password) {
        return sendHtml(reply, loginPage(oauth, 'Enter your email and password.', brand), [], 400);
      }
      const user = await users.getUserByEmail(body.email);
      if (!user?.passwordHash || !(await verify(user.passwordHash, body.password))) {
        return sendHtml(reply, loginPage(oauth, 'Invalid email or password.', brand), [], 401);
      }
      return showConsent(reply, oauth, q, metadata, user);
    }

    // Step 2: consent decision
    const user = body.ticket ? await verifyLoginTicket(body.ticket, oauth) : undefined;
    if (!user) {
      return sendHtml(
        reply,
        loginPage(oauth, 'Your sign-in has expired. Please sign in again.', brand),
        [],
        401,
      );
    }

    if (body.action !== 'approve') {
      const target = new URL(q.redirect_uri!);
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('iss', issuer);
      if (q.state) target.searchParams.set('state', q.state);
      return reply.redirect(target.toString());
    }

    const code = randomToken();
    const scopes = q.scope ?? 'images:read images:write images:delete groups:read groups:write';
    authStore.saveAuthorizationCode({
      code,
      clientId: q.client_id!,
      redirectUri: q.redirect_uri!,
      challenge: q.code_challenge!,
      subject: user.id,
      scope: scopes,
      expires: Date.now() + 60_000,
    });

    const target = new URL(q.redirect_uri!);
    target.searchParams.set('code', code);
    target.searchParams.set('iss', issuer);
    if (q.state) target.searchParams.set('state', q.state);
    return reply.redirect(target.toString());
  });

  async function handleLocalCodeExchange(
    b: Record<string, string | undefined>,
    reply: FastifyReply,
  ) {
    const code = b.code ? authStore.consumeAuthorizationCode(b.code) : undefined;
    if (
      !code ||
      b.client_id !== code.clientId ||
      b.redirect_uri !== code.redirectUri ||
      !b.code_verifier ||
      !verifyS256(b.code_verifier, code.challenge)
    ) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const access = await issueAccessToken(
      secret,
      issuer,
      resource,
      code.subject,
      code.clientId,
      code.scope,
    );
    const refreshToken = randomToken();
    authStore.saveRefreshToken({
      token: refreshToken,
      clientId: code.clientId,
      subject: code.subject,
      scope: code.scope,
      expires: Date.now() + 30 * 86_400_000,
    });
    return reply.send({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: code.scope,
    });
  }

  async function handleLocalRefreshExchange(
    b: Record<string, string | undefined>,
    reply: FastifyReply,
  ) {
    const refreshToken = b.refresh_token ? authStore.getRefreshToken(b.refresh_token) : undefined;
    if (!refreshToken || b.client_id !== refreshToken.clientId) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    if (!(await users.getUser(refreshToken.subject))) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const access = await issueAccessToken(
      secret,
      issuer,
      resource,
      refreshToken.subject,
      refreshToken.clientId,
      refreshToken.scope,
    );
    return reply.send({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: refreshToken.scope,
    });
  }

  app.post('/oauth/token', async (request, reply) => {
    const b = request.body as Record<string, string | undefined>;
    reply.header('Cache-Control', 'no-store'); // RFC 6749 §5.1

    if (b.grant_type === 'authorization_code') {
      const isLocal =
        b.code && authStore.hasAuthorizationCode
          ? await authStore.hasAuthorizationCode(b.code)
          : false;

      if (isLocal) {
        return handleLocalCodeExchange(b, reply);
      }

      if (options.oidcIssuerUrl) {
        try {
          const formBody = new URLSearchParams();
          for (const [key, value] of Object.entries(b)) {
            if (value !== undefined) formBody.set(key, value);
          }
          if (!formBody.has('resource')) {
            formBody.set('resource', resource);
          }

          const response = await fetch(`${options.oidcIssuerUrl.replace(/\/+$/, '')}/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: formBody.toString(),
          });
          const data = await response.json().catch(() => null);
          if (data) {
            return reply.code(response.status).send(data);
          }
        } catch {
          // Relay failed, fall through to local fallback
        }
      }

      return handleLocalCodeExchange(b, reply);
    }

    if (b.grant_type === 'refresh_token') {
      const isLocal =
        b.refresh_token && authStore.hasRefreshToken
          ? await authStore.hasRefreshToken(b.refresh_token)
          : false;

      if (isLocal) {
        return handleLocalRefreshExchange(b, reply);
      }

      if (options.oidcIssuerUrl) {
        try {
          const formBody = new URLSearchParams();
          for (const [key, value] of Object.entries(b)) {
            if (value !== undefined) formBody.set(key, value);
          }
          if (!formBody.has('resource')) {
            formBody.set('resource', resource);
          }

          const response = await fetch(`${options.oidcIssuerUrl.replace(/\/+$/, '')}/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: formBody.toString(),
          });
          const data = await response.json().catch(() => null);
          if (data) {
            return reply.code(response.status).send(data);
          }
        } catch {
          // Relay failed, fall through to local fallback
        }
      }

      return handleLocalRefreshExchange(b, reply);
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });
}
