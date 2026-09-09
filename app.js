"use strict";

const STORAGE_KEY = "awakeLifeTimerStateV2";
const SYNC_HASH_PREFIX = "#sync=";
const SYNC_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const DEFAULT_SCHEDULE = [
  { start: 0, end: 30, label: "起床・身支度" },
  { start: 30, end: 90, label: "朝食・家事" },
  { start: 90, end: 240, label: "集中時間" },
  { start: 240, end: 300, label: "休憩" },
  { start: 300, end: 480, label: "集中時間" },
  { start: 480, end: 540, label: "食事" },
  { start: 540, end: 720, label: "自由時間" },
  { start: 720, end: 840, label: "集中時間" },
  { start: 840, end: 960, label: "入浴・就寝準備" },
  { start: 960, end: 1440, label: "睡眠" },
];

const $ = (selector) => document.querySelector(selector);
const elements = {
  inactiveView: $("#inactive-view"), activeView: $("#active-view"), wakeButton: $("#wake-button"),
  timerButton: $("#timer-button"), timer: $("#timer"), timerModeHint: $("#timer-mode-hint"), clockTime: $("#clock-time"),
  currentLabel: $("#current-label"), currentRange: $("#current-range"), remaining: $("#remaining"),
  progressTrack: $("#progress-track"), progressFill: $("#progress-fill"), nextContent: $("#next-content"),
  taskList: $("#task-list"), taskEmpty: $("#task-empty"), exportTasks: $("#export-tasks"), openTaskDialog: $("#open-task-dialog"),
  taskDialog: $("#task-dialog"), taskForm: $("#task-form"), taskName: $("#task-name"),
  taskDurationField: $("#task-duration-field"), taskDurationLabel: $("#task-duration-label"), taskDuration: $("#task-duration"),
  taskClockField: $("#task-clock-field"), taskClock: $("#task-clock"), taskWeekdays: $("#task-weekdays"), taskFormError: $("#task-form-error"),
  scheduleList: $("#schedule-list"), fullScheduleList: $("#full-schedule-list"), fullScheduleDialog: $("#full-schedule-dialog"), openFullSchedule: $("#open-full-schedule"),
  openAlarmDialog: $("#open-alarm-dialog"), alarmDialog: $("#alarm-dialog"), alarmForm: $("#alarm-form"), alarmName: $("#alarm-name"),
  alarmDurationField: $("#alarm-duration-field"), alarmDurationLabel: $("#alarm-duration-label"), alarmDuration: $("#alarm-duration"),
  alarmClockField: $("#alarm-clock-field"), alarmClock: $("#alarm-clock"), alarmWeekdays: $("#alarm-weekdays"), alarmFormError: $("#alarm-form-error"),
  alarmList: $("#alarm-list"), alarmEmpty: $("#alarm-empty"), testAlarm: $("#test-alarm"), alarmToast: $("#alarm-toast"), alarmToastLabel: $("#alarm-toast-label"), stopAlarm: $("#stop-alarm"),
  openSettings: $("#open-settings"), settingsDialog: $("#settings-dialog"), wakeTimeInput: $("#wake-time-input"), wakeDateNote: $("#wake-date-note"),
  saveWakeTime: $("#save-wake-time"), adjustButtons: document.querySelectorAll("[data-adjust]"), endDayButton: $("#end-day-button"),
  scheduleEditor: $("#schedule-editor"), scheduleRowTemplate: $("#schedule-row-template"), addSchedule: $("#add-schedule"), saveSchedule: $("#save-schedule"), scheduleErrors: $("#schedule-errors"),
  syncStatus: $("#sync-status"), syncDescription: $("#sync-description"), syncDetail: $("#sync-detail"), createSyncRoom: $("#create-sync-room"), copySyncLink: $("#copy-sync-link"), leaveSyncRoom: $("#leave-sync-room"), resetData: $("#reset-data"),
};

let state = loadState();
let timerShowsClock = false;
let deadlineDisplayModes = {};
let lastRenderedSecond = -1;
let lastAlarmCheckSecond = -1;
let audioContext = null;
let alarmInterval = null;
let syncSecret = readSyncSecretFromLocation();
let syncVersion = 0;
let syncRequestInFlight = false;
let syncDirty = false;
let syncRefreshPending = false;
let syncSubscriptionController = null;
let syncReconnectTimer = null;
let syncReconnectDelay = 1000;

function defaultState() {
  return { wakeTimestamp: null, schedule: DEFAULT_SCHEDULE.map((item) => ({ ...item })), tasks: [], alarms: [], taskHistory: [] };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidState(parsed)) return normalizeState(parsed);
  } catch (error) { console.warn("保存データを読み込めませんでした。", error); }

  const migrated = defaultState();
  const oldWake = Number(localStorage.getItem("wakeTimestamp"));
  if (Number.isFinite(oldWake) && oldWake > 0) migrated.wakeTimestamp = oldWake;
  try {
    const oldSchedule = JSON.parse(localStorage.getItem("schedule"));
    if (isValidSchedule(oldSchedule)) migrated.schedule = oldSchedule;
  } catch (_) { /* 初回移行なので無視 */ }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  return migrated;
}

