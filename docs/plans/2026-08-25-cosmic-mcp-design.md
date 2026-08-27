# Cosmic AI Console MCP Design Spec

**Date:** 2026-08-25
**Status:** Approved

## Overview

Add a lightweight, separately deployed MCP Streamable HTTP gateway to Cosmic AI Console. It exposes safe AI tools while delegating all generation and account rotation to the existing Gen API.

## Goals

- Expose chat, vision, image generation/editing, TTS, voice listing, pool status, and health as MCP tools.
- Use separate revocable MCP keys per user.
- Protect the VPS with per-key rate limits, global concurrency limits, body limits, and timeouts.
- Return temporary HTTPS artifact URLs for image/audio outputs instead of large base64 payloads.
- Keep MCP isolated from cookies, Google sessions, token files, and browser profiles.

## Non-Goals

- MCP does not replace the existing REST/OpenAI-compatible API.
- MCP does not manage account cookies, token capture, cronjobs, or API keys for Gen.
- MCP does not expose administrative credentials or account identities.
- MCP does not open Camoufox/browser processes.

## Architecture

```text
MCP clients --Bearer MCP key--> Cosmic MCP :3101
Cosmic MCP --internal API key--> Gen API :3100
Gen API --> account pool/upstream
Cosmic MCP --> temporary artifacts --> /artifacts/*
```

The service uses Node.js built-ins only where practical. It is stateless for MCP protocol requests; persistent state consists only of MCP key metadata and temporary artifacts.

## Public Interface

- `POST /mcp`: JSON-RPC MCP Streamable HTTP endpoint.
- `GET /health`: service health without secrets.
- `GET /artifacts/:id`: opaque temporary media artifact.

Supported MCP methods:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

Tools:

- `chat_text`
- `analyze_image`
- `generate_image`
- `edit_image`
- `generate_audio`
- `list_voices`
- `get_pool_status`
- `get_service_status`

## Authentication

MCP client keys have format `cosmic-mcp-<random>`. Each record has label, active state, created time, per-minute request limit, and cumulative usage counters. Comparison is constant-time. Keys are never included in logs or tool output.

MCP uses a separate internal Gen API key for backend calls.

## Capacity Controls

- Request body: 12 MB maximum.
- Per-key request window: default 30/minute.
- Global concurrency: chat 12, vision 6, image/edit 3, audio 4.
- Queue: bounded; default maximum 30 waiting tasks per class.
- Timeouts: chat/vision 45s, image/edit 120s, audio 60s.
- Rate limit errors include retry guidance.
- Graceful shutdown stops accepting new work and waits briefly for active work.

## Artifacts

Image/audio backend responses are decoded, validated, written atomically under a private artifact directory, and returned as opaque HTTPS URLs. File extensions and MIME types are allowlisted. Default TTL is 24 hours; periodic cleanup deletes expired files. Artifact IDs are cryptographically random and paths cannot be traversed.

## Error Handling

MCP errors use JSON-RPC error objects. Backend errors are sanitized. No cookie, token, API key, Authorization header, base64 payload, or raw upstream response is logged. Overload returns a clear busy/rate-limit error.

## Operations

- Separate systemd unit, port 3101, restart on failure, memory limit 256 MB.
- Public routing sends `/mcp`, `/health/mcp`, and `/artifacts/*` to MCP while existing Gen traffic remains on port 3100.
- Health check verifies process readiness without invoking paid generation.
- Logs are concise and secret-redacted.

## Acceptance Criteria

- MCP initialize/list/call work through public HTTPS.
- Invalid, revoked, and rate-limited keys are rejected.
- All eight tools work; media tools return downloadable artifacts.
- Existing Gen UI/API remain operational.
- Parallel read/light calls stay within limits without crashes or unbounded memory growth.
- Secrets and token pool content never appear in MCP responses/logs.
- Source, tests, docs, deployment templates, and examples are backed up to GitHub; live secrets/state are excluded.

## Edge Cases

- Malformed JSON and invalid JSON-RPC.
- Missing/invalid tool arguments.
- Backend timeout and non-JSON responses.
- Oversized uploads and unsupported MIME types.
- Expired/missing artifacts.
- Queue saturation and revoked keys during active requests.
- Client requests SSE in `Accept`; server may return JSON for non-streaming calls while remaining Streamable HTTP compatible.

## Approved Decisions

- Separate service.
- Separate key per user.
- Temporary artifact URLs.
- Conservative concurrency limits.
- No administrative/token management tools.
