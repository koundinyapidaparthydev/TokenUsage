const SOURCES = ["opencode", "cursor", "openrouter", "gemini", "mistral"];

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

function fmtDayLabel(isoDay) {
  const d = new Date(`${isoDay}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function loadSummary() {
  const paths = ["./data/summary.json", "../data/summary.json"];
  for (const p of paths) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (res.ok) return res.json();
    } catch {
      /* next */
    }
  }
  throw new Error("Could not load summary.json");
}

function levelFor(tokens, max) {
  const t = Number(tokens) || 0;
  if (t <= 0 || max <= 0) return 0;
  const r = t / max;
  if (r <= 0.15) return 1;
  if (r <= 0.35) return 2;
  if (r <= 0.65) return 3;
  return 4;
}

function buildYearDays(endISO) {
  const end = new Date(`${endISO}T12:00:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  // Align to Sunday like GitHub
  start.setDate(start.getDate() - start.getDay());

  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(toISODate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  // Pad to full weeks (Sun–Sat)
  while (days.length % 7 !== 0) {
    const next = new Date(`${days[days.length - 1]}T12:00:00`);
    next.setDate(next.getDate() + 1);
    days.push(toISODate(next));
  }
  return { days, start: days[0], end: endISO };
}

function renderMonths(days) {
  const el = document.getElementById("months");
  el.innerHTML = "";
  el.style.gridTemplateColumns = `repeat(${days.length / 7}, calc(var(--cell) + var(--gap)))`;
  let lastMonth = -1;
  for (let i = 0; i < days.length; i += 7) {
    const d = new Date(`${days[i]}T12:00:00`);
    const m = d.getMonth();
    const span = document.createElement("span");
    if (m !== lastMonth) {
      span.textContent = d.toLocaleString(undefined, { month: "short" });
      lastMonth = m;
    }
    el.appendChild(span);
  }
}

function showTip(text, x, y) {
  const tip = document.getElementById("tip");
  tip.hidden = false;
  tip.textContent = text;
  const pad = 12;
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - pad, x + 12)}px`;
  tip.style.top = `${Math.max(pad, y - tip.offsetHeight - 10)}px`;
}

function hideTip() {
  document.getElementById("tip").hidden = true;
}

function renderDetail(day, data) {
  const title = document.getElementById("detail-title");
  const sub = document.getElementById("detail-sub");
  const tokens = data?.totals?.tokens || 0;
  const requests = data?.totals?.requests || 0;
  const cost = data?.totals?.costUsd || 0;

  title.textContent = fmtDayLabel(day);
  sub.textContent = data
    ? `${fmtTokens(tokens)} tokens across tracked sources`
    : "No tracked usage for this day yet.";

  document.getElementById("detail-tokens").textContent = fmtTokens(tokens);
  document.getElementById("detail-requests").textContent = String(requests || 0);
  document.getElementById("detail-cost").textContent = fmtMoney(cost);

  const bars = document.getElementById("source-bars");
  bars.innerHTML = "";
  const bySource = data?.bySource || {};
  const max = Math.max(1, ...SOURCES.map((s) => bySource[s]?.tokens || 0));
  for (const s of SOURCES) {
    const t = bySource[s]?.tokens || 0;
    const row = document.createElement("div");
    row.className = "source-row";
    row.innerHTML = `
      <span>${s}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(t / max) * 100}%"></div></div>
      <span class="amt">${fmtTokens(t)}</span>`;
    bars.appendChild(row);
  }
}

function renderGraph(summary) {
  const byDate = Object.fromEntries(
    (summary.series || []).map((d) => [d.date, d])
  );
  const today = summary.today || toISODate(new Date());
  const { days, start, end } = buildYearDays(today);
  const values = days.map((d) => byDate[d]?.totals?.tokens || 0);
  const max = Math.max(0, ...values);
  const activeDays = values.filter((v) => v > 0).length;
  const yearTokens = values.reduce((a, b) => a + b, 0);

  document.getElementById("graph-summary").textContent =
    `${fmtTokens(yearTokens)} tokens across ${activeDays} active day${activeDays === 1 ? "" : "s"} in the last year`;
  document.getElementById("graph-range").textContent = `${start} → ${end}`;
  document.getElementById("since-label").textContent = summary.since || "2026-08-28";

  renderMonths(days);

  const cells = document.getElementById("cells");
  cells.innerHTML = "";
  let selectedBtn = null;

  days.forEach((day, idx) => {
    const tokens = values[idx];
    const lvl = levelFor(tokens, max);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cell lvl${lvl}`;
    btn.dataset.date = day;
    btn.setAttribute(
      "aria-label",
      `${day}: ${fmtTokens(tokens)} tokens`
    );

    const select = () => {
      if (selectedBtn) selectedBtn.classList.remove("selected");
      selectedBtn = btn;
      btn.classList.add("selected");
      renderDetail(day, byDate[day] || null);
    };

    btn.addEventListener("click", select);
    btn.addEventListener("mouseenter", (e) => {
      showTip(
        `${fmtDayLabel(day)} · ${fmtTokens(tokens)} tokens`,
        e.clientX,
        e.clientY
      );
    });
    btn.addEventListener("mousemove", (e) => {
      showTip(
        `${fmtDayLabel(day)} · ${fmtTokens(tokens)} tokens`,
        e.clientX,
        e.clientY
      );
    });
    btn.addEventListener("mouseleave", hideTip);
    cells.appendChild(btn);

    if (day === today) select();
  });
}

function renderTotals(summary) {
  const set = (id, tokens, metaId, cost, requests) => {
    document.getElementById(id).textContent = fmtTokens(tokens);
    document.getElementById(metaId).textContent =
      `${fmtMoney(cost)} · ${requests || 0} requests`;
  };
  set(
    "today-tokens",
    summary.totals.today.tokens,
    "today-meta",
    summary.totals.today.costUsd,
    summary.totals.today.requests
  );
  set(
    "week-tokens",
    summary.totals.week.tokens,
    "week-meta",
    summary.totals.week.costUsd,
    summary.totals.week.requests
  );
  set(
    "all-tokens",
    summary.totals.allTime.tokens,
    "all-meta",
    summary.totals.allTime.costUsd,
    summary.totals.allTime.requests
  );

  const body = document.getElementById("source-table");
  body.innerHTML = "";
  for (const s of SOURCES) {
    const row = summary.bySource?.[s] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s}</td>
      <td class="num">${fmtTokens(row.tokens)}</td>
      <td class="num">${row.requests || 0}</td>
      <td class="num">${fmtMoney(row.costUsd)}</td>`;
    body.appendChild(tr);
  }
}

async function main() {
  const summary = await loadSummary();
  document.getElementById("synced").textContent =
    `Synced ${fmtWhen(summary.generatedAt)}`;
  renderGraph(summary);
  renderTotals(summary);
}

main().catch((err) => {
  document.getElementById("synced").textContent = err.message;
});
