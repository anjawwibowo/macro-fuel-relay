// worker.js — MACRO FUEL RELAY v0.2.17
// Production relay for the six active Macro Lab CORE providers.
// JISDOR is removed from the active Worker surface.

const SOURCES = {
  bi_rate: "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx",
  us10y: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026",
  bls_cpi: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  bls_employment: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  srbi: "https://www.bi.go.id/id/fungsi-utama/moneter/operasi-moneter/Default.aspx"
};

const ROUTES = {
  "/fuel/bi_rate": "bi_rate",
  "/fuel/us10y": "us10y",
  "/fuel/bls_cpi": "bls_cpi",
  "/fuel/bls_employment": "bls_employment",
  "/fuel/fomc": "fomc",
  "/fuel/srbi": "srbi"
};

const BLS_SERIES = {
  bls_cpi: "CUUR0000SA0",
  bls_employment: "CES0000000001"
};

async function sha256(s) {
  const b = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );

  return [...new Uint8Array(b)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(obj, status = 200) {
  return Response.json(obj, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function isMonthly(period) {
  return /^M(?:0[1-9]|1[0-2])$/.test(String(period));
}

function numericValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const s = String(value)
    .trim()
    .replace(/,/g, "");

  if (s === "" || s === "..." || s === "-") {
    return null;
  }

  const n = Number(s);

  return Number.isFinite(n) ? n : null;
}

const SRBI_INDEX_URL =
  "https://www.bi.go.id/id/publikasi/lelang/operasi-moneter/default.aspx?kategori=lelang+srbi";

function isAllowedBiUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (
      u.protocol === "https:" &&
      u.hostname === "www.bi.go.id" &&
      u.pathname.startsWith("/id/publikasi/lelang/operasi-moneter/")
    );
  } catch {
    return false;
  }
}

function looksLikeSrbiAuctionPage(body) {
  if (!body || typeof body !== "string") return false;

  const hasSrbi =
    /Hasil-Lelang-SRBI/i.test(body) ||
    /Suku Bunga\.? Indonesia/i.test(body) ||
    /\bSRBI\b/i.test(body);

  const hasAuctionFields =
    /Tanggal Transaksi|Transaction Date/i.test(body) &&
    /Nominal Penawaran|Bidding Amount/i.test(body) &&
    /Nominal Pemenang|Nominal Awarded/i.test(body);

  return hasSrbi && hasAuctionFields;
}

async function fetchSrbiPage(rawUrl) {
  if (!isAllowedBiUrl(rawUrl)) {
    return jsonResponse(
      {
        ok: false,
        source_id: "srbi",
        dataset_id: "srbi",
        error: "official_bi_url_not_allowed"
      },
      400
    );
  }

  const acquiredAt = new Date().toISOString();

  try {
    const r = await fetch(rawUrl, {
      headers: {
        "User-Agent": "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.17",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.bi.go.id/",
        "Cache-Control": "no-cache"
      }
    });

    const body = await r.text();
    const bodySha256 = await sha256(body);
    const bodyBytes = new TextEncoder().encode(body).length;
    const contentType = r.headers.get("content-type") || "";

    if (!r.ok) {
      return jsonResponse(
        {
          ok: false,
          source_id: "srbi",
          dataset_id: "srbi",
          source_url: rawUrl,
          status_code: r.status,
          acquired_at: acquiredAt,
          body_bytes: bodyBytes,
          body_sha256: bodySha256,
          content_type: contentType,
          error: "upstream_http_error",
          body: body.slice(0, 4000)
        },
        502
      );
    }

    if (!looksLikeSrbiAuctionPage(body)) {
      return jsonResponse(
        {
          ok: false,
          source_id: "srbi",
          dataset_id: "srbi",
          source_url: rawUrl,
          status_code: r.status,
          acquired_at: acquiredAt,
          body_bytes: bodyBytes,
          body_sha256: bodySha256,
          content_type: contentType,
          error: "invalid_srbi_payload",
          reason: "srbi_auction_structure_not_detected",
          body: body.slice(0, 4000)
        },
        502
      );
    }

    return jsonResponse({
      ok: true,
      source_id: "srbi",
      dataset_id: "srbi",
      source_url: rawUrl,
      status_code: r.status,
      acquired_at: acquiredAt,
      body_bytes: bodyBytes,
      body_sha256: bodySha256,
      content_type: contentType,
      body
    });
  } catch (e) {
    return jsonResponse(
      {
        ok: false,
        source_id: "srbi",
        dataset_id: "srbi",
        source_url: rawUrl,
        acquired_at: acquiredAt,
        error: "upstream_fetch_failed",
        detail: String(e?.message || e).slice(0, 1000)
      },
      502
    );
  }
}

