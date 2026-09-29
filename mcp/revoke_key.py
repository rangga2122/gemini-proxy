#!/usr/bin/env python3
"""Cabut (nonaktifkan) sebuah API key di mcp-state/keys.json.

Dipakai untuk menutup akses: key tetap ada di berkas (untuk catatan/audit)
tapi `active: false` → gateway menolaknya (authenticate() hanya menerima
record dengan active=true, dan ia memuat ulang berkas tiap permintaan).

Tulis ATOMIK (tmp + rename) supaya disk penuh / proses mati tidak membuat
keys.json terpotong 0 byte — kejadian nyata 28 Sep (token-pool.json).

Pemakaian:  python3 revoke_key.py <id-key> "<alasan>"
"""
import json, os, sys, tempfile, hashlib, datetime

if len(sys.argv) < 3:
    print("pemakaian: revoke_key.py <id-key> \"<alasan>\"")
    sys.exit(2)

ID, ALASAN = sys.argv[1], sys.argv[2]
P = "/home/ubuntu/work/gemini-proxy/mcp-state/keys.json"

data = json.load(open(P))
sasaran = [e for e in data if e.get("id") == ID]
if not sasaran:
    print(f"GAGAL: id {ID} tidak ditemukan di {P}")
    sys.exit(1)

for e in sasaran:
    e["active"] = False
    e["revokedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    e["revokedReason"] = ALASAN

# tulis atomik
d = os.path.dirname(P)
fd, tmp = tempfile.mkstemp(dir=d, prefix=".keys-", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=1)
    f.flush()
    os.fsync(f.fileno())
os.chmod(tmp, 0o600)
os.replace(tmp, P)

for e in sasaran:
    print(f"DICABUT: id={e['id']} label={e.get('label')!r} active={e['active']} "
          f"hash={e['hash'][:16]}… reason={ALASAN}")
print(f"total key di berkas: {len(data)} | aktif: {sum(1 for x in data if x.get('active'))}")
