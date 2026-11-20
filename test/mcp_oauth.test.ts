import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { buildApp } from '../src/app.js';
import { MemoryAuthStore, DefaultUserStore } from '../src/oauth/storage.js';
import type { Config } from '../src/config.js';

const CLIENT_ID = 'https://client.example/oauth/client.json';
const REDIRECT_URI = 'https://client.example/callback';
const EMAIL = 'test@example.com';
const PASSWORD = 'secret-password-123';

let app: FastifyInstance;
let base: string;
const authStore = new MemoryAuthStore();
const userStore = new DefaultUserStore();

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery(
  challenge: string,
  scope = 'images:read images:write images:delete groups:read groups:write',
) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'test-state-xyz',
    scope,
    resource: 'http://127.0.0.1/mcp',
  });
}

async function postForm(path: string, form: Record<string, string>) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
}

const hidden = (html: string, name: string) =>
  html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

async function signInPage(challenge: string, scope?: string) {
  const res = await fetch(base + '/oauth/authorize?' + authorizeQuery(challenge, scope));
  const html = await res.text();
  return { res, html, oauth: hidden(html, 'oauth')! };
}

async function signIn(oauth: string) {
  const res = await postForm('/oauth/authorize', { oauth, email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return { res, html: await res.text() };
}

async function mcp(token: string | null, body: unknown) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  return {
    status: res.status,
    headers: res.headers,
    message: data[0] ?? (text ? JSON.parse(text) : null),
  };
}

describe('RFC 9728 Discovery & OAuth Protected Resource', () => {
  const mockGroups = new Map<string, any>();
  const mockImages = new Map<string, any>();

  const mockGroupService: any = {
    groups: mockGroups,
    async listGroups(userId: string) {
      return Array.from(mockGroups.values()).filter((g: any) => g.ownerId === userId);
    },
    async createGroup(userId: string, data: any) {
      const id = 'grp-' + Math.random().toString(36).slice(2, 9);
      const group = {
        id,
        ownerId: userId,
        name: data.name,
        description: data.description ?? null,
        retentionHours: data.retentionHours ?? 72,
        status: 'active',
        nextSequenceNumber: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGroups.set(id, group);
      return group;
    },
    async getGroup(userId: string, groupId: string) {
      const g = mockGroups.get(groupId);
      if (!g || g.ownerId !== userId) return null;
      return g;
    },
    async updateGroup(userId: string, groupId: string, data: any) {
      const g = await this.getGroup(userId, groupId);
      if (!g) return null;
      if (data.name !== undefined) g.name = data.name;
      if (data.description !== undefined) g.description = data.description;
      if (data.retentionHours !== undefined) g.retentionHours = data.retentionHours;
      return g;
    },
  };

  const mockImageService: any = {
    images: mockImages,
    async listGroupImages(userId: string, groupId: string, options?: any) {
      const list = Array.from(mockImages.values()).filter(
        (img: any) =>
          img.ownerId === userId &&
          img.groupId === groupId &&
          (options?.includePendingDeletion
            ? img.deletionState !== 'deleted'
            : img.deletionState === 'active'),
      );
      return { items: list, nextCursor: null };
    },
    async getImage(userId: string, imageId: string) {
      const img = mockImages.get(imageId);
      if (!img || img.ownerId !== userId) return null;
      return img;
    },
    async getDownloadUrl(userId: string, imageId: string, variant: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) throw new Error('Image not found or not owned by user');
      return {
        imageId,
        variant,
        url: `https://s3.example.com/downloads/${imageId}-${variant}.webp?sig=mock`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        expiresInSeconds: 3600,
        mediaType: 'image/webp',
      };
    },
    async getBatchDownloadUrls(userId: string, items: any[]) {
      return items.map((i) => ({
        imageId: i.imageId,
        variant: i.variant ?? 'preview',
        url: `https://s3.example.com/downloads/${i.imageId}-${i.variant ?? 'preview'}.webp?sig=mock`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }));
    },
    async searchImages(userId: string) {
      const list = Array.from(mockImages.values()).filter((img: any) => img.ownerId === userId);
      return { items: list, nextCursor: null };
    },
    async addTags(userId: string, imageId: string, tags: string[]) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.tags = Array.from(new Set([...(img.tags || []), ...tags]));
      return img;
    },
    async removeTags(userId: string, imageId: string, tags: string[]) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.tags = (img.tags || []).filter((t: string) => !tags.includes(t));
      return img;
    },
    async updateDescription(userId: string, imageId: string, description: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.description = description;
      return img;
    },
    async requestDeletion(userId: string, imageId: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.deletionState = 'pending_deletion';
      img.deletionRequestedAt = new Date();
      img.deletionDeadline = new Date(Date.now() + 72 * 3600000);
      return img;
    },
    async restoreImage(userId: string, imageId: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.deletionState = 'active';
      img.deletionRequestedAt = null;
      img.deletionDeadline = null;
      return img;
    },
    async getChanges() {
      return { changes: [], lastCursor: 0 };
    },
  };

  beforeAll(async () => {
    userStore.createUser({
      id: 'test-user-uuid',
      name: 'Test Owner',
      email: EMAIL,
      passwordHash: await hash(PASSWORD, { algorithm: 2 }),
      createdAt: Date.now(),
    });

    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      baseUrl: 'http://127.0.0.1',
      databaseUrl: 'postgres://dummy',
      s3Endpoint: 'http://localhost:9000',
      s3Region: 'us-east-1',
      s3Bucket: 'test-bucket',
      s3AccessKeyId: 'test',
      s3SecretAccessKey: 'test',
      s3ForcePathStyle: true,
      oidcIssuerUrl: 'https://identity.example.com',
      oidcClientId: 'test-client',
      oidcClientSecret: '',
      sessionSecret: 'secret-session-secret-key-32-bytes-long!',
      imageMaxUploadBytes: 25000000,
      imageMaxPixels: 50000000,
      defaultDeletionRetentionHours: 72,
      signedUrlTtlSeconds: 3600,
    };

    app = buildApp({
      config,
      sessionService: {} as any,
      oidcService: {} as any,
      storageService: {} as any,
      processor: {} as any,
      groupService: mockGroupService,
      imageService: mockImageService,
      authStore,
      userStore,
      authorizationOptions: {
        fetchClientMetadata: async (clientId) => ({
          client_id: clientId,
          client_name: 'Test Agent Client',
          redirect_uris: [REDIRECT_URI],
        }),
      },
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes RFC 9728 protected resource discovery', async () => {
    const res = await fetch(base + '/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resource).toBe('http://127.0.0.1/mcp');
    expect(data.authorization_servers).toEqual(['http://127.0.0.1']);
    expect(data.scopes_supported).toContain('images:read');
    expect(data.scopes_supported).toContain('groups:read');

    // Path-inserted RFC 9728 URL
    const resMcp = await fetch(base + '/.well-known/oauth-protected-resource/mcp');
    expect(resMcp.status).toBe(200);
    const dataMcp = await resMcp.json();
    expect(dataMcp.resource).toBe('http://127.0.0.1/mcp');
  });

  it('exposes authorization server discovery', async () => {
    const res = await fetch(base + '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issuer).toBe('http://127.0.0.1');
    expect(data.authorization_endpoint).toBe('http://127.0.0.1/oauth/authorize');
    expect(data.token_endpoint).toBe('http://127.0.0.1/oauth/token');
    expect(data.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('rejects unauthenticated /mcp request with 401 and WWW-Authenticate pointing to discovery', async () => {
    const res = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain(
      'resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('rejects invalid bearer token with 401 invalid_token', async () => {
    const res = await mcp('invalid-token-string', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toContain('error="invalid_token"');
  });

  it('completes end-to-end OAuth PKCE flow and connects to MCP', async () => {
    const { verifier, challenge } = pkce();
    const page = await signInPage(challenge);
    expect(page.res.status).toBe(200);
    expect(page.res.headers.get('cache-control')).toBe('no-store');

    // Step 1: Sign in with credentials
    const { res, html } = await signIn(page.oauth);
    expect(html).toContain('Test Agent Client');
    expect(html).toContain('Test Owner');
    expect(res.headers.get('content-security-policy')).toContain('https://client.example');

    const ticket = hidden(html, 'ticket');
    expect(ticket).toBeTruthy();

    // Step 2: Approve consent
    const approved = await postForm('/oauth/authorize', {
      oauth: page.oauth,
      ticket: ticket!,
      action: 'approve',
    });
    expect(approved.status).toBe(302);
    const redirectUrl = new URL(approved.headers.get('location')!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(REDIRECT_URI);
    expect(redirectUrl.searchParams.get('state')).toBe('test-state-xyz');
    expect(redirectUrl.searchParams.get('iss')).toBe('http://127.0.0.1');
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    // Step 3: Token exchange
    const tokenRes = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code: code!,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // Step 4: MCP initialize over Streamable HTTP
    const init = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agent-client', version: '1.0' },
      },
    });
    expect(init.status).toBe(200);
    expect(init.message.result.serverInfo.name).toBe('imagehost-mcp');

    // Step 5: List tools and verify all 12 tools are registered
    const toolList = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(toolList.status).toBe(200);
    const toolNames = toolList.message.result.tools.map((t: any) => t.name);
    const expectedTools = [
      'get_image_download_url',
      'get_group_image_download_urls',
      'search_images',
      'list_group_images',
      'create_group',
      'update_group',
      'add_image_tags',
      'remove_image_tags',
      'update_image_description',
      'request_image_deletion',
      'restore_image',
      'get_changes',
    ];
    for (const tool of expectedTools) {
      expect(toolNames).toContain(tool);
    }

    // Step 6: Call tool: create_group
    const createRes = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_group',
        arguments: {
          name: 'Vacation 2026',
          description: 'Summer trip photos',
          retention_hours: 48,
        },
      },
    });
    expect(createRes.status).toBe(200);
    const createdGroup = JSON.parse(createRes.message.result.content[0].text);
    expect(createdGroup.name).toBe('Vacation 2026');
    expect(createdGroup.retentionHours).toBe(48);

    // Step 7: Read resource: photo://groups
    const groupResourceRes = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: {
        uri: 'photo://groups',
      },
    });
    expect(groupResourceRes.status).toBe(200);
    const resourceData = JSON.parse(groupResourceRes.message.result.contents[0].text);
    expect(resourceData.groups.some((g: any) => g.name === 'Vacation 2026')).toBe(true);

    // Step 8: Read resource: photo://library
    const libRes = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: {
        uri: 'photo://library',
      },
    });
    expect(libRes.status).toBe(200);
    const libData = JSON.parse(libRes.message.result.contents[0].text);
    expect(libData.totalGroups).toBeGreaterThanOrEqual(1);
  });

  it('enforces scope restrictions on tools', async () => {
    // Obtain a token with only images:read scope
    const { verifier, challenge } = pkce();
    const page = await signInPage(challenge, 'images:read');
    const { html } = await signIn(page.oauth);
    const ticket = hidden(html, 'ticket')!;

    const approved = await postForm('/oauth/authorize', {
      oauth: page.oauth,
      ticket,
      action: 'approve',
    });
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const tokens = (await tokenRes.json()) as { access_token: string };

    // Try calling create_group (which requires groups:write scope)
    const callRes = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'create_group',
        arguments: { name: 'Forbidden Group' },
      },
    });

    expect(callRes.status).toBe(200);
    expect(callRes.message.result.isError).toBe(true);
    expect(callRes.message.result._meta['mcp/www_authenticate'][0]).toContain('insufficient_scope');
  });

  it('supports image lifecycle tools and resources with owner isolation', async () => {
    // Generate valid full-scope token for test-user-uuid
    const { verifier, challenge } = pkce();
    const page = await signInPage(challenge);
    const { html } = await signIn(page.oauth);
    const ticket = hidden(html, 'ticket')!;
    const approved = await postForm('/oauth/authorize', {
      oauth: page.oauth,
      ticket,
      action: 'approve',
    });
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // 1. Create a group
    const grpRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'create_group',
        arguments: { name: 'Trip to Lapland', description: 'Winter 2026' },
      },
    });
    const group = JSON.parse(grpRes.message.result.content[0].text);
    const groupId = group.id;

    // Seed an image in mockImageService for this group
    const imageId = 'img-uuid-001';
    mockImages.set(imageId, {
      id: imageId,
      groupId,
      ownerId: 'test-user-uuid',
      sequenceNumber: 1,
      originalFilename: 'aurora.jpg',
      mediaType: 'image/jpeg',
      byteSize: 3450000,
      width: 4032,
      height: 3024,
      description: 'Northern lights',
      status: 'ready',
      deletionState: 'active',
      tags: ['northern-lights', 'winter'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 2. Read photo://groups/{group_id}
    const grpReadRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 21,
      method: 'resources/read',
      params: { uri: `photo://groups/${groupId}` },
    });
    expect(grpReadRes.status).toBe(200);
    const grpDetails = JSON.parse(grpReadRes.message.result.contents[0].text);
    expect(grpDetails.name).toBe('Trip to Lapland');

    // 3. Read photo://groups/{group_id}/images
    const grpImgsRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 22,
      method: 'resources/read',
      params: { uri: `photo://groups/${groupId}/images` },
    });
    expect(grpImgsRes.status).toBe(200);
    const grpImages = JSON.parse(grpImgsRes.message.result.contents[0].text);
    expect(grpImages.items).toHaveLength(1);
    expect(grpImages.items[0].id).toBe(imageId);

    // 4. Read photo://images/{image_id}/metadata
    const metaRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 23,
      method: 'resources/read',
      params: { uri: `photo://images/${imageId}/metadata` },
    });
    expect(metaRes.status).toBe(200);
    const imgMeta = JSON.parse(metaRes.message.result.contents[0].text);
    expect(imgMeta.originalFilename).toBe('aurora.jpg');
    expect(imgMeta.tags).toContain('northern-lights');

    // 5. Read photo://images/{image_id}/preview
    const prevRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 24,
      method: 'resources/read',
      params: { uri: `photo://images/${imageId}/preview` },
    });
    expect(prevRes.status).toBe(200);
    const prevData = JSON.parse(prevRes.message.result.contents[0].text);
    expect(prevData.variant).toBe('preview');
    expect(prevData.url).toContain('aurora.jpg' ? imageId : '');

    // 6. Test tool: get_image_download_url (thumbnail)
    const dlToolRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: {
        name: 'get_image_download_url',
        arguments: { image_id: imageId, variant: 'thumbnail' },
      },
    });
    expect(dlToolRes.status).toBe(200);
    const dlInfo = JSON.parse(dlToolRes.message.result.content[0].text);
    expect(dlInfo.variant).toBe('thumbnail');
    expect(dlInfo.expiresInSeconds).toBe(3600);

    // 7. Test tool: get_group_image_download_urls
    const batchDlRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'get_group_image_download_urls',
        arguments: { group_id: groupId, variant: 'preview' },
      },
    });
    expect(batchDlRes.status).toBe(200);
    const batchResult = JSON.parse(batchDlRes.message.result.content[0].text);
    expect(batchResult.results).toHaveLength(1);
    expect(batchResult.results[0].imageId).toBe(imageId);

    // 8. Test tag tools: add_image_tags & remove_image_tags
    const addTagRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 27,
      method: 'tools/call',
      params: {
        name: 'add_image_tags',
        arguments: { image_id: imageId, tags: ['snow', 'finland'] },
      },
    });
    expect(addTagRes.status).toBe(200);
    const afterAdd = JSON.parse(addTagRes.message.result.content[0].text);
    expect(afterAdd.tags).toContain('snow');
    expect(afterAdd.tags).toContain('finland');

    const rmTagRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 28,
      method: 'tools/call',
      params: {
        name: 'remove_image_tags',
        arguments: { image_id: imageId, tags: ['snow'] },
      },
    });
    expect(rmTagRes.status).toBe(200);
    const afterRm = JSON.parse(rmTagRes.message.result.content[0].text);
    expect(afterRm.tags).not.toContain('snow');
    expect(afterRm.tags).toContain('finland');

    // 9. Test tool: update_image_description
    const descRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 29,
      method: 'tools/call',
      params: {
        name: 'update_image_description',
        arguments: { image_id: imageId, description: 'Updated aurora description' },
      },
    });
    expect(descRes.status).toBe(200);
    const afterDesc = JSON.parse(descRes.message.result.content[0].text);
    expect(afterDesc.description).toBe('Updated aurora description');

    // 10. Test tool: request_image_deletion (soft deletion)
    const delRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'request_image_deletion',
        arguments: { image_id: imageId, reason: 'Duplicate photo' },
      },
    });
    expect(delRes.status).toBe(200);
    const afterDel = JSON.parse(delRes.message.result.content[0].text);
    expect(afterDel.deletionState).toBe('pending_deletion');
    expect(afterDel.deletionDeadline).toBeTruthy();

    // 11. Test tool: restore_image
    const restoreRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'restore_image',
        arguments: { image_id: imageId },
      },
    });
    expect(restoreRes.status).toBe(200);
    const afterRestore = JSON.parse(restoreRes.message.result.content[0].text);
    expect(afterRestore.deletionState).toBe('active');

    // 12. Test tool: get_changes
    const changesRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'get_changes',
        arguments: { cursor: 0, limit: 10 },
      },
    });
    expect(changesRes.status).toBe(200);
    const changesData = JSON.parse(changesRes.message.result.content[0].text);
    expect(changesData.changes).toBeDefined();

    // 13. Owner isolation: another user's image cannot be read
    const foreignImageId = 'foreign-img-999';
    mockImages.set(foreignImageId, {
      id: foreignImageId,
      groupId,
      ownerId: 'different-user-uuid',
      originalFilename: 'private.jpg',
      deletionState: 'active',
    });

    const foreignRes = await mcp(access_token, {
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: 'get_image_download_url',
        arguments: { image_id: foreignImageId },
      },
    });
    expect(foreignRes.status).toBe(200);
    expect(foreignRes.message.result.isError).toBe(true);
    expect(foreignRes.message.result.content[0].text).toContain('not found or not owned');
  });

  it('serves static PWA assets from web/dist at root / with SPA fallback', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ImageHost');
    expect(html).toContain('<div id="root"></div>');

    // SPA fallback for arbitrary client route
    const spaRes = await fetch(base + '/groups/test-group-id');
    expect(spaRes.status).toBe(200);
    const spaHtml = await spaRes.text();
    expect(spaHtml).toContain('<div id="root"></div>');
  });
});