function validateBlsPayload(
  sourceId,
  payload
) {
  const expected =
    BLS_SERIES[sourceId];

  if (
    !payload ||
    payload.status !==
      "REQUEST_SUCCEEDED"
  ) {
    return {
      ok:
        false,

      reason:
        "bls_api_status_not_succeeded"
    };
  }

  const series =
    payload?.Results?.series;

  if (
    !Array.isArray(series) ||
    series.length !== 1
  ) {
    return {
      ok:
        false,

      reason:
        "unexpected_series_shape"
    };
  }

  if (
    series[0]?.seriesID !==
    expected
  ) {
    return {
      ok:
        false,

      reason:
        "unexpected_series_id"
    };
  }

  const data =
    series[0]?.data;

  if (
    !Array.isArray(data) ||
    data.length === 0
  ) {
    return {
      ok:
        false,

      reason:
        "no_observations"
    };
  }

  const currentYear =
    new Date()
      .getUTCFullYear();

  const monthly =
    data.filter(
      x =>
        isMonthly(
          x.period
        )
    );

  if (
    monthly.length === 0
  ) {
    return {
      ok:
        false,

      reason:
        "no_monthly_observations"
    };
  }

  for (const row of data) {
    if (
      !/^\d{4}$/.test(
        String(row.year)
      )
    ) {
      return {
        ok:
          false,

        reason:
          "invalid_year"
      };
    }

    if (
      Number(row.year) >
      currentYear
    ) {
      return {
        ok:
          false,

        reason:
          "future_year_observation"
      };
    }
  }

  const numericMonthly =
    monthly
      .map(row => ({
        ...row,

        numeric_value:
          numericValue(
            row.value
          )
      }))
      .filter(
        row =>
          row.numeric_value !==
          null
      );

  if (
    numericMonthly.length === 0
  ) {
    return {
      ok:
        false,

      reason:
        "no_numeric_monthly_observations"
    };
  }

  const latestRaw =
    monthly[0];

  const latestNumeric =
    numericMonthly[0];

  return {
    ok:
      true,

    series_id:
      expected,

    observation_count:
      monthly.length,

    numeric_observation_count:
      numericMonthly.length,

    latest_observation_raw:
      latestRaw,

    latest_numeric_observation:
      latestNumeric,

    latest_observation_usable:
      numericValue(
        latestRaw.value
      ) !== null
  };
}

