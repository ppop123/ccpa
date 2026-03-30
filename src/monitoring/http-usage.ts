import express from "express";
import { ProviderName } from "../providers/types";
import { UsageProvider, UsageTracker } from "./usage";

type UsageDetails = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ProviderResolver = (req: express.Request) => UsageProvider;

function parseJsonUsage(body: any): UsageDetails {
  const promptTokens = body?.usage?.prompt_tokens;
  const completionTokens = body?.usage?.completion_tokens;
  const inputTokens = body?.usage?.input_tokens;
  const outputTokens = body?.usage?.output_tokens;
  const countTokens = body?.input_tokens;

  if (typeof promptTokens === "number" || typeof completionTokens === "number") {
    const normalizedPrompt = typeof promptTokens === "number" ? promptTokens : 0;
    const normalizedCompletion = typeof completionTokens === "number" ? completionTokens : 0;
    return {
      model: typeof body?.model === "string" ? body.model : null,
      inputTokens: normalizedPrompt,
      outputTokens: normalizedCompletion,
      totalTokens:
        typeof body?.usage?.total_tokens === "number"
          ? body.usage.total_tokens
          : normalizedPrompt + normalizedCompletion,
    };
  }

  if (typeof inputTokens === "number" || typeof outputTokens === "number") {
    const normalizedInput = typeof inputTokens === "number" ? inputTokens : 0;
    const normalizedOutput = typeof outputTokens === "number" ? outputTokens : 0;
    return {
      model: typeof body?.model === "string" ? body.model : null,
      inputTokens: normalizedInput,
      outputTokens: normalizedOutput,
      totalTokens:
        typeof body?.usage?.total_tokens === "number"
          ? body.usage.total_tokens
          : normalizedInput + normalizedOutput,
    };
  }

  if (typeof countTokens === "number") {
    return {
      model: typeof body?.model === "string" ? body.model : null,
      inputTokens: countTokens,
      outputTokens: 0,
      totalTokens: countTokens,
    };
  }

  return {
    model: typeof body?.model === "string" ? body.model : null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function mergeUsage(base: UsageDetails, next: Partial<UsageDetails>): UsageDetails {
  const inputTokens = typeof next.inputTokens === "number" ? next.inputTokens : base.inputTokens;
  const outputTokens = typeof next.outputTokens === "number" ? next.outputTokens : base.outputTokens;
  const totalTokens =
    typeof next.totalTokens === "number"
      ? next.totalTokens
      : typeof next.inputTokens === "number" || typeof next.outputTokens === "number"
        ? inputTokens + outputTokens
        : base.totalTokens;

  return {
    model: typeof next.model === "string" ? next.model : base.model,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function parseSsePayload(block: string, details: UsageDetails): UsageDetails {
  let currentEvent = "";
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const dataStr = dataLines.join("\n");
  if (!dataStr || dataStr === "[DONE]") {
    return details;
  }

  let payload: any;
  try {
    payload = JSON.parse(dataStr);
  } catch {
    return details;
  }

  if (currentEvent === "response.completed") {
    const usage = payload?.response?.usage || payload?.usage;
    return mergeUsage(details, {
      model: payload?.response?.model || payload?.model || details.model || null,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
    });
  }

  if (currentEvent === "message_delta") {
    return mergeUsage(details, {
      inputTokens: payload?.usage?.input_tokens,
      outputTokens: payload?.usage?.output_tokens,
      totalTokens:
        typeof payload?.usage?.input_tokens === "number" || typeof payload?.usage?.output_tokens === "number"
          ? (payload?.usage?.input_tokens || 0) + (payload?.usage?.output_tokens || 0)
          : undefined,
    });
  }

  if (payload?.usage) {
    return mergeUsage(details, {
      model: payload?.model || details.model || null,
      inputTokens: payload.usage.prompt_tokens ?? payload.usage.input_tokens,
      outputTokens: payload.usage.completion_tokens ?? payload.usage.output_tokens,
      totalTokens: payload.usage.total_tokens,
    });
  }

  return details;
}

function parseSseChunks(buffer: string, details: UsageDetails): { details: UsageDetails; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() || "";
  let current = details;

  for (const block of blocks) {
    current = parseSsePayload(block, current);
  }

  return { details: current, rest };
}

export function wrapTrackedHandler(
  tracker: UsageTracker,
  options: {
    endpoint: string;
    provider: UsageProvider | ProviderResolver;
  },
  handler: express.RequestHandler
): express.RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    const provider =
      typeof options.provider === "function" ? options.provider(req) : options.provider;
    let details: UsageDetails = {
      model: typeof req.body?.model === "string" ? req.body.model : null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let sseBuffer = "";

    const originalJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      details = mergeUsage(details, parseJsonUsage(body));
      return originalJson(body);
    };

    const originalWrite = res.write.bind(res);
    (res as any).write = (chunk: any, encoding?: any, cb?: any) => {
      const bufferEncoding =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? (encoding as BufferEncoding)
          : "utf8";
      const text = Buffer.isBuffer(chunk) ? chunk.toString(bufferEncoding) : String(chunk);
      const parsed = parseSseChunks(sseBuffer + text, details);
      details = parsed.details;
      sseBuffer = parsed.rest;
      return originalWrite(chunk, encoding, cb);
    };

    res.once("finish", () => {
      tracker.record({
        provider,
        endpoint: options.endpoint,
        model: details.model,
        statusCode: res.statusCode,
        success: res.statusCode < 400,
        stream: !!req.body?.stream,
        latencyMs: Date.now() - startedAt,
        inputTokens: details.inputTokens,
        outputTokens: details.outputTokens,
        totalTokens: details.totalTokens,
      });
    });

    handler(req, res, next);
  };
}

export function resolveUsageProvider(provider: ProviderName | null): UsageProvider {
  if (provider === "claude" || provider === "codex") {
    return provider;
  }
  return "unknown";
}
