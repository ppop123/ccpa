import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { setFailureContext } from "../monitoring/http-usage";
import { apiError, invalidRequest, rateLimitError } from "../errors/openai";
import { openaiToClaude, claudeToOpenai, resolveModel } from "./translator";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI } from "./claude-api";
import { handleStreamingResponse } from "./streaming";
import { readClaudeJsonResponse } from "./upstream-json";
import { sendUnavailableClaudeAccount } from "./account-availability";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const VALID_CHAT_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const CHAT_CONTENT_REQUIRED_ROLES = new Set(["system", "developer", "user"]);
const CHAT_TOOL_CHOICE_ERROR =
  "tool_choice must be one of auto, none, required, a function tool choice, a custom tool choice, or an image_generation tool choice";
const CHAT_FUNCTION_CALL_ERROR = "function_call must be auto, none, or an object with a name";
const VALID_CHAT_TOOL_CHOICE_STRINGS = new Set(["auto", "none", "required"]);
const VALID_ALLOWED_TOOL_MODES = new Set(["auto", "required"]);
const VALID_CUSTOM_TOOL_FORMAT_TYPES = new Set(["text", "grammar"]);
const VALID_CUSTOM_TOOL_GRAMMAR_SYNTAX = new Set(["lark", "regex"]);
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_CHAT_IMAGE_DETAIL = new Set(["auto", "low", "high"]);
const VALID_CHAT_MODALITIES = new Set(["text", "audio", "image"]);
const VALID_SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority"]);
const VALID_CHAT_PROMPT_CACHE_RETENTIONS = new Set(["in_memory", "24h"]);
const VALID_WEB_SEARCH_CONTEXT_SIZES = new Set(["low", "medium", "high"]);
const VALID_CHAT_VERBOSITIES = new Set(["low", "medium", "high"]);
const REASONING_EFFORT_ERROR = "reasoning_effort must be one of none, minimal, low, medium, high, xhigh";
const SERVICE_TIER_ERROR = "service_tier must be one of auto, default, flex, scale, priority";
const PROMPT_CACHE_RETENTION_ERROR = "prompt_cache_retention must be one of in_memory, 24h";
const WEB_SEARCH_CONTEXT_SIZE_ERROR = "web_search_options.search_context_size must be one of low, medium, high";
const VERBOSITY_ERROR = "verbosity must be one of low, medium, high";
const METADATA_MAX_ENTRIES = 16;
const METADATA_MAX_KEY_LENGTH = 64;
const METADATA_MAX_VALUE_LENGTH = 512;
const SAFETY_IDENTIFIER_MAX_LENGTH = 64;
const CHAT_SEED_MIN = -9223372036854776000;
const CHAT_SEED_MAX = 9223372036854776000;
const CHAT_SEED_ERROR = `seed must be a number between ${CHAT_SEED_MIN} and ${CHAT_SEED_MAX}`;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getCustomToolFormatError(format: unknown, prefix: string): string | undefined {
  if (format === undefined) {
    return undefined;
  }
  if (!isObjectRecord(format)) {
    return `${prefix}.format must be an object`;
  }
  if (typeof format.type !== "string" || !VALID_CUSTOM_TOOL_FORMAT_TYPES.has(format.type)) {
    return `${prefix}.format.type must be one of text, grammar`;
  }
  if (format.type === "text") {
    return undefined;
  }
  if (!isObjectRecord(format.grammar)) {
    return `${prefix}.format.grammar is required`;
  }
  if (!isNonEmptyString(format.grammar.definition)) {
    return `${prefix}.format.grammar.definition is required`;
  }
  if (
    typeof format.grammar.syntax !== "string" ||
    !VALID_CUSTOM_TOOL_GRAMMAR_SYNTAX.has(format.grammar.syntax)
  ) {
    return `${prefix}.format.grammar.syntax must be one of lark, regex`;
  }
  return undefined;
}

function getChatCustomToolError(tool: Record<string, unknown>, prefix: string): string | undefined {
  if (!isObjectRecord(tool.custom)) {
    return `${prefix}.custom is required`;
  }
  if (!isNonEmptyString(tool.custom.name)) {
    return `${prefix}.custom.name is required`;
  }
  if (tool.custom.description !== undefined && typeof tool.custom.description !== "string") {
    return `${prefix}.custom.description must be a string`;
  }
  return getCustomToolFormatError(tool.custom.format, `${prefix}.custom`);
}

function getLegacyChatFunctionsError(functions: unknown): string | undefined {
  if (functions === undefined) {
    return undefined;
  }
  if (!Array.isArray(functions)) {
    return "functions must be an array";
  }

  for (const [index, fn] of functions.entries()) {
    const prefix = `functions[${index}]`;
    if (!isObjectRecord(fn)) {
      return `${prefix} must be an object`;
    }
    if (!isNonEmptyString(fn.name)) {
      return `${prefix}.name is required`;
    }
    if (fn.description !== undefined && typeof fn.description !== "string") {
      return `${prefix}.description must be a string`;
    }
    if (fn.parameters !== undefined && !isObjectRecord(fn.parameters)) {
      return `${prefix}.parameters must be an object`;
    }
  }

  return undefined;
}

function getLegacyChatFunctionCallError(functionCall: unknown): string | undefined {
  if (functionCall === undefined || functionCall === null) {
    return undefined;
  }
  if (functionCall === "auto" || functionCall === "none") {
    return undefined;
  }
  if (isObjectRecord(functionCall) && isNonEmptyString(functionCall.name)) {
    return undefined;
  }
  return CHAT_FUNCTION_CALL_ERROR;
}