async function fetchBls(
  sourceId,
  env
) {
  if (!env.BLS_API_KEY) {
    return jsonResponse(
      {
        ok:
          false,

        source_id:
          sourceId,

        error:
          "missing_bls_api_key"
      },
      500
    );
  }

  const now =
    new Date();

  const endYear =
    now.getUTCFullYear();

  const startYear =
    endYear - 2;

  const payload = {
    seriesid:
      [
        BLS_SERIES[sourceId]
      ],

    startyear:
      String(startYear),

    endyear:
      String(endYear),

    registrationkey:
      env.BLS_API_KEY
  };

  let lastStatus = 0;
  let lastBody = "";

  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {
    const acquiredAt =
      new Date().toISOString();

    try {
      const r =
        await fetch(
          SOURCES[sourceId],
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "User-Agent":
                "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.13"
            },

            body:
              JSON.stringify(
                payload
              )
          }
        );

      const body =
        await r.text();

      lastStatus =
        r.status;

      lastBody =
        body;

      if (
        r.status === 429 ||
        r.status >= 500
      ) {
        if (attempt < 2) {
          await sleep(
            attempt === 0
              ? 1000
              : 3000
          );

          continue;
        }
      }

      let parsed = null;

      try {
        parsed =
          JSON.parse(body);
      } catch {
        parsed = null;
      }

      if (!r.ok) {
        return jsonResponse(
          {
            ok:
              false,

            source_id:
              sourceId,

            dataset_id:
              sourceId,

            source_url:
              SOURCES[sourceId],

            status_code:
              r.status,

            acquired_at:
              acquiredAt,

            body_sha256:
              await sha256(body),

            content_type:
              r.headers.get(
                "content-type"
              ) || "",

            error:
              "bls_upstream_http_error",

            upstream_body:
              body.slice(
                0,
                2000
              )
          },
          502
        );
      }

      const validation =
        validateBlsPayload(
          sourceId,
          parsed
        );

      if (!validation.ok) {
        return jsonResponse(
          {
            ok:
              false,

            source_id:
              sourceId,

            dataset_id:
              sourceId,

            source_url:
              SOURCES[sourceId],

            status_code:
              r.status,

            acquired_at:
              acquiredAt,

            body_sha256:
              await sha256(body),

            content_type:
              r.headers.get(
                "content-type"
              ) || "",

            error:
              validation.reason,

            upstream_status:
              parsed?.status ||
              null,

            upstream_message:
              parsed?.message ||
              []
          },
          502
        );
      }

      return jsonResponse({
        ok:
          true,

        source_id:
          sourceId,

        dataset_id:
          sourceId,

        series_id:
          validation.series_id,

        source_url:
          SOURCES[sourceId],

        status_code:
          r.status,

        acquired_at:
          acquiredAt,

        request_start_year:
          String(startYear),

        request_end_year:
          String(endYear),

        observation_count:
          validation.observation_count,

        numeric_observation_count:
          validation.numeric_observation_count,

        latest_observation_raw:
          validation.latest_observation_raw,

        latest_numeric_observation:
          validation.latest_numeric_observation,

        latest_observation_usable:
          validation.latest_observation_usable,

        body_bytes:
          new TextEncoder()
            .encode(body)
            .length,

        body_sha256:
          await sha256(body),

        content_type:
          r.headers.get(
            "content-type"
          ) || "",

        body
      });

    } catch (e) {
      lastBody =
        String(
          e?.message || e
        );

      if (attempt < 2) {
        await sleep(
          attempt === 0
            ? 1000
            : 3000
        );

        continue;
      }
    }
  }

  return jsonResponse(
    {
      ok:
        false,

      source_id:
        sourceId,

      dataset_id:
        sourceId,

      source_url:
        SOURCES[sourceId],

      status_code:
        lastStatus,

      error:
        "upstream_fetch_failed_after_retries",

      upstream_body:
        lastBody.slice(
          0,
          2000
        )
    },
    502
  );
}

export default {
  async fetch(req, env) {
    const u =
      new URL(req.url);

    if (req.method !== "GET") {
      return new Response(
        "Method Not Allowed",
        {
          status:
            405
        }
      );
    }

    if (
      u.pathname ===
      "/health"
    ) {
      return jsonResponse({
        ok:
          true,

        service:
          "macro-fuel-relay",

        version:
          "0.2.17"
      });
    }

    const sourceId =
      ROUTES[u.pathname];

    if (!sourceId) {
      return jsonResponse(
        {
          ok:
            false,

          error:
            "route_not_allowed"
        },
        404
      );
    }

    if (
      env.RELAY_TOKEN &&
      req.headers.get(
        "Authorization"
      ) !==
        `Bearer ${env.RELAY_TOKEN}`
    ) {
      return jsonResponse(
        {
          ok:
            false,

          error:
            "unauthorized"
        },
        401
      );
    }

    if (
      sourceId ===
        "bls_cpi" ||
      sourceId ===
        "bls_employment"
    ) {
      return fetchBls(
        sourceId,
        env
      );
    }

    if (sourceId === "srbi") {
      const targetUrl = u.searchParams.get("url");

      if (targetUrl) {
        return fetchSrbiPage(targetUrl);
      }
    }

    const url =
      SOURCES[sourceId];

    const acquiredAt =
      new Date().toISOString();

    try {
      const r =
        await fetch(
          url,
          {
            headers: {
              "User-Agent":
                "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.13"
            }
          }
        );

      const body =
        await r.text();

      return jsonResponse(
        {
          ok:
            r.ok,

          source_id:
            sourceId,

          dataset_id:
            sourceId,

          source_url:
            url,

          status_code:
            r.status,

          acquired_at:
            acquiredAt,

          body_bytes:
            new TextEncoder()
              .encode(body)
              .length,

          body_sha256:
            await sha256(body),

          content_type:
            r.headers.get(
              "content-type"
            ) || "",

          body
        },

        r.ok
          ? 200
          : 502
      );

    } catch (e) {
      return jsonResponse(
        {
          ok:
            false,

          source_id:
            sourceId,

          dataset_id:
            sourceId,

          source_url:
            url,

          acquired_at:
            acquiredAt,

          error:
            "upstream_fetch_failed"
        },
        502
      );
    }
  }
};