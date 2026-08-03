const token = document.querySelector('meta[name="vibe-tree-token"]').content;
const palette = ["#F72585", "#6D28D9", "#00A8E8", "#FFB703", "#20C997", "#FF6B35", "#3A86FF", "#B5179E"];
const rangeLabels = { "24h": "24H", "7d": "7天", "30d": "30天", all: "全部" };
let toastTimer;
let dashboardData;
let selectedModel;
let pressedSegmentKey;

document.querySelector("#sync-button").addEventListener("click", () => mutate("/api/sync", "同步完成"));
document.querySelector("#clear-model").addEventListener("click", () => selectModel());
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
  dashboardData = data;
  const context = chartContext(data.chart);
  if (selectedModel && !context.visible.includes(selectedModel)) selectedModel = undefined;
  renderMetrics(data, context);
  setText("service-version", `Vibe Tree Lite ${data.version}`);
  setText("freshness", `更新于 ${timeOnly(data.generatedAt)}`);

  if (data.cloud.syncing) setSyncState("", "正在同步");
  else if (data.cloud.error) setSyncState("warn", "同步异常");
  else if (data.cloud.enabled) setSyncState("good", data.cloud.lastSyncedAt ? `已同步 · ${relative(data.cloud.lastSyncedAt)}` : "同步已连接");
  else setSyncState("warn", "尚未连接同步");

  const connected = data.cloud.authenticated && data.cloud.enabled;
  document.querySelector("#auth-actions").hidden = connected;
  setText("sync-identity", data.cloud.profile?.username ? `GitHub · ${data.cloud.profile.username}` : "尚未连接 GitHub");
  setText("auth-note", data.cloud.authenticated
    ? `已登录 ${data.cloud.profile?.username || "GitHub"}，请选择要加入的同步方式。`
    : "这台设备尚未连接 GitHub 同步。");
  renderChart(data.chart, context);
  renderRanks(data.leaderboard || {});
}

function chartContext(days) {
  const totals = new Map();
  for (const day of days) for (const [model, value] of Object.entries(day.models)) totals.set(model, (totals.get(model) || 0) + value);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const topModels = sorted.slice(0, 7).map(([model]) => model);
  const otherModels = new Set(sorted.slice(7).map(([model]) => model));
  const visible = [...topModels];
  if (otherModels.size) visible.push("其他模型");
  const colors = new Map(visible.map((model, index) => [model, palette[index % palette.length]]));
  const groupedDays = days.map((day) => {
    const models = {};
    for (const [model, value] of Object.entries(day.models)) {
      const key = otherModels.has(model) ? "其他模型" : model;
      models[key] = (models[key] || 0) + value;
    }
    return { ...day, models };
  });
  return { visible, colors, groupedDays };
}

function renderMetrics(data, context) {
  const selectedTotal = selectedModel
    ? context.groupedDays.reduce((total, day) => total + (day.models[selectedModel] || 0), 0)
    : data.totals.period;
  const today = context.groupedDays.find((day) => day.date === data.today) || context.groupedDays.at(-1);
  const selectedToday = selectedModel ? today?.models[selectedModel] || 0 : data.totals.today;

  setText("today-label", selectedModel ? "该模型 · 今日" : "今日 Token");
  setText("today-total", compact(selectedToday));
  setText("today-date", selectedModel ? `${selectedModel} · ${localDate(data.today)}` : localDate(data.today));
  setText("period-label", selectedModel ? "该模型 · 30 日" : "30 日 Token");
  setText("period-total", compact(selectedTotal));
  setText("period-note", selectedModel || "包含已同步设备");
  setText("model-label", selectedModel ? "当前高亮" : "常用模型");
  setText("top-model", selectedModel || data.topModel || "—");
  setText("model-note", selectedModel ? "再次点击同色方块可取消" : "按 30 日消耗量");

  if (selectedModel) {
    const share = data.totals.period ? selectedTotal / data.totals.period : 0;
    setText("context-label", "30 日占比");
    setText("device-count", percent(share));
    setText("context-note", `${format(selectedTotal)} / ${format(data.totals.period)} Token`);
    setText("all-total", `${selectedModel} · ${compact(selectedTotal)}`);
  } else {
    setText("context-label", "同步设备");
    setText("device-count", data.cloud.deviceCount || (data.cloud.enabled ? 1 : "—"));
    setText("context-note", `${data.watchers.detected}/${data.watchers.running} 个来源在线`);
    setText("all-total", `累计 ${compact(data.totals.all)}`);
  }
  document.querySelector("#clear-model").hidden = !selectedModel;
}

