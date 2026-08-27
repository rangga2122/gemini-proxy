# Gemini Proxy

Standalone Gemini Web Proxy — reverse-engineered Gemini web API dengan endpoint OpenAI-compatible.

Punya **base URL** + **API key** sendiri. Bisa generate gambar, chat teks, analisa gambar (vision), dan text-to-speech — sama seperti cara RupaAI kerjanya, tapi standalone.

## 🚀 Quick Start

```bash
# 1. Clone/copy folder ini
cd gemini-proxy

# 2. Install dependencies
npm install

# 3. Set API key di .env
#    Edit .env, isi API_KEY dengan key kamu sendiri (bebas)
#    Contoh: API_KEY=sk-myproxy-secret-2026

# 4. Jalankan server
node server.js

# 5. Server berjalan di http://localhost:3000
```

## 📡 Endpoints

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| `GET`  | `/` | Health check & list endpoint |
| `GET`  | `/v1/status` | Status token (butuh API key) |
| `POST` | `/v1/capture-tokens` | Terima token dari Chrome Extension |
| `POST` | `/v1/images/generations` | Generate 1 gambar |
| `POST` | `/v1/images/variations` | Generate multiple gambar paralel |
| `POST` | `/v1/chat/completions` | Chat teks / analisa gambar |
| `POST` | `/v1/audio/speech` | Text-to-speech (TTS) |
| `GET`  | `/v1/tts/voices` | Daftar voice TTS |

## 🔌 MCP Connection

Endpoint MCP produksi: `https://gen.azkazamdigital.com/mcp` (health publik: `GET /health/mcp`).

Setiap pengguna memerlukan **MCP key terpisah** yang harus diminta kepada admin. Tidak ada generator key publik; jangan membagikan key atau memasukkannya ke source control.

```json
{
  "mcpServers": {
    "cosmicAI": {
      "url": "https://gen.azkazamdigital.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_KEY" }
    }
  }
}
```

Tool tersedia: `chat_text`, `analyze_image`, `generate_image`, `edit_image`, `generate_audio`, `list_voices`, `get_pool_status`, dan `get_service_status`.

### Pengelolaan pengguna MCP (admin)

Di Cosmic Console, buka panel **MCP Connection**, pilih **Login Admin**, lalu masuk dengan akun admin yang telah dikonfigurasi oleh operator. Dari area inline tersebut admin dapat membuat/memperbarui pengguna, mengatur label, masa berlaku, batas sesi dan status, serta merotasi key.

Key MCP mentah hanya muncul sekali saat pengguna pertama kali dibuat atau saat key dirotasi. Salin dan simpan segera di pengelola rahasia; jangan masukkan key atau kredensial admin ke source control. Token sesi admin disimpan hanya di `sessionStorage` tab browser dan dihapus saat logout atau sesi ditolak server.

## 🔑 Autentikasi

Semua endpoint (kecuali `/` dan `/v1/capture-tokens`) butuh API key. Bisa lewat:

```
Authorization: Bearer sk-...key...
```

atau

```
X-API-Key: sk-...key...
```

## 📦 API Reference

### 1. Generate Gambar

```bash
curl -X POST http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "kucing astronot di bulan",
    "ratio": "16:9",
    "seed": 12345
  }'
```

**Parameters:**
- `prompt` (required) — deskripsi gambar
- `ratio` (optional) — rasio aspek: `1:1`, `16:9`, `9:16`, `4:3` (default: `1:1`)
- `seed` (optional) — seed untuk variasi
- `referenceImage` (optional) — `{ base64, mimeType }` gambar referensi
- `extraImages` (optional) — array `{ base64, mimeType }` gambar tambahan

**Response:**
```json
{
  "success": true,
  "seed": 12345,
  "image": {
    "mimeType": "image/jpeg",
    "base64": "...",
    "dataUrl": "data:image/jpeg;base64,..."
  },
  "data": [{ "url": "data:...", "b64_json": "...", "mimeType": "image/jpeg" }]
}
```

### 2. Generate Multiple Gambar (Paralel)

