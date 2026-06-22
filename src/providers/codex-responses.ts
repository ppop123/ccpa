import express from "express";
import { randomUUID } from "node:crypto";
import { setFailureContext } from "../monitoring/http-usage";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { apiError, codexAuthErrorResponse, invalidRequest } from "./codex-errors";
import { CodexRequestOptions, normalizeCodexRequestBody } from "./codex-request";
import {
  CodexStreamCompletionState,
  CodexUpstreamInvalidResponseError,
  CodexUpstreamSseError,
  CodexUpstreamTruncatedStreamError,
  collectCodexResponseFromSse,
  observeCodexStreamCompletion,
} from "./codex-sse";
import {
  CodexUpstreamNetworkError,
  CodexUpstreamTimeoutError,
  callCodexResponsesWithAuthRetry,
} from "./codex-upstream";

function normalizeOutput(upstream: any): any[] {
  if (Array.isArray(upstream?.output)) {
    return upstream.output;
  }
  if (Array.isArray(upstream?.content)) {
    return [{
      type: "message",
      id: `msg_${randomUUID().replace(/-/g, "")}`,
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
  const response: any = {
    id: upstream?.id || `resp_${randomUUID().replace(/-/g, "")}`,
    object: upstream?.object || "response",
    created_at: upstream?.created_at || Math.floor(Date.now() / 1000),
    status: upstream?.status || "completed",
    model: upstream?.model || model,
    output: normalizeOutput(upstream),
    usage: normalizeUsage(upstream),
  };
  if (typeof upstream?.service_tier === "string") {
    response.service_tier = upstream.service_tier;
  }
  return response;
}

function isValidResponsesInput(input: unknown): boolean {
  return typeof input === "string" || Array.isArray(input);
}

const VALID_RESPONSES_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);
const VALID_RESPONSES_TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);
const VALID_RESPONSES_IMAGE_PART_TYPES = new Set(["input_image", "image"]);
const VALID_RESPONSES_TOOL_TYPES = new Set([
  "function",
  "image_generation",
  "custom",
  "file_search",
  "web_search",
  "web_search_2025_08_26",
  "computer_use_preview",
  "code_interpreter",
  "mcp",
  "local_shell",
  "shell",
]);
const VALID_WEB_SEARCH_CONTEXT_SIZES = new Set(["low", "medium", "high"]);
const VALID_COMPUTER_USE_ENVIRONMENTS = new Set(["windows", "mac", "linux", "ubuntu", "browser"]);
const UNSUPPORTED_CODEX_TOOL_TYPES = new Set([
  "file_search",
  "web_search",
  "web_search_2025_08_26",
  "computer_use_preview",
  "code_interpreter",
  "mcp",
  "local_shell",
  "shell",
]);
const VALID_CUSTOM_TOOL_FORMAT_TYPES = new Set(["text", "grammar"]);
const VALID_CUSTOM_TOOL_GRAMMAR_SYNTAX = new Set(["lark", "regex"]);
const VALID_RESPONSES_TEXT_FORMAT_TYPES = new Set(["text", "json_object", "json_schema"]);
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_REASONING_SUMMARY_MODES = new Set(["auto", "concise", "detailed"]);
const RESPONSES_REASONING_EFFORT_ERROR =
  "reasoning.effort must be one of none, minimal, low, medium, high, xhigh";
const RESPONSES_REASONING_SUMMARY_ERROR =
  "reasoning.summary must be one of auto, concise, detailed";
const RESPONSES_REASONING_GENERATE_SUMMARY_ERROR =
  "reasoning.generate_summary must be one of auto, concise, detailed";
const RESPONSES_METADATA_MAX_PAIRS = 16;
const RESPONSES_METADATA_MAX_KEY_LENGTH = 64;
const RESPONSES_METADATA_MAX_VALUE_LENGTH = 512;
const VALID_SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority"]);
const SERVICE_TIER_ERROR = "service_tier must be one of auto, default, flex, scale, priority";
const VALID_RESPONSES_PROMPT_CACHE_RETENTIONS = new Set(["in-memory", "24h"]);
const PROMPT_CACHE_RETENTION_ERROR = "prompt_cache_retention must be one of in-memory, 24h";
const VALID_RESPONSES_TRUNCATIONS = new Set(["auto", "disabled"]);
const TRUNCATION_ERROR = "truncation must be one of auto, disabled";
const PREVIOUS_RESPONSE_ID_ERROR = "previous_response_id must be a string";
const CONVERSATION_ERROR = "conversation must be a string or object with an id string";
const CONVERSATION_PREVIOUS_RESPONSE_ID_ERROR = "conversation cannot be used with previous_response_id";
const TOP_LOGPROBS_ERROR = "top_logprobs must be an integer between 0 and 20";
const VALID_RESPONSES_INCLUDE_VALUES = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
];
const VALID_RESPONSES_INCLUDES = new Set(VALID_RESPONSES_INCLUDE_VALUES);
const INCLUDE_VALUE_ERROR = `include values must be one of ${VALID_RESPONSES_INCLUDE_VALUES.join(", ")}`;
const VALID_RESPONSES_PROMPT_VARIABLE_TYPES = new Set(["input_text", "input_image", "input_file"]);
const VALID_RESPONSES_PROMPT_IMAGE_DETAILS = new Set(["low", "high", "auto"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isArrayOfNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function getResponsesCustomToolFormatError(format: unknown, prefix: string): string | undefined {
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
  if (!isNonEmptyString(format.definition)) {
    return `${prefix}.format.definition is required`;
  }
  if (typeof format.syntax !== "string" || !VALID_CUSTOM_TOOL_GRAMMAR_SYNTAX.has(format.syntax)) {
    return `${prefix}.format.syntax must be one of lark, regex`;
  }
  return undefined;
}

function getResponsesCustomToolError(tool: Record<string, unknown>, prefix: string): string | undefined {
  if (!isNonEmptyString(tool.name)) {
    return `${prefix}.name is required`;
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    return `${prefix}.description must be a string`;
  }
  return getResponsesCustomToolFormatError(tool.format, prefix);
}

function getResponsesHostedToolDefinitionError(
  tool: Record<string, unknown>,
  prefix: string
): string | undefined {
  switch (tool.type) {
    case "file_search":
      if (!isArrayOfNonEmptyStrings(tool.vector_store_ids)) {
        return `${prefix}.vector_store_ids is required`;
      }
      return undefined;
    case "web_search":
    case "web_search_2025_08_26":
      if (
        tool.search_context_size !== undefined &&
        !(typeof tool.search_context_size === "string" && VALID_WEB_SEARCH_CONTEXT_SIZES.has(tool.search_context_size))
      ) {
        return `${prefix}.search_context_size must be one of low, medium, high`;
      }
      return undefined;
    case "computer_use_preview":
      if (typeof tool.display_width !== "number") {
        return `${prefix}.display_width is required`;
      }
      if (typeof tool.display_height !== "number") {
        return `${prefix}.display_height is required`;
      }
      if (!(typeof tool.environment === "string" && VALID_COMPUTER_USE_ENVIRONMENTS.has(tool.environment))) {
        return `${prefix}.environment must be one of windows, mac, linux, ubuntu, browser`;
      }
      return undefined;
    case "code_interpreter":
      if (typeof tool.container !== "string" && !isObjectRecord(tool.container)) {
        return `${prefix}.container is required`;
      }
      return undefined;
    case "mcp":
      if (!isNonEmptyString(tool.server_label)) {
        return `${prefix}.server_label is required`;
      }
      if (!isNonEmptyString(tool.server_url) && !isNonEmptyString(tool.connector_id)) {
        return `${prefix}.server_url or connector_id is required`;
      }
      return undefined;
    case "local_shell":
    case "shell":
      return undefined;
    default:
      return undefined;
  }
}

function isValidJsonString(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function getResponsesImageUrl(part: { image_url?: unknown; url?: unknown }): string | undefined {
  if (typeof part.image_url === "string") {
    return part.image_url;
  }
  if (
    part.image_url &&
    typeof part.image_url === "object" &&
    typeof (part.image_url as { url?: unknown }).url === "string"
  ) {
    return (part.image_url as { url: string }).url;
  }
  if (typeof part.url === "string") {
    return part.url;
  }
  return undefined;
}

function getResponsesContentPartError(inputIndex: number, partIndex: number, part: unknown): string | undefined {
  const prefix = `input[${inputIndex}].content[${partIndex}]`;
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return `${prefix} must be an object`;
  }

  const contentPart = part as { type?: unknown; text?: unknown; image_url?: unknown; url?: unknown };
  if (VALID_RESPONSES_TEXT_PART_TYPES.has(String(contentPart.type))) {
    if (typeof contentPart.text !== "string") {
      return `${prefix}.text is required`;
    }
    return undefined;
  }

  if (VALID_RESPONSES_IMAGE_PART_TYPES.has(String(contentPart.type))) {
    if (!getResponsesImageUrl(contentPart)) {
      return `${prefix}.image_url is required`;
    }
    return undefined;
  }

  return `${prefix}.type is invalid`;
}

function getResponsesInputItemError(input: unknown): string | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `input[${index}] must be an object`;
    }

    const inputItem = item as {
      role?: unknown;
      type?: unknown;
      content?: unknown;
      call_id?: unknown;
      name?: unknown;
      arguments?: unknown;
      output?: unknown;
      input?: unknown;
    };

    if (inputItem.type === "function_call") {
      if (!isNonEmptyString(inputItem.call_id)) {
        return `input[${index}].call_id is required`;
      }
      if (!isNonEmptyString(inputItem.name)) {
        return `input[${index}].name is required`;
      }
      if (inputItem.arguments === undefined || inputItem.arguments === null) {
        return `input[${index}].arguments is required`;
      }
      if (typeof inputItem.arguments !== "string") {
        return `input[${index}].arguments must be a string`;
      }
      if (!isValidJsonString(inputItem.arguments)) {
        return `input[${index}].arguments must be valid JSON`;
      }
      continue;
    }

    if (inputItem.type === "function_call_output") {
      if (!isNonEmptyString(inputItem.call_id)) {
        return `input[${index}].call_id is required`;
      }
      if (inputItem.output === undefined || inputItem.output === null) {
        return `input[${index}].output is required`;
      }
      if (typeof inputItem.output !== "string") {
        return `input[${index}].output must be a string`;
      }
      continue;
    }

    if (inputItem.type === "custom_tool_call") {
      if (!isNonEmptyString(inputItem.call_id)) {
        return `input[${index}].call_id is required`;
      }
      if (!isNonEmptyString(inputItem.name)) {
        return `input[${index}].name is required`;
      }
      if (typeof inputItem.input !== "string") {
        return `input[${index}].input must be a string`;
      }
      continue;
    }

    if (inputItem.type === "custom_tool_call_output") {
      if (!isNonEmptyString(inputItem.call_id)) {
        return `input[${index}].call_id is required`;
      }
      if (inputItem.output === undefined || inputItem.output === null) {
        return `input[${index}].output is required`;
      }
      if (typeof inputItem.output !== "string" && !Array.isArray(inputItem.output)) {
        return `input[${index}].output must be a string or array`;
      }
      if (Array.isArray(inputItem.output)) {
        for (const [partIndex, part] of inputItem.output.entries()) {
          const partError = getResponsesContentPartError(index, partIndex, part);
          if (partError) {
            return partError.replace(`input[${index}].content`, `input[${index}].output`);
          }
        }
      }
      continue;
    }

    if (typeof inputItem.role !== "string" || !VALID_RESPONSES_MESSAGE_ROLES.has(inputItem.role)) {
      return `input[${index}].role is invalid`;
    }
    if (inputItem.content === undefined || inputItem.content === null) {
      return `input[${index}].content is required`;
    }
    if (typeof inputItem.content !== "string" && !Array.isArray(inputItem.content)) {
      return `input[${index}].content must be a string or array`;
    }
    if (Array.isArray(inputItem.content)) {
      for (const [partIndex, part] of inputItem.content.entries()) {
        const partError = getResponsesContentPartError(index, partIndex, part);
        if (partError) {
          return partError;
        }
      }
    }
  }

  return undefined;
}

