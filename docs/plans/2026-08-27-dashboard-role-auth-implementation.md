# Gen Dashboard Role Authentication Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Menambahkan landing publik dan login dashboard admin/user dengan authorization server-side berbasis role.

**Architecture:** MCP service menjadi authority sesi karena sudah memiliki admin verifier, managed users, dan key store. Endpoint `/auth/*` menangani login/session/logout; `/admin/*` tetap admin-only. Frontend single-file menampilkan state public/login/dashboard berdasarkan cookie session dan role.

**Tech Stack:** Node.js HTTP, crypto opaque sessions, JSON atomic persistence, vanilla HTML/CSS/JS, Node test runner, Traefik.

---

### Task 1: Dashboard session store dengan TDD
**Files:** Modify `mcp/lib/admin.js`; Test `mcp/test/admin.test.js`.
1. Tulis failing tests untuk create/validate/logout, persistence hash-only, expiry, dan user revalidation.
2. Jalankan targeted test dan pastikan RED karena class/API belum ada.
3. Implement `DashboardAuth` minimal dengan token hash dan atomic storage.
4. Jalankan targeted/full suite hingga GREEN.

### Task 2: Unified login dan role authorization dengan TDD
**Files:** Modify `mcp/server.js`; Test `mcp/test/admin.test.js`.
1. Tulis failing HTTP tests untuk admin login, user email+API key login, generic rejection, disabled/expired/revoked/stale key.
2. Tambahkan `/auth/login`, `/auth/session`, `/auth/logout` dengan cookie Secure/HttpOnly/SameSite=Lax.
3. Terima cookie session pada admin routes; enforce role admin dan return 403 untuk valid user session.
4. Pastikan bearer admin legacy tetap kompatibel untuk UI lama sementara migrasi.
5. Jalankan seluruh suite.

### Task 3: Landing/login/dashboard frontend
**Files:** Modify `public/index.html`.
1. Tambahkan boot gate agar dashboard hidden sampai `/auth/session` selesai.
2. Buat landing publik dan modal/page login dalam Bahasa Indonesia.
3. Login menggunakan `credentials:'include'`; tidak simpan credential/token di Web Storage.
4. Admin menampilkan menu Pengguna; user tidak merender menu tersebut dan `setView('pengguna')` menolak.
5. Gunakan user API key hanya di runtime memory untuk operasi API bila diperlukan; session endpoint tidak mengembalikan raw key.
6. Tambahkan identitas role dan logout.

### Task 4: Routing dan deployment
**Files:** Modify `deploy/gen-azkazam-with-mcp.yaml`; production dynamic config equivalent.
1. Route `/auth/*` ke MCP service dengan priority tinggi.
2. Jalankan syntax/static checks dan  seluruh tests.
3. Deploy route, restart hanya `cosmic-mcp`; frontend static Gen tidak memerlukan backend contract change.
4. Probe unauth landing/session, admin login, test user login, role authorization, logout.

### Task 5: Browser QA dan release
1. Buat user uji via admin, catat key hanya dalam proses memory/temp aman.
2. Browser QA desktop/mobile: landing, login admin/user, user tanpa Pengguna, admin dengan Pengguna.
3. Disable/rotate test user dan pastikan session invalid; bersihkan user uji.
4. Secret scan, full suite, health probe, review independen.
5. Commit/push dan cocokkan local/remote HEAD.
