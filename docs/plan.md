# ImageHost MCP — Implementation Plan

## 1. Purpose

Build a personal image library that lets a user capture or import photographs from a phone, organize them into named groups, and make them securely accessible to the user's AI agents through MCP.

The system has three independently usable components:

1. **Image service** — source of truth for users, groups, images, metadata, storage, processing, permissions and change history.
2. **MCP adapter** — exposes the image service through MCP resources, resource templates, tools, subscriptions/notifications and, later, tasks and prompts.
3. **PWA** — responsive browser client for the photo library, camera capture, device-photo import and image management.

The PWA and MCP adapter communicate with the image service through the same documented REST API. Neither depends on the other.

## 2. Scope

### MVP

- Personal image library; each user sees only their own data.
- OIDC login through Tunnus.
- Named groups containing images.
- Mobile-first PWA with camera capture and device-gallery import.
- Automatic thumbnail and preview generation, preserving the original.
- Stable image IDs and sequential numbers unique within each group.
- Tags and descriptions.
- MCP access to group and image metadata and image variants.
- MCP OAuth authorization-code flow with PKCE and Streamable HTTP transport.
- MCP resource subscriptions and resource-update notifications.
- Soft deletion requested by an agent, visible in the PWA, followed by permanent deletion after a per-group retention period.
- Auditable operations, explicit authorization and durable change history.
- Docker-based development, staging and production deployment.

### Post-MVP

- Sharing images or groups between users.
- Shared groups, invitations and collaboration.
- Native Android application or synchronization into Android MediaStore.
- Automatic image embeddings and semantic search.
- Automatic AI tagging/classification.
- Webhooks and external event consumers.
- MCP Tasks for long-running batch processing.
- Public/anonymous image sharing.

## 3. Technology choices

| Area | Choice |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| PWA | Vite + React |
| API | REST, contract-first OpenAPI |
| MCP | TypeScript MCP SDK, Streamable HTTP |
| Authentication | Tunnus OIDC; OAuth 2.0 authorization code + PKCE for MCP clients |
| Database | PostgreSQL |
| Object storage | S3-compatible storage, VersityGW |
| Image processing | Sharp |
| Packaging | Docker and Docker Compose |

Keep the implementation modular, but do not introduce microservices prematurely. The image service may initially be one deployable Node.js application with clearly separated API, domain, worker and storage modules. The MCP adapter and PWA remain separate components.

Pin runtime, base images and dependencies for reproducible builds. Never put durable application data inside container writable layers.

## 4. System architecture

    Tunnus OIDC
       |                         |
    PWA login                MCP OAuth
       |                         |
    Vite + React             MCP adapter
       |                         |
       +-------- HTTPS ----------+
                    |
              Image service
              REST API + domain
                /         \
          PostgreSQL     S3 / VersityGW
                ^
                |
          Processing worker
          (Sharp, deletion jobs,
           durable event outbox)

### Image service

- Owns all business rules and authorization decisions.
- Issues image and group identifiers and group-local image numbers.
- Manages uploads, image variants, tags, retention and deletion.
- Stores metadata in PostgreSQL and binaries in S3.
- Records durable domain events in an outbox.
- Provides REST endpoints described by OpenAPI.

### MCP adapter

- Authenticates MCP clients and maps their identity/scopes to an image-service principal.
- Calls the REST API; it must not access PostgreSQL or S3 directly.
- Exposes MCP resources, resource templates, tools and subscriptions.
- Converts image-service events into MCP resource update notifications for active subscribers.
- Must tolerate clients that do not support subscriptions or optional MCP capabilities.

### PWA

- Uses the REST API and OIDC login.
- Does not use MCP internally.
- Provides responsive gallery, group management, capture, import, tagging, restore and deletion visibility.
- Uses ordinary API refresh/polling or a future live-update channel; MCP subscriptions are not a PWA dependency.

## 5. Domain model and data rules

### Users

