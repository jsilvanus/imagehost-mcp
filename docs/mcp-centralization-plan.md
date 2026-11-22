# MCP OAuth Centralization & Back-Channel Revocation Plan

## Overview & Architecture

We have centralized Model Context Protocol (MCP) authentication and authorization across the parish ecosystem onto **Tunnus** (OIDC / OAuth 2.1 provider at `https://id.riihimaenseurakunta.fi/tunnus` in production and `https://kehitys.riihimaenseurakunta.fi/identity` in staging).

Centralizing MCP OAuth allows users to:
1. Connect LLM tools and agent clients (e.g. Claude Desktop, Cursor IDE) via single-sign-on using Tunnus credentials.
2. Centrally inspect, manage, and revoke MCP client grants and sessions directly from the Tunnus `/account` management console.
3. Automatically propagate revocations to all connected backend applications in real time using the **OpenID Connect Back-Channel Logout 1.0 (RFC 8417)** specification.

```
┌─────────────────┐       RFC 9728 Metadata         ┌───────────────────────┐
│   MCP Client    │ ──────────────────────────────> │  ImageHost / MCP      │
│ (Claude/Cursor) │ <────────────────────────────── │ (kuvarasto /mcp)      │
└────────┬────────┘   authorization_servers=[Tunnus]└───────────┬───────────┘
         │                                                      │
         │ 1. GET /oauth/authorize (302 Relay)                  │
         │ 2. POST /oauth/token    (Token Relay)                │
         ▼                                                      │
┌─────────────────────────────────┐                             │
│          Tunnus OIDC            │                             │
│ (id.riihimaenseurakunta.fi)     │                             │
└────────────────┬────────────────┘                             │
                 │                                              │
                 │ RFC 8417 Back-Channel Logout token           │
                 │ POST /v1/auth/backchannel                    │
                 └──────────────────────────────────────────────┘
```

---

## Key Components Implemented

### 1. RFC 9728 Protected Resource Metadata (`src/oauth/metadata.ts`)
- Both `/.well-known/oauth-protected-resource` and path-inserted `/.well-known/oauth-protected-resource/mcp` advertise:
  - `resource`: `${publicUrl}/mcp`
  - `authorization_servers`: `[options.oidcIssuerUrl || publicUrl]`
  - `scopes_supported`: `['images:read', 'images:write', 'images:delete', 'groups:read', 'groups:write', 'mcp']`
  - `bearer_methods_supported`: `['header']`
- When `oidcIssuerUrl` is configured, client agents discovery points them directly to Tunnus for authorization. If unset, it gracefully falls back to `publicUrl` (the local authorization server).

