import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountManager } from "../accounts/manager";
import { clearFailureContext, setFailureContext } from "../monitoring/http-usage";
import { apiError, invalidRequest, rateLimitError } from "../errors/openai";
import { redactForLog } from "../logging/redact";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI, callClaudeCountTokens } from "./claude-api";
import { readClaudeJsonResponse } from "./upstream-json";
import { sendUnavailableClaudeAccount, setClaudeCooldownRetryAfter } from "./account-availability";
import { classifyAccountFailure } from "./upstream-failures";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

interface ClaudeStreamCompletionState {
  buffer: string;
  currentEvent: string;
  completed: boolean;
}

function observeClaudeStreamCompletion(state: ClaudeStreamCompletionState, text: string): void {
  state.buffer += text;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) {
      state.currentEvent = "";
      continue;
    }
    if (line.startsWith("event:")) {
      state.currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice(5).trimStart();
    if (state.currentEvent === "message_stop" || data === "[DONE]") {
      state.completed = true;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failNativeValidation(res: ExpressResponse, kind: string, message: string): boolean {
  setFailureContext(res, {
    stage: "validation",
    kind,
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateMessagesArray(body: any, res: ExpressResponse): boolean {
  if (!body?.messages) {
    setFailureContext(res, {
      stage: "validation",
      kind: "missing_messages",
      message: "messages is required",
    });
    res.status(400).json(invalidRequest("messages is required", "missing_required_parameter"));
    return false;
  }

  if (!Array.isArray(body.messages)) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_messages",
      message: "messages must be an array",
    });
    res.status(400).json(invalidRequest("messages must be an array", "invalid_parameter"));
    return false;
  }

  if (body.messages.length === 0) {
    setFailureContext(res, {
      stage: "validation",
      kind: "empty_messages",
      message: "messages must contain at least one message",
    });
    res.status(400).json(invalidRequest("messages must contain at least one message", "invalid_parameter"));
    return false;
  }

  return true;
}

function getNativeContentError(value: unknown, prefix: string): string | null {
  if (value === undefined || value === null) {
    return `${prefix} is required`;
  }
  if (typeof value === "string") {
    return value.trim() ? null : `${prefix} must be a non-empty string`;
  }
  if (!Array.isArray(value)) {
    return `${prefix} must be a string or array`;
  }
  if (value.length === 0) {
    return `${prefix} must contain at least one content block`;
  }

  for (let i = 0; i < value.length; i += 1) {
    const blockPrefix = `${prefix}[${i}]`;
    const block = value[i];
    if (!isRecord(block)) {
      return `${blockPrefix} must be an object`;
    }
    if (!isNonEmptyString(block.type)) {
      return `${blockPrefix}.type must be a non-empty string`;
    }

    if (block.type === "text") {
      if (!isNonEmptyString(block.text)) {
        return `${blockPrefix}.text must be a non-empty string`;
      }
      continue;
    }

    if (block.type === "image") {
      if (!isRecord(block.source)) {
        return `${blockPrefix}.source must be an object`;
      }
      continue;
    }

    if (block.type === "tool_use") {
      if (!isNonEmptyString(block.id)) {
        return `${blockPrefix}.id must be a non-empty string`;
      }
      if (!isNonEmptyString(block.name)) {
        return `${blockPrefix}.name must be a non-empty string`;
      }
      if (!isRecord(block.input)) {
        return `${blockPrefix}.input must be an object`;
      }
      continue;
    }

    if (block.type === "tool_result") {
      if (!isNonEmptyString(block.tool_use_id)) {
        return `${blockPrefix}.tool_use_id must be a non-empty string`;
      }
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
        return `${blockPrefix}.is_error must be a boolean`;
      }
      const nestedContentError = getNativeContentError(block.content, `${blockPrefix}.content`);
      if (nestedContentError) {
        return nestedContentError;
      }
    }
  }

  return null;
}

function validateMessageItems(body: any, res: ExpressResponse): boolean {
  for (let i = 0; i < body.messages.length; i += 1) {
    const message = body.messages[i];
    const prefix = `messages[${i}]`;
    if (!isRecord(message)) {
      return failNativeValidation(res, "invalid_message", `${prefix} must be an object`);
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return failNativeValidation(res, "invalid_message_role", `${prefix}.role must be one of user, assistant`);
    }
    const contentError = getNativeContentError(message.content, `${prefix}.content`);
    if (contentError) {
      return failNativeValidation(res, "invalid_message_content", contentError);
    }
  }

  return true;
}

function validateNativeModel(body: any, res: ExpressResponse): boolean {
  if (body?.model === undefined || body.model === null || body.model === "") {
    setFailureContext(res, {
      stage: "validation",
      kind: "missing_model",
      message: "model is required",
    });
    res.status(400).json(invalidRequest("model is required", "missing_required_parameter"));
    return false;
  }

  if (typeof body.model !== "string" || body.model.trim() === "") {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_model",
      message: "model must be a non-empty string",
    });
    res.status(400).json(invalidRequest("model must be a non-empty string", "invalid_parameter"));
    return false;
  }

  return true;
}