function getResponsesToolsError(tools: unknown): string | undefined {
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
    if (!VALID_RESPONSES_TOOL_TYPES.has(tool.type)) {
      return `${prefix}.type is unsupported`;
    }
    if (tool.type === "custom") {
      const customError = getResponsesCustomToolError(tool, prefix);
      if (customError) {
        return customError;
      }
      continue;
    }
    if (tool.type !== "function" && tool.type !== "image_generation") {
      const hostedToolError = getResponsesHostedToolDefinitionError(tool, prefix);
      if (hostedToolError) {
        return hostedToolError;
      }
      continue;
    }
    if (tool.type !== "function") {
      continue;
    }

    if (!isNonEmptyString(tool.name)) {
      return `${prefix}.name is required`;
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      return `${prefix}.description must be a string`;
    }
    if (tool.parameters !== undefined && !isObjectRecord(tool.parameters)) {
      return `${prefix}.parameters must be an object`;
    }
    if (tool.input_schema !== undefined && !isObjectRecord(tool.input_schema)) {
      return `${prefix}.input_schema must be an object`;
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      return `${prefix}.strict must be a boolean`;
    }
  }

  return undefined;
}

function getCodexResponsesUnsupportedToolError(body: any): string | undefined {
  if (!Array.isArray(body?.tools)) {
    return undefined;
  }

  for (const [index, tool] of body.tools.entries()) {
    if (
      isObjectRecord(tool) &&
      typeof tool.type === "string" &&
      UNSUPPORTED_CODEX_TOOL_TYPES.has(tool.type)
    ) {
      return `tools[${index}].type is unsupported for Codex responses models`;
    }
  }

  return undefined;
}

