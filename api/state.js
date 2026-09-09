import { createHash } from "node:crypto";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 512_000;

function send(response, status, body) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.status(status).json(body);
}

function getSecret(request) {
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const secret = authorization.slice(7);
  return SECRET_PATTERN.test(secret) ? secret : null;
}

function getRedisConfiguration() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfiguration();
  if (!url || !token) {
    const error = new Error("同期用ストレージが設定されていません。");
    error.code = "SYNC_NOT_CONFIGURED";
    throw error;
  }
  const upstream = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const payload = await upstream.json();
  if (!upstream.ok || payload.error) throw new Error(payload.error || "Redis request failed.");
  return payload.result;
}

function isValidScheduleItem(item) {
  return item && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= 10080 && typeof item.label === "string" && item.label.trim().length > 0 && item.label.length <= 40;
}

function normalizeState(candidate) {
  const validWake = candidate?.wakeTimestamp === null || (Number.isFinite(candidate?.wakeTimestamp) && candidate.wakeTimestamp > 0);
  if (!candidate || !validWake || !Array.isArray(candidate.schedule) || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.alarms) || !Array.isArray(candidate.taskHistory) || (candidate.journals !== undefined && !Array.isArray(candidate.journals))) return null;
  const journals = candidate.journals || [];
  if (candidate.schedule.length > 100 || candidate.tasks.length > 500 || candidate.alarms.length > 200 || candidate.taskHistory.length > 10000 || journals.length > 1000) return null;

  const schedule = candidate.schedule.map((item) => ({ start: item.start, end: item.end, label: item.label?.trim() })).sort((a, b) => a.start - b.start);
  const validSchedule = schedule.every((item, index) => isValidScheduleItem(item) && (!schedule[index - 1] || schedule[index - 1].end <= item.start));
  const validTasks = candidate.tasks.every((item) => item && typeof item.id === "string" && item.id.length <= 100 && typeof item.name === "string" && item.name.length <= 80);
  const validAlarms = candidate.alarms.every((item) => item && typeof item.id === "string" && item.id.length <= 100 && typeof item.name === "string" && item.name.length <= 80);
  const validHistory = candidate.taskHistory.every((item) => item && typeof item.lifeDate === "string" && typeof item.taskName === "string");
  const validJournals = journals.every((item) => item && typeof item.lifeDate === "string" && typeof item.text === "string" && item.text.length >= 1 && item.text.length <= 10000);
  if (!validSchedule || !validTasks || !validAlarms || !validHistory || !validJournals) return null;

  return JSON.parse(JSON.stringify({ wakeTimestamp: candidate.wakeTimestamp, schedule, tasks: candidate.tasks, alarms: candidate.alarms, taskHistory: candidate.taskHistory, journals }));
}

export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT");
    send(response, 405, { message: "許可されていない操作です。" });
    return;
  }
  const secret = getSecret(request);
  if (!secret) { send(response, 401, { message: "共有キーが正しくありません。" }); return; }

  const roomHash = createHash("sha256").update(secret).digest("hex");
  const redisKey = `awake:room:v2:${roomHash}`;
  const eventChannel = `awake:events:v2:${roomHash}`;
  try {
    if (request.method === "GET") {
      const stored = await redisCommand(["GET", redisKey]);
      if (!stored) { send(response, 404, { message: "共有ルームが見つかりません。" }); return; }
      send(response, 200, JSON.parse(stored));
      return;
    }

    const serializedBody = JSON.stringify(request.body || {});
    if (Buffer.byteLength(serializedBody, "utf8") > MAX_BODY_BYTES) { send(response, 413, { message: "同期データが大きすぎます。CSVへ出力後、古い履歴を整理してください。" }); return; }
    const normalized = normalizeState(request.body?.state);
    if (!normalized) { send(response, 400, { message: "同期データの形式が正しくありません。" }); return; }

    const record = { version: Date.now(), state: normalized };
    await redisCommand(["SET", redisKey, JSON.stringify(record)]);
    let notified = true;
    try { await redisCommand(["PUBLISH", eventChannel, String(record.version)]); }
    catch (notificationError) { notified = false; console.error("State saved, but notification failed:", notificationError); }
    send(response, 200, { ...record, notified });
  } catch (error) {
    console.error("State sync failed:", error);
    const status = error.code === "SYNC_NOT_CONFIGURED" ? 503 : 500;
    send(response, status, { message: status === 503 ? error.message : "同期処理に失敗しました。" });
  }
}