function legacyChatFunctionsToTools(functions: unknown): any[] | undefined {
  if (!Array.isArray(functions)) {
    return undefined;
  }
  return functions.map((fn: any) => ({
    type: "function",
    function: {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    },
  }));
}

function legacyFunctionCallToToolChoice(functionCall: unknown): any {
  if (functionCall === "auto" || functionCall === "none") {
    return functionCall;
  }
  if (isObjectRecord(functionCall) && isNonEmptyString(functionCall.name)) {
    return { type: "function", function: { name: functionCall.name } };
  }
  return undefined;
}

function normalizeLegacyChatFunctionFields(body: any): any {
  if (body?.functions === undefined && body?.function_call === undefined) {
    return body;
  }

  const normalized = { ...body };
  if (normalized.tools === undefined) {
    const tools = legacyChatFunctionsToTools(body.functions);
    if (tools !== undefined) {
      normalized.tools = tools;
    }
  }
  if (normalized.tool_choice === undefined && body.function_call !== undefined) {
    const toolChoice = legacyFunctionCallToToolChoice(body.function_call);
    if (toolChoice !== undefined) {
      normalized.tool_choice = toolChoice;
    }
  }
  return normalized;
}

function shouldUseLegacyFunctionCallResponse(body: any): boolean {
  return body?.tools === undefined && Array.isArray(body?.functions);
}

type LegacyFunctionCallRef = {
  name: string;
  callId: string;
};

function makeLegacyFunctionCallId(messageIndex: number, name: string): string {
  const safeName = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "function";
  return `call_legacy_${messageIndex}_${safeName.slice(0, 64)}`;
}

function getLegacyAssistantFunctionCallMessageError(message: Record<string, unknown>, index: number): string | undefined {
  if (message.function_call === undefined) {
    return undefined;
  }

  const prefix = `messages[${index}].function_call`;
  if (!isObjectRecord(message.function_call)) {
    return `${prefix} must be an object`;
  }
  if (!isNonEmptyString(message.function_call.name)) {
    return `${prefix}.name is required`;
  }
  if (typeof message.function_call.arguments !== "string") {
    return `${prefix}.arguments must be a string`;
  }
  try {
    JSON.parse(message.function_call.arguments);
  } catch {
    return `${prefix}.arguments must be valid JSON`;
  }

  return undefined;
}

function getLegacyFunctionRoleMessageError(message: Record<string, unknown>, index: number): string | undefined {
  if (!isNonEmptyString(message.name)) {
    return `messages[${index}].name is required`;
  }
  if (message.content === undefined || message.content === null) {
    return `messages[${index}].content is required`;
  }
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    return `messages[${index}].content must be a string or array`;
  }

  return undefined;
}

function addPendingFunctionToolCalls(message: Record<string, unknown>, pending: LegacyFunctionCallRef[]): void {
  if (!Array.isArray(message.tool_calls)) {
    return;
  }

  for (const toolCall of message.tool_calls) {
    if (!isObjectRecord(toolCall) || toolCall.type !== "function" || !isObjectRecord(toolCall.function)) {
      continue;
    }
    if (isNonEmptyString(toolCall.id) && isNonEmptyString(toolCall.function.name)) {
      pending.push({ name: toolCall.function.name, callId: toolCall.id });
    }
  }
}

function findPendingFunctionCallIndex(pending: LegacyFunctionCallRef[], name: string): number {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index].name === name) {
      return index;
    }
  }
  return -1;
}

function normalizeLegacyChatFunctionMessages(body: any): { body: any; error?: string } {
  if (!Array.isArray(body?.messages)) {
    return { body };
  }

  const pending: LegacyFunctionCallRef[] = [];
  const normalizedMessages: any[] = [];
  let changed = false;

  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!isObjectRecord(message)) {
      normalizedMessages.push(message);
      continue;
    }

    if (message.role === "assistant") {
      const functionCallError = getLegacyAssistantFunctionCallMessageError(message, index);
      if (functionCallError) {
        return { body, error: functionCallError };
      }

      if (Array.isArray(message.tool_calls)) {
        addPendingFunctionToolCalls(message, pending);
      }

      if (message.function_call !== undefined && message.tool_calls === undefined) {
        const functionCall = message.function_call as Record<string, unknown>;
        const name = functionCall.name as string;
        const callId = makeLegacyFunctionCallId(index, name);
        pending.push({ name, callId });

        const normalized: any = {
          ...message,
          tool_calls: [{
            id: callId,
            type: "function",
            function: {
              name,
              arguments: functionCall.arguments,
            },
          }],
        };
        delete normalized.function_call;
        normalizedMessages.push(normalized);
        changed = true;
        continue;
      }
    }

    if (message.role === "function") {
      const functionMessageError = getLegacyFunctionRoleMessageError(message, index);
      if (functionMessageError) {
        return { body, error: functionMessageError };
      }

      const name = message.name as string;
      const pendingIndex = findPendingFunctionCallIndex(pending, name);
      if (pendingIndex === -1) {
        return { body, error: `messages[${index}] has no matching prior assistant function_call` };
      }
      const [{ callId }] = pending.splice(pendingIndex, 1);
      normalizedMessages.push({
        role: "tool",
        tool_call_id: callId,
        content: message.content,
      });
      changed = true;
      continue;
    }

    normalizedMessages.push(message);
  }

  return changed ? { body: { ...body, messages: normalizedMessages } } : { body };
}

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