### 2. Non-Destructive OAuth Relay (`src/oauth/authorization-server.ts`)
- **Preserved Local Fallback**: Existing local OAuth authorization codes and token endpoints are completely preserved.
- **GET `/oauth/authorize`**:
  - If `oidcIssuerUrl` is configured and `local !== 'true'` (and `direct !== 'true'`), the request is redirected with HTTP 302 to `${oidcIssuerUrl}/auth`.
  - All incoming query parameters (`client_id`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method`, `state`, etc.) are preserved, and `resource=${publicUrl}/mcp` is appended.
  - If `local=true` or `oidcIssuerUrl` is unset, the local HTML sign-in and consent forms render as usual.
- **POST `/oauth/token`**:
  - First inspects local `authStore` via `hasAuthorizationCode(b.code)` or `hasRefreshToken(b.refresh_token)`.
  - If the token/code exists in the local store, local code exchange or refresh logic runs.
  - If not found locally and `oidcIssuerUrl` is configured, the request is relayed via `fetch` to `${oidcIssuerUrl}/token` as `application/x-www-form-urlencoded` with `resource` appended.
  - If the relay returns a response, the status and JSON payload are transparently forwarded.
  - If the relay fails or `oidcIssuerUrl` is unset, it falls through to local error handling (`invalid_grant`).

### 3. Dual-Layer Token Verification (`src/mcp/http.ts`)
- When client requests hit `POST /mcp` with `Authorization: Bearer <token>`:
  - **Primary Layer (RS256 via Tunnus)**:
    - If `oidcIssuerUrl` is configured, verifies the token against Tunnus JWKS (`jose.createRemoteJWKSet` with in-memory caching).
    - Validates signature algorithm (`RS256`), issuer matching `oidcIssuerUrl`, audience matching `${publicUrl}` or `${publicUrl}/mcp`, and scope containing `images:read` or `mcp`.
    - Maps subject (`sub`) to user ID via database lookup (`users.oidcIssuer` + `users.oidcSub` or `users.oidcSub` or `users.id`) or auto-provisions the user if absent.
    - Populates Fastify request `authInfo` context with `userId`, `clientId`, and `scopes`.
  - **Fallback Layer (HS256 via Local Secret)**:
    - If RS256 verification fails (or token is local HS256), falls through to `verifyAccessToken(options.jwtSecret, options.publicUrl, options.resource, token)`.
    - If both fail, challenges with HTTP 401 and RFC 9728 `WWW-Authenticate` header.

### 4. OIDC Back-Channel Logout & Revocation (`src/auth/backchannel.ts` & `src/app.ts`)
- Mounted at `POST /v1/auth/backchannel` with aliases at `/oidc/backchannel` and `/mcp/backchannel`.
- Accepts `logout_token` as either `application/x-www-form-urlencoded` or `application/json`.
- Enforces RFC 8417 §2.4 requirements:
  - Validates RS256 signature against Tunnus JWKS.
  - Validates issuer matches `oidcIssuerUrl`.
  - Validates audience matches `oidcClientId` (e.g. `kuvarasto`) or `publicUrl`.
  - Validates that `nonce` claim is NOT present.
  - Validates `events` claim contains `http://schemas.openid.net/event/backchannel-logout` or `https://tunnus.fi/event/mcp-revoke`.
  - Requires presence of `sub` or `sid`.
- On valid token:
  - Finds all local user IDs associated with `sub`.
  - Revokes active web sessions in `SessionService` (via `revokeAllSessions`). Subsequent session verification for tokens issued prior to revocation returns `null`.
  - Revokes active refresh tokens in `authStore` (`revokeUserRefreshTokens`).
  - Returns HTTP 200 `{ ok: true }`.

### 5. Deployment & Configuration (`D:\kuvarasto` and `D:\imagehost-mcp`)
- `D:\imagehost-mcp\src\config.ts`:
  - Added support for `oidcJwksUri` (`process.env.OIDC_JWKS_URI`).
  - Permitted `OIDC_ISSUER_URL` or `OIDC_ISSUER`.
- `D:\imagehost-mcp\docker-compose.production.yml`:
  - Added `OIDC_ISSUER_URL: ${OIDC_ISSUER_URL:-${OIDC_ISSUER:-https://kehitys.riihimaenseurakunta.fi/identity}}`
  - Added `OIDC_JWKS_URI: ${OIDC_JWKS_URI:-}`
- `D:\kuvarasto\docker-compose.yml`:
  - Exposed `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_JWKS_URI` in container environment.
  - Verified Traefik stripprefix middleware: requests sent by Tunnus to `https://<domain>/kuvarasto/v1/auth/backchannel` have `/kuvarasto` stripped and arrive at the Fastify container as `/v1/auth/backchannel`.

---

## Test Verification

Unit and integration tests in `test/mcp_centralization.test.ts` and `test/mcp_oauth.test.ts` cover:
1. RFC 9728 protected resource discovery advertising Tunnus when configured, and falling back to `publicUrl` when unset.
2. `GET /oauth/authorize` redirecting to Tunnus with all query parameters and `resource` appended.
3. `GET /oauth/authorize?local=true` falling back to local sign-in page.
4. `POST /oauth/token` relaying to Tunnus for remote authorization codes and refresh tokens.
5. `POST /oauth/token` executing locally when codes or refresh tokens are in local `authStore`.
6. Dual-layer token verification in `/mcp`:
   - RS256 token verification against Tunnus JWKS (primary layer).
   - HS256 local token verification fallback.
   - Rejection of tokens with invalid audience or untrusted signing keys.
7. RFC 8417 Back-channel logout:
   - Valid logout token invalidating active session tokens in `SessionService` and refresh tokens in `authStore`.
   - Rejection of tokens containing `nonce`.
   - Rejection of tokens missing backchannel events.
   - Rejection of tokens with invalid audience or signatures.
   - Route alias support (`/oidc/backchannel`, `/mcp/backchannel`).

All 43 tests pass across 6 test suites with 0 lint and 0 TypeScript errors.
