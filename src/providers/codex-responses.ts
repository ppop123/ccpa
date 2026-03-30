import express from "express";
import { v4 as uuidv4 } from "uuid";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { callCodexResponses } from "./codex-upstream";

function normalizeOutput(upstream: any): any[] {
  if (Array.isArray(upstream?.output)) {
    return upstream.output;
  }
  if (Array.isArray(upstream?.content)) {
    return [{
      type: "message",
      id: `msg_${uuidv4().replace(/-/g, "")}`,
      role: "assistant",
      status: "completed",
      content: upstream.content,
    }];
  }
  return [];
}

function normalizeUsage(upstream: any): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const inputTokens = upstream?.usage?.input_tokens || 0;
  const outputTokens = upstream?.usage?.output_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: upstream?.usage?.total_tokens || inputTokens + outputTokens,
  };
}

function normalizeResponse(upstream: any, model: string): any {
  return {
    id: upstream?.id || `resp_${uuidv4().replace(/-/g, "")}`,
    object: upstream?.object || "response",
    created_at: upstream?.created_at || Math.floor(Date.now() / 1000),
    status: upstream?.status || "completed",
    model: upstream?.model || model,
    output: normalizeOutput(upstream),
    usage: normalizeUsage(upstream),
  };
}

function authErrorResponse(message: string): { status: number; body: { error: { message: string } } } {
  return {
    status: 503,
    body: { error: { message } },
  };
}

export function createCodexResponsesHandler(authStore: CodexAuthStore): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      const body = req.body || {};
      if (body.stream) {
        res.status(501).json({ error: { message: "Codex streaming not implemented yet" } });
        return;
      }

      let snapshot;
      try {
        snapshot = authStore.load();
      } catch (error) {
        if (error instanceof CodexAuthError) {
          const authError = authErrorResponse(error.message);
          res.status(authError.status).json(authError.body);
          return;
        }
        throw error;
      }

      const upstreamResp = await callCodexResponses(snapshot.accessToken, body);
      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => "");
        res.status(upstreamResp.status).json({
          error: { message: text || "Codex upstream request failed" },
        });
        return;
      }

      const upstreamJson = await upstreamResp.json();
      res.json(normalizeResponse(upstreamJson, body.model || upstreamJson?.model || "gpt-5.4"));
    } catch (error: any) {
      res.status(500).json({ error: { message: error?.message || "Internal server error" } });
    }
  };
}