function validateChatStream(body: any, res: ExpressResponse): boolean {
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

function validateChatMaxTokens(body: any, res: ExpressResponse): boolean {
  if (body?.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_max_tokens",
      message: "max_tokens must be a positive integer",
    });
    res.status(400).json(invalidRequest("max_tokens must be a positive integer", "invalid_parameter"));
    return false;
  }

  if (
    body?.max_completion_tokens !== undefined &&
    (!Number.isInteger(body.max_completion_tokens) || body.max_completion_tokens <= 0)
  ) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_max_completion_tokens",
      message: "max_completion_tokens must be a positive integer",
    });
    res.status(400).json(invalidRequest("max_completion_tokens must be a positive integer", "invalid_parameter"));
    return false;
  }

  if (
    body?.max_tokens !== undefined &&
    body?.max_completion_tokens !== undefined &&
    body.max_tokens !== body.max_completion_tokens
  ) {
    setFailureContext(res, {
      stage: "validation",
      kind: "conflicting_token_limits",
      message: "max_tokens and max_completion_tokens must match when both are provided",
    });
    res.status(400).json(
      invalidRequest(
        "max_tokens and max_completion_tokens must match when both are provided",
        "invalid_parameter"
      )
    );
    return false;
  }

  return true;
}

function validateChatN(body: any, res: ExpressResponse): boolean {
  if (body?.n === undefined) {
    return true;
  }

  if (body.n === 1) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_n",
    message: "n must be 1; multiple choices are unsupported",
  });
  res.status(400).json(invalidRequest("n must be 1; multiple choices are unsupported", "invalid_parameter"));
  return false;
}

function validateChatNumberRange(
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

  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
    return true;
  }

  const message = `${field} must be a number between ${min} and ${max}`;
  setFailureContext(res, {
    stage: "validation",
    kind: `invalid_${field}`,
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function failChatValidation(
  res: ExpressResponse,
  kind: string,
  message: string
): boolean {
  setFailureContext(res, {
    stage: "validation",
    kind,
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateChatReasoningEffort(body: any, res: ExpressResponse): boolean {
  const value = body?.reasoning_effort;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string" && VALID_REASONING_EFFORTS.has(value)) {
    return true;
  }

  return failChatValidation(res, "invalid_reasoning_effort", REASONING_EFFORT_ERROR);
}

function validateChatModalities(body: any, res: ExpressResponse): boolean {
  const modalities = body?.modalities;
  if (modalities !== undefined) {
    if (!Array.isArray(modalities)) {
      return failChatValidation(res, "invalid_modalities", "modalities must be an array");
    }
    if (
      !modalities.every((item: unknown) => typeof item === "string" && VALID_CHAT_MODALITIES.has(item))
    ) {
      return failChatValidation(
        res,
        "invalid_modalities",
        "modalities must contain only text, audio, or image"
      );
    }
    if (modalities.includes("audio")) {
      return failChatValidation(res, "unsupported_audio_output", "audio output is unsupported");
    }
  }

  if (body?.audio !== undefined) {
    if (!isObjectRecord(body.audio)) {
      return failChatValidation(res, "invalid_audio", "audio must be an object");
    }
    return failChatValidation(res, "unsupported_audio_output", "audio output is unsupported");
  }

  return true;
}

function validateChatParallelToolCalls(body: any, res: ExpressResponse): boolean {
  const value = body?.parallel_tool_calls;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    return failChatValidation(
      res,
      "invalid_parallel_tool_calls",
      "parallel_tool_calls must be a boolean"
    );
  }
  if (value === false) {
    return failChatValidation(
      res,
      "unsupported_parallel_tool_calls",
      "parallel_tool_calls false is unsupported"
    );
  }

  return true;
}

function validateChatServiceTier(body: any, res: ExpressResponse): boolean {
  const value = body?.service_tier;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string" || !VALID_SERVICE_TIERS.has(value)) {
    return failChatValidation(res, "invalid_service_tier", SERVICE_TIER_ERROR);
  }

  return failChatValidation(
    res,
    "unsupported_service_tier",
    "service_tier is unsupported for Claude chat"
  );
}

function validateChatStore(body: any, res: ExpressResponse): boolean {
  const value = body?.store;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    return failChatValidation(res, "invalid_store", "store must be a boolean");
  }
  if (value === true) {
    return failChatValidation(res, "unsupported_store", "store true is unsupported for Claude chat");
  }

  return true;
}

function validateChatStreamOptions(body: any, res: ExpressResponse): boolean {
  const value = body?.stream_options;
  if (value === undefined) {
    return true;
  }
  if (!isObjectRecord(value)) {
    return failChatValidation(res, "invalid_stream_options", "stream_options must be an object");
  }
  if (body?.stream !== true) {
    return failChatValidation(
      res,
      "invalid_stream_options",
      "stream_options can only be set when stream is true"
    );
  }
  if (value.include_usage !== undefined && typeof value.include_usage !== "boolean") {
    return failChatValidation(
      res,
      "invalid_stream_options",
      "stream_options.include_usage must be a boolean"
    );
  }
  if (value.include_obfuscation !== undefined && typeof value.include_obfuscation !== "boolean") {
    return failChatValidation(
      res,
      "invalid_stream_options",
      "stream_options.include_obfuscation must be a boolean"
    );
  }
  if (value.include_obfuscation !== undefined) {
    return failChatValidation(
      res,
      "unsupported_stream_options",
      "stream_options.include_obfuscation is unsupported for Claude chat"
    );
  }

  return true;
}

function validateChatWebSearchOptions(body: any, res: ExpressResponse): boolean {
  const value = body?.web_search_options;
  if (value === undefined) {
    return true;
  }
  if (!isObjectRecord(value)) {
    return failChatValidation(res, "invalid_web_search_options", "web_search_options must be an object");
  }

  const searchContextSize = value.search_context_size;
  if (
    searchContextSize !== undefined &&
    (typeof searchContextSize !== "string" || !VALID_WEB_SEARCH_CONTEXT_SIZES.has(searchContextSize))
  ) {
    return failChatValidation(res, "invalid_web_search_options", WEB_SEARCH_CONTEXT_SIZE_ERROR);
  }

  const userLocation = value.user_location;
  if (userLocation !== undefined) {
    if (!isObjectRecord(userLocation)) {
      return failChatValidation(
        res,
        "invalid_web_search_options",
        "web_search_options.user_location must be an object"
      );
    }
    if (userLocation.type !== "approximate") {
      return failChatValidation(
        res,
        "invalid_web_search_options",
        "web_search_options.user_location.type must be approximate"
      );
    }

    const approximate = userLocation.approximate;
    if (approximate !== undefined) {
      if (!isObjectRecord(approximate)) {
        return failChatValidation(
          res,
          "invalid_web_search_options",
          "web_search_options.user_location.approximate must be an object"
        );
      }
      for (const field of ["city", "country", "region", "timezone"]) {
        if (approximate[field] !== undefined && typeof approximate[field] !== "string") {
          return failChatValidation(
            res,
            "invalid_web_search_options",
            `web_search_options.user_location.approximate.${field} must be a string`
          );
        }
      }
    }
  }

  return failChatValidation(res, "unsupported_web_search_options", "web_search_options is unsupported");
}

function validateChatVerbosity(body: any, res: ExpressResponse): boolean {
  const value = body?.verbosity;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string" || !VALID_CHAT_VERBOSITIES.has(value)) {
    return failChatValidation(res, "invalid_verbosity", VERBOSITY_ERROR);
  }

  return failChatValidation(res, "unsupported_verbosity", "verbosity is unsupported for Claude chat");
}

