"use strict";

const STORAGE_KEYS = {
  wakeTimestamp: "wakeTimestamp",
  schedule: "schedule",
  settings: "settings",
};

const DEFAULT_SCHEDULE = [
  { start: 0, end: 30, label: "起床・準備" },
  { start: 30, end: 90, label: "朝食・家事" },
  { start: 90, end: 240, label: "制作" },
  { start: 240, end: 300, label: "休憩" },
  { start: 300, end: 480, label: "制作" },
  { start: 480, end: 540, label: "食事" },
  { start: 540, end: 720, label: "自由時間" },
  { start: 720, end: 840, label: "制作" },
  { start: 840, end: 960, label: "入浴・就寝準備" },
  { start: 960, end: 1440, label: "就寝" },
];

const elements = {
  inactiveView: document.querySelector("#inactive-view"),
  activeView: document.querySelector("#active-view"),
  wakeButton: document.querySelector("#wake-button"),
  timer: document.querySelector("#timer"),
  clockTime: document.querySelector("#clock-time"),
  currentLabel: document.querySelector("#current-label"),
  currentRange: document.querySelector("#current-range"),
  remaining: document.querySelector("#remaining"),
  progressTrack: document.querySelector("#progress-track"),
  progressFill: document.querySelector("#progress-fill"),
  nextContent: document.querySelector("#next-content"),
  scheduleList: document.querySelector("#schedule-list"),
  openSettings: document.querySelector("#open-settings"),
  settingsDialog: document.querySelector("#settings-dialog"),
  wakeTimeInput: document.querySelector("#wake-time-input"),
  wakeDateNote: document.querySelector("#wake-date-note"),
  saveWakeTime: document.querySelector("#save-wake-time"),
  adjustButtons: document.querySelectorAll("[data-adjust]"),
  endDayButton: document.querySelector("#end-day-button"),
  scheduleEditor: document.querySelector("#schedule-editor"),
  scheduleRowTemplate: document.querySelector("#schedule-row-template"),
  addSchedule: document.querySelector("#add-schedule"),
  saveSchedule: document.querySelector("#save-schedule"),
  scheduleErrors: document.querySelector("#schedule-errors"),
  resetData: document.querySelector("#reset-data"),
};

let wakeTimestamp = loadWakeTimestamp();
let schedule = loadSchedule();
let lastRenderedSecond = -1;

function cloneDefaultSchedule() {
  return DEFAULT_SCHEDULE.map((item) => ({ ...item }));
}

function loadWakeTimestamp() {
  const value = Number(localStorage.getItem(STORAGE_KEYS.wakeTimestamp));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isValidScheduleItem(item) {
  return item
    && Number.isInteger(item.start)
    && Number.isInteger(item.end)
    && item.start >= 0
    && item.end > item.start
    && typeof item.label === "string"
    && item.label.trim().length > 0;
}

function isValidSchedule(items) {
  if (!Array.isArray(items)) return false;
  const sorted = [...items].sort((a, b) => a.start - b.start);
  return sorted.every((item, index) => {
    const previous = sorted[index - 1];
    return isValidScheduleItem(item) && (!previous || previous.end <= item.start);
  });
}

function loadSchedule() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.schedule));
    if (isValidSchedule(saved)) {
      return saved.sort((a, b) => a.start - b.start);
    }
  } catch (error) {
    console.warn("保存されたスケジュールを読み込めませんでした。", error);
  }
  const defaults = cloneDefaultSchedule();
  localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(defaults));
  return defaults;
}

function ensureSettings() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    if (current && typeof current === "object") return;
  } catch (error) {
    console.warn("保存された設定を読み込めませんでした。", error);
  }
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ version: 1 }));
}

function getElapsedMilliseconds(now = Date.now()) {
  if (!wakeTimestamp) return 0;
  return Math.max(0, now - wakeTimestamp);
}

