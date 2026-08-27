# Gen Console SBO Dashboard Redesign Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Mengubah frontend Gen Console menjadi dashboard operasional bergaya SBO yang responsif tanpa mengubah backend atau perilaku fitur.

**Architecture:** Pertahankan single-file vanilla HTML/CSS/JS. Restrukturisasi markup ke app shell/view sections dan tambahkan controller navigasi client-side. Semua endpoint, ID dan handler bisnis existing tetap kompatibel.

**Tech Stack:** HTML5, CSS Grid/Flexbox, vanilla JavaScript, Node syntax checks, browser QA.

---

### Task 1: Tambahkan regression contract frontend
**Files:**
- Create: `test/frontend-contract.test.mjs`
- Modify: `package.json` bila diperlukan untuk menjalankan test.

**Steps:**
1. Tulis test yang mengharuskan shell SBO, desktop nav, mobile nav, tujuh view, ID bisnis existing, safe-area, breakpoint 900/560, dan tidak adanya credential.
2. Jalankan test dan verifikasi RED karena shell belum ada.
3. Jangan ubah backend.

### Task 2: Restrukturisasi app shell dan token visual
**Files:**
- Modify: `public/index.html`

**Steps:**
1. Tambahkan design contract comment.
2. Ganti token visual dengan token SBO yang disetujui.
3. Buat sidebar, topbar, stage, panel, dan view containers.
4. Pertahankan seluruh ID form/output existing.
5. Jalankan frontend contract hingga GREEN dan HTML/JS syntax check.

### Task 3: Tambahkan navigasi view desktop/mobile
**Files:**
- Modify: `public/index.html`
- Test: `test/frontend-contract.test.mjs`

**Steps:**
1. Tambahkan test hash/view behavior berbasis static contract.
2. Implement controller `setView`, active state, title, hash, dan mobile overflow menu.
3. Pastikan direct link MCP/admin membuka view yang benar.
4. Verifikasi keyboard semantics dan reduced motion.

### Task 4: Adaptasi workspace dan admin untuk mobile
**Files:**
- Modify: `public/index.html`

**Steps:**
1. Terapkan dua kolom desktop untuk form/output dan satu kolom mobile.
2. Ubah user list menjadi responsive rows/cards tanpa mengubah rendering data.
3. Tambahkan safe-area dan touch target 44px.
4. Jalankan contract, HTML parser, JS check, dan detector.

### Task 5: Regression dan visual review
**Files:**
- Review: `public/index.html`
- Output: `.impeccable/review/desktop.png`, `.impeccable/review/mobile.png`

**Steps:**
1. Jalankan MCP 23-test suite dan frontend tests.
2. Deploy hanya frontend melalui restart `gemini-proxy` bila static source memerlukannya.
3. Probe Console, health, pool, MCP, dan admin unauth.
4. Capture desktop/mobile dalam satu batch, perbaiki satu batch jika perlu, lalu konfirmasi.
5. Secret scan dan git diff memastikan backend tidak berubah.
6. Commit dan push setelah semua bukti lulus.