function validateChatPromptCache(body: any, res: ExpressResponse): boolean {
  if (body?.prompt_cache_key !== undefined && typeof body.prompt_cache_key !== "string") {
    return failChatValidation(res, "invalid_prompt_cache_key", "prompt_cache_key must be a string");
  }

  const retention = body?.prompt_cache_retention;
  if (
    retention !== undefined &&
    (typeof retention !== "string" || !VALID_CHAT_PROMPT_CACHE_RETENTIONS.has(retention))
  ) {
    return failChatValidation(res, "invalid_prompt_cache_retention", PROMPT_CACHE_RETENTION_ERROR);
  }

  if (body?.prompt_cache_key !== undefined || retention !== undefined) {
    return failChatValidation(
      res,
      "unsupported_prompt_cache",
      "prompt cache parameters are unsupported for Claude chat"
    );
  }

  return true;
}

function validateChatSafetyIdentifier(body: any, res: ExpressResponse): boolean {
  const value = body?.safety_identifier;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return failChatValidation(res, "invalid_safety_identifier", "safety_identifier must be a string");
  }
  if (value.length > SAFETY_IDENTIFIER_MAX_LENGTH) {
    return failChatValidation(
      res,
      "invalid_safety_identifier",
      "safety_identifier must be at most 64 characters"
    );
  }
  return failChatValidation(
    res,
    "unsupported_safety_identifier",
    "safety_identifier is unsupported for Claude chat"
  );
}

function validateChatUser(body: any, res: ExpressResponse): boolean {
  const value = body?.user;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return failChatValidation(res, "invalid_user", "user must be a string");
  }
  return failChatValidation(res, "unsupported_user", "user is unsupported for Claude chat");
}

function validateChatSeed(body: any, res: ExpressResponse): boolean {
  const value = body?.seed;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < CHAT_SEED_MIN || value > CHAT_SEED_MAX) {
    return failChatValidation(res, "invalid_seed", CHAT_SEED_ERROR);
  }
  return failChatValidation(res, "unsupported_seed", "seed is unsupported");
}

function validateChatMetadata(body: any, res: ExpressResponse): boolean {
  const metadata = body?.metadata;
  if (metadata === undefined) {
    return true;
  }
  if (!isObjectRecord(metadata)) {
    return failChatValidation(res, "invalid_metadata", "metadata must be an object");
  }

  const entries = Object.entries(metadata);
  if (entries.length > METADATA_MAX_ENTRIES) {
    return failChatValidation(
      res,
      "invalid_metadata",
      "metadata must contain at most 16 key-value pairs"
    );
  }

  for (const [key, value] of entries) {
    if (key.length > METADATA_MAX_KEY_LENGTH) {
      return failChatValidation(res, "invalid_metadata", "metadata keys must be at most 64 characters");
    }
    if (typeof value !== "string") {
      return failChatValidation(res, "invalid_metadata", "metadata values must be strings");
    }
    if (value.length > METADATA_MAX_VALUE_LENGTH) {
      return failChatValidation(res, "invalid_metadata", "metadata values must be at most 512 characters");
    }
  }

  return failChatValidation(res, "unsupported_metadata", "metadata is unsupported for Claude chat");
}

function validateChatLogprobs(body: any, res: ExpressResponse): boolean {
  if (body?.logprobs !== undefined && typeof body.logprobs !== "boolean") {
    return failChatValidation(res, "invalid_logprobs", "logprobs must be a boolean");
  }

  if (
    body?.top_logprobs !== undefined &&
    (!Number.isInteger(body.top_logprobs) || body.top_logprobs < 0 || body.top_logprobs > 20)
  ) {
    return failChatValidation(
      res,
      "invalid_top_logprobs",
      "top_logprobs must be an integer between 0 and 20"
    );
  }

  if (body?.logprobs === true) {
    return failChatValidation(res, "unsupported_logprobs", "logprobs is unsupported");
  }

  if (body?.top_logprobs !== undefined) {
    return failChatValidation(res, "unsupported_top_logprobs", "top_logprobs is unsupported");
  }

  return true;
}