function isValidScheduleItem(item) {
  return item && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= 10080 && typeof item.label === "string" && item.label.trim().length > 0 && item.label.length <= 40;
}

function isValidSchedule(items) {
  if (!Array.isArray(items) || items.length > 100) return false;
  const sorted = [...items].sort((a, b) => a.start - b.start);
  return sorted.every((item, index) => isValidScheduleItem(item) && (!sorted[index - 1] || sorted[index - 1].end <= item.start));
}

function isValidState(candidate) {
  return candidate && (candidate.wakeTimestamp === null || (Number.isFinite(candidate.wakeTimestamp) && candidate.wakeTimestamp > 0))
    && isValidSchedule(candidate.schedule) && Array.isArray(candidate.tasks) && Array.isArray(candidate.alarms) && Array.isArray(candidate.taskHistory);
}

function normalizeState(candidate) {
  return {
    wakeTimestamp: candidate.wakeTimestamp,
    schedule: candidate.schedule.map((item) => ({ start: item.start, end: item.end, label: String(item.label).trim() })).sort((a, b) => a.start - b.start),
    tasks: candidate.tasks.filter((item) => item && typeof item.id === "string" && typeof item.name === "string").slice(0, 500),
    alarms: candidate.alarms.filter((item) => item && typeof item.id === "string" && typeof item.name === "string").slice(0, 200),
    taskHistory: candidate.taskHistory.filter((item) => item && typeof item.lifeDate === "string").slice(-10000),
  };
}

function saveState({ sync = true } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (sync) markStateChanged();
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pad(value) { return String(value).padStart(2, "0"); }
function dateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
function currentLifeDate(now = Date.now()) { return dateKey(state.wakeTimestamp || now); }
function getElapsedMilliseconds(now = Date.now()) { return state.wakeTimestamp ? Math.max(0, now - state.wakeTimestamp) : 0; }
function getElapsedMinutes(now = Date.now()) { return getElapsedMilliseconds(now) / 60000; }
function formatDuration(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  return `${Math.floor(rounded / 60)}:${pad(rounded % 60)}`;
}
function formatElapsed(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
function formatClock(timestamp, seconds = false) {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false }).format(new Date(timestamp));
}
function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}
function initializeTimeSelect(group, selectedMinutes = 0) {
  const hoursSelect = group.querySelector(".hours-select");
  const minutesSelect = group.querySelector(".minutes-select");
  hoursSelect.replaceChildren(...Array.from({ length: 25 }, (_, hour) => new Option(pad(hour), String(hour))));
  minutesSelect.replaceChildren(...Array.from({ length: 12 }, (_, index) => new Option(pad(index * 5), String(index * 5))));
  setTimeSelect(group, selectedMinutes);
}
function setTimeSelect(group, totalMinutes) {
  const rounded = Math.min(24 * 60 + 55, Math.max(0, Math.round(Number(totalMinutes || 0) / 5) * 5));
  group.querySelector(".hours-select").value = String(Math.floor(rounded / 60));
  group.querySelector(".minutes-select").value = String(rounded % 60);
}
function readTimeSelect(group) {
  return Number(group.querySelector(".hours-select").value) * 60 + Number(group.querySelector(".minutes-select").value);
}
function disableTimeSelect(group, disabled) {
  group.querySelectorAll("select").forEach((select) => { select.disabled = disabled; });
}
function timestampAtClock(baseTimestamp, minutes) {
  const date = new Date(baseTimestamp);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}
function nextClockTimestamp(minutes, now = Date.now()) {
  let target = timestampAtClock(now, minutes);
  if (target <= now) target += 86400000;
  return target;
}
function recurrenceLabel(item) {
  if (item.recurrence === "daily") return "毎日";
  if (item.recurrence === "weekly") return `毎週 ${item.weekdays.map((day) => WEEKDAYS[day]).join("・")}`;
  return "一回だけ";
}

function getCurrentScheduleItem(elapsedMinutes) { return state.schedule.find((item) => elapsedMinutes >= item.start && elapsedMinutes < item.end) || null; }
function getNextScheduleItem(elapsedMinutes) { return state.schedule.find((item) => item.start > elapsedMinutes) || null; }
function scheduleTime(minutes) { return `起床後 ${formatDuration(minutes)}`; }

