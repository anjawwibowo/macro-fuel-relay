/**
 * TRADER SOTOY Macro Lab — JISDOR relay
 * Cloudflare Worker
 *
 * GET /jisdor?startDate=01-01-2025&endDate=31-01-2025
 *
 * Proxies the official Bank Indonesia getSubKursJisdor3 SOAP operation.
 * Returns the exact BI XML response body.
 */

const BI_URL = "https://www.bi.go.id/biwebservice/wskursbi.asmx";
const ALLOWED_ORIGIN = "*";
const MAX_RANGE_DAYS = 366;

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

function parseDateDDMMYYYY(value) {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(value)) return null;

  const [dd, mm, yyyy] = value.split("-").map(Number);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));

  if (
    d.getUTCFullYear() !== yyyy ||
    d.getUTCMonth() !== mm - 1 ||
    d.getUTCDate() !== dd
  ) {
    return null;
  }

  return d;
}

function soapBody(startDate, endDate) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>` +
    `<getSubKursJisdor3 xmlns="http://tempuri.org/">` +
    `<mts>USD</mts>` +
    `<startDate>${startDate}</startDate>` +
    `<endDate>${endDate}</endDate>` +
    `</getSubKursJisdor3>` +
    `</soap:Body>` +
    `</soap:Envelope>`
  );
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const url = new URL(request.url);

    if (request.method !== "GET" || url.pathname !== "/jisdor") {
      return json(
        {
          ok: false,
          error: "NOT_FOUND",
          usage:
            "/jisdor?startDate=DD-MM-YYYY&endDate=DD-MM-YYYY",
        },
        404
      );
    }

    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");

    if (!startDate || !endDate) {
      return json(
        {
          ok: false,
          error: "MISSING_DATE",
          required: ["startDate", "endDate"],
          format: "DD-MM-YYYY",
        },
        400
      );
    }

    const start = parseDateDDMMYYYY(startDate);
    const end = parseDateDDMMYYYY(endDate);

    if (!start || !end) {
      return json(
        {
          ok: false,
          error: "INVALID_DATE",
          format: "DD-MM-YYYY",
        },
        400
      );
    }

    if (start > end) {
      return json(
        {
          ok: false,
          error: "INVALID_DATE_RANGE",
        },
        400
      );
    }

    const spanDays =
      Math.floor((end - start) / 86400000) + 1;

    if (spanDays > MAX_RANGE_DAYS) {
      return json(
        {
          ok: false,
          error: "DATE_RANGE_TOO_LARGE",
          max_days: MAX_RANGE_DAYS,
        },
        400
      );
    }

    const body = soapBody(startDate, endDate);

    let upstream;

    try {
      upstream = await fetch(BI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction":
            '"http://tempuri.org/getSubKursJisdor3"',
          "User-Agent":
            "TRADER-SOTOY-Macro-Lab-JISDOR-Relay/1",
        },
        body,
      });
    } catch (err) {
      return json(
        {
          ok: false,
          error: "UPSTREAM_NETWORK_ERROR",
          detail: String(err?.message || err),
        },
        502
      );
    }

    const responseBody = await upstream.arrayBuffer();

    if (!upstream.ok) {
      return new Response(responseBody, {
        status: 502,
        headers: corsHeaders({
          "Content-Type":
            upstream.headers.get("content-type") ||
            "text/xml; charset=utf-8",
          "X-Upstream-Status": String(upstream.status),
          "X-Source": "Bank-Indonesia",
        }),
      });
    }

    return new Response(responseBody, {
      status: 200,
      headers: corsHeaders({
        "Content-Type":
          upstream.headers.get("content-type") ||
          "text/xml; charset=utf-8",
        "X-Upstream-Status": String(upstream.status),
        "X-Source": "Bank-Indonesia",
        "X-JISDOR-Operation": "getSubKursJisdor3",
        "X-JISDOR-StartDate": startDate,
        "X-JISDOR-EndDate": endDate,
      }),
    });
  },
};