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

function cookieValue(raw) {
  let t = (raw || "").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1);
  }
  // Accept raw JWT or userId::jwt / userId%3A%3Ajwt
  if (!t.includes("WorkosCursorSessionToken=")) {
    return t;
  }
  const m = t.match(/WorkosCursorSessionToken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : t;
}

function addEvent(days, since, day, model, input, output, cacheRead, cacheWrite, costUsd) {
  if (!day || !isOnOrAfter(day, since)) return;
  if (!days[day]) days[day] = emptyDay(day);
  const src = days[day].sources.cursor;
  const total = input + output + cacheRead + cacheWrite;
  src.input += input;
  src.output += output;
  src.cacheRead = (src.cacheRead || 0) + cacheRead;
  src.cacheWrite = (src.cacheWrite || 0) + cacheWrite;
  src.total += total;
  src.tokens += total;
  src.costUsd += costUsd;
  src.requests += 1;
  bumpModel(src.byModel, model || "unknown", {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    tokens: total,
    costUsd,
    requests: 1,
  });
  recomputeTotals(days[day]);
}

async function collectFromSession({ since }) {
  const raw = process.env.CURSOR_SESSION_TOKEN;
  const meta = { source: "cursor", mode: "session", ok: false, skipped: false };
  const days = {};

  if (!raw) {
    meta.skipped = true;
    meta.reason = "CURSOR_SESSION_TOKEN not set";
    return { days, meta };
  }

  const token = cookieValue(raw);
  const startMs = String(Date.parse(`${since}T00:00:00`));
  const endMs = String(Date.now());
  let page = 1;
  let totalEvents = 0;
  const pageSize = 100;

  try {
    while (page <= 50) {
      const res = await fetch(
        "https://cursor.com/api/dashboard/get-filtered-usage-events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://cursor.com",
            Referer: "https://cursor.com/dashboard/usage",
            Cookie: `WorkosCursorSessionToken=${token}`,
          },
          body: JSON.stringify({
            page,
            pageSize,
            startDate: startMs,
            endDate: endMs,
          }),
        }
      );
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      if (!res.ok) {
        meta.reason = `Cursor dashboard ${res.status}: ${text.slice(0, 180)}`;
        return { days, meta };
      }

      const events = json.usageEventsDisplay || json.usageEvents || [];
      totalEvents = Number(json.totalUsageEventsCount || totalEvents);
      if (!Array.isArray(events) || !events.length) break;

      for (const ev of events) {
        const day = toDay(Number(ev.timestamp) || ev.timestamp);
        const tu = ev.tokenUsage || {};
        const input = num(tu.inputTokens);
        const output = num(tu.outputTokens);
        const cacheRead = num(tu.cacheReadTokens);
        const cacheWrite = num(tu.cacheWriteTokens);
        const costUsd =
          num(ev.chargedCents, tu.totalCents) / 100 ||
          num(String(ev.usageBasedCosts || "").replace(/[^0-9.]/g, ""));
        addEvent(
          days,
          since,
          day,
          ev.model,
          input,
          output,
          cacheRead,
          cacheWrite,
          costUsd
        );
      }

      if (page * pageSize >= totalEvents || events.length < pageSize) break;
      page += 1;
    }

    meta.ok = true;
    meta.events = totalEvents;
    meta.days = Object.keys(days).length;
    meta.pages = page;
  } catch (e) {
    meta.ok = false;
    meta.reason = e.message;
  }

  return { days, meta };
}

async function collectFromCsv({ since }) {
  const dir = resolve(repoRoot(), "data/imports/cursor");
  const meta = { source: "cursor", mode: "csv", ok: false, skipped: false, files: [] };
  const days = {};

  if (!existsSync(dir)) {
    meta.skipped = true;
    meta.reason = "No cursor import directory";
    return { days, meta };
  }

  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (!files.length) {
    meta.skipped = true;
    meta.reason = "No CSV files in data/imports/cursor";
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
      const day =
        toDay(dateRaw) || (dateRaw.match?.(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
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
      addEvent(days, since, day, model, input, output || Math.max(0, total - input), 0, 0, 0);
    }
  }

  meta.ok = true;
  meta.days = Object.keys(days).length;
  return { days, meta };
}

/**
 * Prefer dashboard session token; fall back to CSV imports.
 * @param {{ since: string }} opts
 */
export async function collectCursor({ since }) {
  if (process.env.CURSOR_SESSION_TOKEN) {
    const session = await collectFromSession({ since });
    if (session.meta.ok || !session.meta.skipped) return session;
  }
  return collectFromCsv({ since });
}
