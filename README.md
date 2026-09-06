# MACRO FUEL RELAY v0.2.5

Targeted BLS resource-efficiency patch based on the proven R8 TVDatafeed pattern.

## What changed
- CPI and Employment now share ONE combined BLS API v2 request.
- Cache-first snapshot reuse.
- The combined snapshot contains both series:
  - CUUR0000SA0
  - CES0000000001
- `/fuel/bls_cpi` and `/fuel/bls_employment` consume the same cached snapshot.
- Response exposes `snapshot_cache_hit` so request reuse is directly observable.
- 24h edge snapshot TTL.
- Raw BLS response, SHA-256, acquisition time, request window, and validation evidence are retained.
- Existing non-BLS routes remain transport-only.

## R8 adaptation
Adapted principles, not R8 code:
1. cache-first
2. reuse one upstream resource
3. provider fetch only when cache is unusable
4. expose cache/provider evidence
5. validity remains the first trust boundary

## BLS
Secret required:
`BLS_API_KEY`

Never store the API key in GitHub, wrangler.toml, source code, or chat.

## Scope
Transport-only. No Macro Lab/R8 canonical writes.