function renderTimer(now = Date.now()) {
  const active = Boolean(state.wakeTimestamp);
  elements.inactiveView.hidden = active;
  elements.activeView.hidden = !active;
  elements.clockTime.textContent = formatClock(now);
  if (!active) return;

  elements.timer.textContent = timerShowsClock ? formatClock(now, true) : formatElapsed(getElapsedMilliseconds(now));
  elements.timerModeHint.textContent = timerShowsClock ? "現在時刻を表示中" : matchMedia("(hover: none)").matches ? "タップで現在時刻" : "カーソルを重ねると現在時刻";
  const elapsedMinutes = getElapsedMinutes(now);
  const current = getCurrentScheduleItem(elapsedMinutes);
  const next = getNextScheduleItem(elapsedMinutes);
  if (current) {
    const percentage = Math.min(100, Math.max(0, ((elapsedMinutes - current.start) / (current.end - current.start)) * 100));
    elements.currentLabel.textContent = current.label;
    elements.currentRange.textContent = `${scheduleTime(current.start)} — ${scheduleTime(current.end)}`;
    elements.remaining.textContent = `あと ${formatDuration(current.end - elapsedMinutes)}`;
    elements.progressFill.style.width = `${percentage}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(percentage)));
  } else {
    elements.currentLabel.textContent = "予定なし";
    elements.currentRange.textContent = "—";
    elements.remaining.textContent = next ? `${scheduleTime(next.start)}まで あと ${formatDuration(next.start - elapsedMinutes)}` : "今日の予定は終了しました";
    elements.progressFill.style.width = "0%";
    elements.progressTrack.setAttribute("aria-valuenow", "0");
  }
  elements.nextContent.textContent = next ? `${scheduleTime(next.start)}　${next.label}` : "予定なし";
}

function scheduleItemNode(item, elapsedMinutes) {
  const li = document.createElement("li");
  const isCurrent = elapsedMinutes !== null && elapsedMinutes >= item.start && elapsedMinutes < item.end;
  li.className = `schedule-item${isCurrent ? " current" : ""}`;
  const stateText = isCurrent ? '<span class="schedule-state">現在</span>' : "";
  li.innerHTML = `<span class="schedule-time">${formatDuration(item.start)}<br>— ${formatDuration(item.end)}</span><p class="schedule-name"></p>`;
  li.querySelector(".schedule-name").textContent = item.label;
  li.querySelector(".schedule-name").insertAdjacentHTML("beforeend", stateText);
  return li;
}

function renderSchedule(now = Date.now()) {
  const elapsed = state.wakeTimestamp ? getElapsedMinutes(now) : null;
  let startIndex = 0;
  if (elapsed !== null) {
    const currentIndex = state.schedule.findIndex((item) => elapsed >= item.start && elapsed < item.end);
    if (currentIndex >= 0) startIndex = currentIndex;
    else {
      const nextIndex = state.schedule.findIndex((item) => item.start > elapsed);
      startIndex = nextIndex >= 0 ? nextIndex : Math.max(0, state.schedule.length - 3);
    }
  }
  const preview = state.schedule.slice(startIndex, startIndex + 3);
  elements.scheduleList.replaceChildren(...preview.map((item) => scheduleItemNode(item, elapsed)));
  elements.fullScheduleList.replaceChildren(...state.schedule.map((item) => scheduleItemNode(item, elapsed)));
}

function taskAppliesOn(task, lifeKey) {
  if (lifeKey < task.createdLifeDate) return false;
  if (task.recurrence === "once") return lifeKey === task.createdLifeDate;
  if (task.recurrence === "daily") return true;
  return task.recurrence === "weekly" && task.weekdays.includes(dateFromKey(lifeKey).getDay());
}

function taskDeadline(task, lifeKey) {
  if (task.recurrence === "once" && Number.isFinite(task.targetTimestamp)) return task.targetTimestamp;
  if (task.timeMode === "awake") {
    if (!state.wakeTimestamp || currentLifeDate() !== lifeKey) return null;
    return state.wakeTimestamp + task.durationMinutes * 60000;
  }
  let target = timestampAtClock(dateFromKey(lifeKey).getTime(), task.clockMinutes);
  if (state.wakeTimestamp && currentLifeDate() === lifeKey && target <= state.wakeTimestamp) target += 86400000;
  return target;
}

function taskDeadlineText(task, lifeKey) {
  const deadline = taskDeadline(task, lifeKey);
  const awakeMode = deadlineDisplayModes[task.id] === "awake";
  if (awakeMode) {
    if (!state.wakeTimestamp || !deadline) return "起床後 --:--";
    return `起床後 ${formatDuration((deadline - state.wakeTimestamp) / 60000)}`;
  }
  return deadline ? formatClock(deadline) : task.timeMode === "awake" ? `起床後 ${formatDuration(task.durationMinutes)}` : "--:--";
}

function visibleTasks() {
  const lifeKey = currentLifeDate();
  return state.tasks.filter((task) => taskAppliesOn(task, lifeKey)).sort((a, b) => (taskDeadline(a, lifeKey) ?? Infinity) - (taskDeadline(b, lifeKey) ?? Infinity));
}

function renderTasks(now = Date.now()) {
  const lifeKey = currentLifeDate(now);
  const tasks = visibleTasks();
  elements.taskEmpty.hidden = tasks.length > 0;
  const nodes = tasks.map((task) => {
    const completedAt = task.completions?.[lifeKey];
    const deadline = taskDeadline(task, lifeKey);
    const row = document.createElement("div");
    row.className = `task-row${completedAt ? " completed" : ""}`;
    const check = document.createElement("input");
    check.type = "checkbox"; check.className = "task-check"; check.checked = Boolean(completedAt); check.setAttribute("aria-label", `${task.name}を完了`);
    check.addEventListener("change", () => toggleTask(task.id, check.checked));
    const copy = document.createElement("div");
    const name = document.createElement("p"); name.className = "task-name"; name.textContent = task.name;
    const meta = document.createElement("span"); meta.className = "task-meta"; meta.textContent = completedAt ? `${formatClock(completedAt)} に達成` : recurrenceLabel(task);
    name.append(meta); copy.append(name);
    const deadlineButton = document.createElement("button"); deadlineButton.type = "button"; deadlineButton.className = `deadline-button${!completedAt && deadline && now > deadline ? " overdue" : ""}`; deadlineButton.textContent = taskDeadlineText(task, lifeKey); deadlineButton.title = "クリックで通常時刻／起床後表示を切り替え";
    deadlineButton.addEventListener("click", () => { deadlineDisplayModes[task.id] = deadlineDisplayModes[task.id] === "awake" ? "clock" : "awake"; renderTasks(); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "row-delete"; remove.textContent = "×"; remove.setAttribute("aria-label", `${task.name}を削除`); remove.addEventListener("click", () => deleteTask(task.id));
    row.append(check, copy, deadlineButton, remove);
    return row;
  });
  elements.taskList.replaceChildren(...nodes);
}

function toggleTask(id, completed) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const key = currentLifeDate();
  task.completions = task.completions || {};
  if (completed) task.completions[key] = Date.now(); else delete task.completions[key];
  saveState(); renderTasks();
}

function deleteTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || !confirm(`「${task.name}」を削除しますか？`)) return;
  const lifeKey = currentLifeDate();
  if (taskAppliesOn(task, lifeKey)) archiveTask(task, lifeKey);
  state.tasks = state.tasks.filter((item) => item.id !== id);
  saveState(); renderTasks();
}

function buildWeekdayOptions(container) {
  const holder = container.querySelector(".weekday-options");
  holder.replaceChildren(...WEEKDAYS.map((name, day) => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${day}"><span>${name}</span>`;
    return label;
  }));
}

