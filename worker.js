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

// BLS data are low-frequency macro observations.
// workers.dev does not provide functional Cache API persistence, so this
// relay uses a best-effort in-isolate snapshot only. The upstream request
// remains one combined request for CPI + Employment.
const BLS_MEMORY_TTL_SECONDS = 86400;
let blsMemorySnapshot = null;

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

  if (blsMemorySnapshot &&
      blsMemorySnapshot.request_start_year === String(startYear) &&
      blsMemorySnapshot.request_end_year === String(endYear)) {
    const acquiredMs = Date.parse(blsMemorySnapshot.acquired_at || "");
    if (Number.isFinite(acquiredMs)) {
      const age = Math.max(0, (Date.now() - acquiredMs) / 1000);
      if (age <= BLS_MEMORY_TTL_SECONDS) {
        return {
          ...blsMemorySnapshot,
          cache_hit: true,
          cache_age_seconds: Math.floor(age),
          cache_layer: "isolate_memory"
        };
      }
    }
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
          "User-Agent": "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.9"
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

      snapshot.cache_hit = false;
      snapshot.cache_age_seconds = 0;
      snapshot.cache_layer = "none";
      blsMemorySnapshot = snapshot;
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
    snapshot_cache_layer: snapshot.cache_layer || "none",
    snapshot_series_ids: snapshot.series_ids,
    body_bytes: snapshot.body_bytes,
    body_sha256: snapshot.body_sha256,
    content_type: snapshot.content_type,
    body: snapshot.body
  });
}

export default {
  async fetch(req, env, executionCtx) {
    try {
    const u = new URL(req.url);

    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (u.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "macro-fuel-relay",
        version: "0.2.9"
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
          "User-Agent": "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.9"
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
    } catch (e) {
      return jsonResponse({
        ok: false,
        error: "worker_exception",
        error_name: e?.name || "Error",
        error_message: String(e?.message || e),
        error_stack: String(e?.stack || "").slice(0, 2000)
      }, 500);
    }
  }
};
