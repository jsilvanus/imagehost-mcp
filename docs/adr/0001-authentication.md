# ADR 0001: Authentication & Identity Federation with Tunnus

## Context
ImageHost MCP serves two user types/entrypoints:
1. End-users accessing the mobile-first Progressive Web Application (PWA).
2. Autonomous AI agents accessing MCP resources and tools.

Identity must be federated with the central parish identity provider (Tunnus OIDC). Users must be unambiguously identified across sessions and devices.

## Decision
1. **User Identity Key**:
   Users are identified uniquely by the tuple `(issuer, subject)` as defined by standard OIDC, with a database unique constraint. Profile information (email, name) is mutable and non-authoritative for identity mapping.
2. **PWA Authentication**:
   The PWA authenticates against Tunnus via the standard Authorization Code flow. The server establishes an encrypted, `HttpOnly`, `SameSite=Lax` session cookie. Bearer tokens are not stored in browser localStorage to mitigate XSS risks.
3. **MCP Client Authentication**:
   MCP clients use OAuth 2.0 Authorization Code flow with PKCE (S256). Following the proven template in `jsilvanus/codestash/mcp/api-connector-style`, the server provides OAuth Protected Resource discovery (`/.well-known/oauth-protected-resource`), CIMD client validation, and signs access tokens bound to the user principal and audience.
4. **Authorization**:
   All endpoints enforce strict owner-isolation. Every query and operation checks `user_id` ownership on groups and images.

## Consequences
- Single sign-on with Tunnus is seamless.
- Agent tokens cannot be forged or hijacked for other scopes.
- Multi-tenancy is enforced at the database query level.
