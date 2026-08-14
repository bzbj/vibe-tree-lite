const token = document.querySelector('meta[name="vibe-tree-token"]').content;
const fallbackPalette = ["#F4515B", "#FFD447", "#4387F5", "#18A980", "#FF8E73", "#66C7EE", "#AEDA6D", "#E99A2B"];
const themeSelect = document.querySelector("#theme-select");
const themeStylesheet = document.querySelector("#theme-stylesheet");
const mascotStage = document.querySelector("#theme-mascot");
const mascotPet = document.querySelector("#theme-mascot-pet");
const mascotImage = document.querySelector("#theme-mascot-image");
let mascotWalkTimer;
let mascotActivityToken = 0;
let mascotState = "idle";
let palette = [...fallbackPalette];
let toastTimer;
let dashboardData;
let selectedModel;
let themeCatalog;

document.querySelector("#sync-button").addEventListener("click", (event) => mutate("/api/sync", "同步完成", event.currentTarget, "同步中…"));
document.querySelector("#clear-model").addEventListener("click", () => selectModel());
themeSelect.addEventListener("change", () => selectTheme(themeSelect.value));
document.querySelector("#auth-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button?.dataset.action === "connect-github") {
    mutate("/api/connect-github", "GitHub 已连接", button, "等待 GitHub 授权…");
  }
});
document.addEventListener("visibilitychange", () => mascotStage.classList.toggle("is-paused", document.hidden));
window.addEventListener("resize", updateMascotGeometry, { passive: true });
mascotImage.addEventListener("error", () => { mascotStage.hidden = true; });

await refreshThemes();
await refresh();
setInterval(refresh, 30_000);

async function refreshThemes() {
  try {
    const response = await fetch("/api/themes", { cache: "no-store" });
    if (!response.ok) throw new Error(`主题读取失败 (${response.status})`);
    renderThemeCatalog(await response.json());
    refreshPalette();
  } catch (error) {
    themeSelect.disabled = true;
    themeSelect.title = error.message || "主题包不可用";
  }
}

async function selectTheme(id) {
  const previousId = themeCatalog?.activeId;
  themeSelect.disabled = true;
  try {
    const response = await fetch("/api/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vibe-Tree-Token": token },
      body: JSON.stringify({ id }),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "主题切换失败");
    await reloadThemeStylesheet(result.active.revision);
    renderThemeCatalog(result);
    refreshPalette();
    if (dashboardData) render(dashboardData);
    showToast(`已切换到 ${result.active.name}`);
  } catch (error) {
    if (previousId) themeSelect.value = previousId;
    showToast(error.message || "主题切换失败");
  } finally {
    themeSelect.disabled = !themeCatalog?.themes?.length;
  }
}

function renderThemeCatalog(catalog) {
  const previousKey = themeCatalog?.active ? `${themeCatalog.active.id}:${themeCatalog.active.revision}` : "";
  themeCatalog = catalog;
  themeSelect.replaceChildren();
  for (const theme of catalog.themes || []) {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = `${theme.name} · ${theme.subtitle}`;
    themeSelect.append(option);
  }
  themeSelect.value = catalog.activeId;
  themeSelect.disabled = !(catalog.themes || []).length;
  themeSelect.title = catalog.active.description || `${catalog.active.author} · ${catalog.active.version}`;
  document.documentElement.dataset.theme = catalog.activeId;
  document.documentElement.style.colorScheme = catalog.active.colorScheme;
  document.querySelector('meta[name="color-scheme"]').content = catalog.active.colorScheme;
  setText("theme-name", `· ${catalog.active.name}`);
  setText("theme-subtitle", catalog.active.subtitle);
  document.querySelector(".brand").setAttribute("aria-label", `Vibe Tree Lite · ${catalog.active.name} 首页`);
  document.title = `Vibe Tree Lite · ${catalog.active.name}`;
  configureMascot(catalog.active, previousKey !== `${catalog.active.id}:${catalog.active.revision}`);
}

function configureMascot(theme, changed) {
  clearTimeout(mascotWalkTimer);
  if (!theme?.mascot) {
    mascotStage.hidden = true;
    mascotImage.removeAttribute("src");
    mascotPet.dataset.state = "idle";
    mascotPet.dataset.action = "idle-bob";
    return;
  }
  mascotStage.hidden = false;
  mascotStage.dataset.slot = theme.mascot.slot;
  mascotStage.dataset.motion = theme.mascot.motion || "ambient";
  mascotStage.style.setProperty("--mascot-desktop-size", `${theme.mascot.desktopSize}px`);
  mascotStage.style.setProperty("--mascot-mobile-size", `${theme.mascot.mobileSize}px`);
  mascotImage.src = `/theme-mascot?v=${encodeURIComponent(theme.revision)}-${Date.now()}`;
  requestAnimationFrame(updateMascotGeometry);
  if (changed) {
    setMascotState("idle");
    if (theme.mascot.motion !== "static") scheduleMascotWalk();
  }
}

function updateMascotGeometry() {
  if (mascotStage.hidden) return;
  const petWidth = mascotPet.getBoundingClientRect().width;
  const travel = Math.max(0, mascotStage.clientWidth - petWidth - 24);
  mascotStage.style.setProperty("--mascot-travel", `${Math.round(travel)}px`);
}

