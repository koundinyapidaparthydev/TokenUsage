#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnv, repoRoot, sinceDate } from "../lib/env.mjs";
import { todayLocal, daysBetween } from "../lib/dates.mjs";
import {
  SOURCES,
  emptyDay,
  recomputeTotals,
  sourceTokens,
} from "../lib/schema.mjs";
import { collectOpenCode } from "../collectors/opencode.mjs";
import { collectCursor } from "../collectors/cursor.mjs";
import { collectGemini } from "../collectors/gemini.mjs";

loadEnv();

const args = new Set(process.argv.slice(2));
const doPush = args.has("--push");
const since = sinceDate();
const today = todayLocal();
const root = repoRoot();
const dailyDir = resolve(root, "data/daily");
const dataDir = resolve(root, "data");

mkdirSync(dailyDir, { recursive: true });
mkdirSync(resolve(root, "data/imports/cursor"), { recursive: true });

function loadExistingDays() {
  const map = {};
  if (!existsSync(dailyDir)) return map;
  for (const f of readdirSync(dailyDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const day = JSON.parse(readFileSync(resolve(dailyDir, f), "utf8"));
      if (day?.date) map[day.date] = day;
    } catch {
      /* skip */
    }
  }
  return map;
}

function pruneSources(day) {
  const next = emptyDay(day.date);
  for (const name of SOURCES) {
    if (day.sources?.[name]) next.sources[name] = day.sources[name];
  }
  return recomputeTotals(next);
}

function mergeCollectorDays(base, incoming, sourceName) {
  for (const [date, day] of Object.entries(incoming)) {
    if (!base[date]) base[date] = emptyDay(date);
    // Replace this source's slice from collector (idempotent re-sync)
    base[date].sources[sourceName] = day.sources[sourceName];
    base[date] = pruneSources(base[date]);
  }
}

const collectors = [
  ["opencode", collectOpenCode],
  ["cursor", collectCursor],
  ["gemini", collectGemini],
];

const metas = [];
const merged = loadExistingDays();

// Ensure skeleton days from since..today exist
for (const d of daysBetween(since, today)) {
  if (!merged[d]) merged[d] = emptyDay(d);
  else merged[d] = pruneSources(merged[d]);
}

console.log(`TokenUsage sync since ${since} → ${today}`);

for (const [name, fn] of collectors) {
  process.stdout.write(`  · ${name}… `);
  try {
    const { days, meta } = await fn({ since });
    metas.push(meta);
    if (meta.skipped) {
      console.log(`skipped (${meta.reason})`);
    } else if (!meta.ok) {
      console.log(`error (${meta.reason || "unknown"})`);
    } else {
      mergeCollectorDays(merged, days, name);
      console.log(`ok (${meta.days ?? Object.keys(days).length} days)`);
    }
  } catch (e) {
    metas.push({ source: name, ok: false, reason: e.message });
    console.log(`error (${e.message})`);
  }
}

// Write daily files (only since+)
const written = [];
for (const date of Object.keys(merged).sort()) {
  if (date < since) continue;
  merged[date] = pruneSources(merged[date]);
  const path = resolve(dailyDir, `${date}.json`);
  writeFileSync(path, JSON.stringify(merged[date], null, 2) + "\n");
  written.push(date);
}

// Build summary for the site
const series = written.map((date) => {
  const day = merged[date];
  const bySource = {};
  for (const s of SOURCES) {
    bySource[s] = {
      tokens: sourceTokens(day.sources[s]),
      costUsd: day.sources[s]?.costUsd || 0,
      requests: day.sources[s]?.requests || 0,
    };
  }
  return {
    date,
    totals: day.totals,
    bySource,
    sources: day.sources,
  };
});

const allTime = series.reduce(
  (a, d) => {
    a.tokens += d.totals.tokens || 0;
    a.costUsd += d.totals.costUsd || 0;
    a.requests += d.totals.requests || 0;
    return a;
  },
  { tokens: 0, costUsd: 0, requests: 0 }
);

const weekDates = new Set(
  daysBetween(
    (() => {
      const t = new Date(`${today}T00:00:00`);
      t.setDate(t.getDate() - 6);
      const y = t.getFullYear();
      const m = String(t.getMonth() + 1).padStart(2, "0");
      const d = String(t.getDate()).padStart(2, "0");
      const local = `${y}-${m}-${d}`;
      return local < since ? since : local;
    })(),
    today
  )
);

const week = series
  .filter((d) => weekDates.has(d.date))
  .reduce(
    (a, d) => {
      a.tokens += d.totals.tokens || 0;
      a.costUsd += d.totals.costUsd || 0;
      a.requests += d.totals.requests || 0;
      return a;
    },
    { tokens: 0, costUsd: 0, requests: 0 }
  );

const todayRow = series.find((d) => d.date === today)?.totals || {
  tokens: 0,
  costUsd: 0,
  requests: 0,
};

const bySourceAll = Object.fromEntries(
  SOURCES.map((s) => [
    s,
    series.reduce(
      (a, d) => {
        a.tokens += d.bySource[s]?.tokens || 0;
        a.costUsd += d.bySource[s]?.costUsd || 0;
        a.requests += d.bySource[s]?.requests || 0;
        return a;
      },
      { tokens: 0, costUsd: 0, requests: 0 }
    ),
  ])
);

const modelRows = [];
for (const day of series) {
  for (const [source, src] of Object.entries(day.sources || {})) {
    for (const [model, stats] of Object.entries(src.byModel || {})) {
      modelRows.push({
        date: day.date,
        source,
        model,
        tokens: sourceTokens(stats),
        costUsd: stats.costUsd || 0,
        requests: stats.requests || 0,
      });
    }
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  since,
  today,
  totals: {
    today: todayRow,
    week,
    allTime,
  },
  bySource: bySourceAll,
  series,
  models: modelRows,
  collectors: metas,
};

writeFileSync(
  resolve(dataDir, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n"
);

// Mirror into site/ for Pages relative fetch
mkdirSync(resolve(root, "site/data"), { recursive: true });
writeFileSync(
  resolve(root, "site/data/summary.json"),
  JSON.stringify(summary, null, 2) + "\n"
);

console.log(`Wrote ${written.length} daily files + summary.json`);

if (doPush) {
  const git = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["add", "data", "site/data"]);
  const status = git(["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    console.log("Nothing new to push.");
  } else {
    const msg = `chore: sync usage data ${today}`;
    const commit = git(["commit", "-m", msg]);
    if (commit.status !== 0) {
      console.error(commit.stderr || commit.stdout);
      process.exit(commit.status || 1);
    }
    const push = git(["push"]);
    if (push.status !== 0) {
      console.error(push.stderr || push.stdout);
      process.exit(push.status || 1);
    }
    console.log("Pushed to origin.");
  }
}