A user is identified by the stable OIDC subject (issuer + subject), not by email address. Store issuer and subject with a unique constraint. Email and display name are profile attributes, not authorization identifiers.

### Groups

A group belongs to one owner in the MVP and has:
- UUID, name and optional description.
- Creation/update timestamps.
- Configurable deletion-retention duration.
- Optional future settings.
- Status (active/archived/deleted, as appropriate).

Groups are private by default. Keep ownership and authorization boundaries explicit so sharing can be added without changing image identity or storage layout.

### Images

Each image has:
- Immutable UUID as its canonical identifier.
- Group ID.
- Positive integer sequence number unique within that group.
- Original filename and detected media type.
- Width, height and byte size.
- Upload/creation timestamps.
- Processing status.
- Description and tags.
- Deletion state and relevant timestamps/actor.
- Storage keys for original and generated variants.

The visible number is a human-friendly reference, not a globally unique identifier. Display it with a consistent format such as 001, 002; retain the integer in the database. Numbers are never reused, including after permanent deletion.

Allocate numbers atomically using a group counter updated in a transaction (or an equivalent concurrency-safe mechanism). Do not use an unlocked MAX(number) + 1 calculation.

An image belongs to one group in the MVP. Keep storage identity independent of the group path so future multi-group membership or sharing does not require copying image binaries.

### Suggested tables

- users
- groups
- images
- image_variants
- tags
- image_tags
- deletion_requests (or deletion fields on images)
- event_outbox
- audit_log

Use foreign keys, appropriate unique constraints and indexes. At minimum enforce unique (group_id, sequence_number) and unique OIDC (issuer, subject).

## 6. Image upload and processing

### Variants

Create three image variants:

| Variant | Target | Use |
|---|---:|---|
| Thumbnail | 320 px longest edge | Dense gallery and compact MCP results |
| Preview | 1280 px longest edge | Detail view and agent inspection |
| Original | Preserve uploaded dimensions | Full-resolution access |

Generated variants preserve aspect ratio. The gallery uses square, edge-to-edge cells with a consistent cover crop; do not destructively crop the stored preview or original.

Use Sharp to decode, validate, auto-orient and generate derivatives. Define supported formats and upload size/pixel limits. Reject malformed files and decompression-bomb-like inputs safely. Do not trust client-supplied MIME types.

Store originals and variants in S3-compatible storage. PostgreSQL stores object keys and metadata, not image bytes. Use opaque, non-guessable object keys; do not expose bucket paths.

Suggested logical object layout:

    users/{user_id}/images/{image_id}/original
    users/{user_id}/images/{image_id}/thumbnail.webp
    users/{user_id}/images/{image_id}/preview.webp

Object naming is an implementation detail; clients use API/MCP identifiers and URLs, never construct storage keys.

### Upload lifecycle

1. PWA requests an upload session or upload target.
2. Service authorizes the user and reserves a group-local sequence number.
3. Client uploads the original (direct-to-S3 with a short-lived scoped upload URL, or through the service if simpler initially).
4. Service validates and records the upload.
5. Processing worker creates thumbnail and preview.
6. Image becomes ready only when required variants are available.
7. Service emits durable image-uploaded and processing-completed events as applicable.

Define retry and cleanup behavior for abandoned uploads and failed processing. A failed processing image must be visible with an error/retry state rather than silently disappearing. Do not announce a ready image to MCP before its resources can be read.

### Metadata and privacy

Retain only metadata required by product behavior. Decide explicitly whether original EXIF is retained; if retained, keep it private. Strip GPS and unnecessary EXIF from generated derivatives by default. Do not expose location metadata through MCP unless a later explicit feature and permission allow it.

## 7. PWA requirements

### Main photo library

- Mobile-first responsive layout.
- Named groups presented as headings/sections.
- Approximately four square images per row on a phone; adapt column count to viewport width.
- No gutters between image cells/rows, or only a very small deliberate gap.
- Display the group-local sequence number over each thumbnail.
- Loading, empty, upload-in-progress and error states.
- Tapping an image opens its detail view.
- Pending-deletion images remain visible with a clear red X/overlay and accessible status text.
- Provide group creation, rename and retention settings.

