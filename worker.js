// worker.js — MACRO FUEL RELAY v0.2.16
// JISDOR FINAL DIAGNOSTIC MATRIX
//
// Diagnostic routes:
//   /jisdor_probe
//   /jisdor_probe_structure
//   /jisdor_probe_single
//   /jisdor_probe_matrix
//
// No diagnostic route persists corpus evidence.

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
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getSubKursJisdor3
      xmlns="http://tempuri.org/">
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

async function probeJisdor2Matrix(
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

        operation:
          "getSubKursJisdor2",

        error:
          "invalid_date",

        expected:
          "DD-MM-YYYY"
      },
      400
    );
  }

  const [
    dd,
    mm,
    yyyy
  ] = date.split("-");

  const variants = [
    {
      name:
        "DD-MM-YYYY",

      value:
        date
    },

    {
      name:
        "DD/MM/YYYY",

      value:
        `${dd}/${mm}/${yyyy}`
    },

    {
      name:
        "MM/DD/YYYY",

      value:
        `${mm}/${dd}/${yyyy}`
    },

    {
      name:
        "YYYY-MM-DD",

      value:
        `${yyyy}-${mm}-${dd}`
    },

    {
      name:
        "YYYYMMDD",

      value:
        `${yyyy}${mm}${dd}`
    },

    {
      name:
        "DD.MM.YYYY",

      value:
        `${dd}.${mm}.${yyyy}`
    }
  ];

  const endpoint =
    "https://www.bi.go.id/biwebservice/wskursbi.asmx/getSubKursJisdor2";

  const results = [];

  /*
   * --------------------------------------------------
   * TEST 1 — HTTP POST form-urlencoded
   * --------------------------------------------------
   */

  for (const v of variants) {
    try {
      const body =
        `tgl=${encodeURIComponent(v.value)}`;

      const r = await fetch(
        endpoint,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded; charset=UTF-8",

            "Accept":
              "text/xml, application/xml",

            "User-Agent":
              "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.16-JISDOR-MATRIX"
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

      results.push({
        format:
          v.name,

        transport:
          "POST_FORM",

        parameter: {
          tgl:
            v.value
        },

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
          inspection.table_count,

        schema_element_names:
          inspection.schema_element_names,

        sample_tables:
          inspection.tables.slice(
            0,
            3
          )
      });

    } catch (e) {
      results.push({
        format:
          v.name,

        transport:
          "POST_FORM",

        parameter: {
          tgl:
            v.value
        },

        error:
          String(
            e?.message || e
          ).slice(0, 500)
      });
    }

    /*
     * --------------------------------------------------
     * TEST 2 — HTTP GET
     * --------------------------------------------------
     */

    try {
      const getUrl =
        `${endpoint}?tgl=${encodeURIComponent(v.value)}`;

      const r = await fetch(
        getUrl,
        {
          method:
            "GET",

          headers: {
            "Accept":
              "text/xml, application/xml",

            "User-Agent":
              "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.16-JISDOR-MATRIX"
          }
        }
      );

      const responseBody =
        await r.text();

      const inspection =
        inspectJisdorXml(
          responseBody
        );

      results.push({
        format:
          v.name,

        transport:
          "GET",

        parameter: {
          tgl:
            v.value
        },

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
          inspection.table_count,

        schema_element_names:
          inspection.schema_element_names,

        sample_tables:
          inspection.tables.slice(
            0,
            3
          )
      });

    } catch (e) {
      results.push({
        format:
          v.name,

        transport:
          "GET",

        parameter: {
          tgl:
            v.value
        },

        error:
          String(
            e?.message || e
          ).slice(0, 500)
      });
    }
  }

  /*
   * --------------------------------------------------
   * TEST 3 — SOAP 1.1
   * --------------------------------------------------
   */

  try {
    const soapEndpoint =
      "https://www.bi.go.id/biwebservice/wskursbi.asmx";

    const soapBody =
`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getSubKursJisdor2
      xmlns="http://tempuri.org/">
      <tgl>${date}</tgl>
    </getSubKursJisdor2>
  </soap:Body>
</soap:Envelope>`.trim();

    const r = await fetch(
      soapEndpoint,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "text/xml; charset=utf-8",

          "SOAPAction":
            "\"http://tempuri.org/getSubKursJisdor2\"",

          "Accept":
            "text/xml, application/xml",

          "User-Agent":
            "TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.16-JISDOR-MATRIX"
        },

        body:
          soapBody
      }
    );

    const responseBody =
      await r.text();

    const inspection =
      inspectJisdorXml(
        responseBody
      );

    results.push({
      format:
        "DD-MM-YYYY",

      transport:
        "SOAP_1_1",

      parameter: {
        tgl:
          date
      },

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
        inspection.table_count,

      schema_element_names:
        inspection.schema_element_names,

      sample_tables:
        inspection.tables.slice(
          0,
          3
        )
    });

  } catch (e) {
    results.push({
      format:
        "DD-MM-YYYY",

      transport:
        "SOAP_1_1",

      error:
        String(
          e?.message || e
        ).slice(0, 500)
    });
  }

  const hits =
    results.filter(
      x =>
        x.status_code === 200 &&
        x.table_count > 0
    );

  return jsonResponse({
    ok:
      true,

    diagnostic_only:
      true,

    source_id:
      "jisdor",

    dataset_id:
      "JISDOR",

    operation:
      "getSubKursJisdor2",

    date,

    note:
      "Final diagnostic matrix. No corpus persistence.",

    tested_formats:
      variants.map(
        x => x.name
      ),

    tested_transports: [
      "POST_FORM",
      "GET",
      "SOAP_1_1"
    ],

    successful_row_candidates:
      hits.length,

    conclusion_hint:
      hits.length > 0
        ? "DATA_FOUND — inspect matching result."
        : "NO_ROWS_FOUND_ACROSS_MATRIX",

    results
  });
}

async function fetchJisdorBatch(
  u,
  env
) {
  const startDate =
    u.searchParams.get(
      "startDate"
    );

  const endDate =
    u.searchParams.get(
      "endDate"
    );

  if (!startDate || !endDate) {
    return jsonResponse(
      {
        ok:
          false,

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
    !isValidJisdorDate(
      startDate
    ) ||
    !isValidJisdorDate(
      endDate
    )
  ) {
    return jsonResponse(
      {
        ok:
          false,

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
   