import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../lib/env.mjs";
import { toDay, isOnOrAfter } from "../lib/dates.mjs";
import { emptyDay, bumpModel, recomputeTotals } from "../lib/schema.mjs";

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(String(v).replace(/[$,]/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function pick(row, ...keys) {
  for (const k of keys) {
    const found = Object.keys(row).find((h) => h === k || h.includes(k));
    if (found && row[found] !== "") return row[found];
  }
  return "";
}

/**
 * @param {{ since: string }} opts
 */
export async function collectCursor({ since }) {
  const dir = resolve(repoRoot(), "data/imports/cursor");
  const meta = { source: "cursor", dir, ok: false, skipped: false, files: [] };
  const days = {};

  if (!existsSync(dir)) {
    meta.skipped = true;
    meta.reason = "No cursor import directory";
    return { days, meta };
  }

  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (!files.length) {
    meta.skipped = true;
    meta.reason = "No CSV files in data/imports/cursor (drop Dashboard Usage exports here)";
    return { days, meta };
  }

  for (const file of files) {
    meta.files.push(file);
    const rows = parseCsv(readFileSync(resolve(dir, file), "utf8"));
    for (const row of rows) {
      const dateRaw = pick(
        row,
        "date",
        "timestamp",
        "created at",
        "created_at",
        "time",
        "day"
      );
      const day = toDay(dateRaw) || (dateRaw.match?.(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
      if (!day || !isOnOrAfter(day, since)) continue;

      const input = num(
        pick(row, "input tokens", "input_tokens", "prompt tokens", "prompt_tokens"),
        pick(row, "input")
      );
      const output = num(
        pick(row, "output tokens", "output_tokens", "completion tokens", "completion_tokens"),
        pick(row, "output")
      );
      const total = num(
        pick(row, "total tokens", "total_tokens", "tokens"),
        input + output
      );
      const model = pick(row, "model", "model name", "model_name") || "unknown";

      if (!days[day]) days[day] = emptyDay(day);
      const src = days[day].sources.cursor;
      src.input += input;
      src.output += output;
      src.total += total || input + output;
      src.tokens += total || input + output;
      src.requests += 1;
      bumpModel(src.byModel, model, {
        input,
        output,
        total: total || input + output,
        tokens: total || input + output,
        requests: 1,
      });
      recomputeTotals(days[day]);
    }
  }

  meta.ok = true;
  meta.days = Object.keys(days).length;
  return { days, meta };
}
