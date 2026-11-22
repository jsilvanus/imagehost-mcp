import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../../app.js';
import { getOrCreateUser } from '../../auth/users.js';
import { safeDownloadImage } from './security.js';
import type {
  ChatGptImportRequest,
  ChatGptImportResponse,
  ImportedImageResult,
  ImportedImageError,
  OpenAiFileRef,
} from './types.js';

function sanitizeFilename(name?: string, index = 0, defaultExt = 'png'): string {
  if (!name || typeof name !== 'string') {
    return `chatgpt_gen_${Date.now()}_${index + 1}.${defaultExt}`;
  }
  // Remove path traversal and control characters
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!clean || clean === '.' || clean === '..') {
    return `chatgpt_gen_${Date.now()}_${index + 1}.${defaultExt}`;
  }
  return clean.slice(0, 120);
}

export function registerChatGPTActionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const allowedDomains = (ctx.config.chatgptAllowedDomains || 'oaiusercontent.com,openai.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const maxBytes = ctx.config.chatgptMaxDownloadBytes || 26214400; // 25 MB
  const timeoutMs = ctx.config.chatgptDownloadTimeoutMs || 15000;

  // OpenAPI spec endpoints for ChatGPT Action import
  const serveOpenApiYaml = async (_req: FastifyRequest, reply: FastifyReply) => {
    const specPaths = [
      join(process.cwd(), 'docs', 'openapi', 'chatgpt-actions.yaml'),
      join(process.cwd(), 'docs', 'chatgpt-actions.yaml'),
    ];

    for (const specPath of specPaths) {
      if (existsSync(specPath)) {
        let content = readFileSync(specPath, 'utf8');
        // Replace dynamic baseUrl if configured
        if (ctx.config.baseUrl) {
          const cleanBase = ctx.config.baseUrl.replace(/\/+$/, '');
          content = content.replace(/url:\s*https?:\/\/[^\r\n]+/g, `url: ${cleanBase}`);
        }
        return reply.type('application/yaml').send(content);
      }
    }

    return reply.notFound('ChatGPT Actions OpenAPI specification not found');
  };

  app.get('/api/chatgpt/openapi.yaml', serveOpenApiYaml);
  app.get('/docs/openapi/chatgpt-actions.yaml', serveOpenApiYaml);

  // Authentication helper for GPT Actions
  const authenticateGptRequest = async (req: FastifyRequest): Promise<string | null> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.slice(7).trim();
    if (!token) return null;

    // 1. Dedicated ChatGPT API Key check
    if (ctx.config.chatgptApiKey && token === ctx.config.chatgptApiKey) {
      try {
        const user = await getOrCreateUser('system', 'chatgpt-action-bot', {
          displayName: 'ChatGPT Action Bot',
          email: 'chatgpt-action@local',
        });
        return user.id;
      } catch {
        return 'user-chatgpt-bot';
      }
    }

    // 2. User session token check
    if (ctx.sessionService?.verifySession) {
      try {
        const payload = await ctx.sessionService.verifySession(token);
        if (payload?.userId) {
          return payload.userId;
        }
      } catch {
        // invalid session token
      }
    }

    return null;
  };

  // Main import handler
  const handleImport = async (
    req: FastifyRequest<{ Body: ChatGptImportRequest }>,
    reply: FastifyReply,
  ) => {
    const userId = await authenticateGptRequest(req);
    if (!userId) {
      return reply.code(401).send({
        success: false,
        error: 'Unauthorized: Missing or invalid Bearer token',
      });
    }

    const rawRefs = req.body?.openaiFileIdRefs ?? req.body?.files;
    if (!rawRefs || !Array.isArray(rawRefs) || rawRefs.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'No file references provided. Expected array in "openaiFileIdRefs" or "files"',
      });
    }

    // Resolve or create photo group
    let groupId = req.body?.groupId;
    if (groupId) {
      const existing = await ctx.groupService.getGroup(userId, groupId);
      if (!existing) {
        return reply.code(404).send({
          success: false,
          error: `Group not found: ${groupId}`,
        });
      }
    } else {
      const groupName = req.body?.groupName?.trim() || 'ChatGPT';
      const group = await ctx.groupService.getOrCreateGroupByName(
        userId,
        groupName,
        'Imported automatically via ChatGPT GPT Action',
      );
      groupId = group.id;
    }

    const tagsList = req.body?.tags ?? ['chatgpt', 'ai-generated'];
    const description = req.body?.description;

    const successImages: ImportedImageResult[] = [];
    const errors: ImportedImageError[] = [];

    // Process each file reference
    for (let i = 0; i < rawRefs.length; i++) {
      const item = rawRefs[i];
      let downloadUrl: string | undefined;
      let rawName: string | undefined;
      let refId: string | undefined;

      if (typeof item === 'string') {
        downloadUrl = item.trim();
        refId = `ref-${i + 1}`;
      } else if (item && typeof item === 'object') {
        const obj = item as OpenAiFileRef;
        downloadUrl = obj.download_link || obj.url || obj.download_url;
        rawName = obj.name;
        refId = obj.id || `ref-${i + 1}`;
      }

      if (!downloadUrl) {
        errors.push({
          id: refId,
          filename: rawName,
          error: 'Missing download_link in file reference',
        });
        continue;
      }

      try {
        // 1. Safe download with SSRF, size & signature checks
        const { buffer, detectedMime } = await safeDownloadImage(downloadUrl, {
          allowedDomains,
          maxBytes,
          timeoutMs,
          skipDnsLookup: ctx.config.nodeEnv === 'test',
        });

        const extension = detectedMime.split('/')[1] || 'png';
        const filename = sanitizeFilename(rawName, i, extension);

        // 2. Create upload session in ImageHost
        const session = await ctx.imageService.createUploadSession(userId, groupId, {
          filename,
          mediaType: detectedMime,
          byteSize: buffer.length,
          description: description || `ChatGPT generated image: ${filename}`,
          tagsList,
        });

        // 3. Save raw original content into S3 storage
        await ctx.imageService.saveUploadContent(
          userId,
          session.uploadId,
          buffer,
          detectedMime,
        );

        // 4. Run Sharp pipeline (generate WebP thumbnails & preview derivatives)
        const completed = await ctx.imageService.completeUpload(userId, session.uploadId);

        // 5. Generate permanent download URL
        const downloadInfo = await ctx.imageService.getDownloadUrl(
          userId,
          session.uploadId,
          'preview',
        );

        successImages.push({
          image_id: completed.id,
          filename: completed.originalFilename,
          mime_type: detectedMime,
          url: downloadInfo.url,
          sequence_number: completed.sequenceNumber,
          width: completed.width ?? undefined,
          height: completed.height ?? undefined,
          byte_size: completed.byteSize,
          status: 'success',
        });

        req.log?.info?.(
          { imageId: completed.id, sequenceNumber: completed.sequenceNumber },
          'Successfully imported image from ChatGPT',
        );
      } catch (err: any) {
        req.log?.warn?.({ err: err.message, refId }, 'Failed to import image from ChatGPT');
        errors.push({
          id: refId,
          filename: rawName,
          error: err.message || 'Failed to download or process image',
        });
      }
    }

    const anySuccess = successImages.length > 0;
    const responseData: ChatGptImportResponse = {
      success: anySuccess,
      images: successImages,
      errors: errors.length > 0 ? errors : undefined,
    };

    const statusCode = anySuccess ? 200 : errors.length > 0 ? 422 : 400;
    return reply.code(statusCode).send(responseData);
  };

  // Register main endpoint and aliases
  app.post<{ Body: ChatGptImportRequest }>('/api/chatgpt/import', handleImport);
  app.post<{ Body: ChatGptImportRequest }>('/v1/chatgpt/import', handleImport);
}
