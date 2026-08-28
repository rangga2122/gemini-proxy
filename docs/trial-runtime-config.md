# Trial runtime configuration

This document describes the trial OTP settings actually consumed by `mcp/server.js` and
`mcp/lib/mailer.js`. Keep production values in a host-managed environment file; do not
commit that file.

## Environment variables

| Name | Required / default | Description |
| --- | --- | --- |
| `TRIAL_LEDGER_SECRET` | Required; no default; at least 32 characters | Secret used to protect the trial ledger and derive opaque identifiers. Trial readiness is unavailable if it is missing or invalid. Use a dedicated random value and keep it stable across restarts. |
| `SMTP_HOST` | Required; no default | SMTP server hostname. |
| `SMTP_PORT` | Required; no default | SMTP port, integer `1`–`65535`. |
| `SMTP_SECURE` | Required; no default | Literal `true` or `false`; normally `true` for implicit TLS and `false` for STARTTLS. |
| `SMTP_USER` | Required; no default | SMTP authentication username. |
| `SMTP_PASS` | Required; no default | SMTP authentication password or provider token. |
| `SMTP_FROM_EMAIL` | Required; no default | One valid envelope/header sender email address. |
| `SMTP_FROM_NAME` | Required; no default | Display name for trial OTP mail; control characters are rejected. |
| `TRIAL_REQUEST_ATTEMPT_LIMIT` | Optional; `10` | Maximum trial-code requests per source key in each fixed window. |
| `TRIAL_VERIFY_ATTEMPT_LIMIT` | Optional; `20` | Maximum verification attempts per source key in each fixed window. |
| `TRIAL_REQUEST_MIN_RESPONSE_MS` | Optional; `500` | Minimum response time for trial-code requests, reducing account-enumeration timing differences. |
| `TRIAL_ATTEMPT_RATE_MAX_KEYS` | Optional; `10000` | Maximum source/action entries retained by the in-memory trial rate limiter. |

The request and verification limits use the `FixedWindow` implementation's fixed
**60,000 ms** window. There is currently no environment variable for changing that
window.

Trial ledger cleanup runs at a fixed **900,000 ms (15 minutes)** interval in the normal
runtime. `createApp()` supports a programmatic `trialCleanupIntervalMs` option, but
there is currently no corresponding environment variable.

### Proxy trust

`TRUST_PROXY` bersifat opsional dan default-nya `false`. Atur ke literal `true` atau `1`
hanya ketika listener berada di belakang Traefik/private reverse proxy. Dalam mode ini,
aplikasi menerima `X-Forwarded-For` hanya jika peer socket langsung adalah loopback,
private, atau link-local; semua elemen rantai harus berupa IPv4/IPv6 valid. Peer publik,
header malformed, dan header spoof akan diabaikan dan aplikasi kembali memakai
`req.socket.remoteAddress`. Rantai valid diproses dari kanan ke kiri: hop proxy
loopback/private/link-local dilewati dan alamat publik pertama dipakai, sehingga prefix
yang ditambahkan klien tidak dipercaya. Jika seluruh rantai berisi alamat tepercaya,
alamat paling kanan dipakai sebagai klien langsung (misalnya klien LAN melalui satu
proxy), bukan alamat paling kiri yang dapat dikendalikan penyerang. Model ini
mengasumsikan seluruh proxy tepercaya menggunakan alamat private/loopback/link-local;
proxy publik tidak didukung sebagai hop tepercaya. Untuk deployment Traefik produksi Gen, gunakan
`TRUST_PROXY=true` dan pastikan port backend tidak dipublikasikan langsung.

> The SMTP names are `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` (not `FROM_EMAIL` or
> `FROM_NAME`).

## Generate the ledger secret safely

Generate the value on the target host, without printing it into shell history or
committing it. This command creates a 64-character random hexadecimal value directly
in a root-readable systemd environment file:

```sh
sudo install -d -m 0750 /etc/gemini-proxy
sudo sh -c 'umask 077; printf "TRIAL_LEDGER_SECRET=%s\n" "$(openssl rand -hex 32)" > /etc/gemini-proxy/mcp.env'
```

Append the SMTP and tuning settings using a root-only editor. Use systemd
`EnvironmentFile=` syntax (`NAME=value`), and do not put real credentials in a tracked
example or unit file. Preserve the same ledger secret during upgrades and restarts;
rotating it can make existing trial ledger identifiers unusable.

## systemd `EnvironmentFile` workflow

1. Create `/etc/gemini-proxy/mcp.env` as root with mode `0600` and add the variables
   above. Quote values when needed by systemd; never use shell `export` statements.
2. In the service unit, reference it with:

   ```ini
   [Service]
   EnvironmentFile=/etc/gemini-proxy/mcp.env
   ```

3. Restrict access to the environment file and ensure it is owned by root (or by the
   dedicated service account where operationally required).
4. Validate the unit and restart:

   ```sh
   sudo systemd-analyze verify /etc/systemd/system/gemini-proxy-mcp.service
   sudo systemctl daemon-reload
   sudo systemctl restart gemini-proxy-mcp.service
   sudo systemctl --no-pager --full status gemini-proxy-mcp.service
   ```

5. Check readiness through the local listener before exposing traffic. Avoid commands
   that dump the service environment or SMTP credentials into logs.

## Traefik production checklist

- Terminate TLS at Traefik and redirect plain HTTP to HTTPS.
- Route only intended public paths to the MCP listener; keep administrative surfaces
  protected according to the deployment's access policy.
- Apply request body limits and edge rate limits, particularly to
  `/auth/trial/request` and `/auth/trial/verify`.
- Apply security headers consistently and preserve the application's `no-store`
  behavior for authentication responses.
- Set `TRUST_PROXY=true` only because the backend listener is restricted to
  Traefik/private peers. The application validates the complete `X-Forwarded-For`
  chain and ignores it for untrusted public socket peers.
- Configure complementary edge limits in Traefik using its trusted client-IP handling.
- Ensure the backend listener is reachable only from Traefik/the local host, and do
  not publish it directly.
- Configure SMTP egress deliberately and monitor delivery failures without logging
  OTPs, passwords, SMTP credentials, or the ledger secret.
- Use timeouts appropriate for SMTP delivery and keep Traefik health checks pointed at
  `/health`.

## Health and trial readiness

Request the local or externally routed health endpoint:

```sh
curl --fail-with-body --silent --show-error http://127.0.0.1:3101/health
```

A fully configured running instance returns HTTP `200` with:

```json
{"status":"ok","trial":"ready"}
```

`"trial":"unavailable"` means construction of the trial store or mailer failed—most
commonly because `TRIAL_LEDGER_SECRET` or one of the required SMTP variables is
missing or invalid. The overall endpoint can still return HTTP `200`, so a production
readiness check must inspect the JSON field and require `trial == "ready"`, not merely
check the status code. During shutdown, `/health` returns HTTP `503` with
`"status":"stopping"`.

After readiness succeeds, verify OTP delivery with a controlled test account and
confirm that secrets and OTP values do not appear in service, Traefik, or SMTP logs.
