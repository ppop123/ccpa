import { CodexAuthSnapshot, CodexAuthStore } from "./codex-auth";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_MAX_ATTEMPTS = 2;
const CODEX_RESPONSES_RETRY_DELAY_MS = 300;

export interface CodexUpstreamRequestOptions {
  timeoutMs?: number;
}

export class CodexUpstreamTimeoutError extends Error {
  public readonly status = 504;
  public readonly code = "upstream_timeout";

  constructor(message = "Codex upstream request timed out") {
    super(message);
    this.name = "CodexUpstreamTimeoutError";
  }
}

export class CodexUpstreamNetworkError extends Error {
  public readonly status = 502;
  public readonly code = "upstream_network_error";

  constructor(message = "Codex upstream network error") {
    super(message);
    this.name = "CodexUpstreamNetworkError";
  }
}

function buildHeaders(accessToken: string, stream: boolean): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

function buildTimeoutSignal(timeoutMs?: number): AbortSignal | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

export async function callCodexResponses(
  accessToken: string,
  body: unknown,
  stream = false,
  options: CodexUpstreamRequestOptions = {}
): Promise<Response> {
  const payload = JSON.stringify(body);
  let lastError: unknown;

  for (let attempt = 1; attempt <= CODEX_RESPONSES_MAX_ATTEMPTS; attempt += 1) {
    try {
      const signal = buildTimeoutSignal(options.timeoutMs);
      return await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers: buildHeaders(accessToken, stream),
        body: payload,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isTimeoutFetchError(error)) {
        throw new CodexUpstreamTimeoutError();
      }
      lastError = error;
      if (attempt >= CODEX_RESPONSES_MAX_ATTEMPTS || !isTransientFetchError(error)) {
        throw new CodexUpstreamNetworkError();
      }
      await delay(CODEX_RESPONSES_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

export async function callCodexResponsesWithAuthRetry(
  authStore: CodexAuthStore,
  snapshot: CodexAuthSnapshot,
  body: unknown,
  stream = false,
  options: CodexUpstreamRequestOptions = {}
): Promise<{ response: Response; snapshot: CodexAuthSnapshot; retriedAfterAuthRefresh: boolean }> {
  const first = await callCodexResponses(snapshot.accessToken, body, stream, options);
  if (first.status !== 401) {
    return { response: first, snapshot, retriedAfterAuthRefresh: false };
  }

  const refreshed = authStore.reloadAfterAuthFailure(snapshot);
  if (!refreshed) {
    return { response: first, snapshot, retriedAfterAuthRefresh: false };
  }

  const second = await callCodexResponses(refreshed.accessToken, body, stream, options);
  return { response: second, snapshot: refreshed, retriedAfterAuthRefresh: true };
}

function isTimeoutFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name === "timeouterror" || name === "aborterror" || message.includes("timeout");
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TypeError" || error.message.toLowerCase().includes("fetch failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
