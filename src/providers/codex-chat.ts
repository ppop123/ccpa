import express from "express";
import { v4 as uuidv4 } from "uuid";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { callCodexResponses } from "./codex-upstream";

function authErrorResponse(message: string): { status: number; body: { error: { message: string } } } {
  return {
    status: 503,
    body: { error: { message } },
  };
}

function normalizeMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => {
        if (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .join("");
    return text || null;
  }

  return null;
}

function normalizeOutputText(upstream: any): string {
  if (Array.isArray(upstream?.output)) {
    for (const item of upstream.output) {
      if (item?.role !== "assistant" && item?.type !== "message") {
        continue;
      }
      const text = normalizeMessageContent(item?.content);
      if (text) {
        return text;
      }
    }
  }

  if (typeof upstream?.content === "string") {
    return upstream.content;
  }

  if (Array.isArray(upstream?.content)) {
    const text = normalizeMessageContent(upstream.content);
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeUsage(upstream: any): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = upstream?.usage?.input_tokens || 0;
  const completionTokens = upstream?.usage?.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: upstream?.usage?.total_tokens || promptTokens + completionTokens,
  };
}

function normalizeResponse(upstream: any, model: string): any {
  const completionText = normalizeOutputText(upstream);
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: upstream?.model || model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: completionText,
        },
        finish_reason: upstream?.status === "incomplete" ? "length" : "stop",
      },
    ],
    usage: normalizeUsage(upstream),
  };
}

function canonicalizeChatRequest(body: any): any {
  const input = Array.isArray(body?.messages)
    ? body.messages.map((message: any) => ({
        role: message.role,
        content: message.content,
      }))
    : [];

  return {
    model: body?.model || "gpt-5.4",
    input,
    stream: false,
  };
}

export function createCodexChatCompletionsHandler(authStore: CodexAuthStore): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.messages)) {
        res.status(400).json({ error: { message: "messages is required" } });
        return;
      }

      if (body.stream) {
        res.status(501).json({ error: { message: "Codex chat streaming not implemented" } });
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

      const canonicalRequest = canonicalizeChatRequest(body);
      const upstreamResp = await callCodexResponses(snapshot.accessToken, canonicalRequest, false);
      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => "");
        res.status(upstreamResp.status).json({
          error: { message: text || "Codex upstream request failed" },
        });
        return;
      }

      const upstreamJson = await upstreamResp.json();
      res.json(normalizeResponse(upstreamJson, canonicalRequest.model));
    } catch (error: any) {
      res.status(500).json({ error: { message: error?.message || "Internal server error" } });
    }
  };
}