function selectedRadio(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value; }
function selectedWeekdays(container) { return [...container.querySelectorAll("input:checked")].map((input) => Number(input.value)); }
function showError(element, message) { element.textContent = message; element.hidden = !message; }

function updateTimeForm(kind) {
  const mode = selectedRadio(`${kind}-time-mode`);
  const recurrence = selectedRadio(`${kind}-recurrence`);
  const durationField = elements[`${kind}DurationField`];
  const clockField = elements[`${kind}ClockField`];
  durationField.hidden = mode === "clock";
  clockField.hidden = mode !== "clock";
  elements[`${kind}DurationLabel`].textContent = mode === "awake" ? "起床からの経過時間" : "現在からの経過時間";
  elements[`${kind}Weekdays`].hidden = recurrence !== "weekly";
}

function createTimedItem(kind) {
  const mode = selectedRadio(`${kind}-time-mode`);
  const recurrence = selectedRadio(`${kind}-recurrence`);
  const weekdays = selectedWeekdays(elements[`${kind}Weekdays`]);
  const now = Date.now();
  if (recurrence === "weekly" && weekdays.length === 0) throw new Error("曜日を1つ以上選んでください。");
  if (mode === "awake" && !state.wakeTimestamp) throw new Error("「起床から」を使うには、先にタイマーを開始してください。");
  const duration = mode === "clock" ? null : readTimeSelect(elements[`${kind}Duration`]);
  const selectedClock = mode === "clock" ? readTimeSelect(elements[`${kind}Clock`]) % 1440 : null;
  if (mode === "relative" && duration === 0) throw new Error("現在からの時間は1分以上にしてください。");
  if (mode === "clock" && selectedClock === null) throw new Error("時刻を入力してください。");

  let targetTimestamp = null;
  let clockMinutes = selectedClock;
  if (mode === "relative") {
    targetTimestamp = now + duration * 60000;
    const target = new Date(targetTimestamp);
    clockMinutes = target.getHours() * 60 + target.getMinutes();
  } else if (mode === "awake") {
    targetTimestamp = state.wakeTimestamp + duration * 60000;
  } else targetTimestamp = nextClockTimestamp(selectedClock, now);

  if (kind === "alarm" && recurrence === "once" && targetTimestamp <= now) {
    throw new Error("一回だけのアラームは、これから先の時刻に設定してください。");
  }

  return { id: uid(), timeMode: mode, durationMinutes: duration, clockMinutes, targetTimestamp: recurrence === "once" ? targetTimestamp : null, recurrence, weekdays, createdAt: now, createdLifeDate: currentLifeDate(now) };
}

function addTask(event) {
  event.preventDefault();
  try {
    const name = elements.taskName.value.trim();
    if (!name) throw new Error("タスク名を入力してください。");
    const task = { ...createTimedItem("task"), name, completions: {}, notified: {} };
    state.tasks.push(task); saveState(); renderTasks(); elements.taskDialog.close(); elements.taskForm.reset(); setTimeSelect(elements.taskDuration, 60); setTimeSelect(elements.taskClock, 540); updateTimeForm("task"); showError(elements.taskFormError, "");
  } catch (error) { showError(elements.taskFormError, error.message); }
}

