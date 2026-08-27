# Gen Dashboard Role Authentication Design

**Date:** 2026-08-27
**Status:** Approved

## Overview
Akses root Gen menampilkan landing page publik. Dashboard hanya tampil setelah login. Admin login dengan email dan passkey; managed user login dengan email dan API key yang diberikan admin.

## Roles
- `admin`: seluruh fitur dashboard dan pengelolaan user.
- `user`: fitur AI, MCP, dan dokumentasi; tidak memiliki menu atau akses endpoint pengelolaan user.

## Authentication
- Satu endpoint login dashboard menerima `email` dan `credential`.
- Server mencoba verifier admin, kemudian pasangan managed-user email + API key.
- User harus aktif, belum kedaluwarsa, API key belum dicabut, dan key harus merupakan key aktif miliknya.
- Login menghasilkan opaque session token yang disimpan dalam cookie `HttpOnly`, `Secure`, `SameSite=Lax`; raw credential tidak disimpan di browser.
- Endpoint session mengembalikan role dan profil publik minimal.
- Logout mencabut session dan menghapus cookie.
- Validasi session user selalu memeriksa ulang active/expiry/current key sehingga disable, expiry, delete, atau rotate memutus akses.

## Authorization
- `/admin/users*` tetap hanya menerima admin session.
- User tidak pernah menerima daftar user dan tidak dapat menjalankan operasi create/update/rotate/delete.
- Frontend merender menu Pengguna hanya jika role adalah `admin`; ini UX defense, bukan security boundary.

## Frontend States
1. `checking`: layar netral, dashboard tidak berkedip.
2. `public`: landing page dengan kemampuan Gen dan tombol Masuk.
3. `login`: form email + Passkey/API Key.
4. `dashboard-admin`: semua menu.
5. `dashboard-user`: semua menu operasional kecuali Pengguna.

## Security
- Generic invalid-credential error.
- Login rate limiting existing dipertahankan.
- Session token hanya disimpan sebagai SHA-256 hash server-side.
- Responses auth memakai `no-store`.
- Tidak ada API key/passkey di URL, localStorage, sessionStorage, HTML, atau log.

## Acceptance Criteria
- Root tanpa session hanya menampilkan landing page.
- Admin dan managed user valid dapat login.
- User salah email/key, disabled, expired, revoked, atau stale key ditolak.
- Admin melihat dan dapat mengakses Pengguna.
- User tidak melihat Pengguna dan request langsung ke `/admin/users` ditolak 403/401.
- Refresh mempertahankan login via cookie; logout kembali ke landing.
- Fitur generate/MCP existing dan mobile/desktop tidak mengalami regresi.
