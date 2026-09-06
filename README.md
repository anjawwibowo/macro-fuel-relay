# MACRO FUEL RELAY v0.2.6

Targeted hotfix over v0.2.5.

## Root cause fixed
v0.2.5 used an invented hostname (`macro-fuel-relay.internal`) as the
Cache API key. The Cache API key is now derived from the actual incoming
Worker URL/hostname, following Cloudflare's documented Cache API pattern.

## Safety behavior
- Cache read failures are treated as cache misses, never Worker-fatal.
- Cache writes use `executionCtx.waitUntil()`.
- A cache failure can no longer turn a valid BLS upstream response into
  Cloudflare Error 1101.

## BLS behavior
- CPI + Employment remain ONE combined BLS API v2 request.
- Snapshot is reused for both endpoints.
- 24h snapshot TTL.
- `snapshot_cache_hit` remains observable.
- BLS API key remains a Cloudflare Secret named `BLS_API_KEY`.

## Scope
Transport-only. No Macro Lab/R8 canonical writes.