function addAlarm(event) {
  event.preventDefault();
  try {
    const name = elements.alarmName.value.trim() || "アラーム";
    const alarm = { ...createTimedItem("alarm"), name, enabled: true, triggered: {} };
    state.alarms.push(alarm); saveState(); renderAlarms(); elements.alarmForm.reset(); elements.alarmName.value = "アラーム"; setTimeSelect(elements.alarmDuration, 10); setTimeSelect(elements.alarmClock, 540); updateTimeForm("alarm"); showError(elements.alarmFormError, "");
  } catch (error) { showError(elements.alarmFormError, error.message); }
}

function alarmTarget(alarm, now = Date.now()) {
  if (alarm.recurrence === "once") return { timestamp: alarm.targetTimestamp, key: "once" };
  if (alarm.timeMode === "awake") {
    if (!state.wakeTimestamp) return null;
    const lifeKey = currentLifeDate(now);
    if (alarm.recurrence === "weekly" && !alarm.weekdays.includes(dateFromKey(lifeKey).getDay())) return null;
    return { timestamp: state.wakeTimestamp + alarm.durationMinutes * 60000, key: lifeKey };
  }
  const today = dateKey(now);
  const weekday = new Date(now).getDay();
  if (alarm.recurrence === "weekly" && !alarm.weekdays.includes(weekday)) return null;
  return { timestamp: timestampAtClock(now, alarm.clockMinutes), key: today };
}

function alarmDescription(alarm) {
  let timing;
  if (alarm.timeMode === "awake") timing = `起床後 ${formatDuration(alarm.durationMinutes)}`;
  else if (alarm.recurrence === "once") timing = formatDateTime(alarm.targetTimestamp);
  else timing = `${pad(Math.floor(alarm.clockMinutes / 60))}:${pad(alarm.clockMinutes % 60)}`;
  return `${timing}・${recurrenceLabel(alarm)}`;
}

function renderAlarms() {
  elements.alarmEmpty.hidden = state.alarms.length > 0;
  elements.alarmList.replaceChildren(...state.alarms.map((alarm) => {
    const card = document.createElement("div"); card.className = "alarm-card";
    const copy = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = alarm.name; const small = document.createElement("small"); small.textContent = alarmDescription(alarm); copy.append(strong, small);
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = `toggle${alarm.enabled ? " on" : ""}`; toggle.setAttribute("aria-label", `${alarm.name}を${alarm.enabled ? "オフ" : "オン"}にする`); toggle.addEventListener("click", () => { alarm.enabled = !alarm.enabled; saveState(); renderAlarms(); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "row-delete"; remove.textContent = "×"; remove.addEventListener("click", () => { state.alarms = state.alarms.filter((item) => item.id !== alarm.id); saveState(); renderAlarms(); });
    card.append(copy, toggle, remove); return card;
  }));
}

function ensureAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
}

function playAlarm(label = "時間です") {
  ensureAudio(); stopAlarmSound();
  elements.alarmToastLabel.textContent = label;
  elements.alarmToast.hidden = false;
  const beep = () => {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain();
    oscillator.type = "sine"; oscillator.frequency.setValueAtTime(740, audioContext.currentTime); oscillator.frequency.setValueAtTime(880, audioContext.currentTime + .18);
    gain.gain.setValueAtTime(.0001, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.24, audioContext.currentTime + .025); gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .55);
    oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .58);
  };
  beep(); alarmInterval = window.setInterval(beep, 900);
}

function stopAlarmSound() {
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = null;
  elements.alarmToast.hidden = true;
}

function checkAlarms(now = Date.now()) {
  let changed = false;
  for (const alarm of state.alarms) {
    if (!alarm.enabled) continue;
    const occurrence = alarmTarget(alarm, now);
    if (!occurrence || alarm.triggered?.[occurrence.key]) continue;
    if (now >= occurrence.timestamp && now - occurrence.timestamp < 300000) {
      alarm.triggered = alarm.triggered || {}; alarm.triggered[occurrence.key] = now;
      if (alarm.recurrence === "once") alarm.enabled = false;
      playAlarm(alarm.name); changed = true;
    }
  }
  const lifeKey = currentLifeDate(now);
  for (const task of visibleTasks()) {
    if (task.completions?.[lifeKey] || task.notified?.[lifeKey]) continue;
    const deadline = taskDeadline(task, lifeKey);
    if (deadline && now >= deadline && now - deadline < 300000) {
      task.notified = task.notified || {}; task.notified[lifeKey] = now; playAlarm(`タスク期限：${task.name}`); changed = true;
    }
  }
  if (changed) { saveState(); renderAlarms(); renderTasks(now); }
}

function archiveTask(task, lifeKey) {
  if (state.taskHistory.some((row) => row.lifeDate === lifeKey && row.taskId === task.id)) return;
  const completedAt = task.completions?.[lifeKey] || null;
  state.taskHistory.push({ lifeDate: lifeKey, taskId: task.id, taskName: task.name, deadline: taskDeadline(task, lifeKey), completedAt, status: completedAt ? "達成" : "未達", recurrence: recurrenceLabel(task) });
}

