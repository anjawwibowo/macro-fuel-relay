# MACRO FUEL RELAY v0.2.14

Targeted validation patch over v0.2.3.

## BLS
- Official BLS Public Data API v2.
- Secret binding: `BLS_API_KEY`.
- CPI: `CUUR0000SA0`.
- Employment: `CES0000000001`.
- Never retries HTTP 429; propagates it as HTTP 429 with explicit rate-limit evidence.
- Retries only transient 5xx responses with bounded backoff.
- Validates API status, exact series ID, year bounds, and monthly observations.
- Does not silently convert BLS placeholder values such as `...` into numeric values.
- Reports both the newest raw monthly observation and newest numeric monthly observation.
- HTTP 200 + REQUEST_SUCCEEDED can therefore remain observable even when the newest monthly slot is not numerically usable.
- Raw upstream JSON, SHA-256, and acquisition metadata are returned.

## Scope
Transport-only. No Macro Lab/R8 canonical writes.


v0.2.13 decision:
- BLS CPI and Employment are intentionally NOT combined.
- Each endpoint performs its own single-series BLS v2 request.
- No Cloudflare Cache API.
- No in-isolate snapshot/cache.
- Reliability-first rollback to the proven single-series acquisition path.
- BLS API key remains in the BLS_API_KEY Cloudflare secret.


v0.2.13 optimization baseline:
- Derived from the proven single-series BLS v2 acquisition path.
- No Cache API.
- No combined CPI + Employment request.
- No retries on HTTP 429, preventing retry amplification during BLS throttling.
- Transient 5xx responses may still use bounded retry.
- One request per endpoint when acquisition is attempted.
- Existing BLS validation and evidence fields are preserved.


v0.2.14 hardening:
- HTTP 429 from BLS is returned as HTTP 429, not masked as relay HTTP 502.
- `error=upstream_rate_limited` and `upstream_status=429` make the failure state explicit.
- `Retry-After` is preserved when BLS supplies it.
- 429 is never retried by the Worker, preventing retry amplification.
- Existing single-series, no-cache, transport-only design is unchanged.
