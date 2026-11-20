# MCP OAuth Integration with Tunnus & Client Identification

## Overview
ImageHost MCP supports remote MCP clients (such as Claude Desktop, Claude Code, Cursor, and Antigravity) connecting over **Streamable HTTP** at `/mcp`.

## Protocol Flow

1. **Discovery (RFC 9728 - OAuth Protected Resource Metadata)**:
   - When an unauthenticated MCP client requests `POST /mcp`, the server responds with:
     ```http
     HTTP/1.1 401 Unauthorized
     WWW-Authenticate: Bearer realm="imagehost-mcp", resource_metadata="https://<host>/.well-known/oauth-protected-resource"
     ```
   - Client fetches `/.well-known/oauth-protected-resource` and discovers:
     - `resource`: `https://<host>/mcp`
     - `authorization_servers`: `["https://<host>"]` (or direct Tunnus issuer)
     - `scopes_supported`: `["images:read", "images:write", "images:delete", "groups:read", "groups:write"]`

2. **Client Identification (CIMD - Client ID Metadata Documents)**:
   - MCP clients provide their client ID as an HTTPS URL pointing to their Client Metadata Document (per RFC 7591 / CIMD spec).
   - Dynamic Client Registration (DCR) is not required because CIMD allows deterministic metadata fetching without stateful pre-registration.

3. **Authorization Code Flow with PKCE (RFC 7636)**:
   - Client initiates `/oauth/authorize?client_id=...&response_type=code&code_challenge=...&code_challenge_method=S256&scope=...&redirect_uri=...`.
   - The user authorizes the MCP client. When authenticating the human owner, the authorization server checks the existing session or redirects to Tunnus OIDC.
   - User grants consent to the requested scopes (`images:read`, `images:write`, `images:delete`).
   - Server redirects to client's `redirect_uri` with an authorization code.

4. **Token Exchange & Verification**:
   - Client exchanges code and `code_verifier` at `/oauth/token`.
   - Server issues an asymmetric or HS256-signed JWT access token containing:
     - `sub`: User ID
     - `aud`: `https://<host>/mcp`
     - `scope`: Granted scopes
     - `exp`: Expiration time
   - Client presents `Authorization: Bearer <token>` on all `/mcp` requests.
