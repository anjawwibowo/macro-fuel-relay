# MACRO FUEL RELAY v0.2.12

Targeted validation patch over v0.2.3.

## BLS
- Official BLS Public Data API v2.
- Secret binding: `BLS_API_KEY`.
- CPI: `CUUR0000SA0`.
- Employment: `CES0000000001`.
- Retries transient 429/5xx.
- Validates API status, exact series ID, year bounds, and monthly observations.
- Does not silently convert BLS placeholder values such as `...` into numeric values.
- Reports both the newest raw monthly observation and newest numeric monthly observation.
- HTTP 200 + REQUEST_SUCCEEDED can therefore remain observable even when the newest monthly slot is not numerically usable.
- Raw upstream JSON, SHA-256, and acquisition metadata are returned.

## Scope
Transport-only. No Macro Lab/R8 canonical writes.


v0.2.12 decision:
- BLS CPI and Employment are intentionally NOT combined.
- Each endpoint performs its own single-series BLS v2 request.
- No Cloudflare Cache API.
- No in-isolate snapshot/cache.
- Reliability-first rollback to the proven single-series acquisition path.
- BLS API key remains in the BLS_API_KEY Cloudflare secret.
