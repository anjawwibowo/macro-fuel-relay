# MACRO FUEL RELAY v0.2.10

Diagnostic reliability hotfix.

## What changed
- Removed Workers Cache API from the BLS acquisition path because Cache API is not functional/persistent on `*.workers.dev` deployments.
- Kept CPI + Employment as ONE combined BLS API v2 upstream request.
- Added best-effort in-isolate 24h snapshot reuse to reduce repeated requests when the same Worker isolate handles consecutive calls.
- Added a top-level exception boundary so unexpected JavaScript exceptions are returned as structured evidence instead of Cloudflare 1101.
- No BLS key changes. `BLS_API_KEY` remains a Cloudflare Secret.

## Important
In-isolate memory is an optimization only, not durable cache. It may disappear when the Worker isolate is replaced. The response exposes `snapshot_cache_layer` so this is observable.


v0.2.10 hotfix: corrected the outer exception-boundary placement in worker.js. v0.2.9 had an invalid second catch after an inner catch, causing Cloudflare Wrangler deploy failure. Cache API remains removed from the BLS path; BLS CPI + Employment remain one combined request.