function renderChart(days, context) {
  const chart = document.querySelector("#chart");
  const legend = document.querySelector("#legend");
  const empty = document.querySelector("#empty-state");
  hideTooltip();
  chart.replaceChildren();
  legend.replaceChildren();

  const { visible, colors, groupedDays } = context;
  const max = Math.max(0, ...days.map((day) => day.total));
  setText("axis-max", compact(max));
  setText("axis-mid", compact(max / 2));
  empty.hidden = max > 0;
  chart.classList.toggle("is-filtered", Boolean(selectedModel));
  chart.setAttribute("aria-label", selectedModel
    ? `最近 30 天 ${selectedModel} 每日 Token 消耗，当前已高亮`
    : "最近 30 天每日 Token 消耗，按模型堆叠");

  for (const model of visible) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    item.classList.toggle("is-selected", model === selectedModel);
    item.setAttribute("aria-pressed", String(model === selectedModel));
    item.setAttribute("aria-label", `${model}，点击${model === selectedModel ? "取消" : "高亮"}`);
    item.addEventListener("click", () => selectModel(model));
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = colors.get(model);
    const label = document.createElement("span");
    label.textContent = model;
    item.append(swatch, label);
    legend.append(item);
  }

  groupedDays.forEach((day, index) => {
    const column = document.createElement("div");
    column.className = "bar-column";
    const slot = document.createElement("div");
    slot.className = "bar-slot";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = max ? `${Math.max(day.total ? 1.5 : 0, (day.total / max) * 100)}%` : "0";
    for (const model of visible) {
      const value = day.models[model] || 0;
      if (!value) continue;
      const segment = document.createElement("button");
      const segmentKey = `${day.date}\u0000${model}`;
      segment.type = "button";
      segment.className = "bar-segment";
      segment.classList.toggle("is-selected", model === selectedModel);
      segment.classList.toggle("is-popping", segmentKey === pressedSegmentKey);
      segment.style.flexGrow = String(value);
      segment.style.background = colors.get(model);
      segment.setAttribute("aria-pressed", String(model === selectedModel));
      segment.setAttribute("aria-label", `${localDate(day.date)}，${model}，${format(value)} Token，点击${model === selectedModel ? "取消" : "高亮"}`);
      const tooltipData = { model, date: day.date, value, dayTotal: day.total, color: colors.get(model) };
      segment.addEventListener("pointerenter", (event) => showTooltip(event.clientX, event.clientY, tooltipData));
      segment.addEventListener("pointermove", (event) => moveTooltip(event.clientX, event.clientY));
      segment.addEventListener("pointerleave", hideTooltip);
      segment.addEventListener("focus", () => showTooltipForElement(segment, tooltipData));
      segment.addEventListener("blur", hideTooltip);
      segment.addEventListener("click", () => selectModel(model, segmentKey));
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

function selectModel(model, segmentKey) {
  pressedSegmentKey = segmentKey;
  selectedModel = model && model !== selectedModel ? model : undefined;
  setText("model-filter-status", selectedModel ? `已高亮 ${selectedModel}` : "已显示全部模型");
  if (dashboardData) render(dashboardData);
  pressedSegmentKey = undefined;
}

function showTooltip(x, y, data) {
  const tooltip = document.querySelector("#chart-tooltip");
  tooltip.style.setProperty("--tooltip-color", data.color);
  setText("tooltip-model", data.model);
  setText("tooltip-date", localDate(data.date));
  setText("tooltip-value", `${format(data.value)} Token`);
  setText("tooltip-share", `占当日 ${percent(data.dayTotal ? data.value / data.dayTotal : 0)}`);
  tooltip.hidden = false;
  moveTooltip(x, y);
}

function showTooltipForElement(element, data) {
  const rect = element.getBoundingClientRect();
  showTooltip(rect.left + rect.width / 2, rect.top, data);
}

function moveTooltip(x, y) {
  const tooltip = document.querySelector("#chart-tooltip");
  if (tooltip.hidden) return;
  const gap = 14;
  const rect = tooltip.getBoundingClientRect();
  const left = Math.max(12, Math.min(window.innerWidth - rect.width - 12, x + gap));
  let top = y - rect.height - gap;
  if (top < 12) top = Math.min(window.innerHeight - rect.height - 12, y + gap);
  tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function hideTooltip() {
  document.querySelector("#chart-tooltip").hidden = true;
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
    tokens.textContent = data.tokens != null ? `${compact(data.tokens)} Token` : data.error ? "暂不可用" : "等待同步";
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
function percent(value) { return `${trim((Number(value) || 0) * 100)}%`; }
function setText(id, value) { document.querySelector(`#${id}`).textContent = value; }
function localDate(value) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${value}T12:00:00`)) : "本地时区"; }
function timeOnly(value) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function relative(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}
