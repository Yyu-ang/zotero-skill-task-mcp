# MCP HTTP Architecture

This document describes the **current public implementation** of the plugin's MCP HTTP interface. It intentionally omits early prototypes, private development notes, and abandoned alternatives.

## 1. Transport

The plugin reuses Zotero's built-in Connector HTTP server through `Zotero.Server.Endpoints`.

- Endpoint: `/skilltask/mcp`
- Default host: loopback only (`127.0.0.1`)
- The plugin does **not** open a second TCP listener.
- Turning MCP off unregisters/disables the plugin endpoint; it does not stop Zotero's own Connector Server.

This keeps the plugin lifecycle simple and avoids maintaining a separate network service.

## 2. Default security model

Current defaults:

- MCP endpoint: **enabled**
- Access token requirement: **disabled**
- Network exposure: **loopback only**

Users can disable MCP from the plugin panel. Access-token protection can be enabled separately.

The implementation follows these boundaries:

- MCP requests do not accept arbitrary filesystem paths for read/write operations.
- Material returned to an Agent is limited to the fields enabled by the selected skill.
- Tokens are never intentionally written to logs.
- Note HTML is sanitized before Zotero write-back.
- File deliverables are written only to plugin-controlled locations before optional Zotero attachment import.

Because the endpoint is local-only by design, exposing it through port forwarding, reverse proxies, VPN forwarding, or other network bridges is outside the default threat model and should be reviewed separately.

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

- `Zotero.Server.Endpoints`
- plugin lifecycle hooks
- attachment APIs
- note creation/update APIs
- menu/window integration

## 7. Relevant source files

- `src/mcpServer.ts` — protocol handling and MCP tools
- `src/taskStore.ts` — task state, leases, completion/revision
- `src/taskGenerator.ts` — scanning and material readiness
- `src/attachments.ts` — attachment lookup/replacement helpers
- `src/core.ts` — plugin lifecycle and MCP registration

For user-facing setup and supported workflows, see the repository `README.md`.