function getResponsesTextFormatError(text: unknown): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (!isObjectRecord(text)) {
    return "text must be an object";
  }

  const format = text.format;
  if (format === undefined) {
    return undefined;
  }
  if (!isObjectRecord(format)) {
    return "text.format must be an object";
  }

  const type = format.type;
  if (typeof type !== "string" || !VALID_RESPONSES_TEXT_FORMAT_TYPES.has(type)) {
    return "text.format.type must be one of text, json_object, json_schema";
  }

  if (type !== "json_schema") {
    return undefined;
  }
  if (!isNonEmptyString(format.name)) {
    return "text.format.name is required";
  }
  if (format.schema === undefined) {
    return "text.format.schema is required";
  }
  if (!isObjectRecord(format.schema)) {
    return "text.format.schema must be an object";
  }
  if (format.description !== undefined && typeof format.description !== "string") {
    return "text.format.description must be a string";
  }
  if (format.strict !== undefined && typeof format.strict !== "boolean") {
    return "text.format.strict must be a boolean";
  }

  return undefined;
}

function getResponsesReasoningError(reasoning: unknown): string | undefined {
  if (reasoning === undefined) {
    return undefined;
  }
  if (!isObjectRecord(reasoning)) {
    return "reasoning must be an object";
  }

  const effort = reasoning.effort;
  if (effort !== undefined && !(typeof effort === "string" && VALID_REASONING_EFFORTS.has(effort))) {
    return RESPONSES_REASONING_EFFORT_ERROR;
  }

  const generateSummary = reasoning.generate_summary;
  if (
    generateSummary !== undefined &&
    !(typeof generateSummary === "string" && VALID_REASONING_SUMMARY_MODES.has(generateSummary))
  ) {
    return RESPONSES_REASONING_GENERATE_SUMMARY_ERROR;
  }

  const summary = reasoning.summary;
  if (summary !== undefined && !(typeof summary === "string" && VALID_REASONING_SUMMARY_MODES.has(summary))) {
    return RESPONSES_REASONING_SUMMARY_ERROR;
  }

  return undefined;
}

