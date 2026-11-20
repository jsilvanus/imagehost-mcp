# ADR 0002: Image Upload Strategy, Processing, and Signed URLs

## Context
Mobile phone cameras capture high-resolution images (often 10–25MB HEIC or JPEG). Direct upload through the application server could cause memory bloat and event-loop blocking under concurrent mobile uploads. Downstream AI agents also need to consume images without overwhelming the MCP transport with raw bytes.

## Decision
1. **Presigned Direct-to-S3 Upload Sessions**:
   - The client initiates an upload by requesting a session (`POST /v1/groups/{groupId}/uploads`).
   - The Image Service validates permissions, reserves a group-local sequential number atomically, generates a unique image UUID, and returns a short-lived presigned S3 `PUT` URL.
   - The client uploads directly to S3 / VersityGW.
   - The client confirms upload completion (`POST /v1/uploads/{uploadId}/complete`).
   - For backwards compatibility or simplified testing, a direct streaming multipart endpoint (`POST /v1/groups/{groupId}/images`) is also supported.
2. **Sharp Image Pipeline**:
   - Originals are preserved in their native format.
   - The processing worker loads the original, normalizes rotation using EXIF orientation (`.rotate()`), strips sensitive GPS EXIF from derivatives, and generates:
     - `thumbnail`: max 320px longest edge (WebP).
     - `preview`: max 1280px longest edge (WebP).
   - Generated derivatives are uploaded to S3 and marked `ready`.
3. **Presigned Download URLs for MCP Agents**:
   - MCP resources never stream base64 or raw image binary data over MCP JSON-RPC.
   - MCP tools (`get_image_download_url`, `get_group_image_download_urls`) issue presigned S3 `GET` URLs with a fixed 3600-second (1-hour) TTL directly to downstream consumers.

## Consequences
- ImageHost service remains lightweight and responsive.
- Bandwidth-heavy binary transfers bypass the Node.js event loop and MCP transport.
- Sharp provides efficient, native image resizing and WebP conversion.
