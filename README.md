TRADER SOTOY — MACRO FUEL RELAY v0.2.1
Transport-only Cloudflare Worker. Separate from Macro Lab and R8.
Routes: /health plus /fuel/bi_rate, /fuel/jisdor, /fuel/srbi, /fuel/us10y, /fuel/fomc, /fuel/bls_cpi, /fuel/bls_employment.
Optional secret: RELAY_TOKEN.
Macro Lab must independently verify source hostname, status, hash, timestamps, schema, and temporal/lookahead rules.