function getResponsesMetadataError(metadata: unknown): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (!isObjectRecord(metadata)) {
    return "metadata must be an object";
  }

  const entries = Object.entries(metadata);
  if (entries.length > RESPONSES_METADATA_MAX_PAIRS) {
    return "metadata must contain at most 16 key-value pairs";
  }

  for (const [key, value] of entries) {
    if (key.length > RESPONSES_METADATA_MAX_KEY_LENGTH) {
      return "metadata keys must be at most 64 characters";
    }
    if (typeof value !== "string") {
      return "metadata values must be strings";
    }
    if (value.length > RESPONSES_METADATA_MAX_VALUE_LENGTH) {
      return "metadata values must be at most 512 characters";
    }
  }

  return undefined;
}

const TOOL_CHOICE_ERROR =
  "tool_choice must be one of auto, none, required, an allowed_tools tool choice, a function tool choice, a custom tool choice, a hosted tool choice, an MCP tool choice, a shell/apply_patch tool choice, or an image_generation tool choice";
const VALID_TOOL_CHOICE_STRINGS = new Set(["auto", "none", "required"]);
const VALID_ALLOWED_TOOL_CHOICE_MODES = new Set(["auto", "required"]);
const VALID_HOSTED_TOOL_CHOICE_TYPES = new Set([
  "file_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "computer_use_preview",
  "code_interpreter",
  "image_generation",
]);
const UNSUPPORTED_CODEX_TOOL_CHOICE_TYPES = new Set([
  "file_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "computer_use_preview",
  "code_interpreter",
  "mcp",
  "apply_patch",
  "shell",
]);

function isValidResponsesAllowedToolChoiceTool(tool: unknown): boolean {
  if (!isObjectRecord(tool) || typeof tool.type !== "string") {
    return false;
  }
  if (tool.type === "image_generation") {
    return true;
  }
  if (tool.type === "custom") {
    return isNonEmptyString(tool.name);
  }
  if (tool.type !== "function") {
    return false;
  }
  return isNonEmptyString(tool.name);
}

function isValidResponsesAllowedToolsChoice(toolChoice: Record<string, unknown>): boolean {
  if (typeof toolChoice.mode !== "string" || !VALID_ALLOWED_TOOL_CHOICE_MODES.has(toolChoice.mode)) {
    return false;
  }
  if (!Array.isArray(toolChoice.tools)) {
    return false;
  }
  return toolChoice.tools.every(isValidResponsesAllowedToolChoiceTool);
}

