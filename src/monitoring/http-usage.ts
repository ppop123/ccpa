import express from "express";
import { ProviderName } from "../providers/types";
import { UsageFailureContext, UsageProvider, UsageRequestSummary, UsageTracker } from "./usage";

type UsageDetails = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

type ProviderResolver = (req: express.Request) => UsageProvider;

type FailureContextInput = Omit<UsageFailureContext, "requestSummary">;

const FAILURE_CONTEXT_KEY = "__usageFailureContext";

function getClientIp(req: express.Request): string {
  const forwardedFor = req.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }

  const candidate = req.ip || req.socket.remoteAddress || req.connection.remoteAddress;
  if (!candidate) {
    return "unknown";
  }

  return candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate;
}

function getUserAgent(req: express.Request): string | null {
  const value = req.get("user-agent");
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstHeaderValue(req: express.Request, names: string[]): string | null {
  for (const name of names) {
    const value = req.get(name);
    if (value) {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function classifySource(req: express.Request, clientIp: string, userAgent: string | null): string {
  const explicitSource = firstHeaderValue(req, ["x-request-source", "x-ccpa-source"]);
  if (explicitSource) {
    return explicitSource;
  }

  const openclawAgent = firstHeaderValue(req, ["x-openclaw-agent"]);
  if (openclawAgent) {
    return `openclaw:${openclawAgent}`;
  }

  const openclawSession = firstHeaderValue(req, ["x-openclaw-session"]);
  if (openclawSession) {
    return `openclaw-session:${openclawSession}`;
  }

  const openclawRun = firstHeaderValue(req, ["x-openclaw-run-id"]);
  if (openclawRun) {
    return `openclaw-run:${openclawRun}`;
  }

  const loweredAgent = (userAgent || "").toLowerCase();
  if (loweredAgent.includes("openclaw")) {
    return "openclaw";
  }
  if (loweredAgent.includes("clade")) {
    return "clade";
  }
  if (loweredAgent.includes("claude-cli")) {
    return "claude-cli";
  }
  if (loweredAgent.includes("curl/")) {
    return "curl";
  }
  if (loweredAgent.includes("openai/")) {
    return "openai-sdk";
  }
  if (loweredAgent.includes("python")) {
    return "python-client";
  }
  if (loweredAgent.includes("node")) {
    return "node-client";
  }
  if (clientIp === "127.0.0.1" || clientIp === "::1") {
    return "local";
  }
  return "direct";
}

function summarizeRequestBody(body: any): UsageRequestSummary {
  const objectBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const messages = Array.isArray(objectBody.messages) ? objectBody.messages : null;
  const input = objectBody.input;
  const inputs = Array.isArray(input) ? input : null;
  const maxTokensCandidates = [
    objectBody.max_tokens,
    objectBody.max_output_tokens,
    objectBody.max_completion_tokens,
  ];
  const maxTokens = maxTokensCandidates.find((value) => typeof value === "number");

  const systemCountFromMessages = messages
    ? messages.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          ("role" in item) &&
          (((item as { role?: unknown }).role === "system") ||
            ((item as { role?: unknown }).role === "developer"))
      ).length
    : null;

  const systemCountFromInput = inputs
    ? inputs.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          ("role" in item) &&
          (((item as { role?: unknown }).role === "system") ||
            ((item as { role?: unknown }).role === "developer"))
      ).length
    : null;

  return {
    bodyKeys: Object.keys(objectBody).sort(),
    stream: !!objectBody.stream,
    messageCount: messages ? messages.length : null,
    inputCount:
      inputs ? inputs.length : input == null ? null : 1,
    systemCount: systemCountFromMessages ?? systemCountFromInput,
    toolCount: Array.isArray(objectBody.tools) ? objectBody.tools.length : null,
    maxTokens: typeof maxTokens === "number" ? maxTokens : null,
    reasoningEffort:
      typeof objectBody.reasoning_effort === "string" ? objectBody.reasoning_effort : null,
  };
}

export function setFailureContext(
  res: express.Response,
  context: {
    stage: string;
    kind: string;
    message: string;
    upstreamStatus?: number | null;
    accountEmail?: string | null;
    accountLastError?: string | null;
    cooldownUntil?: number | null;
  }
): void {
  res.locals[FAILURE_CONTEXT_KEY] = {
    stage: context.stage,
    kind: context.kind,
    message: context.message,
    upstreamStatus: context.upstreamStatus ?? null,
    accountEmail: context.accountEmail ?? null,
    accountLastError: context.accountLastError ?? null,
    cooldownUntil: context.cooldownUntil ?? null,
  } satisfies FailureContextInput;
}

export function clearFailureContext(res: express.Response): void {
  delete res.locals[FAILURE_CONTEXT_KEY];
}

function parseJsonUsage(body: any): UsageDetails {
  const cacheCreationTokens = readNumber(body?.usage?.cache_creation_input_tokens, 0);
  const cacheReadTokens = readNumber(
    body?.usage?.cache_read_input_tokens ??
      body?.usage?.prompt_tokens_details?.cached_tokens ??
      body?.usage?.input_tokens_details?.cached_tokens,
    0
  );
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
      cacheCreationInputTokens: cacheCreationTokens,
      cacheReadInputTokens: cacheReadTokens,
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
      cacheCreationInputTokens: cacheCreationTokens,
      cacheReadInputTokens: cacheReadTokens,
    };
  }

  if (typeof countTokens === "number") {
    return {
      model: typeof body?.model === "string" ? body.model : null,
      inputTokens: countTokens,
      outputTokens: 0,
      totalTokens: countTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  return {
    model: typeof body?.model === "string" ? body.model : null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function mergeUsage(base: UsageDetails, next: Partial<UsageDetails>): UsageDetails {
  const inputTokens = typeof next.inputTokens === "number" ? next.inputTokens : base.inputTokens;
  const outputTokens = typeof next.outputTokens === "number" ? next.outputTokens : base.outputTokens;
  const cacheCreationInputTokens =
    typeof next.cacheCreationInputTokens === "number"
      ? next.cacheCreationInputTokens
      : base.cacheCreationInputTokens;
  const cacheReadInputTokens =
    typeof next.cacheReadInputTokens === "number"
      ? next.cacheReadInputTokens
      : base.cacheReadInputTokens;
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
    cacheCreationInputTokens,
    cacheReadInputTokens,
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
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      cacheReadInputTokens:
        usage?.cache_read_input_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens,
    });
  }

  if (currentEvent === "message_delta") {
    const usage = payload?.usage;
    return mergeUsage(details, {
      inputTokens: usage?.prompt_tokens ?? usage?.input_tokens,
      outputTokens: usage?.completion_tokens ?? usage?.output_tokens,
      totalTokens:
        typeof usage?.total_tokens === "number"
          ? usage.total_tokens
          : typeof usage?.prompt_tokens === "number" || typeof usage?.completion_tokens === "number"
            ? (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)
            : typeof usage?.input_tokens === "number" || typeof usage?.output_tokens === "number"
              ? (usage?.input_tokens || 0) + (usage?.output_tokens || 0)
              : undefined,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      cacheReadInputTokens:
        usage?.cache_read_input_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens,
    });
  }

  if (payload?.usage) {
    return mergeUsage(details, {
      model: payload?.model || details.model || null,
      inputTokens: payload.usage.prompt_tokens ?? payload.usage.input_tokens,
      outputTokens: payload.usage.completion_tokens ?? payload.usage.output_tokens,
      totalTokens: payload.usage.total_tokens,
      cacheCreationInputTokens: payload.usage.cache_creation_input_tokens,
      cacheReadInputTokens:
        payload.usage.cache_read_input_tokens ??
        payload.usage.prompt_tokens_details?.cached_tokens ??
        payload.usage.input_tokens_details?.cached_tokens,
    });
  }

  return details;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
    const requestSummary = summarizeRequestBody(req.body);
    const clientIp = getClientIp(req);
    const userAgent = getUserAgent(req);
    const source = classifySource(req, clientIp, userAgent);
    let details: UsageDetails = {
      model: typeof req.body?.model === "string" ? req.body.model : null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    let sseBuffer = "";
    let responseErrorMessage: string | null = null;
    let responseErrorType: string | null = null;

    const originalJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      details = mergeUsage(details, parseJsonUsage(body));
      if (typeof body?.error?.message === "string") {
        responseErrorMessage = body.error.message;
      }
      if (typeof body?.error?.type === "string") {
        responseErrorType = body.error.type;
      }
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
      const explicitFailureContext = res.locals[FAILURE_CONTEXT_KEY] as FailureContextInput | undefined;
      const failed = res.statusCode >= 400 || explicitFailureContext !== undefined;
      const failureContext: UsageFailureContext | null =
        failed
          ? {
              stage: explicitFailureContext?.stage || "response",
              kind:
                explicitFailureContext?.kind ||
                responseErrorType ||
                (res.statusCode === 429 ? "http_429" : "http_error"),
              message:
                explicitFailureContext?.message ||
                responseErrorMessage ||
                `HTTP ${res.statusCode}`,
              upstreamStatus: explicitFailureContext?.upstreamStatus ?? null,
              accountEmail: explicitFailureContext?.accountEmail ?? null,
              accountLastError: explicitFailureContext?.accountLastError ?? null,
              cooldownUntil: explicitFailureContext?.cooldownUntil ?? null,
              requestSummary,
            }
          : null;

      tracker.record({
        provider,
        source,
        clientIp,
        userAgent,
        endpoint: options.endpoint,
        model: details.model,
        statusCode: res.statusCode,
        success: !failed,
        stream: !!req.body?.stream,
        latencyMs: Date.now() - startedAt,
        inputTokens: details.inputTokens,
        outputTokens: details.outputTokens,
        totalTokens: details.totalTokens,
        cacheCreationInputTokens: details.cacheCreationInputTokens,
        cacheReadInputTokens: details.cacheReadInputTokens,
        failureContext,
      });
    });

    handler(req, res, next);
  };
}

export function resolveUsageProvider(provider: ProviderName | null): UsageProvider {
  if (provider === "claude" || provider === "codex" || provider === "grok") {
    return provider;
  }
  return "unknown";
}
