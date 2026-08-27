# Cosmic AI Console MCP Implementation Plan

> **For Hermes:** Implement task-by-task using strict TDD and verify each phase with real command output.

**Goal:** Build and deploy an isolated, resource-bounded MCP gateway for the existing Gen API.

**Architecture:** A Node.js service on port 3101 implements stateless Streamable HTTP MCP and forwards tool calls to the local Gen API on port 3100. Per-user MCP keys authenticate clients; temporary artifact URLs keep image/audio base64 out of agent contexts.

**Tech Stack:** Node.js 22 ESM, built-in `node:http`, `node:test`, systemd, Traefik routing.

---

### Task 1: MCP protocol and authentication

**Files:**
- Create: `mcp/lib/auth.js`
- Create: `mcp/lib/protocol.js`
- Test: `mcp/test/auth.test.js`
- Test: `mcp/test/protocol.test.js`

1. Write failing tests for key generation/storage/validation/revocation and JSON-RPC initialize/list/error responses.
2. Run `node --test mcp/test/auth.test.js mcp/test/protocol.test.js`; expect failures because modules do not exist.
3. Implement minimum behavior with atomic JSON persistence and constant-time key comparison.
4. Re-run tests; expect pass.

### Task 2: Capacity controls

**Files:**
- Create: `mcp/lib/limits.js`
- Test: `mcp/test/limits.test.js`

1. Write failing tests for fixed-window per-key limits, concurrency acquire/release, queue saturation, and retry metadata.
2. Verify RED.
3. Implement bounded limiter/semaphore.
4. Verify GREEN and no timer leaks.

### Task 3: Artifacts

**Files:**
- Create: `mcp/lib/artifacts.js`
- Test: `mcp/test/artifacts.test.js`

1. Write failing tests for base64 decode, MIME allowlist, atomic writes, opaque lookup, expiration, cleanup, and traversal resistance.
2. Verify RED.
3. Implement artifact store.
4. Verify GREEN.

### Task 4: Gen backend client and tools

**Files:**
- Create: `mcp/lib/gen-client.js`
- Create: `mcp/lib/tools.js`
- Test: `mcp/test/tools.test.js`

1. Write failing tests using a local fake Gen HTTP server for all eight tools, argument validation, backend timeout, sanitized errors, and media-to-artifact conversion.
2. Verify RED.
3. Implement the REST adapter and tool registry.
4. Verify GREEN.

### Task 5: HTTP server

**Files:**
- Create: `mcp/server.js`
- Create: `mcp/package.json`
- Create: `mcp/keyctl.js`
- Test: `mcp/test/server.test.js`

1. Write failing end-to-end HTTP tests for health, auth, initialize, notifications, list tools, tool call, invalid JSON, oversized body, rate limit, and artifact download.
2. Verify RED.
3. Implement server with graceful shutdown and redacted logging.
4. Verify GREEN and run full MCP test suite.

### Task 6: Integration and live tool tests

**Files:**
- Create: `mcp/test/live.mjs`
- Modify: `.gitignore`
- Modify: `README.md`

1. Start MCP against local Gen.
2. Create one live MCP key via keyctl.
3. Verify handshake and all read/light tools.
4. Exercise chat, vision, image, edit, and audio once each; verify artifact HTTP downloads and MIME/size.
5. Confirm secrets do not appear in logs.

### Task 7: Deployment

**Files:**
- Create: `deploy/cosmic-mcp.service`
- Create/update reverse proxy routing for `/mcp`, `/health/mcp`, `/artifacts`.

1. Install environment/state files with restrictive permissions.
2. Install and start systemd service on port 3101 with 256 MB memory limit.
3. Add path-based route without changing existing Gen routing.
4. Verify public HTTPS handshake, tools/list, tool calls, artifact download, and existing Gen health/UI.

### Task 8: Load and resilience verification

**Files:**
- Create: `mcp/test/load.mjs`

1. Run parallel health/list/pool calls and verify success/error bounds.
2. Run controlled concurrent chat calls and confirm semaphore behavior.
3. Verify rate limiting and queue saturation do not crash service.
4. Record memory/CPU before and after; confirm process remains active.
5. Test service restart and health recovery.

### Task 9: Backup

1. Run full unit/integration tests and syntax checks.
2. Inspect git diff and secret scan.
3. Commit source/docs/deployment templates.
4. Push to `rangga2122/gemini-proxy`.
5. Verify GitHub commit and confirm excluded live secret/state files.