function isValidResponsesToolChoice(toolChoice: unknown): boolean {
  if (toolChoice === undefined || toolChoice === null) {
    return true;
  }
  if (typeof toolChoice === "string") {
    return VALID_TOOL_CHOICE_STRINGS.has(toolChoice);
  }
  if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return false;
  }

  const choice = toolChoice as { type?: unknown; function?: { name?: unknown }; name?: unknown };
  if (choice.type === "auto" || choice.type === "none" || choice.type === "required") {
    return true;
  }
  if (choice.type === "function") {
    return typeof choice.function?.name === "string" || typeof choice.name === "string";
  }
  if (choice.type === "custom") {
    return isNonEmptyString(choice.name);
  }
  if (choice.type === "allowed_tools") {
    return isValidResponsesAllowedToolsChoice(toolChoice as Record<string, unknown>);
  }
  if (choice.type === "mcp") {
    return isNonEmptyString((choice as { server_label?: unknown }).server_label) &&
      (choice.name === undefined || typeof choice.name === "string");
  }
  if (choice.type === "apply_patch" || choice.type === "shell") {
    return true;
  }
  return typeof choice.type === "string" && VALID_HOSTED_TOOL_CHOICE_TYPES.has(choice.type);
}

function getCodexResponsesUnsupportedToolChoiceError(body: any): string | undefined {
  const toolChoice = body?.tool_choice;
  if (!isObjectRecord(toolChoice) || typeof toolChoice.type !== "string") {
    return undefined;
  }
  if (!UNSUPPORTED_CODEX_TOOL_CHOICE_TYPES.has(toolChoice.type)) {
    return undefined;
  }
  return `tool_choice ${toolChoice.type} is unsupported for Codex responses models`;
}

function validateResponsesStream(body: any, res: express.Response): boolean {
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

function validateResponsesBackground(body: any, res: express.Response): boolean {
  const value = body?.background;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    const message = "background must be a boolean";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_background",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }
  if (value === true) {
    const message = "background true is unsupported for Codex responses models";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_background",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesInstructions(body: any, res: express.Response): boolean {
  if (body?.instructions === undefined) {
    return true;
  }
  if (typeof body.instructions === "string") {
    return true;
  }

  const message = "instructions must be a string";
  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_instructions",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesStore(body: any, res: express.Response): boolean {
  if (body?.store === undefined) {
    return true;
  }

  if (typeof body.store === "boolean") {
    return true;
  }

  const message = "store must be a boolean";
  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_store",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesStreamOptions(body: any, res: express.Response): boolean {
  const value = body?.stream_options;
  if (value === undefined) {
    return true;
  }

  if (!isObjectRecord(value)) {
    const message = "stream_options must be an object";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_stream_options",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  if (body?.stream !== true) {
    const message = "stream_options can only be set when stream is true";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_stream_options",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  if (value.include_obfuscation !== undefined && typeof value.include_obfuscation !== "boolean") {
    const message = "stream_options.include_obfuscation must be a boolean";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_stream_options",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesMaxOutputTokens(body: any, res: express.Response): boolean {
  if (body?.max_output_tokens === undefined) {
    return true;
  }

  if (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens <= 0) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_max_output_tokens",
      message: "max_output_tokens must be a positive integer",
    });
    res.status(400).json(invalidRequest("max_output_tokens must be a positive integer", "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesNumberRange(
  body: any,
  res: express.Response,
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

function validateResponsesTopLogprobs(body: any, res: express.Response): boolean {
  const value = body?.top_logprobs;
  if (value === undefined) {
    return true;
  }

  if (Number.isInteger(value) && value >= 0 && value <= 20) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_top_logprobs",
    message: TOP_LOGPROBS_ERROR,
  });
  res.status(400).json(invalidRequest(TOP_LOGPROBS_ERROR, "invalid_parameter"));
  return false;
}

function validateResponsesParallelToolCalls(body: any, res: express.Response): boolean {
  const value = body?.parallel_tool_calls;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }

  const message = "parallel_tool_calls must be a boolean";
  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_parallel_tool_calls",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesMaxToolCalls(body: any, res: express.Response): boolean {
  const value = body?.max_tool_calls;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "number") {
    return true;
  }

  const message = "max_tool_calls must be a number";
  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_max_tool_calls",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function getResponsesContextManagementError(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return "context_management must be an array";
  }

  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    const prefix = `context_management[${index}]`;
    if (!isObjectRecord(item)) {
      return `${prefix} must be an object`;
    }
    if (item.type !== "compaction") {
      return `${prefix}.type must be compaction`;
    }
    if (item.compact_threshold !== undefined) {
      if (typeof item.compact_threshold !== "number") {
        return `${prefix}.compact_threshold must be a number`;
      }
      if (item.compact_threshold < 1000) {
        return `${prefix}.compact_threshold must be at least 1000`;
      }
    }
  }
  return undefined;
}

