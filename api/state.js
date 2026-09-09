import { createHash } from "node:crypto";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 32_000;

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
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "Redis request failed.");
  return payload.result;
}

function isValidScheduleItem(item) {
  return item
    && Number.isInteger(item.start)
    && Number.isInteger(item.end)
    && item.start >= 0
    && item.end > item.start
    && item.end <= 60 * 24 * 7
    && typeof item.label === "string"
    && item.label.trim().length > 0
    && item.label.length <= 40;
}

function normalizeState(candidate) {
  const validWakeTimestamp = candidate?.wakeTimestamp === null
    || (Number.isFinite(candidate?.wakeTimestamp) && candidate.wakeTimestamp > 0);
  if (!validWakeTimestamp || !Array.isArray(candidate?.schedule) || candidate.schedule.length > 100) return null;

  const schedule = candidate.schedule
    .map((item) => ({ start: item.start, end: item.end, label: item.label.trim() }))
    .sort((a, b) => a.start - b.start);
  const validSchedule = schedule.every((item, index) => {
    const previous = schedule[index - 1];
    return isValidScheduleItem(item) && (!previous || previous.end <= item.start);
  });
  if (!validSchedule) return null;
  return { wakeTimestamp: candidate.wakeTimestamp, schedule };
}

export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT");
    send(response, 405, { message: "許可されていない操作です。" });
    return;
  }

  const secret = getSecret(request);
  if (!secret) {
    send(response, 401, { message: "共有キーが正しくありません。" });
    return;
  }

  const roomHash = createHash("sha256").update(secret).digest("hex");
  const redisKey = `awake:room:v1:${roomHash}`;

  try {
    if (request.method === "GET") {
      const stored = await redisCommand(["GET", redisKey]);
      if (!stored) {
        send(response, 404, { message: "共有ルームが見つかりません。" });
        return;
      }
      send(response, 200, JSON.parse(stored));
      return;
    }

    const serializedBody = JSON.stringify(request.body || {});
    if (Buffer.byteLength(serializedBody, "utf8") > MAX_BODY_BYTES) {
      send(response, 413, { message: "同期データが大きすぎます。" });
      return;
    }
    const state = normalizeState(request.body?.state);
    if (!state) {
      send(response, 400, { message: "同期データの形式が正しくありません。" });
      return;
    }

    const record = { version: Date.now(), state };
    await redisCommand(["SET", redisKey, JSON.stringify(record)]);
    send(response, 200, record);
  } catch (error) {
    console.error("State sync failed:", error);
    const status = error.code === "SYNC_NOT_CONFIGURED" ? 503 : 500;
    send(response, status, { message: status === 503 ? error.message : "同期処理に失敗しました。" });
  }
}