### Camera and import UI

The primary capture view should have:
- Large camera preview.
- Central shutter button.
- Bottom-left device photo-library/import action.
- Bottom-right camera activation/switch action, including front/rear selection when supported.

Use browser camera APIs where available and a file-input fallback for browsers with limited camera support. Request camera permission only after the user initiates capture. Handle denied permissions, missing cameras, device rotation and browser differences.

Import must support selecting multiple images from the device photo library. Upload progress and retry must be visible.

### Phone photo library integration

The PWA can:
- Import photos selected from the phone's native photo picker.
- Save/download service images to the device with user action.
- Use Web Share where supported.

A PWA cannot reliably act as a native photo provider or guarantee background synchronization into the phone's native gallery. Treat automatic Android MediaStore synchronization as a possible future Kotlin companion, not an MVP promise.

### Offline behavior

Cache the application shell. A small IndexedDB-backed upload queue may retain selected files and retry while the PWA is active. Do not promise reliable background uploads after the browser is closed, especially on iOS. Make pending local uploads and server-confirmed uploads distinguishable.

## 8. Deletion and retention

Deletion requested through MCP is a soft-delete request, not immediate object removal.

- Each group has an owner-configured retention duration.
- An authorized MCP tool can request deletion of an image.
- The image is marked pending_deletion and the PWA displays a red X/status overlay.
- Ordinary image listings and normal resource reads omit or deny pending-deletion images by default.
- The owner can restore the image before the deadline.
- A scheduled worker permanently deletes original and derivative objects after the retention deadline, then finalizes the database state.
- Sequence numbers are not reused.
- Deletion and restoration are recorded in the audit log.

The MCP agent cannot change a group's retention duration or shorten an existing deletion deadline. Retention settings are owner-controlled through the PWA/API.

Recommended default: calculate and persist the deletion deadline at the time of the deletion request; later group setting changes affect future requests only.

Deletion jobs must be idempotent and retryable. Handle partial S3 deletion safely. Define a clear policy for backups and database retention; deleting live objects does not automatically erase backup copies.

## 9. Authentication, authorization and security

### Identity

- Integrate user login with Tunnus OIDC.
- Identify users by issuer and subject.
- PWA uses an appropriate browser session pattern; prefer secure, HttpOnly, SameSite cookies with a backend-for-frontend/session if practical, rather than storing long-lived tokens in local storage.
- MCP clients use OAuth 2.0 authorization code flow with PKCE through the supported Tunnus integration.
- MCP adapter validates tokens and maps them to a user principal.
- Do not assume the MCP client and PWA share a browser session.

### Authorization

Personal MVP: all access is owner-scoped. Every REST endpoint and MCP operation must enforce ownership server-side.

Suggested scopes:
- images:read
- images:write
- images:delete
- groups:read
- groups:write

Scopes are an upper bound on what a client may do; they do not replace per-user ownership checks. Deletion requires images:delete. Group retention changes require owner-authorized group write access and must not be available to ordinary agent deletion flows.

### Image URLs

Use short-lived signed URLs or an authenticated image proxy. URLs must be scoped to one image variant and one authorized user/client, expire quickly, and never grant access to an entire bucket. Do not return permanent public object URLs.

MCP responses should provide URLs the agent runtime can actually fetch, not URLs that only work inside the PWA browser session. Where the MCP client supports image content directly, the adapter may return image content for appropriately sized variants. For large originals, prefer a short-lived URL or an explicit bounded download flow.

### General security