function snapshotTasks(lifeKey = currentLifeDate()) {
  for (const task of state.tasks.filter((item) => taskAppliesOn(item, lifeKey))) archiveTask(task, lifeKey);
}

function exportCsv() {
  const currentKey = currentLifeDate();
  const currentRows = state.tasks.filter((task) => taskAppliesOn(task, currentKey)).map((task) => {
    const completedAt = task.completions?.[currentKey] || null;
    return { lifeDate: currentKey, taskId: task.id, taskName: task.name, deadline: taskDeadline(task, currentKey), completedAt, status: completedAt ? "達成" : "未達", recurrence: recurrenceLabel(task) };
  });
  const currentIds = new Set(currentRows.map((row) => row.taskId));
  const archived = state.taskHistory.filter((row) => row.lifeDate !== currentKey || !currentIds.has(row.taskId));
  const rows = [...archived, ...currentRows].sort((a, b) => a.lifeDate.localeCompare(b.lifeDate) || String(a.deadline || "").localeCompare(String(b.deadline || "")));
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [["起床日", "タスク名", "期限", "結果", "達成時刻", "繰り返し"], ...rows.map((row) => [row.lifeDate, row.taskName, row.deadline ? new Date(row.deadline).toLocaleString("ja-JP") : "", row.status, row.completedAt ? new Date(row.completedAt).toLocaleString("ja-JP") : "", row.recurrence])];
  const blob = new Blob(["\uFEFF", lines.map((line) => line.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `awake-tasks-${currentKey}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function startTimer() {
  state.wakeTimestamp = Date.now(); saveState(); syncWakeControls(); renderAll();
}

function endDay() {
  if (!state.wakeTimestamp || !confirm("今日のタスクを記録して、タイマーを終了しますか？")) return;
  snapshotTasks(currentLifeDate()); state.wakeTimestamp = null; saveState(); syncWakeControls(); renderAll(); elements.settingsDialog.close();
}

function syncWakeControls() {
  const active = Boolean(state.wakeTimestamp);
  disableTimeSelect(elements.wakeTimeInput, !active); elements.saveWakeTime.disabled = !active; elements.endDayButton.disabled = !active;
  elements.adjustButtons.forEach((button) => { button.disabled = !active; });
  if (active) {
    const wakeDate = new Date(state.wakeTimestamp);
    setTimeSelect(elements.wakeTimeInput, wakeDate.getHours() * 60 + wakeDate.getMinutes());
    elements.wakeDateNote.textContent = `${new Date(state.wakeTimestamp).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" })}の起床時刻`;
  } else { setTimeSelect(elements.wakeTimeInput, 0); elements.wakeDateNote.textContent = "タイマー開始後に変更できます。"; }
}

function saveWakeTime() {
  if (!state.wakeTimestamp) return;
  const selectedMinutes = readTimeSelect(elements.wakeTimeInput); const next = new Date(state.wakeTimestamp); next.setHours(Math.floor(selectedMinutes / 60), selectedMinutes % 60, 0, 0);
  if (next.getTime() > Date.now()) { alert("起床時刻を未来には設定できません。"); return; }
  state.wakeTimestamp = next.getTime(); saveState(); syncWakeControls(); renderAll();
}

function adjustWakeTime(minutes) {
  if (!state.wakeTimestamp) return;
  const next = state.wakeTimestamp + minutes * 60000;
  if (next > Date.now()) { alert("起床時刻を未来には設定できません。"); return; }
  state.wakeTimestamp = next; saveState(); syncWakeControls(); renderAll();
}

function appendScheduleEditorRow(item = { start: 0, end: 60, label: "" }) {
  const row = elements.scheduleRowTemplate.content.firstElementChild.cloneNode(true);
  initializeTimeSelect(row.querySelector(".start-time"), item.start); initializeTimeSelect(row.querySelector(".end-time"), item.end); row.querySelector(".label-input").value = item.label;
  row.querySelector(".delete-button").addEventListener("click", () => row.remove()); elements.scheduleEditor.append(row);
}
function renderScheduleEditor() { elements.scheduleEditor.replaceChildren(); state.schedule.forEach(appendScheduleEditorRow); }
function readScheduleEditor() {
  const errors = []; const items = [...elements.scheduleEditor.querySelectorAll(".schedule-editor-row")].map((row, index) => {
    const start = readTimeSelect(row.querySelector(".start-time")); const end = readTimeSelect(row.querySelector(".end-time")); const label = row.querySelector(".label-input").value.trim();
    if (end <= start) errors.push(`${index + 1}行目：終了は開始より後にしてください。`);
    if (!label) errors.push(`${index + 1}行目：内容を入力してください。`);
    return { start, end, label };
  }).sort((a, b) => a.start - b.start);
  items.forEach((item, index) => { if (index && items[index - 1].end > item.start) errors.push(`「${items[index - 1].label}」と「${item.label}」の時間が重なっています。`); });
  return { items, errors };
}
function saveSchedule() {
  const { items, errors } = readScheduleEditor(); showError(elements.scheduleErrors, errors.join("\n"));
  if (errors.length) return;
  state.schedule = items; saveState(); renderSchedule(); elements.settingsDialog.close();
}

function resetData() {
  if (!confirm("すべての起床時刻、予定、タスク、アラーム、履歴を削除しますか？")) return;
  state = defaultState(); saveState(); renderScheduleEditor(); syncWakeControls(); renderAll(); elements.settingsDialog.close();
}

function renderAll(now = Date.now()) { renderTimer(now); renderSchedule(now); renderTasks(now); renderAlarms(); }
function tick() {
  const now = Date.now(); const second = Math.floor(now / 1000);
  if (second !== lastRenderedSecond) { renderTimer(now); if (second % 15 === 0) { renderSchedule(now); renderTasks(now); } lastRenderedSecond = second; }
  if (second !== lastAlarmCheckSecond) { checkAlarms(now); lastAlarmCheckSecond = second; }
  requestAnimationFrame(tick);
}

function readSyncSecretFromLocation() {
  const value = location.hash.startsWith(SYNC_HASH_PREFIX) ? location.hash.slice(SYNC_HASH_PREFIX.length) : "";
  return SYNC_SECRET_PATTERN.test(value) ? value : null;
}
function createSyncSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function setSyncStatus(kind, detail) {
  const labels = { local: "この端末のみ", connecting: "同期接続中", connected: "同期中", saving: "同期保存中", error: "同期エラー" };
  elements.syncStatus.textContent = labels[kind] || labels.local; elements.syncStatus.className = `sync-status${kind === "connected" || kind === "saving" ? " connected" : kind === "error" ? " error" : ""}`;
  if (detail) elements.syncDetail.textContent = detail;
}
function renderSyncControls() {
  const shared = Boolean(syncSecret); elements.createSyncRoom.hidden = shared; elements.copySyncLink.hidden = !shared; elements.leaveSyncRoom.hidden = !shared;
  if (!shared) setSyncStatus("local", "現在、この端末内だけに保存されています。");
}
function getLocalSyncState() { return JSON.parse(JSON.stringify(state)); }
function markStateChanged() { if (!syncSecret) return; syncDirty = true; void pushSyncState(); }
async function requestSync(method, body) {
  const response = await fetch("/api/state", { method, headers: { Authorization: `Bearer ${syncSecret}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store" });
  let payload = {}; try { payload = await response.json(); } catch (_) { /* statusで処理 */ }
  if (!response.ok) { const error = new Error(payload.message || `同期エラー (${response.status})`); error.status = response.status; throw error; }
  return payload;
}
async function pushSyncState() {
  if (!syncSecret || !syncDirty || syncRequestInFlight) return;
  syncRequestInFlight = true; syncDirty = false; setSyncStatus("saving", "変更を共有ルームへ保存しています…");
  try { const record = await requestSync("PUT", { state: getLocalSyncState() }); syncVersion = Math.max(syncVersion, Number(record.version) || 0); setSyncStatus("connected", "操作内容は共有リンクを開いた端末へ同期されます。"); }
  catch (error) { syncDirty = true; setSyncStatus("error", error.message); }
  finally { syncRequestInFlight = false; if (syncDirty) window.setTimeout(() => void pushSyncState(), 1200); }
}
async function pullSyncState() {
  if (!syncSecret || syncRefreshPending) return;
  syncRefreshPending = true;
  try {
    const record = await requestSync("GET");
    if (Number(record.version) > syncVersion && isValidState(record.state)) { state = normalizeState(record.state); syncVersion = Number(record.version); saveState({ sync: false }); renderScheduleEditor(); syncWakeControls(); renderAll(); }
    setSyncStatus("connected", "操作内容は共有リンクを開いた端末へ同期されます。");
  } catch (error) { if (error.status !== 404) setSyncStatus("error", error.message); }
  finally { syncRefreshPending = false; }
}
function stopSyncSubscription() { syncSubscriptionController?.abort(); syncSubscriptionController = null; if (syncReconnectTimer) clearTimeout(syncReconnectTimer); syncReconnectTimer = null; }
function scheduleSyncReconnect() {
  if (!syncSecret || syncReconnectTimer) return;
  syncReconnectTimer = window.setTimeout(() => { syncReconnectTimer = null; void connectSyncSubscription(); }, syncReconnectDelay); syncReconnectDelay = Math.min(syncReconnectDelay * 2, 30000);
}
async function connectSyncSubscription() {
  if (!syncSecret || syncSubscriptionController) return;
  const controller = new AbortController(); syncSubscriptionController = controller;
  try {
    const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${syncSecret}`, Accept: "text/event-stream" }, signal: controller.signal, cache: "no-store" });
    if (!response.ok || !response.body) throw new Error("変更通知へ接続できません。");
    syncReconnectDelay = 1000; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) if (line.startsWith("data:") && /message/.test(line)) void pullSyncState();
    }
  } catch (error) { if (!controller.signal.aborted) console.warn(error.message); }
  finally { if (syncSubscriptionController === controller) syncSubscriptionController = null; if (!controller.signal.aborted) scheduleSyncReconnect(); }
}
async function initializeSync() {
  renderSyncControls(); if (!syncSecret) return;
  setSyncStatus("connecting", "共有ルームへ接続しています…");
  try { const record = await requestSync("GET"); if (isValidState(record.state)) { state = normalizeState(record.state); syncVersion = Number(record.version) || 0; saveState({ sync: false }); renderScheduleEditor(); syncWakeControls(); renderAll(); } }
  catch (error) { if (error.status === 404) { syncDirty = true; await pushSyncState(); } else setSyncStatus("error", error.message); }
  void connectSyncSubscription();
}
async function createSyncRoom() {
  syncSecret = createSyncSecret(); history.replaceState(null, "", `${location.pathname}${location.search}${SYNC_HASH_PREFIX}${syncSecret}`); renderSyncControls(); syncDirty = true; await pushSyncState(); void connectSyncSubscription();
}
async function copySyncLink() {
  try { await navigator.clipboard.writeText(location.href); elements.syncDetail.textContent = "共有リンクをコピーしました。別の端末で開いてください。"; }
  catch (_) { prompt("このリンクをコピーしてください", location.href); }
}
function leaveSyncRoom() { if (!confirm("この端末を共有ルームから外しますか？端末内のデータは残ります。")) return; stopSyncSubscription(); syncSecret = null; history.replaceState(null, "", `${location.pathname}${location.search}`); renderSyncControls(); }