function setMascotState(state, durationMs = 0) {
  if (!themeCatalog?.active?.mascot) return;
  const action = themeCatalog.active.mascot.states[state] || themeCatalog.active.mascot.states.idle;
  const activityToken = ++mascotActivityToken;
  mascotState = state;
  mascotPet.dataset.state = state;
  mascotPet.dataset.action = action;
  if (durationMs) {
    window.setTimeout(() => {
      if (activityToken === mascotActivityToken) setMascotState("idle");
    }, durationMs);
  }
}

function scheduleMascotWalk() {
  clearTimeout(mascotWalkTimer);
  if (!themeCatalog?.active?.mascot || themeCatalog.active.mascot.motion === "static") return;
  mascotWalkTimer = window.setTimeout(() => {
    if (mascotState === "idle") setMascotState("walk", 9000);
    scheduleMascotWalk();
  }, 15000 + Math.round(Math.random() * 5000));
}

function reloadThemeStylesheet(revision) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      themeStylesheet.removeEventListener("load", loaded);
      themeStylesheet.removeEventListener("error", failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("主题样式加载失败")); };
    themeStylesheet.addEventListener("load", loaded, { once: true });
    themeStylesheet.addEventListener("error", failed, { once: true });
    themeStylesheet.href = `/theme.css?v=${encodeURIComponent(revision)}-${Date.now()}`;
  });
}

function refreshPalette() {
  const styles = getComputedStyle(document.documentElement);
  const themed = Array.from({ length: 8 }, (_, index) => styles.getPropertyValue(`--vt-chart-${index + 1}`).trim()).filter(Boolean);
  palette = themed.length >= 2 ? themed : [...fallbackPalette];
}

async function refresh() {
  try {
    const response = await fetch("/api/dashboard?days=30", { cache: "no-store" });
    if (!response.ok) throw new Error(`读取失败 (${response.status})`);
    render(await response.json());
  } catch (error) {
    setSyncState("warn", error.message || "服务暂时不可用");
    setMascotState("error", 1800);
  }
}

async function mutate(path, successMessage, button, busyLabel = "正在处理…") {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  setSyncState("", busyLabel);
  if (path === "/api/sync" || path.startsWith("/api/connect-")) setMascotState("syncing");
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
    if (path === "/api/sync" || path.startsWith("/api/connect-")) setMascotState("success", 1500);
    await refresh();
  } catch (error) {
    showToast(error.message || "操作失败");
    setSyncState("warn", "需要处理");
    if (path === "/api/sync" || path.startsWith("/api/connect-")) setMascotState("error", 1800);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function render(data) {
  dashboardData = data;
  const context = chartContext(data.chart);
  if (selectedModel && !context.visible.includes(selectedModel)) selectedModel = undefined;
  renderMetrics(data, context);
  setText("service-version", `Vibe Tree Lite ${data.version}`);
  setText("freshness", `更新于 ${timeOnly(data.generatedAt)}`);

  const connected = data.cloud.authenticated && data.cloud.enabled;
  const username = data.cloud.profile?.username;
  if (data.cloud.syncing) setSyncState("", username ? `GitHub · ${username} · 同步中` : "正在同步");
  else if (data.cloud.error) setSyncState("warn", username ? `GitHub · ${username} · 异常` : "同步异常");
  else if (connected) setSyncState("good", username ? `GitHub · ${username}` : "GitHub 已连接");
  else setSyncState("warn", username ? `GitHub · ${username} · 未加入同步` : "尚未连接 GitHub");

  const syncState = document.querySelector("#sync-state");
  syncState.title = data.cloud.lastSyncedAt ? `最后同步：${relative(data.cloud.lastSyncedAt)}` : "尚无同步记录";
  document.querySelector("#auth-actions").hidden = connected;
  const githubButton = document.querySelector("#github-connect-button");
  if (!githubButton.disabled) githubButton.textContent = data.cloud.authenticated ? "连接 GitHub 同步" : "使用 GitHub 登录";
  setText("auth-note", data.cloud.authenticated
    ? `已登录 ${username || "GitHub"}，点击后会继续连接云端小树。`
    : "登录后会自动查找云端小树；有就加入，没有就从本机开始。");
  renderChart(data.chart, context);
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
  if (max === 0 && mascotState !== "empty") setMascotState("empty");
  else if (max > 0 && mascotState === "empty") setMascotState("idle");
  chart.classList.toggle("is-filtered", Boolean(selectedModel));
  chart.setAttribute("aria-label", selectedModel
    ? `最近 30 天 ${selectedModel} 每日 Token 消耗，当前已高亮`
    : "最近 30 天每日 Token 消耗，按模型堆叠");

  for (const model of visible) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    item.classList.toggle("is-selected", model === selectedModel);
    item.style.setProperty("--item-color", colors.get(model));
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
      segment.type = "button";
      segment.className = "bar-segment";
      segment.classList.toggle("is-selected", model === selectedModel);
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
      segment.addEventListener("click", () => selectModel(model));
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

function selectModel(model) {
  selectedModel = model && model !== selectedModel ? model : undefined;
  setText("model-filter-status", selectedModel ? `已高亮 ${selectedModel}` : "已显示全部模型");
  if (dashboardData) render(dashboardData);
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
