const SOURCES = ["opencode", "cursor", "gemini"];

function $(id) {
  return document.getElementById(id);
}

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
  const paths = [
    `./data/summary.json?t=${Date.now()}`,
    "../data/summary.json",
  ];
  let lastErr = null;
  for (const p of paths) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (res.ok) return res.json();
      lastErr = new Error(`${p} → ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Could not load summary.json");
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

/** Start at tracking start; keep ~1 year of remaining empty slots ahead. */
function buildGraphDays(sinceISO, todayISO) {
  const since = new Date(`${sinceISO}T12:00:00`);
  const today = new Date(`${(todayISO || sinceISO)}T12:00:00`);
  if (Number.isNaN(since.getTime())) throw new Error(`Invalid since: ${sinceISO}`);

  const start = new Date(since);
  start.setDate(start.getDate() - start.getDay()); // align to Sunday

  const end = new Date(since);
  end.setDate(end.getDate() + 364); // remaining year of slots from tracking start
  if (today > end) {
    end.setTime(today.getTime());
    while ((Math.floor((end - start) / 86400000) + 1) % 7 !== 0) {
      end.setDate(end.getDate() + 1);
    }
  }

  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(toISODate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return {
    days,
    start: days[0],
    end: toISODate(end),
    since: sinceISO,
    today: toISODate(today),
  };
}

function renderMonths(days) {
  const el = $("month-labels");
  if (!el) return;
  el.replaceChildren();
  const weeks = Math.max(1, Math.round(days.length / 7));
  el.style.gridTemplateColumns = `repeat(${weeks}, calc(var(--cell) + var(--gap)))`;
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
  const tip = $("tip");
  if (!tip) return;
  tip.hidden = false;
  tip.textContent = text;
  const pad = 12;
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - pad, x + 12)}px`;
  tip.style.top = `${Math.max(pad, y - tip.offsetHeight - 10)}px`;
}

function hideTip() {
  const tip = $("tip");
  if (tip) tip.hidden = true;
}