function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
document.addEventListener("click", () => ensureAudio(), { once: true });
elements.wakeButton.addEventListener("click", startTimer);
elements.timerButton.addEventListener("mouseenter", () => { timerShowsClock = true; renderTimer(); });
elements.timerButton.addEventListener("mouseleave", () => { timerShowsClock = false; renderTimer(); });
elements.timerButton.addEventListener("focus", () => { timerShowsClock = true; renderTimer(); });
elements.timerButton.addEventListener("blur", () => { timerShowsClock = false; renderTimer(); });
elements.timerButton.addEventListener("click", () => { if (matchMedia("(hover: none)").matches) { timerShowsClock = !timerShowsClock; renderTimer(); } });
elements.openTaskDialog.addEventListener("click", () => { showError(elements.taskFormError, ""); openDialog(elements.taskDialog); elements.taskName.focus(); });
elements.taskForm.addEventListener("submit", addTask);
elements.openAlarmDialog.addEventListener("click", () => openDialog(elements.alarmDialog));
elements.alarmForm.addEventListener("submit", addAlarm);
elements.testAlarm.addEventListener("click", () => playAlarm("アラーム音のテスト")); elements.stopAlarm.addEventListener("click", stopAlarmSound);
elements.openFullSchedule.addEventListener("click", () => { renderSchedule(); openDialog(elements.fullScheduleDialog); });
elements.openSettings.addEventListener("click", () => { renderScheduleEditor(); syncWakeControls(); openDialog(elements.settingsDialog); });
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll('input[name$="-time-mode"], input[name$="-recurrence"]').forEach((input) => input.addEventListener("change", () => updateTimeForm(input.name.startsWith("task") ? "task" : "alarm")));
elements.exportTasks.addEventListener("click", exportCsv); elements.saveWakeTime.addEventListener("click", saveWakeTime); elements.endDayButton.addEventListener("click", endDay);
elements.adjustButtons.forEach((button) => button.addEventListener("click", () => adjustWakeTime(Number(button.dataset.adjust))));
elements.addSchedule.addEventListener("click", () => {
  const lastEnd = state.schedule.length ? state.schedule[state.schedule.length - 1].end : 0;
  appendScheduleEditorRow({ start: lastEnd, end: lastEnd + 60, label: "" });
});
elements.saveSchedule.addEventListener("click", saveSchedule); elements.resetData.addEventListener("click", resetData);
elements.createSyncRoom.addEventListener("click", createSyncRoom); elements.copySyncLink.addEventListener("click", copySyncLink); elements.leaveSyncRoom.addEventListener("click", leaveSyncRoom);
window.addEventListener("hashchange", () => { const next = readSyncSecretFromLocation(); if (next === syncSecret) return; stopSyncSubscription(); syncSecret = next; syncVersion = 0; void initializeSync(); });
window.addEventListener("storage", (event) => { if (event.key !== STORAGE_KEY || syncSecret) return; state = loadState(); renderScheduleEditor(); syncWakeControls(); renderAll(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { void pullSyncState(); checkAlarms(); renderAll(); } });

initializeTimeSelect(elements.taskDuration, 60); initializeTimeSelect(elements.taskClock, 540);
initializeTimeSelect(elements.alarmDuration, 10); initializeTimeSelect(elements.alarmClock, 540);
initializeTimeSelect(elements.wakeTimeInput, 0);
buildWeekdayOptions(elements.taskWeekdays); buildWeekdayOptions(elements.alarmWeekdays); updateTimeForm("task"); updateTimeForm("alarm");
renderScheduleEditor(); syncWakeControls(); renderAll(); void initializeSync(); requestAnimationFrame(tick);