function validateChatPenalty(
  body: any,
  res: ExpressResponse,
  field: "presence_penalty" | "frequency_penalty"
): boolean {
  const value = body?.[field];
  if (value === undefined) {
    return true;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < -2 || value > 2) {
    return failChatValidation(res, `invalid_${field}`, `${field} must be a number between -2 and 2`);
  }

  if (value === 0) {
    return true;
  }

  return failChatValidation(res, `unsupported_${field}`, `${field} is unsupported`);
}

function getChatPredictionError(prediction: unknown): string | undefined {
  if (!isObjectRecord(prediction)) {
    return "prediction must be an object";
  }
  if (prediction.type !== "content") {
    return "prediction.type must be content";
  }

  const content = prediction.content;
  if (typeof content === "string") {
    return undefined;
  }
  if (!Array.isArray(content)) {
    return "prediction.content must be a string or array";
  }
  for (const [index, part] of content.entries()) {
    const prefix = `prediction.content[${index}]`;
    if (!isObjectRecord(part)) {
      return `${prefix} must be an object`;
    }
    if (part.type !== "text") {
      return `${prefix}.type must be text`;
    }
    if (typeof part.text !== "string") {
      return `${prefix}.text is required`;
    }
  }
  return undefined;
}

function validateChatPrediction(body: any, res: ExpressResponse): boolean {
  if (body?.prediction === undefined) {
    return true;
  }
  const error = getChatPredictionError(body.prediction);
  if (error) {
    return failChatValidation(res, "invalid_prediction", error);
  }
  return failChatValidation(res, "unsupported_prediction", "prediction is unsupported");
}

function validateChatResponseFormat(body: any, res: ExpressResponse): boolean {
  const responseFormat = body?.response_format;
  if (responseFormat === undefined) {
    return true;
  }

  if (!isObjectRecord(responseFormat)) {
    return failChatValidation(res, "invalid_response_format", "response_format must be an object");
  }

  if (!["text", "json_object", "json_schema"].includes(String(responseFormat.type))) {
    return failChatValidation(
      res,
      "invalid_response_format",
      "response_format.type must be one of text, json_object, json_schema"
    );
  }

  if (responseFormat.type === "text") {
    return true;
  }

  if (responseFormat.type === "json_object") {
    return failChatValidation(res, "unsupported_response_format", "response_format json_object is unsupported");
  }

  if (!isObjectRecord(responseFormat.json_schema)) {
    return failChatValidation(res, "invalid_response_format", "response_format.json_schema is required");
  }
  if (!isNonEmptyString(responseFormat.json_schema.name)) {
    return failChatValidation(res, "invalid_response_format", "response_format.json_schema.name is required");
  }
  if (
    responseFormat.json_schema.description !== undefined &&
    typeof responseFormat.json_schema.description !== "string"
  ) {
    return failChatValidation(
      res,
      "invalid_response_format",
      "response_format.json_schema.description must be a string"
    );
  }
  if (
    responseFormat.json_schema.schema !== undefined &&
    !isObjectRecord(responseFormat.json_schema.schema)
  ) {
    return failChatValidation(res, "invalid_response_format", "response_format.json_schema.schema must be an object");
  }
  if (responseFormat.json_schema.schema === undefined) {
    return failChatValidation(res, "invalid_response_format", "response_format.json_schema.schema is required");
  }
  if (
    responseFormat.json_schema.strict !== undefined &&
    typeof responseFormat.json_schema.strict !== "boolean"
  ) {
    return failChatValidation(res, "invalid_response_format", "response_format.json_schema.strict must be a boolean");
  }

  return failChatValidation(res, "unsupported_response_format", "response_format json_schema is unsupported");
}

function isValidChatStop(stop: unknown): boolean {
  if (stop === undefined || stop === null) {
    return true;
  }
  if (typeof stop === "string") {
    return true;
  }
  return Array.isArray(stop) && stop.every((item) => typeof item === "string");
}

function validateChatStop(body: any, res: ExpressResponse): boolean {
  if (isValidChatStop(body?.stop)) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_stop",
    message: "stop must be a string or array of strings",
  });
  res.status(400).json(invalidRequest("stop must be a string or array of strings", "invalid_parameter"));
  return false;
}

function getChatToolsError(tools: unknown): string | undefined {
  if (tools === undefined) {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    return "tools must be an array";
  }

  for (const [index, tool] of tools.entries()) {
    const prefix = `tools[${index}]`;
    if (!isObjectRecord(tool)) {
      return `${prefix} must be an object`;
    }

    if (typeof tool.type !== "string") {
      return `${prefix}.type is invalid`;
    }
    if (tool.type === "image_generation") {
      return `${prefix}.type is unsupported for Claude chat models`;
    }
    if (tool.type === "custom") {
      const customError = getChatCustomToolError(tool, prefix);
      return customError || `${prefix}.type is unsupported for Claude chat models`;
    }
    if (tool.type !== "function") {
      return `${prefix}.type is unsupported`;
    }

    if (!isObjectRecord(tool.function)) {
      return `${prefix}.function is required`;
    }
    if (!isNonEmptyString(tool.function.name)) {
      return `${prefix}.function.name is required`;
    }
    if (tool.function.description !== undefined && typeof tool.function.description !== "string") {
      return `${prefix}.function.description must be a string`;
    }
    if (tool.function.parameters !== undefined && !isObjectRecord(tool.function.parameters)) {
      return `${prefix}.function.parameters must be an object`;
    }
    if (tool.function.strict !== undefined && typeof tool.function.strict !== "boolean") {
      return `${prefix}.function.strict must be a boolean`;
    }
  }

  return undefined;
}

