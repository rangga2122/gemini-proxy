# Pakasir payment runtime configuration

Gen Console sells one calendar month of access for Rp35,000 through Pakasir QRIS. A successful payment extends from the current expiry when time remains, or from the payment time when the account has expired. Each provider order is applied once and persisted in `mcp-state/billing.json`.

## Required variables

| Name | Default | Description |
| --- | --- | --- |
| `PAKASIR_PROJECT_SLUG` | none | Pakasir project slug. Required to enable checkout. |
| `PAKASIR_API_KEY` | none | Secret Pakasir API key. Required to enable checkout. |
| `PAKASIR_BASE_URL` | `https://app.pakasir.com` | Pakasir API origin. |
| `PLAN_PRICE_IDR` | `35000` | One-month plan price sent to and revalidated from Pakasir. |
| `BILLING_ORDER_TTL_MS` | `1200000` | Local pending-order lifetime (20 minutes). |
| `BILLING_CHECK_INTERVAL_MS` | `60000` | Background verification interval. |

Store production values only in the root-readable `.env.mcp` file used by the systemd service. When either Pakasir credential is missing, `/billing/plan` reports `configured: false`, order creation returns HTTP 503, and the rest of Gen Console remains available.

The server validates project, order ID, and amount on both transaction creation and status lookup. It generates the displayed QR from Pakasir's `payment_number`; no API key or provider response is exposed to the browser. Pending orders are also verified in the background, so package activation does not depend on the profile page remaining open.

The public reverse proxy must route the `/billing/` path prefix to the MCP/dashboard listener, alongside `/auth/`, `/profile`, and `/dashboard/`.
