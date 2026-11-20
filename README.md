# ImageHost MCP

Personal image library and Model Context Protocol (MCP) server bridging mobile photo capture, library organization, and AI agent integration.

## 1. Overview & Architecture

ImageHost MCP consists of three decoupled components:

1. **Image Service (REST API & Domain)**: Source of truth for users, groups, images, storage variants, metadata, audit trails, and transactional events.
2. **MCP Adapter**: Exposes resources (`photo://...`), tools, and subscription notifications over Streamable HTTP with OAuth 2.0 PKCE authentication. Direct binary streaming through MCP is avoided by issuing secure, 1-hour presigned S3 download URLs.
3. **PWA (React + Vite)**: Mobile-first responsive web client for camera capture, device gallery imports, image tagging, and retention/deletion management.

```
       Tunnus OIDC
      /           \
  PWA Login    MCP OAuth
     |             |
 Vite React    MCP Adapter
     \             /
      Image Service (REST API)
       /          \
  PostgreSQL    S3 / MinIO / VersityGW
       ^
       |
  Workers:
  - Retention Worker (Permanent deletion after expiry)
  - Outbox Dispatcher (Resource update notifications)
```

## 2. Key Features

- **Owner-Scoped Multi-Tenancy**: Strict user boundary isolation; users only ever access their own groups and images.
- **Tunnus OIDC & MCP OAuth**: Single sign-on with Tunnus OIDC for the web UI; standard OAuth 2.0 Authorization Code Flow + PKCE for MCP clients (RFC 8414 & RFC 9728 discovery).
- **Non-Reused Sequential Numbers**: Human-friendly 3-digit identifiers (`001`, `002`) allocated atomically and unique within each group.
- **Sharp Processing Pipeline**: Generates WebP thumbnails (320px longest edge) and previews (1280px longest edge) while preserving full original assets.
- **1-Hour Presigned MCP URLs**: Tools `get_image_download_url` and `get_group_image_download_urls` issue presigned GET URLs with a strict 3600-second TTL. Image bytes never burden the MCP transport.
- **Retention & Two-Phase Deletion**:
  - Soft-delete requests place images into `pending_deletion` state with a deadline derived from group retention hours (default: 72 hours).
  - Images in pending deletion show a red status overlay in the PWA and can be restored before the deadline.
  - An automated `RetentionWorker` permanently purges expired S3 binaries, records audit history, and marks the image deleted while preserving group sequence numbering.
- **Transactional Outbox & MCP Subscriptions**:
  - Mutations generate outbox records inside database transactions.
  - Active MCP sessions subscribing to `photo://groups/{group_id}/images` or `photo://images/{image_id}/metadata` receive `notifications/resources/updated` broadcasts via the `OutboxDispatcher`.
  - Clients catching up after disconnections use the monotonic cursor through `get_changes` or `/v1/changes`.

## 3. Local Development

### Prerequisites

- Node.js >= 22
- pnpm >= 10
- Docker & Docker Compose

### Step-by-Step Setup

1. **Install dependencies**:

   ```bash
   pnpm install
   ```

2. **Start local database & S3 storage**:

   ```bash
   docker compose up -d
   ```

   This starts:
   - PostgreSQL 17 on `localhost:5432` (`imagehost_user` / `imagehost_pass`, database `imagehost`)
   - MinIO S3 on `localhost:9000` (Console on `localhost:9001`, `minioadmin` / `minioadminpassword`)

3. **Configure environment variables**:

   ```bash
   cp .env.example .env
   ```

4. **Run database migrations**:

   ```bash
   pnpm db:migrate
   ```

5. **Start development servers**:

   ```bash
   # In terminal 1: Start backend with hot reload
   pnpm dev

   # In terminal 2: Start React PWA dev server
   pnpm -C web dev
   ```

