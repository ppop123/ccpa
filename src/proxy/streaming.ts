import { Response as ExpressResponse } from "express";
import { setFailureContext } from "../monitoring/http-usage";
import { claudeStreamEventToOpenai, createStreamState } from "./translator";

export interface StreamResult {
  completed: boolean;
  clientDisconnected: boolean;
}

export async function handleStreamingResponse(
  upstreamResp: Response,
  res: ExpressResponse,
  model: string,
  options: { includeUsage?: boolean; legacyFunctionCall?: boolean } = {}
): Promise<StreamResult> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    setFailureContext(res, {
      stage: "upstream",
      kind: "network_error",
      message: "Upstream stream ended before completion",
    });
    res.end();
    return { completed: false, clientDisconnected: false };
  }

  const decoder = new TextDecoder();
  const state = createStreamState(model, options);
  let buffer = "";
  let clientDisconnected = false;
  let completed = false;
  let currentEvent = "";

  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (clientDisconnected) break;
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            const chunks = claudeStreamEventToOpenai(currentEvent, data, state);
            for (const chunk of chunks) {
              if (chunk === "[DONE]") {
                completed = true;
              }
              res.write(`data: ${chunk}\n\n`);
            }
          } catch {
            // non-JSON data line, skip
          }
        }
      }
    }
  } catch (err) {
    if (!clientDisconnected) console.error("Stream error:", err);
  } finally {
    if (!clientDisconnected) {
      if (!completed) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: "Upstream stream ended before completion",
        });
      }
      res.end();
    }
  }
  return { completed, clientDisconnected };
}