- TLS everywhere outside local development.
- Validate and limit upload size, image dimensions and decoded pixel count.
- Rate-limit authentication, upload, search and mutation endpoints.
- Protect state-changing browser endpoints against CSRF if cookie sessions are used.
- Validate OAuth redirect URIs and PKCE; do not accept arbitrary redirects.
- Keep secrets out of images, logs, source control and container images.
- Avoid logging signed URLs, access tokens or image contents.
- Audit sensitive operations.
- Apply CORS narrowly.
- Define backup, restore and incident-response procedures.

## 10. REST API and OpenAPI

OpenAPI is the contract-first source for the REST API. Generate or validate types/clients where practical. Keep business rules in domain services, not route handlers.

Suggested endpoint groups (exact paths and schemas to be finalized in API design):

### Groups
- GET /v1/groups
- POST /v1/groups
- GET /v1/groups/{groupId}
- PATCH /v1/groups/{groupId}
- DELETE /v1/groups/{groupId} (define archive/delete semantics explicitly)
- GET /v1/groups/{groupId}/images

### Images
- POST /v1/groups/{groupId}/uploads
- POST /v1/uploads/{uploadId}/complete
- GET /v1/images/{imageId}
- GET /v1/images/{imageId}/variants/{variant}
- PATCH /v1/images/{imageId}
- Tag add/remove endpoints
- POST /v1/images/{imageId}/deletion
- POST /v1/images/{imageId}/restore

### Search and change history
- GET /v1/images/search with group, tags, date and status filters.
- Cursor-based pagination with stable ordering.
- GET /v1/changes?after={cursor} (or equivalent) for durable change catch-up.

Use consistent error envelopes, request IDs, pagination and validation. Avoid returning unbounded group image lists.

## 11. MCP adapter

Use the official TypeScript MCP SDK and Streamable HTTP transport. Keep MCP handlers thin: validate inputs, call the image-service API, and map results to MCP protocol types.

### Resources and resource templates

Resources are the primary interface for reading known library objects.

Suggested URI scheme (opaque IDs preferred; group slugs are display conveniences, not identifiers):

    photo://library
    photo://groups
    photo://groups/{group_id}
    photo://groups/{group_id}/images
    photo://images/{image_id}/metadata
    photo://images/{image_id}/thumbnail
    photo://images/{image_id}/preview
    photo://images/{image_id}/original

- Library resource: compact library overview.
- Groups resource: user's accessible groups.
- Group resource: name, description, image count and retention policy summary.
- Group image listing: paginated metadata and thumbnail resource references, not embedded full image data.
- Image metadata: number, group, tags, description, dimensions, variant availability, timestamps and deletion state as permitted.
- Thumbnail/preview: image content where client limits allow.
- Original: image content only when reasonable; otherwise a short-lived authorized URL or explicit resource representation with media type and size metadata.

Use resource templates for dynamic image/group URIs. Resource URIs are not bearer credentials; every read must be authenticated and authorized. Do not expose another user's identifiers through enumeration.

### Tools

Tools perform actions or searches that do not fit resource reads.

Initial tool set:
- search_images — paginated search by group, tags, date, text/description and status.
- list_group_images — paginated group listing if more convenient than reading the group listing resource.
- create_group
- update_group — owner-controlled name/description/retention changes.
- add_image_tags
- remove_image_tags
- update_image_description
- request_image_deletion
- restore_image
- get_changes — durable change catch-up from cursor.

Avoid redundant tools when a resource read or REST operation is a better fit. Do not provide an immediate permanent-delete tool. The deletion tool always starts the retention workflow.

MCP upload support is not required for MVP; the PWA is the primary capture/import client. Consider an upload tool only when a clear agent-driven upload use case exists.

### Subscriptions and notifications

Support resource subscriptions where supported by the MCP protocol/client:
- Subscribe to a group resource or its image-list resource to observe changes across the group.
- Subscribe to individual image metadata/variant resources when useful.
- Send resource-updated notifications after committed changes.
- Send resource-list-changed notifications when the set of discoverable resources changes, where applicable.

Internal domain events should include:
- group.created, group.updated, group.archived
- image.uploaded, image.processing.completed, image.processing.failed
- image.metadata.updated, image.tags.updated
- image.deletion.requested, image.restored, image.deleted