function validateChatTools(body: any, res: ExpressResponse): boolean {
  const error = getChatToolsError(body?.tools);
  if (!error) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_tools",
    message: error,
  });
  res.status(400).json(invalidRequest(error, "invalid_parameter"));
  return false;
}

function validateLegacyChatFunctions(body: any, res: ExpressResponse): boolean {
  const error = getLegacyChatFunctionsError(body?.functions);
  if (!error) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_functions",
    message: error,
  });
  res.status(400).json(invalidRequest(error, "invalid_parameter"));
  return false;
}

function validateLegacyChatFunctionCall(body: any, res: ExpressResponse): boolean {
  const error = getLegacyChatFunctionCallError(body?.function_call);
  if (!error) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_function_call",
    message: error,
  });
  res.status(400).json(invalidRequest(error, "invalid_parameter"));
  return false;
}

function isValidAllowedToolChoiceTool(tool: unknown): boolean {
  if (!isObjectRecord(tool) || typeof tool.type !== "string") {
    return false;
  }
  if (tool.type === "image_generation") {
    return true;
  }
  if (tool.type === "custom") {
    return isObjectRecord(tool.custom) && isNonEmptyString(tool.custom.name);
  }
  if (tool.type !== "function") {
    return false;
  }
  return isObjectRecord(tool.function) && isNonEmptyString(tool.function.name);
}

function isValidAllowedToolsChoice(toolChoice: Record<string, unknown>): boolean {
  const allowedTools = toolChoice.allowed_tools;
  if (!isObjectRecord(allowedTools)) {
    return false;
  }
  if (typeof allowedTools.mode !== "string" || !VALID_ALLOWED_TOOL_MODES.has(allowedTools.mode)) {
    return false;
  }
  if (!Array.isArray(allowedTools.tools)) {
    return false;
  }
  return allowedTools.tools.every(isValidAllowedToolChoiceTool);
}

function getChatToolChoiceError(toolChoice: unknown): string | undefined {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    return VALID_CHAT_TOOL_CHOICE_STRINGS.has(toolChoice) ? undefined : CHAT_TOOL_CHOICE_ERROR;
  }
  if (!isObjectRecord(toolChoice)) {
    return CHAT_TOOL_CHOICE_ERROR;
  }

  if (toolChoice.type === "image_generation") {
    return "tool_choice image_generation is unsupported for Claude chat models";
  }
  if (toolChoice.type === "allowed_tools") {
    return isValidAllowedToolsChoice(toolChoice)
      ? "tool_choice allowed_tools is unsupported for Claude chat models"
      : CHAT_TOOL_CHOICE_ERROR;
  }
  if (toolChoice.type === "custom") {
    return isObjectRecord(toolChoice.custom) && isNonEmptyString(toolChoice.custom.name)
      ? "tool_choice custom is unsupported for Claude chat models"
      : CHAT_TOOL_CHOICE_ERROR;
  }
  if (toolChoice.type === "function") {
    return isObjectRecord(toolChoice.function) && isNonEmptyString(toolChoice.function.name)
      ? undefined
      : CHAT_TOOL_CHOICE_ERROR;
  }

  return CHAT_TOOL_CHOICE_ERROR;
}

function validateChatToolChoice(body: any, res: ExpressResponse): boolean {
  const error = getChatToolChoiceError(body?.tool_choice);
  if (!error) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_tool_choice",
    message: error,
  });
  res.status(400).json(invalidRequest(error, "invalid_parameter"));
  return false;
}

function getChatContentPartError(
  messageIndex: number,
  role: string,
  partIndex: number,
  part: unknown
): string | undefined {
  const prefix = `messages[${messageIndex}].content[${partIndex}]`;
  if (!isObjectRecord(part)) {
    return `${prefix} must be an object`;
  }

  const type = part.type;
  if (typeof type !== "string") {
    return `${prefix}.type is invalid`;
  }

  if (type === "text") {
    return typeof part.text === "string" ? undefined : `${prefix}.text is required`;
  }

  if (type === "image_url") {
    if (role !== "user") {
      return `${prefix}.type is unsupported for ${role} messages`;
    }
    if (!isObjectRecord(part.image_url) || !isNonEmptyString(part.image_url.url)) {
      return `${prefix}.image_url.url is required`;
    }
    if (part.image_url.detail !== undefined && !VALID_CHAT_IMAGE_DETAIL.has(String(part.image_url.detail))) {
      return `${prefix}.image_url.detail must be one of auto, low, high`;
    }
    return undefined;
  }

  if (type === "input_audio" || type === "file") {
    return `${prefix}.type is unsupported`;
  }

  return `${prefix}.type is invalid`;
}

