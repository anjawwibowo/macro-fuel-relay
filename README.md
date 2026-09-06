TRADER SOTOY — MACRO FUEL RELAY v0.2.2
Transport-only Cloudflare Worker. Separate from Macro Lab and R8.

CORE routes:
 /health /fuel/bi_rate /fuel/jisdor /fuel/srbi /fuel/us10y
 /fuel/fomc /fuel/bls_cpi /fuel/bls_employment

BLS uses official BLS flat files instead of the rate-limited Public Data API:
- CPI-U all items: cu.data.1.AllItems
- CES total nonfarm employment: ce.data.00a.TotalNonfarm.Employment

Optional secret: RELAY_TOKEN.
Macro Lab must independently verify source hostname, status, hash, timestamps, schema, and temporal/lookahead rules.
