# Public Trial OTP Design

**Date:** 2026-08-28
**Status:** Approved

## Overview
Gen Console menyediakan pendaftaran publik trial 72 jam menggunakan email dan password. Akun hanya dibuat setelah OTP email berhasil diverifikasi. Semua alamat email valid diperbolehkan.

## Signup Flow
1. User mengisi email, password, dan konfirmasi password.
2. `POST /auth/trial/request` memvalidasi payload dan eligibility, lalu mengirim OTP enam digit melalui SMTP Azkazam Digital.
3. OTP berlaku 10 menit, maksimal lima verifikasi, resend cooldown 60 detik, maksimal lima pengiriman per email per jam, serta rate limit IP.
4. Password pending disimpan hanya sebagai verifier scrypt, tidak plaintext.
5. `POST /auth/trial/verify` memvalidasi email dan OTP, lalu secara atomik membuat user trial dengan expiry tepat 72 jam, mencatat ledger trial, menghapus pending signup, dan membuat session cookie.
6. Respons request bersifat generik dan tidak membocorkan apakah email telah terdaftar atau pernah trial.

## Data
- `trial.json`: store gabungan berisi pending (password verifier, OTP verifier, expiry, attempts, resend/send history), ledger consumed dengan HMAC email stabil, dan kuota kirim per IP yang opaque. Pending dibersihkan setelah 24 jam; ledger tidak ikut dihapus bersama user. File ini sensitif walau tidak menyimpan email/password/OTP plaintext.
- `activation-journal.json`: snapshot rollback sementara untuk aktivasi lintas-store. File mode privat ini sensitif dan harus diperlakukan seperti state autentikasi; dihapus setelah commit/recovery.
- User trial: `accountType: trial`, `trialStartedAt`, `trialEndsAt`, dan `expiresAt` yang sama dengan trialEndsAt.
- User admin-created existing/default: `accountType: managed`.

## Entitlement States
- `full`: admin atau user aktif yang belum expired.
- `profile-only`: user trial aktif secara administratif tetapi trialEndsAt telah lewat.
- `denied`: disabled, deleted, invalid password/session.

Expired trial dapat login dan mengakses `/auth/session`, `GET /profile`, `POST /profile/password`, serta `DELETE /profile/api-key`. Endpoint dashboard AI, MCP, dan `POST /profile/api-key` ditolak 403. UI hanya menampilkan Profil, Dokumentasi, dan Logout dengan pesan trial berakhir.

User managed yang expired tetap mengikuti perilaku lama (login ditolak), kecuali secara eksplisit bertipe trial.

## Trial Reuse
Satu email hanya boleh mengonsumsi trial satu kali. Ledger memakai HMAC-SHA256 dengan `TRIAL_LEDGER_SECRET`; record tetap ada setelah hard-delete. Admin tetap dapat membuat user managed dengan email tersebut.

## Email
Gunakan Nodemailer dan konfigurasi privat: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`. Secret tidak masuk repo atau respons/log. Template Bahasa Indonesia, subjek "Kode Verifikasi Trial Gen Console".

## Security
- OTP enam digit dari CSPRNG, hash + salt, compare constant-time.
- Password minimal 10 dan maksimal 1024 karakter; confirmation exact.
- Body 64 KiB + 10 detik deadline dibaca sebelum mutation lock.
- Bounded per-IP attempt limit diterapkan sebelum parsing/body dan kerja mahal (request dan verify), di samping kuota successful-send; key IP di-HMAC. Respons request valid-shape memiliki minimum response floor dan generic accepted response yang sama untuk eligibility maupun hasil SMTP.
- OTP baru membatalkan OTP lama; maksimal lima attempt.
- Session cookie HttpOnly/Secure/SameSite=Lax.
- Mutation serialized and multi-store activation rollback-safe.
- Mail send occurs outside global mutation lock; pending reservation prevents race and is committed only on successful delivery.

## UI
- Landing/login: tombol "Mulai Trial Gratis 3 Hari".
- Step signup: email, password, konfirmasi.
- Step OTP: enam digit, resend countdown 60 detik.
- Trial aktif: badge/countdown di Ringkasan.
- Trial expired: navigation limited to Profil/Dokumentasi; profile shows expiry and contact-admin message.
- Admin users: badges Trial Aktif/Trial Habis/Akun Aktif and editable expiry.

## Non-Goals
- Google OAuth.
- Automatic payment/upgrade.
- Multiple trials per email.
- Persisting plaintext OTP/password.