6. **Run tests & verification**:
   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm build:web
   ```

## 4. Environment Variables Reference

| Variable                            | Default                                                             | Description                                                        |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `PORT`                              | `3000`                                                              | HTTP port to listen on                                             |
| `HOST`                              | `0.0.0.0`                                                           | HTTP host interface to bind to                                     |
| `NODE_ENV`                          | `development`                                                       | Environment mode (`development`, `test`, `production`)             |
| `BASE_URL`                          | `http://localhost:3000`                                             | Canonical public base URL                                          |
| `DATABASE_URL`                      | `postgres://imagehost_user:imagehost_pass@localhost:5432/imagehost` | PostgreSQL connection string                                       |
| `S3_ENDPOINT`                       | `http://localhost:9000`                                             | S3 API endpoint URL                                                |
| `S3_REGION`                         | `us-east-1`                                                         | S3 bucket region                                                   |
| `S3_BUCKET`                         | `imagehost`                                                         | S3 bucket name                                                     |
| `S3_ACCESS_KEY_ID`                  | `minioadmin`                                                        | S3 credentials access key ID                                       |
| `S3_SECRET_ACCESS_KEY`              | `minioadminpassword`                                                | S3 credentials secret access key                                   |
| `S3_FORCE_PATH_STYLE`               | `true`                                                              | Use path-style URLs for MinIO / VersityGW                          |
| `OIDC_ISSUER_URL`                   | `https://kehitys.riihimaenseurakunta.fi/identity`                   | Tunnus OIDC issuer URL                                             |
| `OIDC_CLIENT_ID`                    | `kuva-mcp`                                                          | Tunnus OIDC client ID                                              |
| `OIDC_CLIENT_SECRET`                | `""`                                                                | Tunnus OIDC client secret (if required)                            |
| `SESSION_SECRET`                    | `...`                                                               | Secret key for session encryption & JWT signing (minimum 32 chars) |
| `IMAGE_MAX_UPLOAD_BYTES`            | `26214400` (25MB)                                                   | Maximum allowed file upload size                                   |
| `IMAGE_MAX_PIXELS`                  | `50000000` (50MP)                                                   | Maximum allowed pixel dimension                                    |
| `DEFAULT_DELETION_RETENTION_HOURS`  | `72`                                                                | Default retention period before permanent purge                    |
| `RETENTION_WORKER_INTERVAL_SECONDS` | `60`                                                                | Background retention worker interval                               |
| `ENABLE_RETENTION_WORKER`           | `true`                                                              | Enable periodic retention purge worker in the app process          |
| `OUTBOX_DISPATCH_INTERVAL_MS`       | `2000`                                                              | Outbox dispatcher notification polling interval in milliseconds    |
| `ENABLE_OUTBOX_DISPATCHER`          | `true`                                                              | Enable periodic outbox dispatcher in the app process               |

## 5. Production Deployment

### Multi-Stage Docker Build

Build the production container image (compiles PWA and TypeScript):

```bash
docker build -t ghcr.io/jsilvanus/imagehost-mcp:latest .
```

### Production Docker Compose Behind Traefik

A ready-to-deploy configuration is provided in `docker-compose.production.yml`:

- Uses shared networks `traefik-public` and `shared_multi_network`.
- Runs a dedicated `migrate` container that executes `node dist/db/migrate.js` to ensure the schema is current before the app service starts.
- Integrates with Traefik router, Let's Encrypt TLS certresolver, and container health checks against `/healthz`.

To deploy:

```bash
docker compose -f docker-compose.production.yml up -d
```

### Observability & Health

- **Health check endpoint**: `GET /healthz`
  - Validates active database connectivity via `SELECT 1`.
  - Returns `200 OK` with `{ status: "ok", database: "connected", timestamp: "..." }`.
  - Returns `503 Service Unavailable` with `{ status: "degraded", database: "disconnected" }` on connection failures.
- **Structured logging**:
  - Request IDs are tracked via incoming `x-request-id` headers or auto-generated UUIDs.
  - JSON structured logs formatted for production log aggregators.

## 6. MCP Protocol Surface

### Transport

- **Streamable HTTP**: `POST /mcp`
- **Metadata Discovery**: `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`

### Resources

- `photo://library`: Overview of the user's groups and image summary.
- `photo://groups`: Listing of all user groups.
- `photo://groups/{group_id}`: Group metadata and retention settings.
- `photo://groups/{group_id}/images`: Group images with sequence numbers and thumbnail URLs.
- `photo://images/{image_id}/metadata`: Full image metadata, dimensions, and tags.
- `photo://images/{image_id}/thumbnail`: 1-hour presigned GET URL for 320px thumbnail.
- `photo://images/{image_id}/preview`: 1-hour presigned GET URL for 1280px preview.
- `photo://images/{image_id}/original`: 1-hour presigned GET URL for unmodified original.

### Tools

- `get_image_download_url`: Issue 1-hour presigned download URL for an image variant.
- `get_group_image_download_urls`: Batch issue presigned download URLs for all images in a group.
- `search_images`: Search library by query keyword, group ID, or tags with cursor pagination.
- `list_group_images`: Paginated group image listing.
- `create_group`: Create a new named photo group with custom retention duration.
- `update_group`: Update group name, description, or retention hours.
- `add_image_tags`: Attach tags to an image.
- `remove_image_tags`: Remove tags from an image.
- `update_image_description`: Update an image description.
- `request_image_deletion`: Request soft deletion of an image, setting its retention deadline.
- `restore_image`: Restore a soft-deleted image before its retention window expires.
- `get_changes`: Catch up on durable domain events using a monotonic cursor sequence.

### Subscriptions

Clients can subscribe to `photo://groups/{group_id}/images` and `photo://images/{image_id}/metadata`. The `OutboxDispatcher` publishes `notifications/resources/updated` whenever resources are modified. Disconnected clients can resume synchronization at any time using `get_changes`.