function validateMessagesMaxTokens(body: any, res: ExpressResponse): boolean {
  if (body?.max_tokens === undefined || body.max_tokens === null) {
    setFailureContext(res, {
      stage: "validation",
      kind: "missing_max_tokens",
      message: "max_tokens is required",
    });
    res.status(400).json(invalidRequest("max_tokens is required", "missing_required_parameter"));
    return false;
  }

  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_max_tokens",
      message: "max_tokens must be a positive integer",
    });
    res.status(400).json(invalidRequest("max_tokens must be a positive integer", "invalid_parameter"));
    return false;
  }

  return true;
}

function validateMessagesStream(body: any, res: ExpressResponse): boolean {
  if (body?.stream === undefined) {
    return true;
  }

  if (typeof body.stream !== "boolean") {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_stream",
      message: "stream must be a boolean",
    });
    res.status(400).json(invalidRequest("stream must be a boolean", "invalid_parameter"));
    return false;
  }

  return true;
}

function validateCountTokensStream(body: any, res: ExpressResponse): boolean {
  if (body?.stream === undefined || body.stream === false) {
    return true;
  }

  if (typeof body.stream !== "boolean") {
    return failNativeValidation(res, "invalid_stream", "stream must be a boolean");
  }

  return failNativeValidation(res, "unsupported_stream", "stream is unsupported for count_tokens");
}

function validateNativeNumberRange(
  body: any,
  res: ExpressResponse,
  field: "temperature" | "top_p",
  min: number,
  max: number
): boolean {
  const value = body?.[field];
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return failNativeValidation(res, `invalid_${field}`, `${field} must be a number between ${min} and ${max}`);
  }
  return true;
}

function validateNativeSystem(body: any, res: ExpressResponse): boolean {
  const system = body?.system;
  if (system === undefined) {
    return true;
  }

  if (typeof system === "string") {
    if (!system.trim()) {
      return failNativeValidation(res, "invalid_system", "system must be a non-empty string");
    }
    return true;
  }

  if (!Array.isArray(system)) {
    return failNativeValidation(res, "invalid_system", "system must be a non-empty string or array");
  }

  if (system.length === 0) {
    return failNativeValidation(res, "invalid_system", "system must contain at least one text block");
  }

  for (let i = 0; i < system.length; i += 1) {
    const block = system[i];
    const prefix = `system[${i}]`;
    if (!isRecord(block)) {
      return failNativeValidation(res, "invalid_system", `${prefix} must be an object`);
    }
    if (block.type !== "text") {
      return failNativeValidation(res, "invalid_system", `${prefix}.type must be text`);
    }
    if (!isNonEmptyString(block.text)) {
      return failNativeValidation(res, "invalid_system", `${prefix}.text must be a non-empty string`);
    }
    if (block.cache_control !== undefined && !isRecord(block.cache_control)) {
      return failNativeValidation(res, "invalid_system", `${prefix}.cache_control must be an object`);
    }
  }

  return true;
}

function getNativeContextManagementError(value: unknown): string | null {
  if (!isRecord(value)) {
    return "context_management must be an object";
  }

  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    return "context_management.edits must be a non-empty array";
  }

  for (let i = 0; i < value.edits.length; i += 1) {
    const edit = value.edits[i];
    const prefix = `context_management.edits[${i}]`;
    if (!isRecord(edit)) {
      return `${prefix} must be an object`;
    }
    if (edit.type !== "compact_20260112") {
      return `${prefix}.type must be compact_20260112`;
    }
    if (edit.trigger !== undefined) {
      if (!isRecord(edit.trigger)) {
        return `${prefix}.trigger must be an object`;
      }
      if (edit.trigger.type !== "input_tokens") {
        return `${prefix}.trigger.type must be input_tokens`;
      }
      if (typeof edit.trigger.value !== "number" || !Number.isFinite(edit.trigger.value)) {
        return `${prefix}.trigger.value must be a number`;
      }
      if (edit.trigger.value < 50000) {
        return `${prefix}.trigger.value must be at least 50000`;
      }
    }
    if (edit.pause_after_compaction !== undefined && typeof edit.pause_after_compaction !== "boolean") {
      return `${prefix}.pause_after_compaction must be a boolean`;
    }
    if (edit.instructions !== undefined && typeof edit.instructions !== "string") {
      return `${prefix}.instructions must be a string`;
    }
  }

  return null;
}