function validateResponsesContextManagement(body: any, res: express.Response): boolean {
  const value = body?.context_management;
  if (value === undefined) {
    return true;
  }

  const message = getResponsesContextManagementError(value);
  if (!message) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_context_management",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function getResponsesPromptVariableError(name: string, value: unknown): string | undefined {
  const prefix = `prompt.variables.${name}`;
  if (typeof value === "string") {
    return undefined;
  }
  if (!isObjectRecord(value)) {
    return `${prefix} must be a string or response input object`;
  }

  const type = value.type;
  if (typeof type !== "string" || !VALID_RESPONSES_PROMPT_VARIABLE_TYPES.has(type)) {
    return `${prefix}.type must be one of input_text, input_image, input_file`;
  }

  if (type === "input_text") {
    if (typeof value.text !== "string") {
      return `${prefix}.text is required`;
    }
    return undefined;
  }

  if (type === "input_image") {
    if (
      value.detail !== undefined &&
      (typeof value.detail !== "string" || !VALID_RESPONSES_PROMPT_IMAGE_DETAILS.has(value.detail))
    ) {
      return `${prefix}.detail must be one of low, high, auto`;
    }
    if (value.file_id !== undefined && typeof value.file_id !== "string") {
      return `${prefix}.file_id must be a string`;
    }
    if (value.image_url !== undefined && typeof value.image_url !== "string") {
      return `${prefix}.image_url must be a string`;
    }
    return undefined;
  }

  for (const field of ["file_data", "file_id", "file_url", "filename"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return `${prefix}.${field} must be a string`;
    }
  }
  return undefined;
}

function getResponsesPromptError(prompt: unknown): string | undefined {
  if (!isObjectRecord(prompt)) {
    return "prompt must be an object";
  }
  if (typeof prompt.id !== "string") {
    return "prompt.id must be a string";
  }
  if (prompt.version !== undefined && typeof prompt.version !== "string") {
    return "prompt.version must be a string";
  }
  if (prompt.variables === undefined) {
    return undefined;
  }
  if (!isObjectRecord(prompt.variables)) {
    return "prompt.variables must be an object";
  }

  for (const [name, value] of Object.entries(prompt.variables)) {
    const error = getResponsesPromptVariableError(name, value);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function validateResponsesPrompt(body: any, res: express.Response): boolean {
  const value = body?.prompt;
  if (value === undefined) {
    return true;
  }

  const message = getResponsesPromptError(value);
  if (!message) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_prompt",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesServiceTier(body: any, res: express.Response): boolean {
  const value = body?.service_tier;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string" && VALID_SERVICE_TIERS.has(value)) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_service_tier",
    message: SERVICE_TIER_ERROR,
  });
  res.status(400).json(invalidRequest(SERVICE_TIER_ERROR, "invalid_parameter"));
  return false;
}

function validateResponsesSafetyIdentifier(body: any, res: express.Response): boolean {
  const value = body?.safety_identifier;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    const message = "safety_identifier must be a string";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_safety_identifier",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }
  if (value.length > 64) {
    const message = "safety_identifier must be at most 64 characters";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_safety_identifier",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesUser(body: any, res: express.Response): boolean {
  const value = body?.user;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    const message = "user must be a string";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_user",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesPromptCache(body: any, res: express.Response): boolean {
  if (body?.prompt_cache_key !== undefined && typeof body.prompt_cache_key !== "string") {
    const message = "prompt_cache_key must be a string";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_prompt_cache_key",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  const retention = body?.prompt_cache_retention;
  if (retention === undefined) {
    return true;
  }
  if (typeof retention === "string" && VALID_RESPONSES_PROMPT_CACHE_RETENTIONS.has(retention)) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_prompt_cache_retention",
    message: PROMPT_CACHE_RETENTION_ERROR,
  });
  res.status(400).json(invalidRequest(PROMPT_CACHE_RETENTION_ERROR, "invalid_parameter"));
  return false;
}

function validateResponsesTruncation(body: any, res: express.Response): boolean {
  const value = body?.truncation;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string" && VALID_RESPONSES_TRUNCATIONS.has(value)) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_truncation",
    message: TRUNCATION_ERROR,
  });
  res.status(400).json(invalidRequest(TRUNCATION_ERROR, "invalid_parameter"));
  return false;
}

