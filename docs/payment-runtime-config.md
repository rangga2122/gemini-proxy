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

Public landing-page checkout also requires working SMTP configuration. `/billing/plan` reports `publicCheckoutConfigured: true` only when both Pakasir and paid-access email delivery are available. Profile renewal remains available whenever Pakasir itself is configured.

The standard account capacity is 60 requests per minute with five simultaneous active requests. Administrators can set each account to 1-20 workers from the user-management menu, and changes take effect without rotating the API key. The configured limit is shared by the same account across MCP API-key traffic and Console dashboard traffic; an excess request returns HTTP 429 with the account's current `workerLimit`.

The server validates project, order ID, and amount on both transaction creation and status lookup. It generates the displayed QR from Pakasir's `payment_number`; no API key or provider response is exposed to the browser. Pending orders are also verified in the background, so package activation does not depend on the profile page remaining open.

## Public landing-page checkout

`POST /billing/public/order` accepts exactly an email and an Indonesian mobile/WhatsApp number. There is no OTP step before payment. For a new email, the paid user is provisioned only after Pakasir reports `completed`. For an existing email, one calendar month is accumulated from the remaining future expiry; an expired account starts from the confirmed payment time. Managed accounts without an expiry cannot be renewed through public checkout.

After confirmed payment, the server generates a new random password and emails it to the order address together with the new expiry. No OTP is used in paid checkout or paid-account login. For an existing account, the new password replaces the previous password and invalidates old dashboard sessions only after the access email has been accepted by SMTP. Existing passwords cannot be emailed because only salted password verifiers are stored.

Checkout status is protected by a random HttpOnly, Secure, SameSite cookie whose SHA-256 hash is stored with the order. Raw passwords are never placed in `billing.json`, API responses, cookies, or logs. If email delivery fails, the paid order remains active with delivery marked pending and the background verifier retries it; the account's current password is not changed by a failed email attempt. After delivery, the browser shows a paid-success screen with an email-prefilled login form, while the buyer enters the password received through email.

The public reverse proxy must route the `/billing/` path prefix to the MCP/dashboard listener, alongside `/auth/`, `/profile`, and `/dashboard/`.