function validateChatMessageRoles(body: any, res: ExpressResponse): boolean {
  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      setFailureContext(res, {
        stage: "validation",
        kind: "invalid_message",
        message: `messages[${index}] must be an object`,
      });
      res.status(400).json(invalidRequest(`messages[${index}] must be an object`, "invalid_parameter"));
      return false;
    }

    if (typeof message.role !== "string" || !VALID_CHAT_MESSAGE_ROLES.has(message.role)) {
      setFailureContext(res, {
        stage: "validation",
        kind: "invalid_message_role",
        message: `messages[${index}].role is invalid`,
      });
      res.status(400).json(invalidRequest(`messages[${index}].role is invalid`, "invalid_parameter"));
      return false;
    }

    if (CHAT_CONTENT_REQUIRED_ROLES.has(message.role)) {
      if (message.content === undefined || message.content === null) {
        setFailureContext(res, {
          stage: "validation",
          kind: "missing_message_content",
          message: `messages[${index}].content is required`,
        });
        res.status(400).json(invalidRequest(`messages[${index}].content is required`, "invalid_parameter"));
        return false;
      }
      if (typeof message.content !== "string" && !Array.isArray(message.content)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_message_content",
          message: `messages[${index}].content must be a string or array`,
        });
        res.status(400).json(invalidRequest(`messages[${index}].content must be a string or array`, "invalid_parameter"));
        return false;
      }
    }

    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
        setFailureContext(res, {
          stage: "validation",
          kind: "missing_tool_call_id",
          message: `messages[${index}].tool_call_id is required`,
        });
        res.status(400).json(invalidRequest(`messages[${index}].tool_call_id is required`, "invalid_parameter"));
        return false;
      }
      if (message.content === undefined || message.content === null) {
        setFailureContext(res, {
          stage: "validation",
          kind: "missing_message_content",
          message: `messages[${index}].content is required`,
        });
        res.status(400).json(invalidRequest(`messages[${index}].content is required`, "invalid_parameter"));
        return false;
      }
      if (typeof message.content !== "string" && !Array.isArray(message.content)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_message_content",
          message: `messages[${index}].content must be a string or array`,
        });
        res.status(400).json(invalidRequest(`messages[${index}].content must be a string or array`, "invalid_parameter"));
        return false;
      }
    }

    if (Array.isArray(message.content)) {
      for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
        const partError = getChatContentPartError(index, message.role, partIndex, message.content[partIndex]);
        if (partError) {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_message_content_part",
            message: partError,
          });
          res.status(400).json(invalidRequest(partError, "invalid_parameter"));
          return false;
        }
      }
    }

    if (message.role === "assistant" && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_tool_calls",
          message: `messages[${index}].tool_calls must be an array`,
        });
        res.status(400).json(invalidRequest(`messages[${index}].tool_calls must be an array`, "invalid_parameter"));
        return false;
      }

      for (let toolIndex = 0; toolIndex < message.tool_calls.length; toolIndex += 1) {
        const toolCall = message.tool_calls[toolIndex];
        const prefix = `messages[${index}].tool_calls[${toolIndex}]`;
        if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_tool_call",
            message: `${prefix} must be an object`,
          });
          res.status(400).json(invalidRequest(`${prefix} must be an object`, "invalid_parameter"));
          return false;
        }
        if (typeof toolCall.id !== "string" || !toolCall.id) {
          setFailureContext(res, {
            stage: "validation",
            kind: "missing_tool_call_id",
            message: `${prefix}.id is required`,
          });
          res.status(400).json(invalidRequest(`${prefix}.id is required`, "invalid_parameter"));
          return false;
        }
        if (toolCall.type === "custom") {
          if (!toolCall.custom || typeof toolCall.custom !== "object" || Array.isArray(toolCall.custom)) {
            setFailureContext(res, {
              stage: "validation",
              kind: "invalid_tool_call",
              message: `${prefix}.custom is required`,
            });
            res.status(400).json(invalidRequest(`${prefix}.custom is required`, "invalid_parameter"));
            return false;
          }
          if (typeof toolCall.custom.name !== "string" || !toolCall.custom.name) {
            setFailureContext(res, {
              stage: "validation",
              kind: "invalid_tool_call",
              message: `${prefix}.custom.name is required`,
            });
            res.status(400).json(invalidRequest(`${prefix}.custom.name is required`, "invalid_parameter"));
            return false;
          }
          if (typeof toolCall.custom.input !== "string") {
            setFailureContext(res, {
              stage: "validation",
              kind: "invalid_tool_call",
              message: `${prefix}.custom.input must be a string`,
            });
            res.status(400).json(invalidRequest(`${prefix}.custom.input must be a string`, "invalid_parameter"));
            return false;
          }
          setFailureContext(res, {
            stage: "validation",
            kind: "unsupported_tool_call",
            message: `${prefix}.custom is unsupported for Claude chat models`,
          });
          res.status(400).json(invalidRequest(`${prefix}.custom is unsupported for Claude chat models`, "invalid_parameter"));
          return false;
        }
        if (toolCall.type !== "function" || !toolCall.function || typeof toolCall.function !== "object") {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_tool_call",
            message: `${prefix}.function is required`,
          });
          res.status(400).json(invalidRequest(`${prefix}.function is required`, "invalid_parameter"));
          return false;
        }
        if (typeof toolCall.function.name !== "string" || !toolCall.function.name) {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_tool_call",
            message: `${prefix}.function.name is required`,
          });
          res.status(400).json(invalidRequest(`${prefix}.function.name is required`, "invalid_parameter"));
          return false;
        }
        if (typeof toolCall.function.arguments !== "string") {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_tool_call",
            message: `${prefix}.function.arguments must be a string`,
          });
          res.status(400).json(invalidRequest(`${prefix}.function.arguments must be a string`, "invalid_parameter"));
          return false;
        }
        try {
          JSON.parse(toolCall.function.arguments);
        } catch {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_tool_call",
            message: `${prefix}.function.arguments must be valid JSON`,
          });
          res.status(400).json(invalidRequest(`${prefix}.function.arguments must be valid JSON`, "invalid_parameter"));
          return false;
        }
      }
    }
  }

  return true;
}

