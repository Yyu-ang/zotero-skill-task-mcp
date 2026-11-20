# MCP HTTP Architecture

This document describes the **current public implementation** of the plugin's MCP HTTP interface. It intentionally omits early prototypes, private development notes, and abandoned alternatives.

## 1. Transport

The plugin owns two independent Gecko `nsIServerSocket` listeners, sharing the MCP route `/skilltask/mcp` and the same task implementation.

- **23123:** loopback by default; all interfaces only after “Allow remote access” is enabled. The request policy accepts loopback and private/link-local peers, validates Host, and rejects browser Origin headers. It serves only the plugin MCP route.
- **23124:** created only when remote access and OAuth are both enabled. Every MCP request requires OAuth, even when the TCP peer is a local reverse proxy.
- Zotero's own Connector listener on **23119**, its routes, preferences and lifecycle are untouched. No listener uses **23121**.
- Mode changes close live plugin transports before changing policy. Disabling or unloading the plugin closes both owned sockets.
- The panel reports actual socket state. Bind failure never selects a different port; the implementation attempts to return to local-only 23123 and reports any remaining failure.

## 2. Access policy and OAuth

Both remote-access options default to false, including upgrades from old token settings. OAuth alone does not open a remote socket. Local/LAN access requires no token.

The public OAuth origin must be configured as an HTTPS origin. A TLS reverse proxy/tunnel forwards that origin to `127.0.0.1:23124`; it must never forward to the unauthenticated 23123 endpoint. OAuth issuer and resource come exclusively from the saved origin, not Host or forwarded headers.

`src/oauthServer.ts` implements discovery, dynamic public-client registration, authorization code + S256 PKCE, local Zotero consent, access/rotating refresh tokens and revocation. The resource is the public MCP URL and the scope is `skilltask`. Consent explains material access, skill-group creation, task management and deliverable writes. Callback URI matching is exact; untrusted client labels and callback URLs cannot contain control characters.

Authorization codes last five minutes and are single-use. Access tokens last one hour; refresh families last at most thirty days. Refresh replay revokes the whole family. Token digests and all authorization state live only in process memory. Revocation, mode/origin changes and restart invalidate grants; secure randomness and SHA-256 are required.

Socket admission limits active connections and body memory. Route, method and OAuth authentication checks run before body allocation. OAuth bodies are limited to 8 KiB. HTTP framing rejects duplicate headers, transfer encoding, invalid lengths and malformed UTF-8. There is no authorization bypass based on source IP or X-Forwarded headers on 23124.

Existing application boundaries remain: returned materials follow skill settings, HTML is sanitized before note creation, and file output is limited to plugin-controlled locations before Zotero attachment import. See [network-access.md](network-access.md) for setup and validation.

## 3. MCP protocol compatibility

The endpoint currently supports:

- `2026-07-28`
- `2025-11-25`
- `2025-06-18`
- `2025-03-26`
- `2024-11-05`

### 2026-07-28

The modern stateless path supports:

- `server/discover`
- per-request protocol metadata
- `MCP-Protocol-Version`
- `Mcp-Method`
- `Mcp-Name` for tool calls
- `resultType: "complete"`
- server metadata
- `structuredContent`
- cache hints for discovery/tool listings

### Legacy initialize path

Legacy clients use `initialize`. The server negotiates the client-requested supported revision instead of always forcing the newest legacy version.

Structured tool output follows the negotiated revision:

- `2025-06-18` and `2025-11-25`: tools may advertise `outputSchema`, and calls return matching `structuredContent`.
- `2025-03-26` and `2024-11-05`: the server keeps the compatible text result form and does not advertise unsupported structured-output contracts.

## 4. MCP tools

Current tools:

- `skilltask_claim` — claim one pending task
- `skilltask_renew` — extend an active lease
- `skilltask_release` — return a claimed task to pending
- `skilltask_status` — read-only queue/status summary
- `skilltask_submit` — submit a deliverable; `revise=true` explicitly revises a completed result
- `skilltask_inject_skill` — create a skill through MCP

The server keeps normal duplicate submission idempotent. Revising an already completed task requires explicit `revise=true`.

## 5. Task and file boundaries

Persistent plugin data lives under the Zotero data directory:

```text
skilltask/
  skill-groups.json
  tasks.json
  skills/<skill-id>/SKILL.md
  skills/<skill-id>/references/
  deliverables/<task-id>/
```

The plugin does not directly modify the Zotero database.

When a file deliverable is configured as a Zotero attachment, the plugin imports or replaces the attachment through Zotero APIs. Fixed output filenames can use either:

- skip existing attachment and mark the task complete
- overwrite the existing attachment

## 6. Compatibility notes

The repository manifest currently targets Zotero 9–10. Major Zotero upgrades should revalidate:

- Gecko socket and stream APIs
- plugin lifecycle hooks
- attachment APIs
- note creation/update APIs
- menu/window integration

## 7. Relevant source files

- `src/mcpServer.ts` — protocol handling, OAuth routing and MCP tools
- `src/networkAccess.ts` — two-switch mode selection, IP/Host policy and listener lifecycle
- `src/oauthServer.ts` — OAuth protocol and in-memory authorization state
- `src/lanMcpListener.ts` — independent Gecko TCP socket and byte-framed HTTP transport
- `scripts/test-lan-mcp.mjs` and `scripts/test-network-access.mjs` — socket framing and access-mode tests
- `scripts/test-oauth.mjs` and `scripts/test-mcp-access.mjs` — OAuth and MCP adapter tests
- `src/taskStore.ts` — task state, leases, completion/revision
- `src/taskGenerator.ts` — scanning and material readiness
- `src/attachments.ts` — attachment lookup/replacement helpers
- `src/core.ts` — plugin lifecycle and MCP registration

For user-facing setup and supported workflows, see the repository `README.md`.
