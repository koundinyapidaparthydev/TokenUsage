export const SOURCES = ["opencode", "cursor", "gemini"];

export function emptySource() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    tokens: 0,
    requests: 0,
    costUsd: 0,
    byModel: {},
  };
}

export function emptyDay(date) {
  const sources = Object.fromEntries(SOURCES.map((s) => [s, emptySource()]));
  return {
    date,
    sources,
    totals: { tokens: 0, costUsd: 0, requests: 0 },
  };
}

export function bumpModel(byModel, model, patch) {
  const key = model || "unknown";
  if (!byModel[key]) {
    byModel[key] = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      tokens: 0,
      requests: 0,
      costUsd: 0,
    };
  }
  const row = byModel[key];
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "number") row[k] = (row[k] || 0) + v;
  }
}

export function mergeSource(target, patch) {
  for (const k of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
    "tokens",
    "requests",
    "costUsd",
  ]) {
    if (typeof patch[k] === "number") target[k] = (target[k] || 0) + patch[k];
  }
  if (patch.byModel) {
    for (const [model, stats] of Object.entries(patch.byModel)) {
      bumpModel(target.byModel, model, stats);
    }
  }
}

export function recomputeTotals(day) {
  let tokens = 0;
  let costUsd = 0;
  let requests = 0;
  for (const name of SOURCES) {
    const src = day.sources?.[name];
    if (!src) continue;
    const t =
      src.tokens ||
      src.total ||
      (src.input || 0) +
        (src.output || 0) +
        (src.cacheRead || 0) +
        (src.cacheWrite || 0);
    tokens += t;
    costUsd += src.costUsd || 0;
    requests += src.requests || 0;
  }
  day.totals = { tokens, costUsd, requests };
  return day;
}

export function sourceTokens(src) {
  if (!src) return 0;
  if (src.tokens) return src.tokens;
  if (src.total) return src.total;
  return (
    (src.input || 0) +
    (src.output || 0) +
    (src.cacheRead || 0) +
    (src.cacheWrite || 0)
  );
}
