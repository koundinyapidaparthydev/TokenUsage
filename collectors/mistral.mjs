import { isOnOrAfter, todayLocal } from "../lib/dates.mjs";
import { emptyDay, bumpModel, recomputeTotals } from "../lib/schema.mjs";

/**
 * Walk nested Mistral usage structures and pull token-ish numbers.
 */
function walkUsage(node, path = [], acc = []) {
  if (node == null) return acc;
  if (Array.isArray(node)) {
    for (const item of node) walkUsage(item, path, acc);
    return acc;
  }
  if (typeof node !== "object") return acc;

  const keys = Object.keys(node);
  if (
    keys.some((k) =>
      /token|prompt|completion|input|output|cost|amount|requests?/i.test(k)
    )
  ) {
    acc.push({ path: path.join("."), value: node });
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "object") walkUsage(v, [...path, k], acc);
  }
  return acc;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {{ since: string }} opts
 */
export async function collectMistral({ since }) {
  const key = process.env.MISTRAL_ADMIN_API_KEY || process.env.MISTRAL_API_KEY;
  const meta = { source: "mistral", ok: false, skipped: false };
  const days = {};

  if (!key) {
    meta.skipped = true;
    meta.reason = "MISTRAL_ADMIN_API_KEY not set";
    return { days, meta };
  }

  const now = new Date();
  const months = [];
  const sinceDate = new Date(`${since}T00:00:00Z`);
  let cursor = new Date(
    Date.UTC(sinceDate.getUTCFullYear(), sinceDate.getUTCMonth(), 1)
  );
  const endMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor <= endMonth) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  try {
    for (const { year, month } of months) {
      const url = `https://api.mistral.ai/v1/admin/usage?month=${month}&year=${year}`;
      const res = await fetch(url, {
        headers: { "x-api-key": key, Authorization: `Bearer ${key}` },
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      if (!res.ok) {
        meta.reason = `Mistral ${res.status}: ${text.slice(0, 200)}`;
        continue;
      }

      // Prefer explicit date field; else attribute month total to period end or today
      const periodEnd =
        (json.end_date && String(json.end_date).slice(0, 10)) ||
        (json.date && String(json.date).slice(0, 10)) ||
        todayLocal();

      const completion = json.completion || json.chat || {};
      // Structure varies; try common shapes
      const models =
        completion?.tokens?.models ||
        completion?.models ||
        json?.completion?.tokens?.models ||
        null;

      let input = 0;
      let output = 0;
      let costUsd = 0;
      let requests = 0;
      const byModelPatches = [];

      if (Array.isArray(models)) {
        // Deep nested arrays from Mistral admin API — flatten numbers heuristically
        const flat = JSON.stringify(models);
        // Fallback: use prices / known cost fields
      }

      costUsd += num(json.amount) + num(json.total_cost) + num(json.cost);

      // Extract from completion token buckets if present as simple objects
      const tryExtractModelMap = (obj, modelName = "unknown") => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const item of obj) tryExtractModelMap(item, modelName);
          return;
        }
        const maybeModel = obj.model || obj.model_id || obj.name || modelName;
        const inp = num(obj.input_tokens ?? obj.prompt_tokens ?? obj.input);
        const out = num(obj.output_tokens ?? obj.completion_tokens ?? obj.output);
        const tok = num(obj.tokens) || inp + out;
        const c = num(obj.cost ?? obj.amount);
        const r = num(obj.requests ?? obj.count);
        if (inp || out || tok || c || r) {
          input += inp;
          output += out || Math.max(0, tok - inp);
          costUsd += c;
          requests += r;
          byModelPatches.push({
            model: String(maybeModel),
            input: inp,
            output: out || Math.max(0, tok - inp),
            tokens: tok || inp + out,
            total: tok || inp + out,
            costUsd: c,
            requests: r || 1,
          });
        } else {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "object") tryExtractModelMap(v, k);
          }
        }
      };

      tryExtractModelMap(completion);
      tryExtractModelMap(json.chat);

      // If still empty, scan for any token fields and dump onto a single bucket day
      if (!input && !output && !costUsd) {
        const leaves = walkUsage(json);
        for (const leaf of leaves) {
          const v = leaf.value;
          input += num(v.input_tokens ?? v.prompt_tokens ?? v.input);
          output += num(v.output_tokens ?? v.completion_tokens ?? v.output);
          costUsd += num(v.cost ?? v.amount);
          requests += num(v.requests);
        }
      }

      const day = isOnOrAfter(periodEnd, since) ? periodEnd : since;
      if (!isOnOrAfter(day, since)) continue;

      if (!days[day]) days[day] = emptyDay(day);
      const src = days[day].sources.mistral;
      src.input += input;
      src.output += output;
      src.total += input + output;
      src.tokens += input + output;
      src.costUsd += costUsd;
      src.requests += requests;
      if (byModelPatches.length) {
        for (const p of byModelPatches) {
          bumpModel(src.byModel, p.model, p);
        }
      } else if (input || output || costUsd) {
        bumpModel(src.byModel, `mistral-${year}-${month}`, {
          input,
          output,
          tokens: input + output,
          total: input + output,
          costUsd,
          requests: requests || 1,
        });
      }
      recomputeTotals(days[day]);
      meta.rawSample = meta.rawSample || Object.keys(json);
    }

    meta.ok = true;
    meta.days = Object.keys(days).length;
  } catch (e) {
    meta.ok = false;
    meta.reason = e.message;
  }

  return { days, meta };
}
