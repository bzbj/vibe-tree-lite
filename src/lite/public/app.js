const token = document.querySelector('meta[name="vibe-tree-token"]').content;
const palette = ["#174f3a", "#2c8562", "#47b989", "#7bcba5", "#d4a64c", "#d87956", "#846ca7", "#7b8680"];
const rangeLabels = { "24h": "24H", "7d": "7天", "30d": "30天", all: "全部" };
let toastTimer;

document.querySelector("#sync-button").addEventListener("click", () => mutate("/api/sync", "同步完成"));
document.querySelector("#auth-actions").addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "connect-existing") mutate("/api/connect-existing", "已加入同步");
  if (action === "connect-new") mutate("/api/connect-new", "已建立同步");
});

await refresh();
setInterval(refresh, 30_000);

async function refresh() {
  try {
    const response = await fetch("/api/dashboard?days=30", { cache: "no-store" });
    if (!response.ok) throw new Error(`读取失败 (${response.status})`);
    render(await response.json());
  } catch (error) {
    setSyncState("warn", error.message || "服务暂时不可用");
  }
}

async function mutate(path, successMessage) {
  const button = document.querySelector("#sync-button");
  button.disabled = true;
  setSyncState("", "正在处理…");
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "X-Vibe-Tree-Token": token },
    });
    const result = await response.json();
    if (!response.ok || result.error || result.cloud?.error || result.leaderboard?.error) {
      throw new Error(result.error || result.cloud?.error || result.leaderboard?.error || "操作未完成");
    }
    showToast(successMessage);
    await refresh();
  } catch (error) {
    showToast(error.message || "操作失败");
    setSyncState("warn", "需要处理");
  } finally {
    button.disabled = false;
  }
}

function render(data) {
  setText("today-total", compact(data.totals.today));
  setText("period-total", compact(data.totals.period));
  setText("all-total", `累计 ${compact(data.totals.all)}`);
  setText("today-date", localDate(data.today));
  setText("top-model", data.topModel || "—");
  setText("device-count", data.cloud.deviceCount || (data.cloud.enabled ? 1 : "—"));
  setText("watcher-count", `${data.watchers.detected}/${data.watchers.running} 个来源在线`);
  setText("service-version", `Vibe Tree Lite ${data.version}`);
  setText("freshness", `更新于 ${timeOnly(data.generatedAt)}`);

  if (data.cloud.syncing) setSyncState("", "正在同步");
  else if (data.cloud.error) setSyncState("warn", "同步异常");
  else if (data.cloud.enabled) setSyncState("good", data.cloud.lastSyncedAt ? `已同步 · ${relative(data.cloud.lastSyncedAt)}` : "同步已连接");
  else setSyncState("warn", "尚未连接同步");

  document.querySelector("#auth-actions").hidden = data.cloud.authenticated && data.cloud.enabled;
  renderChart(data.chart);
  renderRanks(data.leaderboard);
}

function renderChart(days) {
  const chart = document.querySelector("#chart");
  const legend = document.querySelector("#legend");
  const empty = document.querySelector("#empty-state");
  chart.replaceChildren();
  legend.replaceChildren();

  const totals = new Map();
  for (const day of days) for (const [model, value] of Object.entries(day.models)) totals.set(model, (totals.get(model) || 0) + value);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const visible = sorted.slice(0, 7).map(([model]) => model);
  if (sorted.length > 7) visible.push("其他模型");
  const colors = new Map(visible.map((model, index) => [model, palette[index % palette.length]]));
  const max = Math.max(0, ...days.map((day) => day.total));
  setText("axis-max", compact(max));
  setText("axis-mid", compact(max / 2));
  empty.hidden = max > 0;

  for (const model of visible) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = colors.get(model);
    const label = document.createElement("span");
    label.textContent = model;
    item.append(swatch, label);
    legend.append(item);
  }

  days.forEach((day, index) => {
    const grouped = new Map();
    for (const [model, value] of Object.entries(day.models)) {
      const key = visible.includes(model) ? model : "其他模型";
      grouped.set(key, (grouped.get(key) || 0) + value);
    }
    const column = document.createElement("div");
    column.className = "bar-column";
    const slot = document.createElement("div");
    slot.className = "bar-slot";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = max ? `${Math.max(day.total ? 1.5 : 0, (day.total / max) * 100)}%` : "0";
    const details = [...grouped.entries()].sort((a, b) => b[1] - a[1]).map(([model, value]) => `${model} ${format(value)}`).join("；");
    bar.title = `${localDate(day.date)} · ${format(day.total)} Token${details ? `\n${details}` : ""}`;
    bar.setAttribute("aria-label", bar.title);
    for (const model of visible) {
      const value = grouped.get(model) || 0;
      if (!value) continue;
      const segment = document.createElement("span");
      segment.className = "bar-segment";
      segment.style.flexGrow = String(value);
      segment.style.background = colors.get(model);
      bar.append(segment);
    }
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = index % 5 === 0 || index === days.length - 1 ? day.date.slice(5).replace("-", "/") : "";
    slot.append(bar);
    column.append(slot, label);
    chart.append(column);
  });
}

function renderRanks(leaderboard) {
  const list = document.querySelector("#rank-list");
  list.replaceChildren();
  for (const range of ["24h", "7d", "30d", "all"]) {
    const data = leaderboard[range] || {};
    const row = document.createElement("div");
    row.className = "rank-row";
    const label = document.createElement("span");
    label.className = "rank-range";
    label.textContent = rangeLabels[range];
    const rank = document.createElement("strong");
    rank.className = data.rank ? "rank-value" : "rank-empty";
    rank.textContent = data.rank ? `#${format(data.rank)}` : "未上榜";
    const tokens = document.createElement("span");
    tokens.className = "rank-token";
    tokens.textContent = data.tokens != null ? compact(data.tokens) : data.error ? "暂不可用" : "—";
    row.append(label, rank, tokens);
    list.append(row);
  }
}

function setSyncState(kind, text) {
  const state = document.querySelector("#sync-state");
  state.className = `sync-state${kind ? ` is-${kind}` : ""}`;
  state.lastElementChild.textContent = text;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function compact(value) {
  const number = Number(value) || 0;
  if (number >= 1e9) return `${trim(number / 1e9)}B`;
  if (number >= 1e6) return `${trim(number / 1e6)}M`;
  if (number >= 1e3) return `${trim(number / 1e3)}K`;
  return format(number);
}

function trim(value) { return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/\.?0+$/, ""); }
function format(value) { return Math.round(Number(value) || 0).toLocaleString("zh-CN"); }
function setText(id, value) { document.querySelector(`#${id}`).textContent = value; }
function localDate(value) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${value}T12:00:00`)) : "本地时区"; }
function timeOnly(value) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function relative(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}
