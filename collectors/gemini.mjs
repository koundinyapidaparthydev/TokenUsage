import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { expandHome } from "../lib/env.mjs";
import { toDay, isOnOrAfter, todayLocal } from "../lib/dates.mjs";
import { emptyDay, bumpModel, recomputeTotals } from "../lib/schema.mjs";

function loadServiceAccount() {
  const p = expandHome(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/monitoring.read",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign
    .sign(sa.private_key)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`GCP token: ${JSON.stringify(json)}`);
  return json.access_token;
}

/**
 * @param {{ since: string }} opts
 */
export async function collectGemini({ since }) {
  const meta = { source: "gemini", ok: false, skipped: false };
  const days = {};
  const projectId =
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "653669929081";

  // Optional API key health check (does not provide usage history)
  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
      );
      meta.apiKeyOk = r.ok;
      if (!r.ok) meta.apiKeyStatus = r.status;
    } catch (e) {
      meta.apiKeyOk = false;
      meta.apiKeyError = e.message;
    }
  }

  const sa = loadServiceAccount();
  if (!sa) {
    meta.skipped = true;
    meta.reason =
      "GOOGLE_APPLICATION_CREDENTIALS not set — Gemini API key alone cannot read usage. Add a GCP SA with Monitoring Viewer.";
    return { days, meta };
  }

  try {
    const token = await getAccessToken(sa);
    const end = new Date();
    const start = new Date(`${since}T00:00:00Z`);
    const interval = {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    };

    const filters = [
      'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.labels.service="generativelanguage.googleapis.com"',
      'metric.type="serviceruntime.googleapis.com/quota/allocation/usage" AND resource.labels.service="generativelanguage.googleapis.com"',
      'metric.type="generativeai.googleapis.com/request_count"',
    ];

    for (const filter of filters) {
      const url = new URL(
        `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries`
      );
      url.searchParams.set("filter", filter);
      url.searchParams.set("interval.startTime", interval.startTime);
      url.searchParams.set("interval.endTime", interval.endTime);
      url.searchParams.set("aggregation.alignmentPeriod", "86400s");
      url.searchParams.set(
        "aggregation.perSeriesAligner",
        "ALIGN_SUM"
      );
      url.searchParams.set("aggregation.crossSeriesReducer", "REDUCE_SUM");
      url.searchParams.set("aggregation.groupByFields", "resource.labels.method");

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) {
        meta.errors = meta.errors || [];
        meta.errors.push({ filter, status: res.status, error: json.error?.message });
        continue;
      }

      for (const series of json.timeSeries || []) {
        const method =
          series.resource?.labels?.method ||
          series.metric?.labels?.method ||
          "gemini";
        for (const point of series.points || []) {
          const day =
            toDay(point.interval?.endTime || point.interval?.startTime) ||
            null;
          if (!day || !isOnOrAfter(day, since)) continue;
          const value =
            Number(point.value?.int64Value ?? point.value?.doubleValue ?? 0) ||
            0;
          if (!value) continue;
          if (!days[day]) days[day] = emptyDay(day);
          const src = days[day].sources.gemini;
          src.requests += value;
          src.tokens = src.tokens || null;
          bumpModel(src.byModel, method, { requests: value });
          recomputeTotals(days[day]);
        }
      }
    }

    meta.ok = true;
    meta.projectId = projectId;
    meta.days = Object.keys(days).length;
    if (!Object.keys(days).length) {
      meta.note =
        "No Monitoring time series found yet. Ensure Generative Language API is enabled and the SA can read Monitoring.";
    }
  } catch (e) {
    meta.ok = false;
    meta.reason = e.message;
  }

  return { days, meta };
}
