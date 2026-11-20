# ADR 0003: MCP SDK, Streamable HTTP Transport, and Notification Strategy

## Context
Model Context Protocol (MCP) clients (such as Claude Desktop, Claude Code, Antigravity, and cursor/remote bots) communicate over standard transports. Modern MCP server architecture standardizes on Streamable HTTP rather than legacy SSE or stdio for remote multi-user services.

## Decision
1. **MCP SDK**:
   Use `@modelcontextprotocol/sdk` (TypeScript) adhering to the standard Streamable HTTP transport specification.
2. **Transport**:
   Streamable HTTP endpoint mounted at `/mcp`. Unauthenticated calls receive HTTP 401 with `WWW-Authenticate` header pointing to OAuth discovery metadata per RFC 9728.
3. **Subscriptions & Notifications**:
   - Clients may subscribe to resources (`photo://groups/{group_id}/images`, `photo://images/{image_id}/metadata`).
   - Domain events are written to a transactional `event_outbox` table in PostgreSQL.
   - MCP adapter broadcasts `notifications/resources/updated` to active subscribers based on outbox events.
   - For offline or disconnected clients, `get_changes(cursor)` enables deterministic catch-up.

## Consequences
- Clean standards compliance across all modern MCP client implementations.
- Zero data loss for state changes thanks to durable cursor synchronization.
