import { isOnOrAfter, toDay, daysBetween, todayLocal } from "../lib/dates.mjs";
import { emptyDay, bumpModel, recomputeTotals } from "../lib/schema.mjs";

async function fetchJson(url, headers, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: headers.Authorization,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * @param {{ since: string }} opts
 */
export async function collectOpenRouter({ since }) {
  const key = process.env.OPENROUTER_API_KEY;
  const meta = { source: "openrouter", ok: false, skipped: false };
  const days = {};

  if (!key) {
    meta.skipped = true;
    meta.reason = "OPENROUTER_API_KEY not set";
    return { days, meta };
  }

  const headers = { Authorization: `Bearer ${key}` };
  const end = todayLocal();

  try {
    // Credits snapshot (lifetime totals — stored on end day for visibility)
    try {
      const credits = await fetchJson(
        "https://openrouter.ai/api/v1/credits",
        headers
      );
      meta.credits = credits?.data || credits;
    } catch (e) {
      meta.creditsError = e.message;
    }

    // Analytics by day + model when management key allows it
    let analyticsOk = false;
    try {
      const analytics = await fetchJson(
        "https://openrouter.ai/api/v1/analytics/query",
        headers,
        {
          metrics: ["prompt_tokens", "completion_tokens", "cost", "request_count"],
          dimensions: ["model"],
          granularity: "day",
          time_range: {
            start: `${since}T00:00:00Z`,
            end: `${end}T23:59:59Z`,
          },
          limit: 5000,
        }
      );
      const rows = analytics?.data?.data || analytics?.data || [];
      if (Array.isArray(rows)) {
        analyticsOk = true;
        for (const row of rows) {
          const day =
            toDay(row.date__day || row.date || row.day || row.timestamp) ||
            null;
          if (!day || !isOnOrAfter(day, since)) continue;
          const input = Number(row.prompt_tokens || row.tokens_prompt || 0);
          const output = Number(
            row.completion_tokens || row.tokens_completion || 0
          );
          const costUsd = Number(row.cost || row.total_cost || 0);
          const requests = Number(row.request_count || row.requests || 0);
          const model = row.model || "unknown";
          if (!days[day]) days[day] = emptyDay(day);
          const src = days[day].sources.openrouter;
          src.input += input;
          src.output += output;
          src.total += input + output;
          src.tokens += input + output;
          src.costUsd += costUsd;
          src.requests += requests || (input || output ? 1 : 0);
          bumpModel(src.byModel, model, {
            input,
            output,
            total: input + output,
            tokens: input + output,
            costUsd,
            requests: requests || 1,
          });
          recomputeTotals(days[day]);
        }
      }
    } catch (e) {
      meta.analyticsError = e.message;
    }

    // Fallback: if no daily analytics, stamp credit usage on today only as note
    if (!analyticsOk && meta.credits?.total_usage != null) {
      const day = end;
      if (!days[day]) days[day] = emptyDay(day);
      days[day].sources.openrouter.costUsd = Number(meta.credits.total_usage) || 0;
      days[day].sources.openrouter.byModel["_credits_lifetime"] = {
        costUsd: Number(meta.credits.total_usage) || 0,
        tokens: 0,
        requests: 0,
        input: 0,
        output: 0,
        total: 0,
      };
      recomputeTotals(days[day]);
      meta.note =
        "Analytics unavailable; stored lifetime credit usage on today only. Prefer a management key for daily tokens.";
    }

    meta.ok = true;
    meta.days = Object.keys(days).length;
  } catch (e) {
    meta.ok = false;
    meta.reason = e.message;
  }

  return { days, meta };
}