function validateResponsesPreviousResponseId(body: any, res: express.Response): boolean {
  const value = body?.previous_response_id;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_previous_response_id",
    message: PREVIOUS_RESPONSE_ID_ERROR,
  });
  res.status(400).json(invalidRequest(PREVIOUS_RESPONSE_ID_ERROR, "invalid_parameter"));
  return false;
}

function isValidResponsesConversation(value: unknown): boolean {
  return typeof value === "string" || (isObjectRecord(value) && typeof value.id === "string");
}

function validateResponsesConversation(body: any, res: express.Response): boolean {
  const value = body?.conversation;
  if (value === undefined) {
    return true;
  }
  if (!isValidResponsesConversation(value)) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_conversation",
      message: CONVERSATION_ERROR,
    });
    res.status(400).json(invalidRequest(CONVERSATION_ERROR, "invalid_parameter"));
    return false;
  }
  if (body?.previous_response_id !== undefined) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_conversation_previous_response_id",
      message: CONVERSATION_PREVIOUS_RESPONSE_ID_ERROR,
    });
    res.status(400).json(invalidRequest(CONVERSATION_PREVIOUS_RESPONSE_ID_ERROR, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesInclude(body: any, res: express.Response): boolean {
  const value = body?.include;
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value)) {
    const message = "include must be an array";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_include",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  for (const item of value) {
    if (typeof item !== "string" || !VALID_RESPONSES_INCLUDES.has(item)) {
      setFailureContext(res, {
        stage: "validation",
        kind: "invalid_include",
        message: INCLUDE_VALUE_ERROR,
      });
      res.status(400).json(invalidRequest(INCLUDE_VALUE_ERROR, "invalid_parameter"));
      return false;
    }
  }

  return true;
}

async function streamCodexResponses(upstreamResp: Response, res: express.Response): Promise<void> {
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
      message: "Codex upstream response body is unavailable",
      upstreamStatus: 502,
    });
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let clientDisconnected = false;
  const completionState: CodexStreamCompletionState = { buffer: "", currentEvent: "", completed: false };
  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!clientDisconnected && value) {
        const text = decoder.decode(value, { stream: true });
        observeCodexStreamCompletion(completionState, text);
        res.write(text);
      }
    }
  } catch {
    completionState.completed = false;
  } finally {
    if (!clientDisconnected) {
      if (completionState.error) {
        setFailureContext(res, {
          stage: "upstream",
          kind: completionState.error.kind,
          message: completionState.error.message,
          upstreamStatus: completionState.error.status,
        });
        res.end();
        return;
      }
      if (!completionState.completed) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: "Upstream stream ended before completion",
          upstreamStatus: 502,
        });
      }
      res.end();
    }
  }
}

