const SOURCE_COLORS = {
  opencode: "#2ec4b6",
  cursor: "#7eb6ff",
  openrouter: "#f0a202",
  gemini: "#8fd694",
  mistral: "#f28482",
};

const SOURCES = Object.keys(SOURCE_COLORS);

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  if (!v) return "$0.00";
  if (v < 0.01) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

function fmtWhen(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function loadSummary() {
  const paths = ["./data/summary.json", "../data/summary.json"];
  for (const p of paths) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (res.ok) return res.json();
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not load summary.json");
}

function setMetric(id, tokens, metaId, cost, requests) {
  document.getElementById(id).textContent = fmtTokens(tokens);
  document.getElementById(metaId).textContent = `${fmtMoney(cost)} · ${requests || 0} requests`;
}

let chart;
let active = new Set(SOURCES);

function renderChips() {
  const el = document.getElementById("source-chips");
  el.innerHTML = "";
  for (const s of SOURCES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip${active.has(s) ? " active" : ""}`;
    btn.textContent = s;
    btn.style.setProperty("--chip", SOURCE_COLORS[s]);
    btn.addEventListener("click", () => {
      if (active.has(s) && active.size === 1) return;
      if (active.has(s)) active.delete(s);
      else active.add(s);
      btn.classList.toggle("active");
      window.__redraw?.();
    });
    el.appendChild(btn);
  }
}

function renderTables(summary) {
  const sourceBody = document.getElementById("source-table");
  sourceBody.innerHTML = "";
  for (const s of SOURCES) {
    const row = summary.bySource?.[s] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span style="color:${SOURCE_COLORS[s]}">${s}</span></td>
      <td class="num">${fmtTokens(row.tokens)}</td>
      <td class="num">${row.requests || 0}</td>
      <td class="num">${fmtMoney(row.costUsd)}</td>`;
    sourceBody.appendChild(tr);
  }

  const modelBody = document.getElementById("model-table");
  modelBody.innerHTML = "";
  const agg = new Map();
  for (const m of summary.models || []) {
    if (!active.has(m.source)) continue;
    const key = `${m.source}::${m.model}`;
    const cur = agg.get(key) || {
      source: m.source,
      model: m.model,
      tokens: 0,
      requests: 0,
    };
    cur.tokens += m.tokens || 0;
    cur.requests += m.requests || 0;
    agg.set(key, cur);
  }
  const rows = [...agg.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 40);
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4">No model rows yet — run sync after adding keys or Cursor CSVs.</td>`;
    modelBody.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.source}</td>
      <td>${r.model}</td>
      <td class="num">${fmtTokens(r.tokens)}</td>
      <td class="num">${r.requests}</td>`;
    modelBody.appendChild(tr);
  }
}

function renderChart(summary) {
  const labels = (summary.series || []).map((d) => d.date);
  const datasets = SOURCES.filter((s) => active.has(s)).map((s) => ({
    label: s,
    data: (summary.series || []).map((d) => d.bySource?.[s]?.tokens || 0),
    backgroundColor: SOURCE_COLORS[s],
    stack: "tokens",
    borderWidth: 0,
  }));

  const ctx = document.getElementById("daily-chart");
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${fmtTokens(c.raw)}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#93a0b0", maxRotation: 0, autoSkipPadding: 12 },
          grid: { color: "rgba(238,242,246,0.06)" },
        },
        y: {
          stacked: true,
          ticks: {
            color: "#93a0b0",
            callback: (v) => fmtTokens(v),
          },
          grid: { color: "rgba(238,242,246,0.06)" },
        },
      },
    },
  });
}

async function main() {
  renderChips();
  const summary = await loadSummary();
  document.getElementById("synced").textContent = `Synced ${fmtWhen(summary.generatedAt)}`;
  setMetric(
    "today-tokens",
    summary.totals.today.tokens,
    "today-meta",
    summary.totals.today.costUsd,
    summary.totals.today.requests
  );
  setMetric(
    "week-tokens",
    summary.totals.week.tokens,
    "week-meta",
    summary.totals.week.costUsd,
    summary.totals.week.requests
  );
  setMetric(
    "all-tokens",
    summary.totals.allTime.tokens,
    "all-meta",
    summary.totals.allTime.costUsd,
    summary.totals.allTime.requests
  );

  window.__redraw = () => {
    renderChart(summary);
    renderTables(summary);
  };
  window.__redraw();
}

main().catch((err) => {
  document.getElementById("synced").textContent = err.message;
});