```bash
curl -X POST http://localhost:3000/v1/images/variations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "pemandangan pegunungan salju",
    "ratio": "1:1",
    "count": 4
  }'
```

**Parameters:** sama seperti generate + `count` (default: 4)

### 3. Chat / Text / Vision

**Format prompt sederhana:**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Jelaskan apa itu machine learning dalam bahasa Indonesia"
  }'
```

**Format OpenAI-style:**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "system", "content": "Kamu asisten AI yang membantu." },
      { "role": "user", "content": "Apa ibu kota Indonesia?" }
    ]
  }'
```

**Vision / Analisa gambar (OpenAI-style):**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "Deskripsikan gambar ini" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }]
  }'
```

**Atau format simple:**
```json
{
  "prompt": "Deskripsikan gambar ini",
  "referenceImage": { "base64": "...", "mimeType": "image/jpeg" }
}
```

**Response (OpenAI-compatible):**
```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion",
  "model": "gemini-3-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Jawaban dari Gemini..." },
    "finish_reason": "stop"
  }],
  "text": "Jawaban dari Gemini..."
}
```

### 4. Text-to-Speech

```bash
curl -X POST http://localhost:3000/v1/audio/speech \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Halo, selamat datang di aplikasi saya.",
    "voice": "Charon"
  }'
```

**Parameters:**
- `input` atau `text` (required) — teks yang akan dibacakan
- `voice` (optional) — nama voice (default: `Charon`)

**Voices tersedia:**

| Code | Karakter |
|------|----------|
| Leda | Mentari [P] — muda & segar |
| Aoede | Melati [P] — ringan & santai |
| Callirrhoe | Sari [P] — ramah & luwes |
| Algieba | Laras [P] — halus & lembut |
| Sadachbia | Intan [P] — hidup & ceria |
| Zephyr | Bintang [L] — cerah & jelas |
| Puck | Fajar [L] — ceria & semangat |
| Charon | Satria [L] — formal & berwibawa |
| Orus | Baskara [L] — tegas & dewasa |
| Umbriel | Dimas [L] — ramah & santai |

**Response:**
```json
{
  "success": true,
  "audio": {
    "base64": "...",
    "mimeType": "audio/wav",
    "dataUrl": "data:audio/wav;base64,..."
  },
  "voice": "Charon",
  "textLength": 35
}
```

### 5. Token Capture (dari Extension)

```bash
curl -X POST http://localhost:3000/v1/capture-tokens \
  -H "Content-Type: application/json" \
  -d '{
    "at": "token_at_dari_gemini",
    "bl": "boq_assistant-bard-web-server_...",
    "fSid": "1234567890123456789",
    "shareId": "c26c881da4e6",
    "hl": "id",
    "cookies": "...",
    "extensionKey": "YOUR_API_KEY"
  }'
```

Endpoint ini **tidak butuh API key header**, tapi butuh `extensionKey` di body.

## 🔌 Chrome Extension (Auto-Capture Token)

### Cara Install

1. Buka `chrome://extensions`
2. Aktifkan **Developer mode** (toggle kanan atas)
3. Klik **Load unpacked**
4. Pilih folder `gemini-proxy/extension/`
5. Extension muncul di toolbar Chrome

### Cara Pakai

1. Buka **gemini.google.com** dan login dengan akun Google kamu
2. Extension akan **auto-capture token** dalam 3 detik, lalu setiap 5 menit
3. Klik icon extension untuk lihat status
4. Tekan **"Capture Sekarang"** untuk capture manual

### Konfigurasi Extension

Klik icon extension → atur:
- **Proxy Server URL** — URL endpoint `/v1/capture-tokens` proxy kamu
  - Default: `http://localhost:3000/v1/capture-tokens`
  - Untuk server remote: `https://domain.com/v1/capture-tokens`
- **Extension Key** — harus sama dengan `API_KEY` (atau `EXTENSION_KEY` jika diset) di proxy

### Auto-Capture di Background

Extension otomatis:
- Capture token saat halaman Gemini dibuka (3 detik setelah load)
- Refresh token setiap 5 menit
- Kirim ke proxy server via POST