function renderDetail(day, data, isFuture) {
  const title = $("detail-title");
  const sub = $("detail-sub");
  if (!title || !sub) return;

  const tokens = data?.totals?.tokens || 0;
  const requests = data?.totals?.requests || 0;
  const cost = data?.totals?.costUsd || 0;

  title.textContent = fmtDayLabel(day);
  if (isFuture) {
    sub.textContent = "Future slot — no usage yet.";
  } else {
    sub.textContent = data
      ? `${fmtTokens(tokens)} tokens across OpenCode, Cursor & Gemini`
      : "No tracked usage for this day yet.";
  }

  const dt = $("detail-tokens");
  const dr = $("detail-requests");
  const dc = $("detail-cost");
  if (dt) dt.textContent = fmtTokens(tokens);
  if (dr) dr.textContent = String(requests || 0);
  if (dc) dc.textContent = fmtMoney(cost);

  const bars = $("source-bars");
  if (!bars) return;
  bars.replaceChildren();
  const bySource = data?.bySource || {};
  const max = Math.max(1, ...SOURCES.map((s) => bySource[s]?.tokens || 0));
  for (const s of SOURCES) {
    const t = bySource[s]?.tokens || 0;
    const row = document.createElement("div");
    row.className = "source-row";
    const name = document.createElement("span");
    name.textContent = s;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${(t / max) * 100}%`;
    track.appendChild(fill);
    const amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = fmtTokens(t);
    row.append(name, track, amt);
    bars.appendChild(row);
  }
}

function renderGraph(summary) {
  const byDate = Object.fromEntries(
    (summary.series || []).map((d) => [d.date, d])
  );
  const since = summary.since || summary.today || toISODate(new Date());
  const today = summary.today || toISODate(new Date());
  const { days, start, end } = buildGraphDays(since, today);
  const values = days.map((d) => byDate[d]?.totals?.tokens || 0);
  const max = Math.max(0, ...values);
  const activeDays = values.filter((v) => v > 0).length;
  const yearTokens = values.reduce((a, b) => a + b, 0);

  const gs = $("graph-summary");
  const gr = $("graph-range");
  const sinceEl = $("since-label");
  if (gs) {
    gs.textContent = `${fmtTokens(yearTokens)} tokens across ${activeDays} active day${
      activeDays === 1 ? "" : "s"
    } since tracking started`;
  }
  if (gr) gr.textContent = `${start} → ${end}`;
  if (sinceEl) sinceEl.textContent = since;

  renderMonths(days);

  const cells = $("cells");
  if (!cells) throw new Error("Missing #cells container");
  cells.replaceChildren();
  let selectedBtn = null;

  days.forEach((day, idx) => {
    const tokens = values[idx];
    const lvl = levelFor(tokens, max);
    const isFuture = day > today;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cell lvl${lvl}${isFuture ? " future" : ""}`;
    btn.dataset.date = day;
    btn.setAttribute(
      "aria-label",
      isFuture ? `${day}: upcoming` : `${day}: ${fmtTokens(tokens)} tokens`
    );

    const select = () => {
      if (selectedBtn) selectedBtn.classList.remove("selected");
      selectedBtn = btn;
      btn.classList.add("selected");
      renderDetail(day, byDate[day] || null, isFuture);
    };

    btn.addEventListener("click", select);
    btn.addEventListener("mouseenter", (e) => {
      showTip(
        isFuture
          ? `${fmtDayLabel(day)} · upcoming`
          : `${fmtDayLabel(day)} · ${fmtTokens(tokens)} tokens`,
        e.clientX,
        e.clientY
      );
    });
    btn.addEventListener("mousemove", (e) => {
      showTip(
        isFuture
          ? `${fmtDayLabel(day)} · upcoming`
          : `${fmtDayLabel(day)} · ${fmtTokens(tokens)} tokens`,
        e.clientX,
        e.clientY
      );
    });
    btn.addEventListener("mouseleave", hideTip);
    cells.appendChild(btn);

    if (day === today) select();
  });

  if (!selectedBtn) {
    const latest = [...(summary.series || [])]
      .reverse()
      .find((d) => (d.totals?.tokens || 0) > 0);
    if (latest) {
      const btn = cells.querySelector(`[data-date="${latest.date}"]`);
      if (btn) btn.click();
      else renderDetail(latest.date, latest, false);
    }
  }
}

function renderTotals(summary) {
  const set = (id, tokens, metaId, cost, requests) => {
    const el = $(id);
    const meta = $(metaId);
    if (el) el.textContent = fmtTokens(tokens);
    if (meta) meta.textContent = `${fmtMoney(cost)} · ${requests || 0} requests`;
  };

  const t = summary.totals || {};
  set("today-tokens", t.today?.tokens, "today-meta", t.today?.costUsd, t.today?.requests);
  set("week-tokens", t.week?.tokens, "week-meta", t.week?.costUsd, t.week?.requests);
  set("all-tokens", t.allTime?.tokens, "all-meta", t.allTime?.costUsd, t.allTime?.requests);

  const body = $("source-table");
  if (!body) return;
  body.replaceChildren();
  for (const s of SOURCES) {
    const row = summary.bySource?.[s] || {};
    const tr = document.createElement("tr");
    [s, fmtTokens(row.tokens), String(row.requests || 0), fmtMoney(row.costUsd)].forEach(
      (text, i) => {
        const td = document.createElement("td");
        if (i > 0) td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      }
    );
    body.appendChild(tr);
  }
}

async function main() {
  const summary = await loadSummary();
  const synced = $("synced");
  if (synced) synced.textContent = `Synced ${fmtWhen(summary.generatedAt)}`;
  renderGraph(summary);
  renderTotals(summary);
}

main().catch((err) => {
  const synced = $("synced");
  if (synced) synced.textContent = err?.message || String(err);
  console.error(err);
});