export function createCodexResponsesHandler(
  authStore: CodexAuthStore,
  requestOptions?: CodexRequestOptions
): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      const rawBody = req.body || {};
      if (rawBody.input !== undefined && !isValidResponsesInput(rawBody.input)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_input",
          message: "input must be a string or array",
        });
        res.status(400).json(invalidRequest("input must be a string or array", "invalid_parameter"));
        return;
      }
      if (Array.isArray(rawBody.input) && rawBody.input.length === 0) {
        setFailureContext(res, {
          stage: "validation",
          kind: "empty_input",
          message: "input must contain at least one item",
        });
        res.status(400).json(invalidRequest("input must contain at least one item", "invalid_parameter"));
        return;
      }
      const inputItemError = getResponsesInputItemError(rawBody.input);
      if (inputItemError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_input_item",
          message: inputItemError,
        });
        res.status(400).json(invalidRequest(inputItemError, "invalid_parameter"));
        return;
      }
      const toolsError = getResponsesToolsError(rawBody.tools);
      if (toolsError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_tools",
          message: toolsError,
        });
        res.status(400).json(invalidRequest(toolsError, "invalid_parameter"));
        return;
      }
      const unsupportedToolError = getCodexResponsesUnsupportedToolError(rawBody);
      if (unsupportedToolError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "unsupported_tool",
          message: unsupportedToolError,
        });
        res.status(400).json(invalidRequest(unsupportedToolError, "invalid_parameter"));
        return;
      }
      if (!isValidResponsesToolChoice(rawBody.tool_choice)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_tool_choice",
          message: TOOL_CHOICE_ERROR,
        });
        res.status(400).json(invalidRequest(TOOL_CHOICE_ERROR, "invalid_parameter"));
        return;
      }
      const unsupportedToolChoiceError = getCodexResponsesUnsupportedToolChoiceError(rawBody);
      if (unsupportedToolChoiceError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "unsupported_tool_choice",
          message: unsupportedToolChoiceError,
        });
        res.status(400).json(invalidRequest(unsupportedToolChoiceError, "invalid_parameter"));
        return;
      }
      const reasoningError = getResponsesReasoningError(rawBody.reasoning);
      if (reasoningError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_reasoning",
          message: reasoningError,
        });
        res.status(400).json(invalidRequest(reasoningError, "invalid_parameter"));
        return;
      }
      const metadataError = getResponsesMetadataError(rawBody.metadata);
      if (metadataError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_metadata",
          message: metadataError,
        });
        res.status(400).json(invalidRequest(metadataError, "invalid_parameter"));
        return;
      }
      const textFormatError = getResponsesTextFormatError(rawBody.text);
      if (textFormatError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_text_format",
          message: textFormatError,
        });
        res.status(400).json(invalidRequest(textFormatError, "invalid_parameter"));
        return;
      }
      if (!validateResponsesStream(rawBody, res)) {
        return;
      }
      if (!validateResponsesBackground(rawBody, res)) {
        return;
      }
      if (!validateResponsesInstructions(rawBody, res)) {
        return;
      }
      if (!validateResponsesStore(rawBody, res)) {
        return;
      }
      if (!validateResponsesStreamOptions(rawBody, res)) {
        return;
      }
      if (!validateResponsesMaxOutputTokens(rawBody, res)) {
        return;
      }
      if (!validateResponsesNumberRange(rawBody, res, "temperature", 0, 2)) {
        return;
      }
      if (!validateResponsesNumberRange(rawBody, res, "top_p", 0, 1)) {
        return;
      }
      if (!validateResponsesTopLogprobs(rawBody, res)) {
        return;
      }
      if (!validateResponsesParallelToolCalls(rawBody, res)) {
        return;
      }
      if (!validateResponsesMaxToolCalls(rawBody, res)) {
        return;
      }
      if (!validateResponsesServiceTier(rawBody, res)) {
        return;
      }
      if (!validateResponsesSafetyIdentifier(rawBody, res)) {
        return;
      }
      if (!validateResponsesUser(rawBody, res)) {
        return;
      }
      if (!validateResponsesPromptCache(rawBody, res)) {
        return;
      }
      if (!validateResponsesTruncation(rawBody, res)) {
        return;
      }
      if (!validateResponsesPreviousResponseId(rawBody, res)) {
        return;
      }
      if (!validateResponsesContextManagement(rawBody, res)) {
        return;
      }
      if (!validateResponsesPrompt(rawBody, res)) {
        return;
      }
      if (!validateResponsesConversation(rawBody, res)) {
        return;
      }
      if (!validateResponsesInclude(rawBody, res)) {
        return;
      }

      const body = normalizeCodexRequestBody(rawBody, requestOptions);
      const clientStream = !!body.stream;
      const upstreamBody = {
        ...body,
        stream: true,
      };

      let snapshot;
      try {
        snapshot = authStore.load();
      } catch (error) {
        if (error instanceof CodexAuthError) {
          const authError = codexAuthErrorResponse(error.message);
          setFailureContext(res, {
            stage: "provider_auth",
            kind: "codex_auth",
            message: error.message,
          });
          res.status(authError.status).json(authError.body);
          return;
        }
        throw error;
      }

      const { response: upstreamResp } = await callCodexResponsesWithAuthRetry(
        authStore,
        snapshot,
        upstreamBody,
        true,
        { timeoutMs: requestOptions?.upstreamTimeoutMs }
      );
      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => "");
        setFailureContext(res, {
          stage: "upstream",
          kind:
            upstreamResp.status === 429
              ? "rate_limit"
              : upstreamResp.status === 401
                ? "auth"
                : upstreamResp.status === 403
                  ? "forbidden"
                  : "http_error",
          message: text || "Codex upstream request failed",
          upstreamStatus: upstreamResp.status,
        });
        res.status(upstreamResp.status).json(
          apiError(text || "Codex upstream request failed", "codex_upstream_error")
        );
        return;
      }

      if (clientStream) {
        await streamCodexResponses(upstreamResp, res);
        return;
      }

      const upstreamJson = await collectCodexResponseFromSse(upstreamResp);
      res.json(normalizeResponse(upstreamJson, body.model || upstreamJson?.model || "gpt-5.4"));
    } catch (error: any) {
      if (error instanceof CodexUpstreamTimeoutError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "timeout",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamNetworkError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamSseError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: error.kind,
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamTruncatedStreamError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamInvalidResponseError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "invalid_response",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      setFailureContext(res, {
        stage: "internal",
        kind: "internal_error",
        message: error?.message || "Internal server error",
      });
      res.status(500).json(apiError(error?.message || "Internal server error", "internal_error"));
    }
  };
}
