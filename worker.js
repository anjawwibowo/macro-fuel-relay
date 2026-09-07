const SOURCES = {
  bi_rate: "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx",
  us10y: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026",
  bls_cpi: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  bls_employment: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
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

function isValidJisdorDate(value) {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(String(value))) {
    return false;
  }

  const [dd, mm, yyyy] = String(value)
    .split("-")
    .map(Number);

  const d = new Date(
    Date.UTC(yyyy, mm - 1, dd)
  );

  return (
    d.getUTCFullYear() === yyyy &&
    d.getUTCMonth() === mm - 1 &&
    d.getUTCDate() === dd
  );
}

function jisdorDateToUtc(value) {
  const [dd, mm, yyyy] = String(value)
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(yyyy, mm - 1, dd)
  );
}

function buildJisdorSoapBody(
  startDate,
  endDate
) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getSubKursJisdor3 xmlns="http://tempuri.org/">
      <mts>USD</mts>
      <startDate>${startDate}</startDate>
      <endDate>${endDate}</endDate>
    </getSubKursJisdor3>
  </soap:Body>
</soap:Envelope>`.trim();
}

function extractTagNames(xml) {
  const names = new Set();

  const re =
    /<(?![!?/])([A-Za-z_][\w:.-]*)(?:\s|>)/g;

  let m;

  while ((m = re.exec(xml)) !== null) {
    const n = m[1];

    if (
      !/^(DataSet|schema|Table|xs:schema|xsd:schema)$/i.test(n)
    ) {
      names.add(n);
    }
  }

  return [...names].slice(0, 200);
}

function inspectJisdorXml(xml) {
  const tableMatches = [
    ...xml.matchAll(
      /<Table(?:\s[^>]*)?>([\s\S]*?)<\/Table>/gi
    )
  ];

  const tables = tableMatches.map(
    (m, i) => {
      const block = m[1] || "";

      const rowMatches = [
        ...block.matchAll(
          /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g
        )
      ];

      const fields = [
        ...new Set(
          rowMatches.map(x => x[1])
        )
      ];

      return {
        index: i,

        bytes:
          new TextEncoder()
            .encode(block)
            .length,

        fields:
          fields.slice(0, 100),

        sample_values:
          rowMatches
            .slice(0, 30)
            .map(x => ({
              field: x[1],
              value: x[2]
                .trim()
                .slice(0, 200)
            }))
      };
    }
  );

  const schemaElements = [
    ...xml.matchAll(
      /<(?:xs|xsd):element\s+[^>]*name=["']([^"']+)["'][^>]*>/gi
    )
  ].map(m => m[1]);

  const allElementNames =
    extractTagNames(xml);

  return {
    table_count:
      tables.length,

    tables,

    schema_element_names:
      [
        ...new Set(schemaElements)
      ].slice(0, 200),

    all_element_names:
      allElementNames,

    jisdor_keyword_hits:
      [
        ...new Set(
          (
            xml.match(
              /[^<]*jisdor[^<]*/gi
            ) || []
          ).map(x =>
            x.trim().slice(0, 200)
          )
        )
      ].slice(0, 50)
  };
}

async function fetchJisdorOperation(
  operation,
  params,
  env,
  diagnosticOnly = true
) {
  const sourceUrl =
    `https://www.bi.go.id/biwebservice/wskursbi.asmx/${operation}`;

  const body =
    new URLSearchParams(params).toString();

  const acquiredAt =
    new Date().toISOString();

  const r = await fetch(
    sourceUrl,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded; charset=UTF-8",

        "Accept":
          "text/xml, application/xml",

        "User-Agent":
          "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.14-JISDOR-DIAG"
      },

      body
    }
  );

  const responseBody =
    await r.text();

  return {
    operation,

    source_url:
      sourceUrl,

    acquired_at:
      acquiredAt,

    status_code:
      r.status,

    content_type:
      r.headers.get("content-type") || "",

    request_params:
      params,

    request_body_sha256:
      await sha256(body),

    body_bytes:
      new TextEncoder()
        .encode(responseBody)
        .length,

    body_sha256:
      await sha256(responseBody),

    has_dataset:
      /<DataSet(?:\s|>)/i
        .test(responseBody),

    has_html:
      /<\s*!doctype\s+html|<\s*html(?:\s|>)/i
        .test(responseBody),

    inspection:
      inspectJisdorXml(responseBody),

    body:
      responseBody.slice(0, 20000)
  };
}

