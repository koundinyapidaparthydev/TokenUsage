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
    // Key metadata + spend windows (works with normal API keys)
    try {
      const keyInfo = await fetchJson("https://openrouter.ai/api/v1/key", headers);
      meta.key = {
        isManagementKey: !!keyInfo?.data?.is_management_key,
        isFreeTier: !!keyInfo?.data?.is_free_tier,
        usage: keyInfo?.data?.usage ?? 0,
        usageDaily: keyInfo?.data?.usage_daily ?? 0,
        usageWeekly: keyInfo?.data?.usage_weekly ?? 0,
        usageMonthly: keyInfo?.data?.usage_monthly ?? 0,
        expiresAt: keyInfo?.data?.expires_at,
      };
    } catch (e) {
      meta.keyError = e.message;
    }

    // Credits snapshot
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

    // Fallback for normal API keys: store spend windows on today
    if (!analyticsOk && meta.key) {
      const day = end;
      if (!days[day]) days[day] = emptyDay(day);
      const src = days[day].sources.openrouter;
      const daily = Number(meta.key.usageDaily) || 0;
      const lifetime =
        Number(meta.credits?.total_usage) || Number(meta.key.usage) || 0;
      src.costUsd = daily || lifetime;
      bumpModel(src.byModel, "_key_usage_daily", {
        costUsd: daily,
        tokens: 0,
        requests: 0,
        input: 0,
        output: 0,
        total: 0,
      });
      bumpModel(src.byModel, "_key_usage_lifetime", {
        costUsd: lifetime,
        tokens: 0,
        requests: 0,
        input: 0,
        output: 0,
        total: 0,
      });
      recomputeTotals(days[day]);
      meta.note =
        "Normal API key: daily model/token analytics need a management key. Stored spend from /api/v1/key + /credits.";
    }

    meta.ok = true;
    meta.days = Object.keys(days).length;
  } catch (e) {
    meta.ok = false;
    meta.reason = e.message;
  }

  return { days, meta };
}
