const SOURCES = {
  bi_rate: "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx",
  us10y: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026",
  bls: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  jisdor: "https://www.bi.go.id/biwebservice/wskursbi.asmx/getSubKursJisdor1",
  srbi: "https://www.bi.go.id/id/fungsi-utama/moneter/operasi-moneter/Default.aspx"
};

const ROUTES = {
  "/fuel/bi_rate": "bi_rate",
  "/fuel/us10y": "us10y",
  "/fuel/bls_cpi": "bls_cpi",
  "/fuel/bls_employment": "bls_employment",
  "/fuel/fomc": "fomc",
  "/fuel/jisdor": "jisdor",
  "/fuel/srbi": "srbi"
};

const BLS_SERIES = {
  bls_cpi: "CUUR0000SA0",
  bls_employment: "CES0000000001"
};

// BLS data are low-frequency macro observations. Cache the combined
// snapshot for 24h to avoid repeated upstream requests while retaining
// a deterministic freshness boundary. Macro Lab remains responsible for
// its own canonical freshness/revision rules.
const BLS_CACHE_TTL_SECONDS = 86400;

async function sha256(s) {
  const b = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return [...new Uint8Array(b)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return Response.json(obj, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMonthly(period) {
  return /^M(?:0[1-9]|1[0-2])$/.test(String(period));
}

function numericValue(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().replace(/,/g, "");
  if (s === "" || s === "..." || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function validateBlsSeries(series, expectedId) {
  if (!series || series.seriesID !== expectedId) {
    return {
      ok: false,
      series_id: expectedId,
      reason: "unexpected_series_id"
    };
  }

  const data = Array.isArray(series.data) ? series.data : [];
  if (data.length === 0) {
    return {
      ok: false,
      series_id: expectedId,
      reason: "no_observations"
    };
  }

  const currentYear = new Date().getUTCFullYear();
  const monthly = data.filter(x => isMonthly(x.period));

  for (const row of data) {
    if (!/^\d{4}$/.test(String(row.year))) {
      return {
        ok: false,
        series_id: expectedId,
        reason: "invalid_year"
      };
    }
    if (Number(row.year) > currentYear) {
      return {
        ok: false,
        series_id: expectedId,
        reason: "future_year_observation"
      };
    }
  }

  if (monthly.length === 0) {
    return {
      ok: false,
      series_id: expectedId,
      reason: "no_monthly_observations"
    };
  }

  const numericMonthly = monthly
    .map(row => ({
      ...row,
      numeric_value: numericValue(row.value)
    }))
    .filter(row => row.numeric_value !== null);

  if (numericMonthly.length === 0) {
    return {
      ok: false,
      series_id: expectedId,
      reason: "no_numeric_monthly_observations"
    };
  }

  const latestRaw = monthly[0];
  const latestNumeric = numericMonthly[0];

  return {
    ok: true,
    series_id: expectedId,
    observation_count: monthly.length,
    numeric_observation_count: numericMonthly.length,
    latest_observation_raw: latestRaw,
    latest_numeric_observation: latestNumeric,
    latest_observation_usable: numericValue(latestRaw.value) !== null
  };
}

function snapshotCacheRequest(startYear, endYear) {
  const u = new URL("https://macro-fuel-relay.internal/_bls_snapshot");
  u.searchParams.set("series", "CUUR0000SA0,CES0000000001");
  u.searchParams.set("startyear", String(startYear));
  u.searchParams.set("endyear", String(endYear));
  return new Request(u.toString(), { method: "GET" });
}

async function readBlsSnapshotCache(startYear, endYear) {
  const cache = caches.default;
  const req = snapshotCacheRequest(startYear, endYear);
  const hit = await cache.match(req);
  if (!hit) return null;

  try {
    const obj = await hit.json();
    if (!obj || obj.snapshot_version !== "bls-combined-v1") return null;

    const acquiredAt = Date.parse(obj.acquired_at || "");
    if (!Number.isFinite(acquiredAt)) return null;

    const ageSeconds = Math.max(
      0,
      (Date.now() - acquiredAt) / 1000
    );

    if (ageSeconds > BLS_CACHE_TTL_SECONDS) return null;

    return {
      ...obj,
      cache_hit: true,
      cache_age_seconds: Math.floor(ageSeconds)
    };
  } catch {
    return null;
  }
}

async function writeBlsSnapshotCache(snapshot, startYear, endYear) {
  const cache = caches.default;
  const req = snapshotCacheRequest(startYear, endYear);

  const body = JSON.stringify(snapshot);
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${BLS_CACHE_TTL_SECONDS}`
    }
  });

  await cache.put(req, response);
}

async function fetchBlsSnapshot(env) {
  if (!env.BLS_API_KEY) {
    return {
      ok: false,
      error: "missing_bls_api_key"
    };
  }

  const now = new Date();
  const endYear = now.getUTCFullYear();
  const startYear = endYear - 2;

  // Cache-first: one combined upstream request can satisfy both BLS
  // consumers. This is the Macro Lab equivalent of R8's provider-session
  // reuse + cache-first principle.
  const cached = await readBlsSnapshotCache(startYear, endYear);
  if (cached) {
    return cached;
  }

  const payload = {
    seriesid: [
      BLS_SERIES.bls_cpi,
      BLS_SERIES.bls_employment
    ],
    startyear: String(startYear),
    endyear: String(endYear),
    registrationkey: env.BLS_API_KEY
  };

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const acquiredAt = new Date().toISOString();

    try {
      const r = await fetch(SOURCES.bls, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.5"
        },
        body: JSON.stringify(payload)
      });

      const body = await r.text();
      lastStatus = r.status;
      lastBody = body;

      if (r.status === 429 || r.status >= 500) {
        if (attempt < 2) {
          await sleep(attempt === 0 ? 1000 : 3000);
          continue;
        }
      }

      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }

      if (!r.ok) {
        return {
          ok: false,
          source_id: "bls_combined",
          dataset_id: "bls_combined",
          source_url: SOURCES.bls,
          status_code: r.status,
          acquired_at: acquiredAt,
          body_sha256: await sha256(body),
          content_type: r.headers.get("content-type") || "",
          error: "bls_upstream_http_error",
          upstream_body: body.slice(0, 2000)
        };
      }

      if (!parsed || parsed.status !== "REQUEST_SUCCEEDED") {
        return {
          ok: false,
          source_id: "bls_combined",
          dataset_id: "bls_combined",
          source_url: SOURCES.bls,
          status_code: r.status,
          acquired_at: acquiredAt,
          body_sha256: await sha256(body),
          content_type: r.headers.get("content-type") || "",
          error: "bls_api_status_not_succeeded",
          upstream_status: parsed?.status || null,
          upstream_message: parsed?.message || []
        };
      }

      const series = Array.isArray(parsed?.Results?.series)
        ? parsed.Results.series
        : [];

      if (series.length !== 2) {
        return {
          ok: false,
          source_id: "bls_combined",
          dataset_id: "bls_combined",
          source_url: SOURCES.bls,
          status_code: r.status,
          acquired_at: acquiredAt,
          body_sha256: await sha256(body),
          content_type: r.headers.get("content-type") || "",
          error: "unexpected_combined_series_shape",
          returned_series_ids: series.map(x => x?.seriesID || null)
        };
      }

      const byId = Object.fromEntries(
        series.map(x => [x?.seriesID, x])
      );

      const cpi = validateBlsSeries(
        byId[BLS_SERIES.bls_cpi],
        BLS_SERIES.bls_cpi
      );
      const employment = validateBlsSeries(
        byId[BLS_SERIES.bls_employment],
        BLS_SERIES.bls_employment
      );

      if (!cpi.ok || !employment.ok) {
        return {
          ok: false,
          source_id: "bls_combined",
          dataset_id: "bls_combined",
          source_url: SOURCES.bls,
          status_code: r.status,
          acquired_at: acquiredAt,
          body_sha256: await sha256(body),
          content_type: r.headers.get("content-type") || "",
          error: "bls_series_validation_failed",
          cpi,
          employment
        };
      }

      const snapshot = {
        snapshot_version: "bls-combined-v1",
        ok: true,
        source_id: "bls_combined",
        dataset_id: "bls_combined",
        source_url: SOURCES.bls,
        status_code: r.status,
        upstream_status: parsed.status,
        acquired_at: acquiredAt,
        request_start_year: String(startYear),
        request_end_year: String(endYear),
        series_ids: [
          BLS_SERIES.bls_cpi,
          BLS_SERIES.bls_employment
        ],
        cpi,
        employment,
        body_bytes: new TextEncoder().encode(body).length,
        body_sha256: await sha256(body),
        content_type: r.headers.get("content-type") || "",
        body
      };

      try {
        await writeBlsSnapshotCache(snapshot, startYear, endYear);
      } catch {
        // Cache failure is observable in the response but does not turn a
        // valid upstream acquisition into a false failure.
        snapshot.cache_write_ok = false;
      }

      snapshot.cache_hit = false;
      snapshot.cache_age_seconds = 0;
      return snapshot;
    } catch (e) {
      lastBody = String(e?.message || e);
      if (attempt < 2) {
        await sleep(attempt === 0 ? 1000 : 3000);
        continue;
      }
    }
  }

  return {
    ok: false,
    source_id: "bls_combined",
    dataset_id: "bls_combined",
    source_url: SOURCES.bls,
    status_code: lastStatus,
    error: "upstream_fetch_failed_after_retries",
    upstream_body: lastBody.slice(0, 2000)
  };
}

function blsEndpointResponse(snapshot, sourceId) {
  if (!snapshot?.ok) {
    return jsonResponse({
      ...snapshot,
      source_id: sourceId,
      dataset_id: sourceId
    }, 502);
  }

  const selected = snapshot[sourceId];

  return jsonResponse({
    ok: true,
    source_id: sourceId,
    dataset_id: sourceId,
    series_id: selected.series_id,
    source_url: snapshot.source_url,
    status_code: snapshot.status_code,
    upstream_status: snapshot.upstream_status,
    acquired_at: snapshot.acquired_at,
    request_start_year: snapshot.request_start_year,
    request_end_year: snapshot.request_end_year,
    observation_count: selected.observation_count,
    numeric_observation_count: selected.numeric_observation_count,
    latest_observation_raw: selected.latest_observation_raw,
    latest_numeric_observation: selected.latest_numeric_observation,
    latest_observation_usable: selected.latest_observation_usable,
    snapshot_version: snapshot.snapshot_version,
    snapshot_cache_hit: snapshot.cache_hit === true,
    snapshot_cache_age_seconds: snapshot.cache_age_seconds ?? 0,
    snapshot_series_ids: snapshot.series_ids,
    body_bytes: snapshot.body_bytes,
    body_sha256: snapshot.body_sha256,
    content_type: snapshot.content_type,
    body: snapshot.body
  });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (u.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "macro-fuel-relay",
        version: "0.2.5"
      });
    }

    const sourceId = ROUTES[u.pathname];
    if (!sourceId) {
      return jsonResponse(
        { ok: false, error: "route_not_allowed" },
        404
      );
    }

    if (
      env.RELAY_TOKEN &&
      req.headers.get("Authorization") !== `Bearer ${env.RELAY_TOKEN}`
    ) {
      return jsonResponse(
        { ok: false, error: "unauthorized" },
        401
      );
    }

    if (sourceId === "bls_cpi" || sourceId === "bls_employment") {
      const snapshot = await fetchBlsSnapshot(env);
      return blsEndpointResponse(snapshot, sourceId);
    }

    const url = SOURCES[sourceId];
    const acquiredAt = new Date().toISOString();

    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.5"
        }
      });
      const body = await r.text();

      return jsonResponse({
        ok: r.ok,
        source_id: sourceId,
        dataset_id: sourceId,
        source_url: url,
        status_code: r.status,
        acquired_at: acquiredAt,
        body_bytes: new TextEncoder().encode(body).length,
        body_sha256: await sha256(body),
        content_type: r.headers.get("content-type") || "",
        body
      }, r.ok ? 200 : 502);
    } catch {
      return jsonResponse({
        ok: false,
        source_id: sourceId,
        dataset_id: sourceId,
        source_url: url,
        acquired_at: acquiredAt,
        error: "upstream_fetch_failed"
      }, 502);
    }
  }
};
