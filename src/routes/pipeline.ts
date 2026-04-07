import { Hono } from "hono";
import { getClient } from "../redis";
import { encodeResult } from "../translate/encoding";
import { normalizeResp3 } from "../translate/response";

export const pipelineRoutes = new Hono();

pipelineRoutes.post("/pipeline", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(body)) {
    return c.json(
      { error: "Request body must be a JSON array of command arrays" },
      400,
    );
  }

  const useBase64 = c.req.header("upstash-encoding") === "base64";
  const redis = getClient();

  // Fire all commands concurrently to leverage Bun.redis auto-pipelining.
  // Invalid entries become instantly-rejected promises (no Redis call).
  // Redis executes pipelined commands in FIFO order on a single connection.
  const promises = body.map((cmd) => {
    if (!Array.isArray(cmd) || cmd.length === 0) {
      return Promise.reject(
        new Error("Each pipeline command must be a non-empty array"),
      );
    }
    return redis.send(String(cmd[0]), cmd.slice(1).map(String));
  });

  const settled = await Promise.allSettled(promises);

  const results = settled.map((s) => {
    if (s.status === "fulfilled") {
      let result = normalizeResp3(s.value);
      if (useBase64) result = encodeResult(result);
      return { result };
    }
    const message =
      s.reason instanceof Error ? s.reason.message : String(s.reason);
    return { error: message };
  });

  return c.json(results);
});