function validateNativeContextManagement(body: any, res: ExpressResponse): boolean {
  if (body?.context_management === undefined) {
    return true;
  }

  const error = getNativeContextManagementError(body.context_management);
  if (error) {
    return failNativeValidation(res, "invalid_context_management", error);
  }

  return true;
}

function validateNativeTopLevelParameters(body: any, res: ExpressResponse): boolean {
  if (!validateNativeSystem(body, res)) {
    return false;
  }
  if (!validateNativeContextManagement(body, res)) {
    return false;
  }

  if (!validateNativeNumberRange(body, res, "temperature", 0, 1)) {
    return false;
  }
  if (!validateNativeNumberRange(body, res, "top_p", 0, 1)) {
    return false;
  }

  if (body?.top_k !== undefined && (!Number.isInteger(body.top_k) || body.top_k <= 0)) {
    return failNativeValidation(res, "invalid_top_k", "top_k must be a positive integer");
  }

  if (body?.stop_sequences !== undefined) {
    if (
      !Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some((sequence: unknown) => !isNonEmptyString(sequence))
    ) {
      return failNativeValidation(res, "invalid_stop_sequences", "stop_sequences must be an array of strings");
    }
  }

  if (body?.metadata !== undefined) {
    if (!isRecord(body.metadata)) {
      return failNativeValidation(res, "invalid_metadata", "metadata must be an object");
    }
    if (body.metadata.user_id !== undefined && typeof body.metadata.user_id !== "string") {
      return failNativeValidation(res, "invalid_metadata", "metadata.user_id must be a string");
    }
  }

  if (body?.tool_choice !== undefined) {
    if (!isRecord(body.tool_choice)) {
      return failNativeValidation(res, "invalid_tool_choice", "tool_choice must be an object");
    }
    if (
      body.tool_choice.type !== "auto" &&
      body.tool_choice.type !== "any" &&
      body.tool_choice.type !== "tool" &&
      body.tool_choice.type !== "none"
    ) {
      return failNativeValidation(res, "invalid_tool_choice", "tool_choice.type must be one of auto, any, tool, none");
    }
    if (body.tool_choice.type === "tool" && !isNonEmptyString(body.tool_choice.name)) {
      return failNativeValidation(res, "invalid_tool_choice", "tool_choice.name must be a non-empty string");
    }
    if (
      body.tool_choice.disable_parallel_tool_use !== undefined &&
      typeof body.tool_choice.disable_parallel_tool_use !== "boolean"
    ) {
      return failNativeValidation(
        res,
        "invalid_tool_choice",
        "tool_choice.disable_parallel_tool_use must be a boolean"
      );
    }
  }

  if (body?.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return failNativeValidation(res, "invalid_tools", "tools must be an array");
    }
    for (let i = 0; i < body.tools.length; i += 1) {
      const tool = body.tools[i];
      const prefix = `tools[${i}]`;
      if (!isRecord(tool)) {
        return failNativeValidation(res, "invalid_tools", `${prefix} must be an object`);
      }
      if (tool.name === undefined && tool.type === undefined) {
        return failNativeValidation(res, "invalid_tools", `${prefix}.name or ${prefix}.type is required`);
      }
      if (tool.name !== undefined && !isNonEmptyString(tool.name)) {
        return failNativeValidation(res, "invalid_tools", `${prefix}.name must be a non-empty string`);
      }
      if (tool.type !== undefined && !isNonEmptyString(tool.type)) {
        return failNativeValidation(res, "invalid_tools", `${prefix}.type must be a non-empty string`);
      }
      if (tool.description !== undefined && typeof tool.description !== "string") {
        return failNativeValidation(res, "invalid_tools", `${prefix}.description must be a string`);
      }
      if (tool.input_schema !== undefined && !isRecord(tool.input_schema)) {
        return failNativeValidation(res, "invalid_tools", `${prefix}.input_schema must be an object`);
      }
    }
  }

  if (body?.thinking !== undefined) {
    if (!isRecord(body.thinking)) {
      return failNativeValidation(res, "invalid_thinking", "thinking must be an object");
    }
    if (body.thinking.type !== "enabled" && body.thinking.type !== "disabled") {
      return failNativeValidation(res, "invalid_thinking", "thinking.type must be one of enabled, disabled");
    }
    if (
      body.thinking.type === "enabled" &&
      (!Number.isInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens <= 0)
    ) {
      return failNativeValidation(
        res,
        "invalid_thinking",
        "thinking.budget_tokens must be a positive integer"
      );
    }
  }

  return true;
}