async function probeJisdorStructure(
  u,
  env
) {
  const startDate =
    u.searchParams.get("startDate") ||
    "01-01-2026";

  const endDate =
    u.searchParams.get("endDate") ||
    "31-01-2026";

  const [
    dd,
    mm,
    yyyy
  ] = startDate.split("-");

  const [
    dd2,
    mm2,
    yyyy2
  ] = endDate.split("-");

  const normalizedStart =
    `${dd}-${mm}-${yyyy}`;

  const normalizedEnd =
    `${dd2}-${mm2}-${yyyy2}`;

  const results = [];

  try {
    results.push(
      await fetchJisdorOperation(
        "getSubKursJisdor3",
        {
          mts: "USD",
          startDate:
            normalizedStart,
          endDate:
            normalizedEnd
        },
        env
      )
    );
  } catch (e) {
    results.push({
      operation:
        "getSubKursJisdor3",

      error:
        String(
          e?.message || e
        ).slice(0, 1000)
    });
  }

  try {
    results.push(
      await fetchJisdorOperation(
        "getSubKursJisdor4",
        {
          startDate:
            normalizedStart
        },
        env
      )
    );
  } catch (e) {
    results.push({
      operation:
        "getSubKursJisdor4",

      error:
        String(
          e?.message || e
        ).slice(0, 1000)
    });
  }

  return jsonResponse({
    ok: true,

    diagnostic_only: true,

    source_id:
      "jisdor",

    dataset_id:
      "JISDOR",

    note:
      "Diagnostic only. No corpus persistence. Jisdor3 structure + Jisdor4 single-date cross-check.",

    request: {
      startDate:
        normalizedStart,

      endDate:
        normalizedEnd
    },

    results
  });
}

async function probeJisdorSingle(
  u,
  env
) {
  const date =
    u.searchParams.get("date") ||
    "02-01-2026";

  if (!isValidJisdorDate(date)) {
    return jsonResponse(
      {
        ok: false,

        diagnostic_only: true,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        error:
          "invalid_date",

        expected:
          "DD-MM-YYYY"
      },
      400
    );
  }

  const sourceUrl =
    "https://www.bi.go.id/biwebservice/wskursbi.asmx/getSubKursJisdor2";

  const body =
    `tgl=${encodeURIComponent(date)}`;

  const acquiredAt =
    new Date().toISOString();

  try {
    const r = await fetch(
      sourceUrl,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded; charset=UTF-8",

          "Accept":
            "text/xml, application/xml",

          "User-Agent":
            "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.15-JISDOR-SINGLE-DIAG"
        },

        body
      }
    );

    const responseBody =
      await r.text();

    const inspection =
      inspectJisdorXml(
        responseBody
      );

    return jsonResponse(
      {
        ok: r.ok,

        diagnostic_only: true,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        operation:
          "getSubKursJisdor2",

        source_url:
          sourceUrl,

        acquired_at:
          acquiredAt,

        request: {
          tgl: date
        },

        request_body_sha256:
          await sha256(body),

        status_code:
          r.status,

        content_type:
          r.headers.get(
            "content-type"
          ) || "",

        body_bytes:
          new TextEncoder()
            .encode(responseBody)
            .length,

        body_sha256:
          await sha256(
            responseBody
          ),

        has_dataset:
          /<DataSet(?:\s|>)/i
            .test(responseBody),

        has_html:
          /<\s*!doctype\s+html|<\s*html(?:\s|>)/i
            .test(responseBody),

        inspection,

        body:
          responseBody.slice(
            0,
            20000
          )
      },

      r.ok ? 200 : 502
    );

  } catch (e) {
    return jsonResponse(
      {
        ok: false,

        diagnostic_only: true,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        operation:
          "getSubKursJisdor2",

        source_url:
          sourceUrl,

        acquired_at:
          acquiredAt,

        request: {
          tgl: date
        },

        error:
          "upstream_fetch_failed",

        detail:
          String(
            e?.message || e
          ).slice(0, 1000)
      },
      502
    );
  }
}

