import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expandHome } from "../lib/env.mjs";
import { toDay, isOnOrAfter } from "../lib/dates.mjs";
import { emptySource, bumpModel, recomputeTotals, emptyDay } from "../lib/schema.mjs";

function defaultDbPath() {
  return resolve(homedir(), ".local/share/opencode/opencode.db");
}

function parseTokens(data) {
  try {
    const obj = typeof data === "string" ? JSON.parse(data) : data;
    const tokens = obj?.tokens;
    if (!tokens) return null;
    const input = Number(tokens.input || 0);
    const output = Number(tokens.output || 0);
    const reasoning = Number(tokens.reasoning || 0);
    const cacheRead = Number(tokens.cache?.read || 0);
    const cacheWrite = Number(tokens.cache?.write || 0);
    const total =
      Number(tokens.total) ||
      input + output + reasoning + cacheRead + cacheWrite;
    const costUsd = Number(obj.cost ?? obj.costUsd ?? 0) || 0;
    const model =
      obj.model?.modelID ||
      obj.model?.id ||
      obj.modelID ||
      [obj.model?.providerID, obj.model?.modelID].filter(Boolean).join("/") ||
      "unknown";
    return {
      input,
      output: output + reasoning,
      cacheRead,
      cacheWrite,
      total,
      tokens: total,
      costUsd,
      model,
      requests: 1,
    };
  } catch {
    return null;
  }
}

/**
 * @param {{ since: string }} opts
 * @returns {Promise<{ days: Record<string, object>, meta: object }>}
 */
export async function collectOpenCode({ since }) {
  const dbPath = expandHome(process.env.OPENCODE_DB) || defaultDbPath();
  const meta = { source: "opencode", dbPath, ok: false, skipped: false };

  if (!existsSync(dbPath)) {
    meta.skipped = true;
    meta.reason = `OpenCode DB not found at ${dbPath}`;
    return { days: {}, meta };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const days = {};

  try {
    const rows = db
      .prepare(
        `SELECT time_created, data FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL`
      )
      .all();

    for (const row of rows) {
      const day = toDay(row.time_created);
      if (!day || !isOnOrAfter(day, since)) continue;
      const parsed = parseTokens(row.data);
      if (!parsed) continue;

      if (!days[day]) days[day] = emptyDay(day);
      const src = days[day].sources.opencode;
      src.input += parsed.input;
      src.output += parsed.output;
      src.cacheRead += parsed.cacheRead;
      src.cacheWrite += parsed.cacheWrite;
      src.total += parsed.total;
      src.tokens += parsed.tokens;
      src.costUsd += parsed.costUsd;
      src.requests += 1;
      bumpModel(src.byModel, parsed.model, {
        input: parsed.input,
        output: parsed.output,
        cacheRead: parsed.cacheRead,
        cacheWrite: parsed.cacheWrite,
        total: parsed.total,
        tokens: parsed.tokens,
        costUsd: parsed.costUsd,
        requests: 1,
      });
      recomputeTotals(days[day]);
    }

    meta.ok = true;
    meta.messages = rows.length;
    meta.days = Object.keys(days).length;
  } finally {
    db.close();
  }

  return { days, meta };
}
