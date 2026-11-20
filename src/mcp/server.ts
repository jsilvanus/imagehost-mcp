import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GroupService } from '../services/group-service.js';
import type { ImageService } from '../services/image-service.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface McpServerOptions {
  groupService: GroupService;
  imageService: ImageService;
  publicUrl: string;
}

function result(value: unknown): CallToolResult {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function authError(publicUrl: string, requiredScope: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    _meta: {
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${requiredScope}", error="insufficient_scope", error_description="${message}"`,
      ],
    },
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function checkAuth(
  extra: Extra,
  requiredScope: string,
  publicUrl: string,
): { userId: string } | { error: CallToolResult } {
  const auth = extra.authInfo;
  if (!auth?.token) {
    return {
      error: authError(publicUrl, requiredScope, 'Authentication required to use this tool.'),
    };
  }
  const userId = auth.extra?.userId;
  if (!userId || typeof userId !== 'string') {
    return {
      error: authError(publicUrl, requiredScope, 'Missing user context in authorization token.'),
    };
  }
  const scopes = auth.scopes ?? [];
  if (!scopes.includes(requiredScope) && !scopes.includes('mcp')) {
    return {
      error: authError(
        publicUrl,
        requiredScope,
        `Insufficient scope: tool requires '${requiredScope}'.`,
      ),
    };
  }
  return { userId };
}

function checkResourceAuth(extra: Extra, requiredScope: string): string {
  const auth = extra.authInfo;
  if (!auth?.token) {
    throw new Error('Authentication required');
  }
  const userId = auth.extra?.userId;
  if (!userId || typeof userId !== 'string') {
    throw new Error('Missing user context in authorization token');
  }
  const scopes = auth.scopes ?? [];
  if (!scopes.includes(requiredScope) && !scopes.includes('mcp')) {
    throw new Error(`Insufficient scope: resource requires '${requiredScope}'`);
  }
  return userId;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({
    name: 'imagehost-mcp',
    version: '0.1.0',
  });

  const { groupService, imageService, publicUrl } = options;

  // =========================================================================
  // RESOURCES
  // =========================================================================

  // 1. photo://library - Overview of user's photo library
  server.resource(
    'library',
    'photo://library',
    {
      description:
        "Overview summary of the user's photo library including group list and image counts",
    },
    async (uri, extra) => {
      const userId = checkResourceAuth(extra, 'groups:read');
      const groups = await groupService.listGroups(userId);
      const groupsWithCounts = await Promise.all(
        groups.map(async (g) => {
          const imgs = await imageService.listGroupImages(userId, g.id, { limit: 1 });
          return {
            ...g,
            hasImages: imgs.items.length > 0,
          };
        }),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ groups: groupsWithCounts, totalGroups: groups.length }, null, 2),
          },
        ],
      };
    },
  );

  // 2. photo://groups - List of user's groups
  server.resource(
    'groups',
    'photo://groups',
    { description: 'List of all photo groups owned by the user' },
    async (uri, extra) => {
      const userId = checkResourceAuth(extra, 'groups:read');
      const groups = await groupService.listGroups(userId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ groups }, null, 2),
          },
        ],
      };
    },
  );

  // 3. photo://groups/{group_id} - Group details
  server.resource(
    'group_details',
    new ResourceTemplate('photo://groups/{group_id}', { list: undefined }),
    { description: 'Metadata and configuration of a specific photo group' },
    async (uri, variables, extra) => {
      const userId = checkResourceAuth(extra, 'groups:read');
      const groupId = String(variables.group_id);
      const group = await groupService.getGroup(userId, groupId);
      if (!group) throw new Error(`Group not found or access denied: ${groupId}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(group, null, 2),
          },
        ],
      };
    },
  );

  // 4. photo://groups/{group_id}/images - Images in a group
  server.resource(
    'group_images',
    new ResourceTemplate('photo://groups/{group_id}/images', { list: undefined }),
    { description: 'List of images contained in a specific group' },
    async (uri, variables, extra) => {
      const userId = checkResourceAuth(extra, 'images:read');
      const groupId = String(variables.group_id);
      const group = await groupService.getGroup(userId, groupId);
      if (!group) throw new Error(`Group not found or access denied: ${groupId}`);
      const imageList = await imageService.listGroupImages(userId, groupId, {
        limit: 100,
        includePendingDeletion: true,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(imageList, null, 2),
          },
        ],
      };
    },
  );

  // 5. photo://images/{image_id}/metadata - Single image metadata
  server.resource(
    'image_metadata',
    new ResourceTemplate('photo://images/{image_id}/metadata', { list: undefined }),
    { description: 'Comprehensive metadata of an image including tags and dimensions' },
    async (uri, variables, extra) => {
      const userId = checkResourceAuth(extra, 'images:read');
      const imageId = String(variables.image_id);
      const image = await imageService.getImage(userId, imageId);
      if (!image) throw new Error(`Image not found or access denied: ${imageId}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(image, null, 2),
          },
        ],
      };
    },
  );

  // 6. photo://images/{image_id}/thumbnail - Presigned download URL for thumbnail
  server.resource(
    'image_thumbnail',
    new ResourceTemplate('photo://images/{image_id}/thumbnail', { list: undefined }),
    { description: 'Presigned download URL (1-hour TTL) for the 320px thumbnail variant' },
    async (uri, variables, extra) => {
      const userId = checkResourceAuth(extra, 'images:read');
      const imageId = String(variables.image_id);
      const urlInfo = await imageService.getDownloadUrl(userId, imageId, 'thumbnail');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(urlInfo, null, 2),
          },
        ],
      };
    },
  );

  // 7. photo://images/{image_id}/preview - Presigned download URL for preview
  server.resource(
    'image_preview',
    new ResourceTemplate('photo://images/{image_id}/preview', { list: undefined }),
    { description: 'Presigned download URL (1-hour TTL) for the 1280px preview variant' },
    async (uri, variables, extra) => {
      const userId = checkResourceAuth(extra, 'images:read');
      const imageId = String(variables.image_id);
      const urlInfo = await imageService.getDownloadUrl(userId, imageId, 'preview');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(urlInfo, null, 2),
          },
        ],
      };
    },
  );

  // 8. photo://images/{image_id}/original - Presigned download URL for full original
  server.resource(
    'image_original',
    new ResourceTemplate('photo://images/{image_id}/original', { list: undefined }),
    { description: 'Presigned download URL (1-hour TTL) for the full-resolution original image' },
    async (uri, variables, extra) => {
      const userId = checkResourceAuth(extra, 'images:read');
      const imageId = String(variables.image_id);
      const urlInfo = await imageService.getDownloadUrl(userId, imageId, 'original');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(urlInfo, null, 2),
          },
        ],
      };
    },
  );

  // =========================================================================
  // TOOLS
  // =========================================================================

  // 1. get_image_download_url
  server.registerTool(
    'get_image_download_url',
    {
      description:
        'Issue a short-lived (1-hour TTL) presigned GET download URL for an image variant (thumbnail, preview, or original). Never streams binary bytes over MCP.',
      inputSchema: {
        image_id: z.string().describe('Canonical UUID of the image'),
        variant: z
          .enum(['thumbnail', 'preview', 'original'])
          .default('preview')
          .describe('Image variant: thumbnail (320px), preview (1280px), or original (unmodified)'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:read', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const info = await imageService.getDownloadUrl(
          auth.userId,
          args.image_id,
          args.variant ?? 'preview',
        );
        return result(info);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 2. get_group_image_download_urls
  server.registerTool(
    'get_group_image_download_urls',
    {
      description:
        'Batch issue 1-hour presigned GET download URLs for all images in a group, returning per-item status.',
      inputSchema: {
        group_id: z.string().describe('UUID of the group'),
        variant: z
          .enum(['thumbnail', 'preview', 'original'])
          .default('preview')
          .describe('Variant type to issue URLs for (thumbnail, preview, or original)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .optional()
          .describe('Maximum images to include'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:read', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const group = await groupService.getGroup(auth.userId, args.group_id);
        if (!group) return errorResult('Group not found or access denied');
        const list = await imageService.listGroupImages(auth.userId, args.group_id, {
          limit: args.limit ?? 50,
        });
        const itemsToFetch = list.items.map((img) => ({
          imageId: img.id,
          variant: args.variant ?? 'preview',
        }));
        const results = await imageService.getBatchDownloadUrls(auth.userId, itemsToFetch);
        return result({ results, total: results.length });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 3. search_images
  server.registerTool(
    'search_images',
    {
      description:
        'Search images across the user library by keyword query (matches description and filename), group filter, or tags.',
      inputSchema: {
        query: z.string().optional().describe('Optional keyword query'),
        group_id: z.string().optional().describe('Optional group UUID to filter results'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional array of tag names to filter results'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .optional()
          .describe('Max records to return (1-100)'),
        cursor: z.string().optional().describe('Opaque pagination cursor from prior search result'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:read', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const data = await imageService.searchImages(auth.userId, {
          query: args.query,
          groupId: args.group_id,
          tags: args.tags,
          limit: args.limit,
          cursor: args.cursor,
        });
        return result(data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 4. list_group_images
  server.registerTool(
    'list_group_images',
    {
      description:
        'List images in a specific group with pagination and sequence numbers. Sequence numbers are 1-based sequential integers within the group.',
      inputSchema: {
        group_id: z.string().describe('UUID of the group'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .optional()
          .describe('Number of images to return'),
        cursor: z
          .number()
          .int()
          .optional()
          .describe('Sequence number cursor to continue listing after'),
        include_pending_deletion: z
          .boolean()
          .default(false)
          .optional()
          .describe('Include images marked for soft deletion'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:read', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const data = await imageService.listGroupImages(auth.userId, args.group_id, {
          limit: args.limit,
          cursor: args.cursor,
          includePendingDeletion: args.include_pending_deletion,
        });
        return result(data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 5. create_group
  server.registerTool(
    'create_group',
    {
      description: 'Create a new named image group with retention policy.',
      inputSchema: {
        name: z.string().min(1).max(255).describe('Human-friendly group name'),
        description: z.string().optional().describe('Optional group description'),
        retention_hours: z
          .number()
          .int()
          .min(1)
          .max(8760)
          .default(72)
          .optional()
          .describe(
            'Retention window in hours before soft-deleted images are permanently purged (default: 72)',
          ),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'groups:write', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const group = await groupService.createGroup(auth.userId, {
          name: args.name,
          description: args.description,
          retentionHours: args.retention_hours,
        });
        return result(group);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 6. update_group
  server.registerTool(
    'update_group',
    {
      description: 'Update group metadata such as name, description, or retention period.',
      inputSchema: {
        group_id: z.string().describe('UUID of the group to update'),
        name: z.string().min(1).max(255).optional().describe('New name for the group'),
        description: z.string().optional().describe('New description'),
        retention_hours: z
          .number()
          .int()
          .min(1)
          .max(8760)
          .optional()
          .describe('Updated retention hours before permanent deletion'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'groups:write', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const updated = await groupService.updateGroup(auth.userId, args.group_id, {
          name: args.name,
          description: args.description,
          retentionHours: args.retention_hours,
        });
        if (!updated) return errorResult('Group not found or access denied');
        return result(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 7. add_image_tags
  server.registerTool(
    'add_image_tags',
    {
      description: 'Attach one or more tag names to an image.',
      inputSchema: {
        image_id: z.string().describe('UUID of the image'),
        tags: z.array(z.string().min(1)).min(1).describe('Array of tag names to attach'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:write', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const updated = await imageService.addTags(auth.userId, args.image_id, args.tags);
        if (!updated) return errorResult('Image not found or access denied');
        return result(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 8. remove_image_tags
  server.registerTool(
    'remove_image_tags',
    {
      description: 'Remove one or more tags from an image.',
      inputSchema: {
        image_id: z.string().describe('UUID of the image'),
        tags: z.array(z.string().min(1)).min(1).describe('Array of tag names to remove'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:write', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const updated = await imageService.removeTags(auth.userId, args.image_id, args.tags);
        if (!updated) return errorResult('Image not found or access denied');
        return result(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 9. update_image_description
  server.registerTool(
    'update_image_description',
    {
      description: 'Update the text description of an image.',
      inputSchema: {
        image_id: z.string().describe('UUID of the image'),
        description: z.string().describe('New description text'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:write', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const updated = await imageService.updateDescription(
          auth.userId,
          args.image_id,
          args.description,
        );
        if (!updated) return errorResult('Image not found or access denied');
        return result(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 10. request_image_deletion
  server.registerTool(
    'request_image_deletion',
    {
      description:
        'Soft-delete an image. It will remain in pending_deletion state visible with a red overlay in the PWA until the group retention deadline passes, after which it is permanently purged.',
      inputSchema: {
        image_id: z.string().describe('UUID of the image to mark for deletion'),
        reason: z.string().optional().describe('Optional reason for deletion request'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:delete', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const updated = await imageService.requestDeletion(auth.userId, args.image_id, 'mcp');
        if (!updated) return errorResult('Image not found or access denied');
        return result(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 11. restore_image
  server.registerTool(
    'restore_image',
    {
      description:
        'Restore an image that was previously marked pending_deletion back to active status, before its retention deadline expires.',
      inputSchema: {
        image_id: z.string().describe('UUID of the pending_deletion image to restore'),
      },
    },
    async (args, extra) => {
      // Either images:delete or images:write scope is accepted
      const auth = checkAuth(extra, 'images:delete', publicUrl);
      let userId: string;
      if ('error' in auth) {
        const auth2 = checkAuth(extra, 'images:write', publicUrl);
        if ('error' in auth2) return auth.error;
        userId = auth2.userId;
      } else {
        userId = auth.userId;
      }

      try {
        const restored = await imageService.restoreImage(userId, args.image_id);
        if (!restored) return errorResult('Image not found or access denied');
        return result(restored);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 12. get_changes
  server.registerTool(
    'get_changes',
    {
      description:
        'Catch up on durable domain events (image uploads, status changes, deletions) using cursor synchronization.',
      inputSchema: {
        cursor: z
          .number()
          .int()
          .min(0)
          .default(0)
          .optional()
          .describe('Cursor sequence to fetch changes after'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .optional()
          .describe('Maximum event records to return'),
      },
    },
    async (args, extra) => {
      const auth = checkAuth(extra, 'images:read', publicUrl);
      if ('error' in auth) return auth.error;
      try {
        const changes = await imageService.getChanges(
          auth.userId,
          args.cursor ?? 0,
          args.limit ?? 100,
        );
        return result(changes);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