async function probeJisdorDateFormats(
  u,
  env
) {
  const startDate =
    u.searchParams.get("startDate") ||
    "01-01-2026";

  const endDate =
    u.searchParams.get("endDate") ||
    "31-01-2026";

  const [
    dd,
    mm,
    yyyy
  ] = startDate.split("-");

  const [
    dd2,
    mm2,
    yyyy2
  ] = endDate.split("-");

  const candidates = [
    {
      name:
        "DD-MM-YYYY",

      startDate,

      endDate
    },

    {
      name:
        "YYYY-MM-DD",

      startDate:
        `${yyyy}-${mm}-${dd}`,

      endDate:
        `${yyyy2}-${mm2}-${dd2}`
    },

    {
      name:
        "DD/MM/YYYY",

      startDate:
        `${dd}/${mm}/${yyyy}`,

      endDate:
        `${dd2}/${mm2}/${yyyy2}`
    },

    {
      name:
        "MM/DD/YYYY",

      startDate:
        `${mm}/${dd}/${yyyy}`,

      endDate:
        `${mm2}/${dd2}/${yyyy2}`
    }
  ];

  const sourceUrl =
    "https://www.bi.go.id/biwebservice/wskursbi.asmx/getSubKursJisdor3";

  const results = [];

  for (
    const candidate of candidates
  ) {
    const body =
      `mts=${encodeURIComponent("USD")}` +
      `&startDate=${encodeURIComponent(candidate.startDate)}` +
      `&endDate=${encodeURIComponent(candidate.endDate)}`;

    try {
      const r = await fetch(
        sourceUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded; charset=UTF-8",

            "Accept":
              "text/xml, application/xml",

            "User-Agent":
              "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.13-PROBE"
          },

          body
        }
      );

      const responseBody =
        await r.text();

      results.push({
        format:
          candidate.name,

        startDate:
          candidate.startDate,

        endDate:
          candidate.endDate,

        status_code:
          r.status,

        content_type:
          r.headers.get(
            "content-type"
          ) || "",

        body_bytes:
          new TextEncoder()
            .encode(responseBody)
            .length,

        body_sha256:
          await sha256(
            responseBody
          ),

        has_dataset:
          /<DataSet(?:\s|>)/i
            .test(responseBody),

        has_html:
          /<\s*!doctype\s+html|<\s*html(?:\s|>)/i
            .test(responseBody),

        table_count:
          (
            responseBody.match(
              /<Table(?:\s|>)/gi
            ) || []
          ).length,

        jisdor_field_count:
          (
            responseBody.match(
              /<(?:tgl_subkursjisdor|nilai_subkursjisdor)(?:\s|>)/gi
            ) || []
          ).length
      });

    } catch (e) {
      results.push({
        format:
          candidate.name,

        startDate:
          candidate.startDate,

        endDate:
          candidate.endDate,

        error:
          String(
            e?.message || e
          ).slice(0, 500)
      });
    }
  }

  return jsonResponse({
    ok: true,

    diagnostic_only: true,

    source_id:
      "jisdor",

    dataset_id:
      "JISDOR",

    source_url:
      sourceUrl,

    note:
      "Diagnostic only. Results are not corpus evidence and are not persisted.",

    results
  });
}