Persist events in a transactional outbox in the same database transaction as the domain change. A dispatcher publishes updates to active MCP sessions/subscriptions. Notifications are hints that a resource has changed; they are not a durable queue and must not contain image binaries.

Clients can disconnect or miss notifications. Provide get_changes with a stable cursor so clients can catch up. Define cursor ordering and retention; return a reset/resync indication if a cursor is too old.

Group-level subscriptions are important and should be supported. A group image-list resource update is the natural notification surface for additions, removals and status changes within that group.

### Prompts and Tasks

Prompts are optional for MVP. Candidate prompts include review_new_photos, describe_photo, organize_group and compare_photos.

Do not make MCP Tasks a dependency for MVP. Design a backend job abstraction so future long-running operations can be exposed through MCP Tasks if supported by the selected SDK and target clients. Potential jobs include embedding generation, batch classification/tagging, reprocessing variants and large group exports.

Ordinary image reads, tagging and deletion requests should remain ordinary resources/tools, not tasks.

### Client compatibility

MCP clients vary in support for resource subscriptions, image content, prompts and Tasks. Core functionality must work with resources, tools and ordinary reads even when optional capabilities are absent. Test against intended clients and document capability requirements. Do not assume every MCP host supports subscriptions or task APIs.

## 12. Events and change delivery

The image service owns a durable event/outbox. The outbox is written transactionally with the relevant data mutation. A worker dispatches events to:
- MCP adapter subscriptions (live, best effort).
- PWA live-update mechanism, if/when added.
- Future webhook or automation consumers.

Keep event schemas versioned and include event ID, event type, user/owner ID, relevant group/image IDs, occurrence time and minimal safe metadata. Never put image bytes or signed URLs in the event log.

The durable change feed is the recovery mechanism; notifications are only an optimization for low latency.

## 13. Deployment and configuration

### Development
- Run Node.js application(s) locally.
- Docker Compose provides PostgreSQL and optionally local S3-compatible storage for integration tests.
- Document migrations, seed/test user setup and Tunnus development OIDC configuration.

### Staging
- Pinned application image(s).
- Docker Compose PostgreSQL.
- S3-compatible storage configured by environment.
- Staging OIDC client/issuer and isolated buckets/database.
- Health checks and structured logs.

### Production
- Pinned application image(s), no floating latest tag.
- PostgreSQL provided externally by the deployment environment.
- S3-compatible storage provided externally (VersityGW).
- Secrets injected at runtime.
- Database migrations run as a controlled release step.
- Backups and restore tested.
- Health/readiness endpoints and operational metrics.

Suggested environment configuration:
- DATABASE_URL
- OIDC_ISSUER_URL
- OIDC_CLIENT_ID
- OIDC_CLIENT_SECRET (only where the selected flow requires a confidential client)
- PUBLIC_BASE_URL
- S3_ENDPOINT
- S3_REGION
- S3_BUCKET
- S3_ACCESS_KEY_ID
- S3_SECRET_ACCESS_KEY
- S3_FORCE_PATH_STYLE (if required by provider)
- IMAGE_MAX_UPLOAD_BYTES
- IMAGE_MAX_PIXELS
- DEFAULT_DELETION_RETENTION
- SIGNED_URL_TTL_SECONDS

Do not commit real values. Provide .env.example with safe placeholders.

## 14. Testing strategy

- Unit tests for domain rules, sequence allocation, retention deadline calculation, authorization and variant selection.
- PostgreSQL integration tests for transactions, uniqueness and concurrent uploads.
- S3 integration tests for upload, variant storage, retries and permanent deletion.
- API contract tests against OpenAPI.
- MCP protocol tests for resources, templates, tools, subscriptions, authentication and error behavior.
- PWA tests for responsive gallery, camera permission/fallback, multi-file import, upload retry and deletion/restore states.
- End-to-end tests covering OIDC login through upload, processing, MCP read, deletion request, restore and expiry.
- Security tests for cross-user access, token scope enforcement, URL expiry, invalid media, CSRF (where applicable) and OAuth redirect validation.

