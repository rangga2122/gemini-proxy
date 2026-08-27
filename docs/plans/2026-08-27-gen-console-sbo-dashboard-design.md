# Gen Console — SBO Dashboard Redesign Spec
**Date:** 2026-08-27
**Status:** Approved

## Overview
Redesign frontend Gen Console agar menggunakan bahasa visual dan pola responsif dashboard SBO setelah login, tanpa mengubah backend, endpoint, autentikasi, atau perilaku fitur.

## Goals
- Desktop memakai sidebar sticky 216px, topbar sticky, dan workspace maksimal 1180px.
- Mobile memakai bottom navigation fixed, touch target minimum 44px, safe-area, dan layout satu kolom.
- Memecah halaman panjang menjadi view operasional: Ringkasan, Generate Gambar, Analisis Gambar, Chat Teks, Buat Audio, MCP, dan Kelola Pengguna.
- Mengadopsi token SBO: bg `#0b0c0f`, panel `#14161b`, panel aktif `#1a1d24`, line `#262a33`, chalk `#edeff3`, dim `#9ba3af`, amber `#ffb224`, lime `#9fe870`, tally `#ff4d3d`.
- Mempertahankan seluruh fungsi, ID DOM, event handler, session admin, upload, output media, API key, dan status pool.

## Non-Goals
- Tidak mengubah backend `server.js`, MCP, API contract, token pool, systemd, Traefik, RupaAI, atau SBO.
- Tidak menambah framework/dependency frontend.
- Tidak mengubah credential atau mekanisme autentikasi.

## Architecture
Satu file `public/index.html` tetap menjadi frontend. Markup direstrukturisasi menjadi app shell dan view sections. Navigasi mengubah view aktif secara client-side dengan hash/state, tanpa route backend baru. JavaScript bisnis existing dipertahankan dan hanya ditambah controller navigasi/presentation.

## Components
- `app-shell`: sidebar desktop + stage.
- `channel-strip`: brand, nav, pool status, role/status footer.
- `topbar`: judul view, jam/status backend.
- `view`: ringkasan dan enam workspace fitur.
- `panel`: header instrumen SBO, body form/output.
- `mobile-nav`: fixed bottom navigation; core views + menu lainnya.
- `admin workspace`: login, user form, user list/cards tetap aman.

## Responsive Rules
- `>900px`: sidebar tampil, mobile nav tersembunyi, workspace dua kolom bila cocok.
- `<=900px`: sidebar tersembunyi, bottom nav tampil, content single column.
- `<=560px`: padding 14px, tombol aksi full-width, admin rows menjadi kartu, modal/fullscreen safe-area.
- Konten panjang memakai `min-width:0`, `overflow-wrap:anywhere`, media `max-width:100%`.

## Accessibility
- Navigasi berupa button dengan `aria-current`.
- Focus visible amber.
- Touch target minimum 44px.
- Status memakai live region yang sesuai.
- `prefers-reduced-motion` mematikan boot animation.

## Acceptance Criteria
- Semua fitur lama tetap dapat ditemukan dan dijalankan.
- Backend files tidak berubah.
- HTML/JS syntax valid; MCP test suite tetap lulus.
- Tidak ada overflow desktop/mobile pada screenshot review.
- Gen live HTTP 200 dan seluruh endpoint lama tetap sehat.
- Visual mengikuti dashboard SBO, bukan landing page marketing.
