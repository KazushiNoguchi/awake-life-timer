import { createHash } from "node:crypto";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ message: "許可されていない操作です。" });
    return;
  }
  const secret = getSecret(request);
  if (!secret) { response.status(401).json({ message: "共有キーが正しくありません。" }); return; }
  const { url, token } = getRedisConfiguration();
  if (!url || !token) { response.status(503).json({ message: "同期用ストレージが設定されていません。" }); return; }

  const roomHash = createHash("sha256").update(secret).digest("hex");
  const channel = `awake:events:v2:${roomHash}`;
  const controller = new AbortController();
  request.on("close", () => controller.abort());
  try {
    const upstream = await fetch(`${url}/subscribe/${encodeURIComponent(channel)}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal: controller.signal });
    if (!upstream.ok || !upstream.body) throw new Error("Redis subscription failed.");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    const reader = upstream.body.getReader();
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error("Event subscription failed:", error);
    if (!response.headersSent) response.status(502).json({ message: "変更通知へ接続できませんでした。" });
    else response.end();
  }
}