## 15. Implementation milestones

### Milestone 0 — Repository foundation
- Confirm package manager, Node version and repository conventions.
- Establish TypeScript project structure and lint/format/test commands.
- Add Docker Compose for development PostgreSQL and required local dependencies.
- Add architecture decision records for authentication, upload strategy and MCP SDK/version.

### Milestone 1 — Contracts and identity
- Define domain types and initial PostgreSQL schema/migrations.
- Configure Tunnus OIDC integration for the PWA.
- Define OpenAPI skeleton and error/pagination conventions.
- Define MCP OAuth registration/authorization approach with Tunnus.

### Milestone 2 — Image service
- Implement groups and owner-scoped authorization.
- Implement upload sessions and S3 storage.
- Implement Sharp thumbnail/preview pipeline.
- Implement concurrency-safe group numbering.
- Implement image metadata, tags and descriptions.

### Milestone 3 — PWA
- Implement login and group library.
- Implement responsive square gallery and image detail.
- Implement camera capture and device photo picker import.
- Implement upload progress/retry and processing states.
- Implement group retention settings and pending-deletion/restore UI.

### Milestone 4 — MCP adapter
- Implement Streamable HTTP and OAuth/PKCE integration.
- Implement resources, resource templates and tools.
- Implement image content/short-lived URL delivery.
- Implement scope and owner enforcement.
- Add MCP integration tests using representative clients.

### Milestone 5 — Events and deletion
- Implement transactional outbox and durable change cursor.
- Implement MCP group/image subscriptions and notifications.
- Implement deletion request, restore, retention scheduler and permanent S3 cleanup.
- Verify idempotency, audit history and missed-notification recovery.

### Milestone 6 — Release readiness
- Add staging and production Docker configurations.
- Add migrations/release procedure, health checks and observability.
- Run end-to-end and security tests.
- Document backup/restore, operations and client compatibility.

## 16. MVP acceptance criteria

1. A user can authenticate through Tunnus and access only their own library.
2. The user can create and configure named groups.
3. The PWA displays group headings and a dense square photo grid with group-local numbers.
4. The user can capture a photo or import multiple photos from the device gallery.
5. An accepted upload receives a stable UUID and a unique, never-reused group number.
6. The service stores the original and creates thumbnail and preview variants.
7. The user can view and edit tags and descriptions.
8. An authorized MCP client can authenticate with OAuth/PKCE and use Streamable HTTP.
9. The MCP client can discover groups, search/list images, read metadata and obtain thumbnail, preview and original access.
10. Group-level and image-level subscriptions produce resource update notifications for connected clients where supported.
11. A client can recover missed changes using a durable cursor.
12. An authorized MCP deletion request marks the image pending deletion and the PWA shows a red X.
13. The owner can restore the image before its persisted deletion deadline.
14. A scheduled worker permanently removes all image variants after the retention period and retries safely after failures.
15. Cross-user access is denied at both REST and MCP boundaries.
16. Development, staging and production deployment modes are documented and reproducible.

## 17. Open decisions

Resolve these during implementation and record decisions as short ADRs:

- Exact Tunnus OAuth client/consent configuration and whether the MCP adapter is a separate OAuth resource server or shares a supported issuer configuration.
- Whether uploads go through the image service or use presigned S3 upload sessions (recommended for larger files).
- Supported source image formats and upload limits.
- Whether original EXIF metadata is retained privately.
- Exact group archive/delete semantics.
- Default deletion retention and allowed owner-configurable range.
- Whether MCP image reads return image content, short-lived URLs or both, based on client interoperability and file size.
- Which MCP client applications are mandatory compatibility targets.
- Whether the PWA needs live updates in MVP or can initially refresh/poll.