async function fetchJisdorBatch(
  u,
  env
) {
  const startDate =
    u.searchParams.get("startDate");

  const endDate =
    u.searchParams.get("endDate");

  if (!startDate || !endDate) {
    return jsonResponse(
      {
        ok: false,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        error:
          "missing_startDate_or_endDate",

        expected:
          "/jisdor?startDate=DD-MM-YYYY&endDate=DD-MM-YYYY"
      },
      400
    );
  }

  if (
    !isValidJisdorDate(startDate) ||
    !isValidJisdorDate(endDate)
  ) {
    return jsonResponse(
      {
        ok: false,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        error:
          "invalid_date_format_or_date",

        expected:
          "DD-MM-YYYY"
      },
      400
    );
  }

  const start =
    jisdorDateToUtc(
      startDate
    );

  const end =
    jisdorDateToUtc(
      endDate
    );

  if (end < start) {
    return jsonResponse(
      {
        ok: false,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        error:
          "end_date_before_start_date"
      },
      400
    );
  }

  const rangeDays =
    Math.floor(
      (end - start) /
      86400000
    );

  if (rangeDays > 366) {
    return jsonResponse(
      {
        ok: false,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        error:
          "date_range_too_large",

        max_days:
          366
      },
      400
    );
  }

  const sourceUrl =
    "https://www.bi.go.id/biwebservice/wskursbi.asmx/getSubKursJisdor3";

  const body =
    `mts=${encodeURIComponent("USD")}` +
    `&startDate=${encodeURIComponent(startDate)}` +
    `&endDate=${encodeURIComponent(endDate)}`;

  const acquiredAt =
    new Date().toISOString();

  try {
    const r = await fetch(
      sourceUrl,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded; charset=UTF-8",

          "Accept":
            "text/xml, application/xml",

          "User-Agent":
            "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.13"
        },

        body
      }
    );

    const responseBody =
      await r.text();

    const bodyBytes =
      new TextEncoder()
        .encode(responseBody)
        .length;

    const bodySha256 =
      await sha256(
        responseBody
      );

    const contentType =
      r.headers.get(
        "content-type"
      ) || "";

    const trimmedBody =
      responseBody.trim();

    const looksLikeXml =
      /^<\?xml[\s\S]*</i
        .test(trimmedBody) ||

      /^<DataSet[\s\S]*</i
        .test(trimmedBody) ||

      /^<soap:Envelope[\s\S]*</i
        .test(trimmedBody);

    const looksLikeHtml =
      /<\s*!doctype\s+html|<\s*html(?:\s|>)/i
        .test(trimmedBody);

    const looksLikeJisdor =
      /<DataSet(?:\s|>)/i
        .test(responseBody) ||

      /<getSubKursJisdor3Response(?:\s|>)/i
        .test(responseBody) ||

      /<(?:Table|tgl_subkursjisdor|nilai_subkursjisdor)(?:\s|>)/i
        .test(responseBody);

    if (
      r.ok &&
      (
        !looksLikeXml ||
        looksLikeHtml ||
        !looksLikeJisdor
      )
    ) {
      return jsonResponse(
        {
          ok: false,

          source_id:
            "jisdor",

          dataset_id:
            "JISDOR",

          source_url:
            sourceUrl,

          status_code:
            r.status,

          acquired_at:
            acquiredAt,

          request_start_date:
            startDate,

          request_end_date:
            endDate,

          request_fingerprint_material:
            {
              url:
                sourceUrl,

              method:
                "POST",

              params:
                {
                  mts:
                    "USD",

                  startDate,

                  endDate
                }
            },

          request_body_sha256:
            await sha256(body),

          body_bytes:
            bodyBytes,

          body_sha256:
            bodySha256,

          content_type:
            contentType,

          error:
            "invalid_jisdor_payload",

          reason:
            looksLikeHtml
              ? "html_payload"

              : !looksLikeXml
                ? "non_xml_payload"

                : "jisdor_structure_not_detected",

          body:
            responseBody.slice(
              0,
              4000
            )
        },
        502
      );
    }

    if (r.status === 429) {
      return jsonResponse(
        {
          ok: false,

          source_id:
            "jisdor",

          dataset_id:
            "JISDOR",

          source_url:
            sourceUrl,

          status_code:
            r.status,

          acquired_at:
            acquiredAt,

          request_start_date:
            startDate,

          request_end_date:
            endDate,

          body_bytes:
            bodyBytes,

          body_sha256:
            bodySha256,

          content_type:
            r.headers.get(
              "content-type"
            ) || "",

          error:
            "upstream_rate_limited",

          body:
            responseBody.slice(
              0,
              2000
            )
        },
        429
      );
    }

    if (r.status >= 500) {
      return jsonResponse(
        {
          ok: false,

          source_id:
            "jisdor",

          dataset_id:
            "JISDOR",

          source_url:
            sourceUrl,

          status_code:
            r.status,

          acquired_at:
            acquiredAt,

          request_start_date:
            startDate,

          request_end_date:
            endDate,

          body_bytes:
            bodyBytes,

          body_sha256:
            bodySha256,

          content_type:
            r.headers.get(
              "content-type"
            ) || "",

          error:
            "upstream_server_error",

          body:
            responseBody.slice(
              0,
              2000
            )
        },
        502
      );
    }

    return jsonResponse(
      {
        ok:
          r.ok,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        source_url:
          sourceUrl,

        status_code:
          r.status,

        acquired_at:
          acquiredAt,

        request_start_date:
          startDate,

        request_end_date:
          endDate,

        request_fingerprint_material:
          {
            url:
              sourceUrl,

            method:
              "POST",

            params:
              {
                mts:
                  "USD",

                startDate,

                endDate
              }
          },

        request_body_sha256:
          await sha256(body),

        body_bytes:
          bodyBytes,

        body_sha256:
          bodySha256,

        content_type:
          contentType,

        body:
          responseBody
      },

      r.ok ? 200 : 502
    );

  } catch (e) {
    return jsonResponse(
      {
        ok: false,

        source_id:
          "jisdor",

        dataset_id:
          "JISDOR",

        source_url:
          sourceUrl,

        acquired_at:
          acquiredAt,

        request_start_date:
          startDate,

        request_end_date:
          endDate,

        error:
          "upstream_fetch_failed",

        detail:
          String(
            e?.message || e
          ).slice(0, 1000)
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
      ok: false,

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
      ok: false,

      reason:
        "unexpected_series_shape"
    };
  }

  if (
    series[0]?.seriesID !==
    expected
  ) {
    return {
      ok: false,

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
      ok: false,

      reason:
        "no_observations"
    };
  }

  const currentYear =
    new Date()
      .getUTCFullYear();

  const monthly =
    data.filter(x =>
      isMonthly(x.period)
    );

  if (
    monthly.length === 0
  ) {
    return {
      ok: false,

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
        ok: false,

        reason:
          "invalid_year"
      };
    }

    if (
      Number(row.year) >
      currentYear
    ) {
      return {
        ok: false,

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
      .filter(row =>
        row.numeric_value !==
        null
      );

  if (
    numericMonthly.length === 0
  ) {
    return {
      ok: false,

      reason:
        "no_numeric_monthly_observations"
    };
  }

  const latestRaw =
    monthly[0];

  const latestNumeric =
    numericMonthly[0];

  return {
    ok: true,

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
        ok: false,

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
            ok: false,

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
            ok: false,

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
        ok: true,

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
      ok: false,

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
          status: 405
        }
      );
    }

    if (
      u.pathname ===
      "/health"
    ) {
      return jsonResponse({
        ok: true,

        service:
          "macro-fuel-relay",

        version:
          "0.2.13"
      });
    }

    if (
      u.pathname ===
      "/jisdor_probe_single"
    ) {
      if (
        env.RELAY_TOKEN &&
        req.headers.get(
          "Authorization"
        ) !==
          `Bearer ${env.RELAY_TOKEN}`
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "unauthorized"
          },
          401
        );
      }

      return probeJisdorSingle(
        u,
        env
      );
    }

    if (
      u.pathname ===
      "/jisdor_probe"
    ) {
      if (
        env.RELAY_TOKEN &&
        req.headers.get(
          "Authorization"
        ) !==
          `Bearer ${env.RELAY_TOKEN}`
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "unauthorized"
          },
          401
        );
      }

      return probeJisdorDateFormats(
        u,
        env
      );
    }

    if (
      u.pathname ===
      "/jisdor"
    ) {
      if (
        env.RELAY_TOKEN &&
        req.headers.get(
          "Authorization"
        ) !==
          `Bearer ${env.RELAY_TOKEN}`
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "unauthorized"
          },
          401
        );
      }

      return fetchJisdorBatch(
        u,
        env
      );
    }

    if (
      u.pathname ===
      "/jisdor_probe_structure"
    ) {
      if (
        env.RELAY_TOKEN &&
        req.headers.get(
          "Authorization"
        ) !==
          `Bearer ${env.RELAY_TOKEN}`
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "unauthorized"
          },
          401
        );
      }

      return probeJisdorStructure(
        u,
        env
      );
    }

    const sourceId =
      ROUTES[u.pathname];

    if (!sourceId) {
      return jsonResponse(
        {
          ok: false,
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
          ok: false,
          error:
            "unauthorized"
        },
        401
      );
    }

    if (
      sourceId === "bls_cpi" ||
      sourceId === "bls_employment"
    ) {
      return fetchBls(
        sourceId,
        env
      );
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
          ok: false,

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