function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatScheduleTime(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatEditorTime(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  return `${Math.floor(safeMinutes / 60)}:${String(safeMinutes % 60).padStart(2, "0")}`;
}

function parseElapsedTime(value) {
  const match = /^\s*(\d{1,3}):([0-5]\d)\s*$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getElapsedMinutes(now = Date.now()) {
  return getElapsedMilliseconds(now) / 60000;
}

function getCurrentScheduleItem(elapsedMinutes) {
  return schedule.find((item) => item.start <= elapsedMinutes && elapsedMinutes < item.end) || null;
}

function getNextScheduleItem(elapsedMinutes) {
  return schedule.find((item) => item.start > elapsedMinutes) || null;
}

function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (totalSeconds < 60) return `あと ${totalSeconds}秒`;
  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return `あと ${totalMinutes}分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `あと ${hours}時間` : `あと ${hours}時間${minutes}分`;
}

function renderTimer(now = Date.now()) {
  elements.clockTime.textContent = new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  const isActive = wakeTimestamp !== null;
  elements.inactiveView.hidden = isActive;
  elements.activeView.hidden = !isActive;

  if (!isActive) {
    renderSchedule(null);
    return;
  }

  const elapsedMilliseconds = getElapsedMilliseconds(now);
  const elapsedMinutes = elapsedMilliseconds / 60000;
  const current = getCurrentScheduleItem(elapsedMinutes);
  const next = getNextScheduleItem(elapsedMinutes);

  elements.timer.textContent = formatElapsedTime(elapsedMilliseconds);

  if (current) {
    const remainingMilliseconds = current.end * 60000 - elapsedMilliseconds;
    const progress = Math.max(0, Math.min(1, (elapsedMinutes - current.start) / (current.end - current.start)));
    elements.currentLabel.textContent = current.label;
    elements.currentRange.textContent = `${formatScheduleTime(current.start)} → ${formatScheduleTime(current.end)}`;
    elements.remaining.textContent = formatRemaining(remainingMilliseconds);
    elements.progressTrack.hidden = false;
    elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
    elements.progressFill.style.width = `${progress * 100}%`;
  } else {
    elements.currentLabel.textContent = "予定なし";
    elements.currentRange.textContent = "—";
    elements.remaining.textContent = next
      ? `${formatRemaining(next.start * 60000 - elapsedMilliseconds)}で次の予定`
      : "今日の予定は終了しました";
    elements.progressTrack.hidden = true;
    elements.progressFill.style.width = "0%";
  }

  elements.nextContent.textContent = next
    ? `${formatScheduleTime(next.start)}  ${next.label}`
    : "予定なし";
  renderSchedule(elapsedMinutes);
}

function renderSchedule(elapsedMinutes = wakeTimestamp ? getElapsedMinutes() : null) {
  const fragment = document.createDocumentFragment();
  for (const item of schedule) {
    const listItem = document.createElement("li");
    listItem.className = "schedule-item";
    if (elapsedMinutes !== null) {
      if (item.start <= elapsedMinutes && elapsedMinutes < item.end) listItem.classList.add("is-current");
      else if (item.end <= elapsedMinutes) listItem.classList.add("is-past");
    }

    const time = document.createElement("time");
    time.textContent = formatScheduleTime(item.start);
    const label = document.createElement("span");
    label.className = "schedule-item-label";
    label.textContent = item.label;
    listItem.append(time, label);
    fragment.append(listItem);
  }
  elements.scheduleList.replaceChildren(fragment);
}

function startTimer() {
  wakeTimestamp = Date.now();
  localStorage.setItem(STORAGE_KEYS.wakeTimestamp, String(wakeTimestamp));
  syncWakeControls();
  lastRenderedSecond = -1;
  renderTimer();
}

function endDay() {
  if (!wakeTimestamp) return;
  if (!window.confirm("今日のタイマーを終了しますか？")) return;
  wakeTimestamp = null;
  localStorage.removeItem(STORAGE_KEYS.wakeTimestamp);
  syncWakeControls();
  lastRenderedSecond = -1;
  renderTimer();
  elements.settingsDialog.close();
}

function formatInputTime(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatWakeDate(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(timestamp);
}

function syncWakeControls() {
  const active = wakeTimestamp !== null;
  elements.wakeTimeInput.disabled = !active;
  elements.saveWakeTime.disabled = !active;
  elements.endDayButton.disabled = !active;
  elements.adjustButtons.forEach((button) => { button.disabled = !active; });

  if (active) {
    elements.wakeTimeInput.value = formatInputTime(wakeTimestamp);
    elements.wakeDateNote.textContent = `${formatWakeDate(wakeTimestamp)}の起床時刻`;
  } else {
    elements.wakeTimeInput.value = "";
    elements.wakeDateNote.textContent = "タイマー開始後に変更できます。";
  }
}

function saveWakeTime() {
  if (!wakeTimestamp || !elements.wakeTimeInput.value) return;
  const [hours, minutes] = elements.wakeTimeInput.value.split(":").map(Number);
  const changed = new Date(wakeTimestamp);
  changed.setHours(hours, minutes, 0, 0);
  if (changed.getTime() > Date.now()) {
    window.alert("起床時刻は現在より前の時刻を指定してください。");
    return;
  }
  wakeTimestamp = changed.getTime();
  localStorage.setItem(STORAGE_KEYS.wakeTimestamp, String(wakeTimestamp));
  syncWakeControls();
  lastRenderedSecond = -1;
  renderTimer();
}

function adjustWakeTime(minutes) {
  if (!wakeTimestamp) return;
  const changed = wakeTimestamp + minutes * 60000;
  if (changed > Date.now()) {
    window.alert("起床時刻は現在より前の時刻を指定してください。");
    return;
  }
  wakeTimestamp = changed;
  localStorage.setItem(STORAGE_KEYS.wakeTimestamp, String(wakeTimestamp));
  syncWakeControls();
  lastRenderedSecond = -1;
  renderTimer();
}

function appendScheduleEditorRow(item = { start: 0, end: 60, label: "" }) {
  const row = elements.scheduleRowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".start-input").value = formatEditorTime(item.start);
  row.querySelector(".end-input").value = formatEditorTime(item.end);
  row.querySelector(".label-input").value = item.label;
  row.querySelector(".delete-button").addEventListener("click", () => row.remove());
  elements.scheduleEditor.append(row);
}

function renderScheduleEditor() {
  elements.scheduleEditor.replaceChildren();
  schedule.forEach(appendScheduleEditorRow);
  hideScheduleErrors();
}

function readScheduleEditor() {
  const rows = [...elements.scheduleEditor.querySelectorAll(".schedule-editor-row")];
  const errors = [];
  const items = rows.map((row, index) => {
    const startText = row.querySelector(".start-input").value;
    const endText = row.querySelector(".end-input").value;
    const label = row.querySelector(".label-input").value.trim();
    const start = parseElapsedTime(startText);
    const end = parseElapsedTime(endText);
    const rowNumber = index + 1;

    if (start === null || end === null) errors.push(`${rowNumber}行目: 時間は「3:30」の形式で入力してください。`);
    else if (start >= end) errors.push(`${rowNumber}行目: 終了は開始より後にしてください。`);
    if (!label) errors.push(`${rowNumber}行目: 内容を入力してください。`);
    return { start, end, label };
  });

  const validItems = items.filter((item) => item.start !== null && item.end !== null).sort((a, b) => a.start - b.start);
  validItems.forEach((item, index) => {
    const previous = validItems[index - 1];
    if (previous && item.start < previous.end) {
      errors.push(`「${previous.label || "予定"}」と「${item.label || "予定"}」の時間が重複しています。`);
    }
  });

  return { items: validItems, errors: [...new Set(errors)] };
}

function showScheduleErrors(errors) {
  elements.scheduleErrors.textContent = errors.join("\n");
  elements.scheduleErrors.style.whiteSpace = "pre-line";
  elements.scheduleErrors.hidden = false;
  elements.scheduleErrors.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideScheduleErrors() {
  elements.scheduleErrors.hidden = true;
  elements.scheduleErrors.textContent = "";
}

function saveSchedule() {
  const { items, errors } = readScheduleEditor();
  if (errors.length) {
    showScheduleErrors(errors);
    return;
  }
  schedule = items;
  localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(schedule));
  hideScheduleErrors();
  renderScheduleEditor();
  lastRenderedSecond = -1;
  renderTimer();
}

function addScheduleRow() {
  const rows = [...elements.scheduleEditor.querySelectorAll(".schedule-editor-row")];
  const lastRow = rows.at(-1);
  const lastEnd = lastRow ? parseElapsedTime(lastRow.querySelector(".end-input").value) : 0;
  const start = lastEnd ?? 0;
  appendScheduleEditorRow({ start, end: start + 60, label: "" });
  const newRow = elements.scheduleEditor.lastElementChild;
  newRow.querySelector(".label-input").focus();
  newRow.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetData() {
  if (!window.confirm("すべての設定を初期化しますか？ この操作は取り消せません。")) return;
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  wakeTimestamp = null;
  schedule = cloneDefaultSchedule();
  localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(schedule));
  ensureSettings();
  syncWakeControls();
  renderScheduleEditor();
  lastRenderedSecond = -1;
  renderTimer();
  elements.settingsDialog.close();
}

function openSettings() {
  syncWakeControls();
  renderScheduleEditor();
  elements.settingsDialog.showModal();
}

function tick() {
  const now = Date.now();
  const second = Math.floor(now / 1000);
  if (second !== lastRenderedSecond) {
    lastRenderedSecond = second;
    renderTimer(now);
  }
  window.requestAnimationFrame(tick);
}

elements.wakeButton.addEventListener("click", startTimer);
elements.openSettings.addEventListener("click", openSettings);
elements.saveWakeTime.addEventListener("click", saveWakeTime);
elements.adjustButtons.forEach((button) => {
  button.addEventListener("click", () => adjustWakeTime(Number(button.dataset.adjust)));
});
elements.endDayButton.addEventListener("click", endDay);
elements.addSchedule.addEventListener("click", addScheduleRow);
elements.saveSchedule.addEventListener("click", saveSchedule);
elements.resetData.addEventListener("click", resetData);
elements.settingsDialog.addEventListener("click", (event) => {
  if (event.target === elements.settingsDialog) elements.settingsDialog.close();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    lastRenderedSecond = -1;
    renderTimer();
  }
});

ensureSettings();
syncWakeControls();
renderScheduleEditor();
renderTimer();
window.requestAnimationFrame(tick);
