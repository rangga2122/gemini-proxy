# Public Trial OTP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Menambahkan signup trial publik 72 jam berbasis OTP email dengan entitlement profile-only setelah expiry.

**Architecture:** TrialStore menyimpan pending OTP dan immutable consumption ledger pada file state atomik. Mailer Nodemailer diinjeksi agar unit test deterministik. Dashboard session mengembalikan entitlement, sementara setiap endpoint tetap menegakkan authorization server-side.

**Tech Stack:** Node.js 22 ESM, node:test, Nodemailer SMTP, HTML/CSS/JS existing.

---

### Task 1: Trial stores and OTP primitives
**Files:** Create `mcp/lib/trial.js`; test `mcp/test/trial.test.js`.
1. Tulis failing tests untuk OTP hash/expiry/attempt/cooldown/hour limit, pending cleanup, ledger persistence, and one-trial-per-email.
2. Jalankan targeted test dan buktikan RED.
3. Implement minimal atomic stores with injected `now`, `persist`, random OTP, and ledger HMAC.
4. Verify targeted and full suite.

### Task 2: SMTP mailer
**Files:** Create `mcp/lib/mailer.js`; modify `mcp/package.json` and lockfile; test `mcp/test/mailer.test.js`.
1. Tulis tests untuk configuration validation, transport options, Indonesian template, and no secret logging.
2. Install Nodemailer dependency.
3. Implement injectable transport and `sendTrialOtp`.
4. Verify tests and syntax.

### Task 3: Trial request and verify endpoints
**Files:** Modify `mcp/server.js`, `mcp/lib/admin.js`; test `mcp/test/admin.test.js`.
1. Tests first untuk exact payload, generic response, request limits, successful verify/account/session, invalid/expired OTP, five attempts, concurrent verify, delivery failure, and rollback.
2. Add `/auth/trial/request` and `/auth/trial/verify` with body pre-read before mutation.
3. Activation creates trial fields and 72-hour expiry atomically; ledger survives hard-delete.
4. Full suite.

### Task 4: Profile-only entitlement
**Files:** Modify `mcp/lib/admin.js`, `mcp/server.js`; tests `mcp/test/admin.test.js`, `mcp/test/dashboard-proxy.test.js`, MCP tests.
1. Tests first for expired trial login/session/profile/password/revoke access and denial of dashboard/MCP/key creation.
2. Preserve disabled/deleted and expired managed-user denial.
3. Return entitlement/accountType/trial timestamps in safe user/profile/session responses.
4. Verify complete matrix.

### Task 5: Trial frontend
**Files:** Modify `public/index.html`; test `mcp/test/frontend-role-ui.test.js`.
1. Static contract tests first for signup/OTP forms, countdown, generic errors, role-aware menus, expired profile-only gate, trial badges.
2. Implement state machine login → signup → OTP; never store password/OTP.
3. Add Ringkasan countdown and Profil expiry message.
4. Verify HTML parser, extracted JS syntax, desktop/mobile browser.

### Task 6: Production configuration and deployment
**Files:** Modify `.env.mcp.example` if present and deployment docs/config without values.
1. Copy SMTP variable values from `azkazam-web` runtime to private cosmic MCP environment without printing them.
2. Install dependencies, run all tests, secret scan.
3. Restart only `cosmic-mcp` and `gemini-proxy`; health probes.
4. Test actual OTP delivery to approved QA email, signup, expiry simulation, profile-only, admin extension, hard-delete cleanup.
5. Independent security/spec review; fix all material findings.
6. Commit/push and verify local/remote HEAD.