## ⚙️ Konfigurasi .env

```bash
# Server
PORT=3000
API_KEY=sk-your-secret-key-here

# Gemini Token (opsional jika pakai extension)
GEMINI_AT=
GEMINI_BL=boq_assistant-bard-web-server_20260709.09_p0
GEMINI_FSID=
GEMINI_SHARE_ID=c26c881da4e6
GEMINI_HL=id
GEMINI_COOKIES=

# Extension key (opsional, default = API_KEY)
EXTENSION_KEY=

# Supabase sync (opsional, untuk multi-server)
SUPABASE_URL=
SUPABASE_ANON_KEY=

# Timeouts (ms)
GEMINI_IMAGE_TIMEOUT_MS=45000
GEMINI_TEXT_TIMEOUT_MS=30000
GEMINI_TTS_TIMEOUT_MS=30000
```

## 🐳 Docker

```bash
# Build
docker build -t gemini-proxy .

# Run
docker run -d \
  -p 3000:3000 \
  -e API_KEY=sk-your-key \
  --name gemini-proxy \
  gemini-proxy
```

## 🔗 Integrasi dengan Aplikasi

### Base URL + API Key

```
Base URL: http://your-server:3000
API Key:  sk-your-key-here
```

### Contoh: Python

```python
import requests

BASE = "http://localhost:3000"
KEY  = "sk-your-key"
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# Generate image
r = requests.post(f"{BASE}/v1/images/generations", headers=HEADERS,
    json={"prompt": "kucing astronot", "ratio": "1:1"})
image_data_url = r.json()["image"]["dataUrl"]

# Chat
r = requests.post(f"{BASE}/v1/chat/completions", headers=HEADERS,
    json={"prompt": "Ceritakan lelucon singkat"})
text = r.json()["choices"][0]["message"]["content"]

# TTS
r = requests.post(f"{BASE}/v1/audio/speech", headers=HEADERS,
    json={"input": "Halo dunia", "voice": "Charon"})
audio_data_url = r.json()["audio"]["dataUrl"]

# Vision / analisa gambar
import base64
with open("photo.jpg", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

r = requests.post(f"{BASE}/v1/chat/completions", headers=HEADERS,
    json={"prompt": "Deskripsikan gambar ini", "referenceImage": {"base64": img_b64, "mimeType": "image/jpeg"}})
analysis = r.json()["text"]
```

### Contoh: JavaScript

```javascript
const BASE = 'http://localhost:3000';
const KEY = 'sk-your-key';

// Generate image
const r = await fetch(`${BASE}/v1/images/generations`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'sunset di pantai', ratio: '16:9' }),
});
const { image } = await r.json();
// image.dataUrl = "data:image/jpeg;base64,..."
```

### Contoh: OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-your-key"
)

# Chat
response = client.chat.completions.create(
    model="gemini-3-flash",
    messages=[{"role": "user", "content": "Halo, apa kabar?"}]
)
print(response.choices[0].message.content)
```

## 📁 Struktur Project

```
gemini-proxy/
├── server.js              # HTTP server + router
├── lib/
│   ├── gemini.js          # Core engine (image, text, TTS)
│   ├── parser.js          # Response parser + PCM→WAV converter
│   └── tokens.js          # Token management + Supabase sync
├── extension/             # Chrome Extension
│   ├── manifest.json
│   ├── content.js         # Token capture script
│   ├── background.js      # Service worker
│   ├── popup.html         # UI popup
│   └── popup.js           # Popup logic
├── package.json
├── .env                   # Config
├── Dockerfile
└── README.md
```

## ⚠️ Catatan Penting

1. **Bukan API resmi Google** — proxy ini me-reverse-engineer Gemini web interface
2. **Rate limit** mengikuti akun Google yang login
3. **Token expiry** — session Gemini web bisa expired, auto-capture extension mengatasi ini
4. **Akun terpisah** — gunakan akun Google berbeda untuk capture token, jangan campur dengan akun pribadi
5. **Tidak ada dependency** — server hanya butuh Node.js 18+, tidak butuh dotenv atau library lain
