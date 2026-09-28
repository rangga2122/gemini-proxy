#!/bin/bash
# Batch login + capture 15 akun gasmil.store — SEQUENTIAL, bukan paralel
cd /home/ubuntu/work/gemini-proxy
export GEN_EXTENSION_KEY='azkazamdigital-aegxrzim'
export NODE_PATH=/home/ubuntu/.9router/automation-runtime/node_modules
export MOZ_DISABLE_CONTENT_SANDBOX=1

ACCOUNTS=(
  "LabibJovanMelawati"
  "KaiJovanPramudya"
  "ZafranAbimanaNugraha"
  "FauziAqilaBaskoro"
  "RafsanAdeliaRanadira"
  "VioletKaiAnggraini"
  "ShakiraVioletPradana"
  "FauziAfrizalHardiansyah"
  "VioletElvinaMulyadi"
  "ElangAbizarAlamsyah"
  "HanifSyahdanSalsabila"
  "NazwaVaroRajendra"
  "QonitaShaniaFirmanto"
)

for LABEL in "${ACCOUNTS[@]}"; do
  echo ""
  echo "################ $LABEL ################"
  mkdir -p "/home/ubuntu/google-profiles/$LABEL"
  export LOGIN_EMAIL="${LABEL}@gasmil.store"
  export LOGIN_PASSWORD="$(cat /home/ubuntu/.gasmil_pw)"
  export ACCOUNT_LABEL="$LABEL"
  export PROFILE_DIR="/home/ubuntu/google-profiles/$LABEL"

  echo "--- LOGIN ---"
  timeout 240 xvfb-run -a node scripts/login-google-real.cjs 2>&1 | grep -E 'LOGIN_|CHALLENGE|ERROR|Wrong|SID:' | tail -5
  sleep 3

  echo "--- CAPTURE ---"
  timeout 120 xvfb-run -a node scripts/gen-token-capture.cjs 2>&1 | grep -E 'CAPTURE SUMMARY|account:|at:|cookies:|pool:|DONE|❌|⚠️' | tail -8
  sleep 3
done

echo ""
echo "================ AUDIT AKHIR ================"
node -e "
const p=JSON.parse(require('fs').readFileSync('token-pool.json'));
const sids=p.accounts.map(a=>(a.cookies.match(/SID=([^;]+)/)||[])[1]).filter(Boolean);
console.log('pool total:', p.accounts.length, '| unique SIDs:', new Set(sids).size);
p.accounts.filter(a=>a.label.includes('gasmil')||/[A-Z]/.test(a.label[0])).forEach(a=>{
  const nc=(a.cookies||'').split('; ').filter(Boolean).length;
  console.log('-', a.label, '| cookies:', nc, '| at:', a.at?'OK':'NULL');
});
"
echo "=== BATCH DONE ==="
