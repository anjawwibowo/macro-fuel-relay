# MACRO FUEL RELAY v0.2.3

Targeted BLS hardening patch for TRADER SOTOY Macro Lab.

## BLS
- Uses official BLS Public Data API v2.
- Secret binding required: `BLS_API_KEY`.
- No BLS key is stored in this repository.
- CPI series: `CUUR0000SA0`.
- Employment series: `CES0000000001`.
- POST request with 3-year window.
- Retries transient 429/5xx twice with backoff.
- Validates BLS `REQUEST_SUCCEEDED`, exact series ID, monthly observations, year bounds, and numeric values.
- Returns raw upstream JSON plus SHA-256 and acquisition metadata.
- Returns 502 when upstream or validation fails.

## Existing fuel routes
BI_RATE, US10Y, FOMC, JISDOR, SRBI remain transport-only and unchanged in source scope.

## Cloudflare secret
Create a Worker secret named exactly:
`BLS_API_KEY`

Never put the key in GitHub, source code, wrangler.toml, or chat.

## Scope
Transport-only. This relay does not modify Macro Lab or R8 canonical state.
