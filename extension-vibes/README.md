# Gen Console Video Sync (Chrome Extension)

Extension untuk menangkap session vibes.ai dari browser dan mengirimkannya ke
Gen Console, supaya akun browser Om ikut masuk rotasi multi-akun video.

## Cara pakai

1. Buka Chrome, masuk ke mode profil yang SUDAH login vibes.ai.
2. Buka `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder ini.
3. Klik ikon extension → isi:
   - **Token Sync**: minta ke admin (format `vibes-sync-...`)
   - **Nama Akun**: opsional, mis `akun-1` (kosong = deteksi otomatis)
4. Klik **Simpan**, lalu **Sync Sekarang**. Harus muncul "✓ Tersinkron".

Untuk tiap akun tambahan: pakai **profile Chrome berbeda** (masing-masing login
vibes.ai dengan akun lain), lalu install extension yang sama dan beri Nama Akun berbeda.

## Perilaku

- Sync otomatis tiap 30 menit + setiap tab vibes.ai dibuka.
- Session lama dengan nama akun sama akan diperbarui; akun baru otomatis masuk
  rotasi di Gen Console (round-robin, failover saat akun bermasalah).
- Server: `POST /v1/vibes/sync` dengan header `x-vibes-sync-token`.