export function createChatCompletionsHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      let body = req.body;
      if (!body.messages || !Array.isArray(body.messages)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "missing_messages",
          message: "messages is required",
        });
        res.status(400).json(invalidRequest("messages is required", "missing_required_parameter"));
        return;
      }
      if (body.messages.length === 0) {
        setFailureContext(res, {
          stage: "validation",
          kind: "empty_messages",
          message: "messages must contain at least one message",
        });
        res.status(400).json(invalidRequest("messages must contain at least one message", "invalid_parameter"));
        return;
      }
      const legacyMessages = normalizeLegacyChatFunctionMessages(body);
      if (legacyMessages.error) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_message",
          message: legacyMessages.error,
        });
        res.status(400).json(invalidRequest(legacyMessages.error, "invalid_parameter"));
        return;
      }
      body = legacyMessages.body;
      if (!validateChatMessageRoles(body, res)) {
        return;
      }
      if (!validateChatStream(body, res)) {
        return;
      }
      if (!validateChatMaxTokens(body, res)) {
        return;
      }
      if (!validateChatN(body, res)) {
        return;
      }
      if (!validateChatReasoningEffort(body, res)) {
        return;
      }
      if (!validateChatModalities(body, res)) {
        return;
      }
      if (!validateChatParallelToolCalls(body, res)) {
        return;
      }
      if (!validateChatServiceTier(body, res)) {
        return;
      }
      if (!validateChatStore(body, res)) {
        return;
      }
      if (!validateChatStreamOptions(body, res)) {
        return;
      }
      if (!validateChatWebSearchOptions(body, res)) {
        return;
      }
      if (!validateChatVerbosity(body, res)) {
        return;
      }
      if (!validateChatPromptCache(body, res)) {
        return;
      }
      if (!validateChatSafetyIdentifier(body, res)) {
        return;
      }
      if (!validateChatUser(body, res)) {
        return;
      }
      if (!validateChatMetadata(body, res)) {
        return;
      }
      if (!validateChatNumberRange(body, res, "temperature", 0, 1)) {
        return;
      }
      if (!validateChatNumberRange(body, res, "top_p", 0, 1)) {
        return;
      }
      if (!validateChatSeed(body, res)) {
        return;
      }
      if (!validateChatPenalty(body, res, "presence_penalty")) {
        return;
      }
      if (!validateChatPenalty(body, res, "frequency_penalty")) {
        return;
      }
      if (!validateChatPrediction(body, res)) {
        return;
      }
      if (!validateChatResponseFormat(body, res)) {
        return;
      }
      if (!validateChatLogprobs(body, res)) {
        return;
      }
      if (!validateChatStop(body, res)) {
        return;
      }
      if (!validateChatTools(body, res)) {
        return;
      }
      if (!validateLegacyChatFunctions(body, res)) {
        return;
      }
      if (!validateLegacyChatFunctionCall(body, res)) {
        return;
      }
      if (!validateChatToolChoice(body, res)) {
        return;
      }

      const normalizedBody = normalizeLegacyChatFunctionFields(body);
      const legacyFunctionCallResponse = shouldUseLegacyFunctionCallResponse(body);
      const stream = !!normalizedBody.stream;
      const model = resolveModel(normalizedBody.model || "claude-sonnet-4-6");
      const userAgent = req.headers["user-agent"] || "";
      const apiKey = extractApiKey(req.headers);

      // Translate OpenAI -> Claude
      let claudeBody = openaiToClaude(normalizedBody);
      claudeBody = applyCloaking(claudeBody, config.cloaking, userAgent, apiKey);

      // Retry with account switching on retryable errors
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
            console.error(`Attempt ${attempt + 1} network failure: ${err.message}`);
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
          if (stream) {
            const streamResult = await handleStreamingResponse(upstreamResp, res, model, {
              includeUsage: body?.stream_options?.include_usage === true,
              legacyFunctionCall: legacyFunctionCallResponse,
            });
            if (streamResult.completed) {
              manager.recordSuccess(account.email);
            } else if (!streamResult.clientDisconnected) {
              manager.recordFailure(account.email, "network", "stream terminated before completion");
            }
          } else {
            const parsed = await readClaudeJsonResponse(upstreamResp, res, manager, account.email);
            if (!parsed.ok) return;
            const claudeResp = parsed.data;
            const openaiResp = claudeToOpenai(claudeResp, model, {
              legacyFunctionCall: legacyFunctionCallResponse,
            });
            manager.recordSuccess(account.email);
            res.json(openaiResp);
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          const errText = await upstreamResp.text();
          if (isDebugLevel(config.debug, "errors")) {
            console.error(`Attempt ${attempt + 1} failed (${lastStatus}): ${errText}`);
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
          manager.recordFailure(account.email, classifyFailure(lastStatus));
        }

        // Don't retry on client errors (400, 401, 403) except rate limits
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;

        // Brief delay before retry
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      const clientMsg = lastStatus === 429 ? "Rate limited on the configured account"
        : lastStatus === 401 ? "Authentication error"
        : "Upstream request failed";
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
      res.status(lastStatus).json(errorBody);
    } catch (err: any) {
      console.error("Handler error:", err.message);
      setFailureContext(res, {
        stage: "internal",
        kind: "internal_error",
        message: err?.message || "Internal server error",
      });
      res.status(500).json(apiError("Internal server error", "internal_error"));
    }
  };
}
