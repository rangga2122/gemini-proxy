# User Password, Profile, and Self-Service API Key Design

**Date:** 2026-08-27
**Status:** Approved

## Overview
Dashboard user berpindah dari login email + API key menjadi email + password. Password awal dibuat acak oleh admin dan hanya ditampilkan sekali. API key menjadi credential operasional yang dibuat sendiri user, bukan credential login.

## Data Model
Setiap user menyimpan `passwordSalt`, `passwordHash`, `passwordVersion`, `passwordUpdatedAt`, serta `keyId` yang sudah ada. Field rahasia tidak pernah masuk `publicUser()` atau response list admin.

User lama tanpa password tetap tersimpan dan API key existing tetap bekerja untuk MCP/API, tetapi login dashboard ditolak sampai admin melakukan reset password.

## Authentication
- Admin tetap login dengan email + passkey existing.
- User login dengan email + password.
- Verifikasi password memakai scrypt dan timing-safe comparison.
- Sesi user terikat ke `userId` dan `passwordVersion`, bukan `keyId`.
- Disable, expiry, delete, atau perubahan password membatalkan sesi.
- Rotasi API key tidak membatalkan sesi dashboard.
- `maxSessions` tetap ditegakkan per user.

## Admin User Lifecycle
Create user menghasilkan password acak kuat dan tidak lagi otomatis membuat API key. Password plaintext tampil satu kali pada response create. Upsert user existing tidak mengganti password.

Admin dapat:
- mengubah label, expiry, maxSessions, dan status;
- reset password dan menerima password acak baru satu kali;
- mencabut API key;
- menghapus user permanen.

Hapus permanen menghapus record user, mencabut key, dan membatalkan seluruh sesi. Email dapat dibuat kembali.

## Self-Service API Key
User authenticated dapat melihat metadata key miliknya dan generate API key dari Ringkasan. Generate bersifat replace/rotate atomik: key lama dicabut, key baru dibuat, `keyId` user diperbarui. Raw key hanya tampil sekali. Admin juga dapat mencabut key tanpa membuat pengganti.

## Profile
Menu Profil tersedia bagi user dan admin. User melihat email, label, status, expiry, sisa masa aktif, serta metadata API key. User dapat mengganti password dengan password lama, password baru, dan konfirmasi. Password baru minimal 10 karakter; setelah berhasil, sesi sekarang dipertahankan melalui cookie baru dan sesi user lain dicabut.

Profil admin hanya menampilkan identitas dan role; perubahan passkey admin di luar scope karena verifier berasal dari environment privat.

## API Contracts
- `GET /profile` — session identity, expiry/status/key metadata.
- `POST /profile/password` — current/new password; user-only; rotates password version and session.
- `POST /profile/api-key` — user-only; replace existing key, returns raw key once.
- `DELETE /profile/api-key` — user-only; revoke current key.
- `POST /admin/users/:id/reset-password` — admin-only; returns random password once.
- `DELETE /admin/users/:id` — hard delete user, key, and sessions.

## Security
No password/API key plaintext stored. Responses use `Cache-Control: no-store`; secrets are not logged. Password and key endpoints are rate-limited by existing dashboard/admin controls. Error login remains generic.

## UI
- Ringkasan user: kartu API Key Saya dengan Generate/Ganti dan copy-once result.
- Pengguna admin: create result shows email + initial password once; actions Reset Password, Cabut API Key, Hapus Pengguna.
- Profil: account details, active period, and password form.
- Menu Pengguna remains admin-only; Profil available to both roles.