// POST /v1/messages — Claude native format passthrough
export function createMessagesHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!validateMessagesArray(body, res)) {
        return;
      }
      if (!validateMessageItems(body, res)) {
        return;
      }
      if (!validateNativeModel(body, res)) {
        return;
      }
      if (!validateMessagesMaxTokens(body, res)) {
        return;
      }
      if (!validateMessagesStream(body, res)) {
        return;
      }
      if (!validateNativeTopLevelParameters(body, res)) {
        return;
      }

      const stream = !!body.stream;
      const userAgent = req.headers["user-agent"] || "";
      const apiKey = extractApiKey(req.headers);

      // Apply cloaking (system prompt injection, user ID, etc.)
      const claudeBody = applyCloaking({ ...body }, config.cloaking, userAgent, apiKey);

      let lastStatus = 500;
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const account = manager.getNextAccount();
        if (!account) {
          sendUnavailableClaudeAccount(res, manager.getAvailability());
          return;
        }

        manager.recordAttempt(account.email);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeAPI(
            account.accessToken,
            claudeBody,
            stream,
            config.timeouts,
            config.claude?.["beta-header"]
          );
        } catch (err: any) {
          setFailureContext(res, {
            stage: "upstream",
            kind: /timeout/i.test(String(err?.message || "")) ? "timeout" : "network_error",
            message: err?.message || "Upstream network error",
            accountEmail: account.email,
          });
          if (isDebugLevel(config.debug, "errors")) {
            console.error(redactForLog(`Messages attempt ${attempt + 1} network failure: ${err.message}`));
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          manager.recordFailure(account.email, "network", err.message);
          res.status(502).json(apiError("Upstream network error", "upstream_network_error"));
          return;
        }

        if (upstreamResp.ok) {
          clearFailureContext(res);
          if (stream) {
            // Pipe SSE directly — no translation needed
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
                accountEmail: account.email,
              });
              manager.recordFailure(account.email, "network", "stream terminated before completion");
              res.end();
              return;
            }

            const decoder = new TextDecoder();
            const completionState: ClaudeStreamCompletionState = {
              buffer: "",
              currentEvent: "",
              completed: false,
            };
            let clientDisconnected = false;
            res.on("close", () => {
              clientDisconnected = true;
              reader.cancel().catch(() => {});
            });

            try {
              while (!clientDisconnected) {
                const { done, value } = await reader.read();
                if (done) break;
                observeClaudeStreamCompletion(completionState, decoder.decode(value, { stream: true }));
                res.write(Buffer.from(value));
              }
              if (!clientDisconnected && completionState.completed) {
                manager.recordSuccess(account.email);
              }
            } catch (err) {
              if (!clientDisconnected) console.error("Stream pipe error:", redactForLog(err));
            } finally {
              if (!clientDisconnected) {
                if (!completionState.completed) {
                  setFailureContext(res, {
                    stage: "upstream",
                    kind: "network_error",
                    message: "Upstream stream ended before completion",
                    accountEmail: account.email,
                  });
                  manager.recordFailure(account.email, "network", "stream terminated before completion");
                }
                res.end();
              }
            }
          } else {
            // Forward JSON response directly
            const parsed = await readClaudeJsonResponse(upstreamResp, res, manager, account.email);
            if (!parsed.ok) return;
            const data = parsed.data;
            manager.recordSuccess(account.email);
            res.json(data);
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          const errText = await upstreamResp.text();
          if (isDebugLevel(config.debug, "errors")) {
            console.error(redactForLog(`Messages attempt ${attempt + 1} failed (${lastStatus}): ${errText}`));
          }
        } catch { /* ignore */ }

        if (lastStatus === 401) {
          if (!refreshedAccounts.has(account.email)) {
            const refreshed = await manager.refreshAccount(account.email);
            if (refreshed) {
              refreshedAccounts.add(account.email);
              attempt--;
              continue;
            }
          }
          manager.recordFailure(account.email, "auth");
        } else {
          const failureKind = classifyAccountFailure(lastStatus);
          if (failureKind) {
            manager.recordFailure(account.email, failureKind);
          }
        }
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      const clientMsg = lastStatus === 429 ? "Rate limited on the configured account" : "Upstream request failed";
      setFailureContext(res, {
        stage: "upstream",
        kind:
          lastStatus === 429
            ? "rate_limit"
            : lastStatus === 401
              ? "auth"
              : lastStatus === 403
                ? "forbidden"
                : "http_error",
        message: clientMsg,
        upstreamStatus: lastStatus,
      });
      const errorBody = lastStatus === 429
        ? rateLimitError(clientMsg, "account_rate_limited")
        : lastStatus === 401
          ? apiError(clientMsg, "upstream_auth_error")
          : lastStatus === 403
            ? apiError(clientMsg, "upstream_forbidden")
            : apiError(clientMsg, "upstream_request_failed");
      if (lastStatus === 429) {
        setClaudeCooldownRetryAfter(res, manager.getAvailability());
      }
      res.status(lastStatus).json(errorBody);
    } catch (err: any) {
      console.error("Messages handler error:", redactForLog(err.message));
      setFailureContext(res, {
        stage: "internal",
        kind: "internal_error",
        message: err?.message || "Internal server error",
      });
      res.status(500).json(apiError("Internal server error", "internal_error"));
    }
  };
}

