# User Password, Profile, and Self-Service API Key Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Mengganti login user menjadi email+password, menambahkan profil dan self-service API key, serta hard-delete pengguna.

**Architecture:** UserStore menyimpan verifier password scrypt dan passwordVersion. DashboardAuth memvalidasi user/version tanpa bergantung pada key. Route profile menjadi self-service berbasis cookie, sedangkan route admin menangani create/reset/revoke/delete. Frontend tetap single-file dengan view Profil dan kartu API key role-aware.

**Tech Stack:** Node.js 22 ESM, built-in crypto/http/test, HTML/CSS/vanilla JS.

---

### Task 1: Password-capable user model
**Files:** Modify `mcp/lib/admin.js`; Test `mcp/test/admin.test.js`.
1. Write failing tests for random initial password, hash-only persistence, password verification, legacy passwordless users, and public sanitization.
2. Run focused test and confirm expected RED.
3. Add password hash/version helpers, UserStore create/reset/change/delete, session revocation helpers.
4. Run focused and full suite.

### Task 2: Password login and profile API
**Files:** Modify `mcp/server.js`, `mcp/lib/admin.js`; Test `mcp/test/admin.test.js`.
1. Write failing HTTP tests: user login password, API key rejected for login, GET profile, change password, old password rejected, current session replacement, other sessions revoked.
2. Confirm RED.
3. Implement exact routes and secure no-store responses.
4. Run focused/full suite.

### Task 3: Self-service API key and admin lifecycle
**Files:** Modify `mcp/server.js`, `mcp/lib/auth.js`, `mcp/lib/admin.js`; Test `mcp/test/admin.test.js`.
1. Write failing tests for no key at create, self-generation, replace old key, admin revoke key, password reset, hard delete record/key/sessions, recreate same email.
2. Confirm RED.
3. Implement minimal atomic lifecycle operations and routes.
4. Run focused/full suite.

### Task 4: Role-aware frontend
**Files:** Modify `public/index.html`; Test `mcp/test/frontend-role-ui.test.js`.
1. Write failing static/browser contract tests for Profil navigation, initial password one-time display, user API key card, password change form, hard-delete confirmation, and removal of legacy rotate/login-key text.
2. Confirm RED.
3. Implement UI with Bahasa Indonesia and role gates.
4. Run parser, static tests, and full suite.

### Task 5: Integration review and production verification
1. Spec compliance review.
2. Security/code-quality review and fix all critical/important findings.
3. Run full tests, parser, secret scan, and git diff checks.
4. Restart only `cosmic-mcp` and `gemini-proxy`.
5. E2E: create user→initial password login→profile→generate key→MCP works→replace key invalidates old→change password→old login fails/new succeeds→admin reset→hard delete→session/key invalid→recreate email→cleanup.
6. Browser desktop/mobile role audits.
7. Commit/push and verify local/remote HEAD.