// POST /v1/messages/count_tokens — passthrough
export function createCountTokensHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      if (!validateMessagesArray(req.body, res)) {
        return;
      }
      if (!validateMessageItems(req.body, res)) {
        return;
      }
      if (!validateNativeModel(req.body, res)) {
        return;
      }
      if (!validateCountTokensStream(req.body, res)) {
        return;
      }
      if (!validateNativeTopLevelParameters(req.body, res)) {
        return;
      }

      const userAgent = req.headers["user-agent"] || "";
      const apiKey = extractApiKey(req.headers);
      const countTokensBody = { ...req.body };
      if (countTokensBody.stream === false) {
        delete countTokensBody.stream;
      }
      const claudeBody = applyCloaking(countTokensBody, config.cloaking, userAgent, apiKey);

      let lastStatus = 500;
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const account = manager.getNextAccount();
        if (!account) {
          sendUnavailableClaudeAccount(res, manager.getAvailability());
          return;
        }

        manager.recordAttempt(account.email);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeCountTokens(
            account.accessToken,
            claudeBody,
            config.timeouts,
            config.claude?.["beta-header"]
          );
        } catch (err: any) {
          setFailureContext(res, {
            stage: "upstream",
            kind: /timeout/i.test(String(err?.message || "")) ? "timeout" : "network_error",
            message: err?.message || "Upstream network error",
            accountEmail: account.email,
          });
          if (isDebugLevel(config.debug, "errors")) {
            console.error(redactForLog(`Count tokens attempt ${attempt + 1} network failure: ${err.message}`));
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          manager.recordFailure(account.email, "network", err.message);
          res.status(502).json(apiError("Upstream network error", "upstream_network_error"));
          return;
        }

        if (upstreamResp.ok) {
          clearFailureContext(res);
          const parsed = await readClaudeJsonResponse(upstreamResp, res, manager, account.email);
          if (!parsed.ok) return;
          const data = parsed.data;
          manager.recordSuccess(account.email);
          res.json(data);
          return;
        }

        lastStatus = upstreamResp.status;
        if (lastStatus === 401) {
          if (!refreshedAccounts.has(account.email)) {
            const refreshed = await manager.refreshAccount(account.email);
            if (refreshed) {
              refreshedAccounts.add(account.email);
              attempt--;
              continue;
            }
          }
          manager.recordFailure(account.email, "auth");
        } else {
          const failureKind = classifyAccountFailure(lastStatus);
          if (failureKind) {
            manager.recordFailure(account.email, failureKind);
          }
        }

        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      setFailureContext(res, {
        stage: "upstream",
        kind:
          lastStatus === 429
            ? "rate_limit"
            : lastStatus === 401
              ? "auth"
              : lastStatus === 403
                ? "forbidden"
                : "http_error",
        message: "Token counting failed",
        upstreamStatus: lastStatus,
      });
      const errorBody = lastStatus === 429
        ? rateLimitError("Token counting failed", "account_rate_limited")
        : lastStatus === 401
          ? apiError("Token counting failed", "upstream_auth_error")
          : lastStatus === 403
            ? apiError("Token counting failed", "upstream_forbidden")
            : apiError("Token counting failed", "upstream_request_failed");
      if (lastStatus === 429) {
        setClaudeCooldownRetryAfter(res, manager.getAvailability());
      }
      res.status(lastStatus).json(errorBody);
    } catch (err: any) {
      console.error("Count tokens error:", redactForLog(err.message));
      setFailureContext(res, {
        stage: "internal",
        kind: "internal_error",
        message: err?.message || "Internal server error",
      });
      res.status(500).json(apiError("Internal server error", "internal_error"));
    }
  };
}
