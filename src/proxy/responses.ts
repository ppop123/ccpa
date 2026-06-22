import { Request, Response as ExpressResponse } from "express";
import { randomUUID } from "node:crypto";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { setFailureContext } from "../monitoring/http-usage";
import { apiError, invalidRequest, rateLimitError } from "../errors/openai";
import { redactForLog } from "../logging/redact";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI } from "./claude-api";
import { resolveModel } from "./translator";
import { readClaudeJsonResponse } from "./upstream-json";
import { sendUnavailableClaudeAccount, setClaudeCooldownRetryAfter } from "./account-availability";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
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
const UNSUPPORTED_CLAUDE_TOOL_TYPES = new Set([
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
const VALID_CUSTOM_TOOL_FORMAT_TYPES = new Set(["text", "grammar"]);
const VALID_CUSTOM_TOOL_GRAMMAR_SYNTAX = new Set(["lark", "regex"]);
const VALID_RESPONSES_TEXT_FORMAT_TYPES = new Set(["text", "json_object", "json_schema"]);
const VALID_RESPONSES_TEXT_VERBOSITIES = new Set(["low", "medium", "high"]);
const RESPONSES_TEXT_VERBOSITY_ERROR = "text.verbosity must be one of low, medium, high";
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

function getClaudeResponsesUnsupportedToolError(body: any): string | undefined {
  if (Array.isArray(body?.tools)) {
    for (const [index, tool] of body.tools.entries()) {
      if (
        isObjectRecord(tool) &&
        typeof tool.type === "string" &&
        UNSUPPORTED_CLAUDE_TOOL_TYPES.has(tool.type)
      ) {
        return `tools[${index}].type is unsupported for Claude responses models`;
      }
    }
  }

  const toolChoice = body?.tool_choice;
  if (isObjectRecord(toolChoice) && toolChoice.type === "image_generation") {
    return "tool_choice image_generation is unsupported for Claude responses models";
  }
  if (isObjectRecord(toolChoice) && toolChoice.type === "custom") {
    return "tool_choice custom is unsupported for Claude responses models";
  }
  if (isObjectRecord(toolChoice) && toolChoice.type === "allowed_tools") {
    return "tool_choice allowed_tools is unsupported for Claude responses models";
  }
  if (
    isObjectRecord(toolChoice) &&
    typeof toolChoice.type === "string" &&
    UNSUPPORTED_CLAUDE_TOOL_CHOICE_TYPES.has(toolChoice.type)
  ) {
    return `tool_choice ${toolChoice.type} is unsupported for Claude responses models`;
  }

  if (Array.isArray(body?.input)) {
    for (const [index, item] of body.input.entries()) {
      if (
        isObjectRecord(item) &&
        (item.type === "custom_tool_call" || item.type === "custom_tool_call_output")
      ) {
        return `input[${index}].type is unsupported for Claude responses models`;
      }
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

  const verbosity = text.verbosity;
  if (verbosity !== undefined && (typeof verbosity !== "string" || !VALID_RESPONSES_TEXT_VERBOSITIES.has(verbosity))) {
    return RESPONSES_TEXT_VERBOSITY_ERROR;
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

function getClaudeResponsesUnsupportedTextFormatError(body: any): string | undefined {
  if (body?.text?.verbosity !== undefined) {
    return "text.verbosity is unsupported for Claude responses models";
  }

  const format = body?.text?.format;
  if (!isObjectRecord(format)) {
    return undefined;
  }
  if (format.type === "json_object" || format.type === "json_schema") {
    return `text.format ${format.type} is unsupported for Claude responses models`;
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

function getClaudeResponsesUnsupportedReasoningError(body: any): string | undefined {
  const reasoning = body?.reasoning;
  if (!isObjectRecord(reasoning)) {
    return undefined;
  }
  if (reasoning.summary !== undefined) {
    return "reasoning.summary is unsupported for Claude responses models";
  }
  if (reasoning.generate_summary !== undefined) {
    return "reasoning.generate_summary is unsupported for Claude responses models";
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

function getClaudeResponsesUnsupportedMetadataError(body: any): string | undefined {
  if (body?.metadata !== undefined) {
    return "metadata is unsupported for Claude responses models";
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
const UNSUPPORTED_CLAUDE_TOOL_CHOICE_TYPES = new Set([
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

function validateResponsesStream(body: any, res: ExpressResponse): boolean {
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

function validateResponsesBackground(body: any, res: ExpressResponse): boolean {
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
    const message = "background true is unsupported for Claude responses models";
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

function validateResponsesInstructions(body: any, res: ExpressResponse): boolean {
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

function validateResponsesStore(body: any, res: ExpressResponse): boolean {
  const value = body?.store;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    const message = "store must be a boolean";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_store",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }
  if (value === true) {
    const message = "store true is unsupported for Claude responses models";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_store",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesStreamOptions(body: any, res: ExpressResponse): boolean {
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

  if (value.include_obfuscation !== undefined) {
    const message = "stream_options.include_obfuscation is unsupported for Claude responses models";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_stream_options",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesMaxOutputTokens(body: any, res: ExpressResponse): boolean {
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

function validateResponsesTopLogprobs(body: any, res: ExpressResponse): boolean {
  const value = body?.top_logprobs;
  if (value === undefined) {
    return true;
  }

  if (!Number.isInteger(value) || value < 0 || value > 20) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_top_logprobs",
      message: TOP_LOGPROBS_ERROR,
    });
    res.status(400).json(invalidRequest(TOP_LOGPROBS_ERROR, "invalid_parameter"));
    return false;
  }

  const message = "top_logprobs is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_top_logprobs",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesParallelToolCalls(body: any, res: ExpressResponse): boolean {
  const value = body?.parallel_tool_calls;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    const message = "parallel_tool_calls must be a boolean";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_parallel_tool_calls",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }
  if (value === false) {
    const message = "parallel_tool_calls false is unsupported";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_parallel_tool_calls",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesMaxToolCalls(body: any, res: ExpressResponse): boolean {
  const value = body?.max_tool_calls;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "number") {
    const message = "max_tool_calls must be a number";
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_max_tool_calls",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  const message = "max_tool_calls is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_max_tool_calls",
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

function validateResponsesContextManagement(body: any, res: ExpressResponse): boolean {
  const value = body?.context_management;
  if (value === undefined) {
    return true;
  }

  const validationMessage = getResponsesContextManagementError(value);
  if (validationMessage) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_context_management",
      message: validationMessage,
    });
    res.status(400).json(invalidRequest(validationMessage, "invalid_parameter"));
    return false;
  }

  const message = "context_management is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_context_management",
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

function validateResponsesPrompt(body: any, res: ExpressResponse): boolean {
  const value = body?.prompt;
  if (value === undefined) {
    return true;
  }

  const validationMessage = getResponsesPromptError(value);
  if (validationMessage) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_prompt",
      message: validationMessage,
    });
    res.status(400).json(invalidRequest(validationMessage, "invalid_parameter"));
    return false;
  }

  const message = "prompt is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_prompt",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesServiceTier(body: any, res: ExpressResponse): boolean {
  const value = body?.service_tier;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string" || !VALID_SERVICE_TIERS.has(value)) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_service_tier",
      message: SERVICE_TIER_ERROR,
    });
    res.status(400).json(invalidRequest(SERVICE_TIER_ERROR, "invalid_parameter"));
    return false;
  }

  const message = "service_tier is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_service_tier",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesSafetyIdentifier(body: any, res: ExpressResponse): boolean {
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

  const message = "safety_identifier is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_safety_identifier",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesUser(body: any, res: ExpressResponse): boolean {
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

  const message = "user is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_user",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesPromptCache(body: any, res: ExpressResponse): boolean {
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
  if (
    retention !== undefined &&
    (typeof retention !== "string" || !VALID_RESPONSES_PROMPT_CACHE_RETENTIONS.has(retention))
  ) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_prompt_cache_retention",
      message: PROMPT_CACHE_RETENTION_ERROR,
    });
    res.status(400).json(invalidRequest(PROMPT_CACHE_RETENTION_ERROR, "invalid_parameter"));
    return false;
  }

  if (body?.prompt_cache_key !== undefined || retention !== undefined) {
    const message = "prompt cache parameters are unsupported for Claude responses models";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_prompt_cache",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesTruncation(body: any, res: ExpressResponse): boolean {
  const value = body?.truncation;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string" || !VALID_RESPONSES_TRUNCATIONS.has(value)) {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_truncation",
      message: TRUNCATION_ERROR,
    });
    res.status(400).json(invalidRequest(TRUNCATION_ERROR, "invalid_parameter"));
    return false;
  }
  if (value === "auto") {
    const message = "truncation auto is unsupported for Claude responses models";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_truncation",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

function validateResponsesPreviousResponseId(body: any, res: ExpressResponse): boolean {
  const value = body?.previous_response_id;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_previous_response_id",
      message: PREVIOUS_RESPONSE_ID_ERROR,
    });
    res.status(400).json(invalidRequest(PREVIOUS_RESPONSE_ID_ERROR, "invalid_parameter"));
    return false;
  }

  const message = "previous_response_id is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_previous_response_id",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function isValidResponsesConversation(value: unknown): boolean {
  return typeof value === "string" || (isObjectRecord(value) && typeof value.id === "string");
}

function validateResponsesConversation(body: any, res: ExpressResponse): boolean {
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
  if (typeof body?.previous_response_id === "string") {
    setFailureContext(res, {
      stage: "validation",
      kind: "invalid_conversation_previous_response_id",
      message: CONVERSATION_PREVIOUS_RESPONSE_ID_ERROR,
    });
    res.status(400).json(invalidRequest(CONVERSATION_PREVIOUS_RESPONSE_ID_ERROR, "invalid_parameter"));
    return false;
  }
  if (body?.previous_response_id !== undefined) {
    return true;
  }

  const message = "conversation is unsupported for Claude responses models";
  setFailureContext(res, {
    stage: "validation",
    kind: "unsupported_conversation",
    message,
  });
  res.status(400).json(invalidRequest(message, "invalid_parameter"));
  return false;
}

function validateResponsesInclude(body: any, res: ExpressResponse): boolean {
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

  if (value.length > 0) {
    const message = "include is unsupported for Claude responses models";
    setFailureContext(res, {
      stage: "validation",
      kind: "unsupported_include",
      message,
    });
    res.status(400).json(invalidRequest(message, "invalid_parameter"));
    return false;
  }

  return true;
}

const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 32768,
};

// ── OpenAI Responses API request → Claude Messages request ──

function responsesToClaude(body: any): any {
  const model = resolveModel(body.model || "claude-sonnet-4-6");
  const claudeBody: any = {
    model,
    max_tokens: body.max_output_tokens || 8192,
    stream: !!body.stream,
  };

  // reasoning.effort → Claude thinking
  const effort = body.reasoning?.effort;
  if (effort && effort !== "none") {
    const budget = EFFORT_TO_BUDGET[effort];
    if (budget) {
      claudeBody.thinking = { type: "enabled", budget_tokens: budget };
      if (claudeBody.max_tokens <= budget) claudeBody.max_tokens = budget + 4096;
    } else {
      claudeBody.thinking = { type: "enabled", budget_tokens: 8192 };
    }
  }

  if (body.temperature !== undefined) {
    claudeBody.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    claudeBody.top_p = body.top_p;
  }

  // instructions → system
  if (body.instructions) {
    claudeBody.system = [{ type: "text", text: body.instructions }];
  }

  // tools: parameters → input_schema
  if (Array.isArray(body.tools)) {
    claudeBody.tools = body.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.parameters || t.input_schema || { type: "object", properties: {} },
    }));
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto" || tc?.type === "auto") claudeBody.tool_choice = { type: "auto" };
    else if (tc === "required" || tc?.type === "required") claudeBody.tool_choice = { type: "any" };
    else if (tc === "none" || tc?.type === "none") claudeBody.tool_choice = { type: "none" };
    else if (tc?.type === "function") claudeBody.tool_choice = { type: "tool", name: tc.name || tc.function?.name };
  }

  // input[] → messages[]
  const messages: any[] = [];
  const inputItems = typeof body.input === "string"
    ? [{ role: "user", content: body.input }]
    : body.input || [];

  for (const item of inputItems) {
    const role = item.role;

    // system/developer items in input[] (if instructions not set)
    if (role === "system" || role === "developer") {
      if (!claudeBody.system) {
        const text = extractText(item.content);
        if (text) claudeBody.system = [{ type: "text", text }];
      }
      continue;
    }

    if (role === "user" || role === "assistant") {
      if (typeof item.content === "string") {
        messages.push({ role, content: item.content });
      } else if (Array.isArray(item.content)) {
        const content = item.content.flatMap((part: any) => convertResponsesPart(part, role));
        if (content.length) messages.push({ role, content });
      }
    }

    // function_call_output → tool_result
    if (item.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        }],
      });
    }

    // function_call → assistant tool_use
    if (item.type === "function_call") {
      let input: any = {};
      try { input = JSON.parse(item.arguments || "{}"); } catch { /* ignore */ }
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: item.call_id || item.id, name: item.name, input }],
      });
    }
  }

  claudeBody.messages = messages;
  return claudeBody;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => p.text || "").join("\n");
  }
  return "";
}

function convertResponsesPart(part: any, role: string): any[] {
  if (!part || !part.type) return [];

  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return [{ type: "text", text: part.text || "" }];

    case "image":
    case "input_image": {
      const url = getResponsesImageUrl(part) || "";
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) return [{ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }];
      }
      if (url) return [{ type: "image", source: { type: "url", url } }];
      return [];
    }

    case "tool_use":
    case "function_call":
      if (role !== "assistant") return [];
      let input: any = {};
      try { input = JSON.parse(part.arguments || "{}"); } catch { /* ignore */ }
      return [{ type: "tool_use", id: part.call_id || part.id, name: part.name, input }];

    case "tool_result":
    case "function_call_output":
      return []; // handled separately in input loop

    default:
      return [];
  }
}

// ── Claude response → OpenAI Responses API format (non-streaming) ──

function claudeToResponses(claudeResp: any, model: string): any {
  const respId = `resp_${randomUUID().replace(/-/g, "")}`;
  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const contentParts: any[] = [];
  const toolCalls: any[] = [];

  for (const block of claudeResp.content || []) {
    if (block.type === "text") {
      contentParts.push({ type: "output_text", text: block.text, annotations: [] });
    } else if (block.type === "thinking" && block.thinking) {
      contentParts.push({ type: "reasoning", summary: [{ type: "summary_text", text: block.thinking }] });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        type: "function_call",
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
        status: "completed",
      });
    }
    // redacted_thinking — skip
  }

  const output: any[] = [];
  if (contentParts.length) {
    output.push({
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: contentParts,
    });
  }
  output.push(...toolCalls);

  const stopReason = claudeResp.stop_reason;
  const status = stopReason === "max_tokens" ? "incomplete" : "completed";
  const cacheCreation = claudeResp.usage?.cache_creation_input_tokens || 0;
  const cacheRead = claudeResp.usage?.cache_read_input_tokens || 0;
  const inputTokens = claudeResp.usage?.input_tokens || 0;
  const outputTokens = claudeResp.usage?.output_tokens || 0;

  return {
    id: respId,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage: {
      input_tokens: inputTokens + cacheCreation + cacheRead,
      output_tokens: outputTokens,
      total_tokens: inputTokens + cacheCreation + cacheRead + outputTokens,
      input_tokens_details: {
        cached_tokens: cacheRead,
      },
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    },
  };
}

// ── Claude SSE → OpenAI Responses API SSE (streaming) ──

interface ResponsesStreamState {
  respId: string;
  msgId: string;
  createdAt: number;
  seq: number;
  inTextBlock: boolean;
  inThinkingBlock: boolean;
  inToolBlock: boolean;
  currentToolId: string;
  currentToolName: string;
  toolIndex: number;
  baseInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  currentText: string;
  currentToolArgs: string;
}

function makeResponsesState(): ResponsesStreamState {
  return {
    respId: `resp_${randomUUID().replace(/-/g, "")}`,
    msgId: `msg_${randomUUID().replace(/-/g, "")}`,
    createdAt: Math.floor(Date.now() / 1000),
    seq: 0,
    inTextBlock: false,
    inThinkingBlock: false,
    inToolBlock: false,
    currentToolId: "",
    currentToolName: "",
    toolIndex: 0,
    baseInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    currentText: "",
    currentToolArgs: "",
  };
}

function emitEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function claudeSSEToResponses(event: string, data: any, state: ResponsesStreamState, model: string): string[] {
  const out: string[] = [];
  const nextSeq = () => ++state.seq;

  if (event === "message_start") {
    state.baseInputTokens = data.message?.usage?.input_tokens || 0;
    state.cacheCreationInputTokens = data.message?.usage?.cache_creation_input_tokens || 0;
    state.cacheReadInputTokens = data.message?.usage?.cache_read_input_tokens || 0;
    state.inputTokens = state.baseInputTokens + state.cacheCreationInputTokens + state.cacheReadInputTokens;
    out.push(emitEvent("response.created", {
      type: "response.created",
      sequence_number: nextSeq(),
      response: { id: state.respId, object: "response", created_at: state.createdAt, status: "in_progress", model, output: [] },
    }));
    out.push(emitEvent("response.in_progress", {
      type: "response.in_progress",
      sequence_number: nextSeq(),
      response: { id: state.respId, object: "response", created_at: state.createdAt, status: "in_progress", model, output: [] },
    }));
    return out;
  }

  if (event === "content_block_start") {
    const block = data.content_block;
    const idx = data.index;

    if (block?.type === "text") {
      state.inTextBlock = true;
      state.currentText = "";
      out.push(emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: idx,
        item: { id: state.msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
      }));
      out.push(emitEvent("response.content_part.added", {
        type: "response.content_part.added",
        sequence_number: nextSeq(),
        item_id: state.msgId,
        output_index: idx,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }));
    } else if (block?.type === "thinking") {
      state.inThinkingBlock = true;
    } else if (block?.type === "tool_use") {
      state.inToolBlock = true;
      state.currentToolId = block.id;
      state.currentToolName = block.name;
      state.currentToolArgs = "";
      const fcId = `fc_${block.id}`;
      out.push(emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: idx,
        item: { id: fcId, type: "function_call", status: "in_progress", call_id: block.id, name: block.name, arguments: "" },
      }));
    }
    // redacted_thinking — skip
    return out;
  }

  if (event === "content_block_delta") {
    const deltaType = data.delta?.type;
    const idx = data.index;

    if (deltaType === "text_delta") {
      state.currentText += data.delta.text;
      out.push(emitEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: nextSeq(),
        item_id: state.msgId,
        output_index: idx,
        content_index: 0,
        delta: data.delta.text,
      }));
    } else if (deltaType === "thinking_delta") {
      // thinking delta — skip in responses format (no standard field for this)
    } else if (deltaType === "redacted_thinking_delta") {
      // redacted_thinking — skip
    } else if (deltaType === "input_json_delta") {
      state.currentToolArgs += data.delta.partial_json;
      out.push(emitEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: nextSeq(),
        item_id: `fc_${state.currentToolId}`,
        output_index: idx,
        delta: data.delta.partial_json,
      }));
    }
    return out;
  }

  if (event === "content_block_stop") {
    const idx = data.index;
    if (state.inTextBlock) {
      out.push(emitEvent("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: nextSeq(),
        item_id: state.msgId,
        output_index: idx,
        content_index: 0,
        text: state.currentText,
      }));
      out.push(emitEvent("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        item_id: state.msgId,
        output_index: idx,
        content_index: 0,
        part: { type: "output_text", text: state.currentText, annotations: [] },
      }));
      out.push(emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item: { id: state.msgId, type: "message", status: "completed", role: "assistant", content: [] },
      }));
      state.inTextBlock = false;
      state.currentText = "";
    } else if (state.inThinkingBlock) {
      state.inThinkingBlock = false;
    } else if (state.inToolBlock) {
      const fcId = `fc_${state.currentToolId}`;
      out.push(emitEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: nextSeq(),
        item_id: fcId,
        output_index: idx,
        arguments: state.currentToolArgs,
      }));
      out.push(emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item: {
          id: fcId,
          type: "function_call",
          status: "completed",
          call_id: state.currentToolId,
          name: state.currentToolName,
          arguments: state.currentToolArgs,
        },
      }));
      state.inToolBlock = false;
      state.currentToolArgs = "";
    }
    return out;
  }

  if (event === "message_delta") {
    state.outputTokens = data.usage?.output_tokens || 0;
    if (typeof data.usage?.input_tokens === "number") {
      state.baseInputTokens = data.usage.input_tokens;
    }
    if (typeof data.usage?.cache_creation_input_tokens === "number") {
      state.cacheCreationInputTokens = data.usage.cache_creation_input_tokens;
    }
    if (typeof data.usage?.cache_read_input_tokens === "number") {
      state.cacheReadInputTokens = data.usage.cache_read_input_tokens;
    }
    state.inputTokens = state.baseInputTokens + state.cacheCreationInputTokens + state.cacheReadInputTokens;
  }

  if (event === "message_stop") {
    out.push(emitEvent("response.completed", {
      type: "response.completed",
      sequence_number: nextSeq(),
      response: {
        id: state.respId,
        object: "response",
        created_at: state.createdAt,
        status: "completed",
        model,
        output: [],
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
          input_tokens_details: {
            cached_tokens: state.cacheReadInputTokens,
          },
          cache_creation_input_tokens: state.cacheCreationInputTokens,
          cache_read_input_tokens: state.cacheReadInputTokens,
        },
      },
    }));
    out.push(`event: response.done\ndata: ${JSON.stringify({ type: "response.done", sequence_number: nextSeq() })}\n\n`);
    return out;
  }

  return out;
}

// ── Express handler ──

export function createResponsesHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.input && !body.messages) {
        setFailureContext(res, {
          stage: "validation",
          kind: "missing_input",
          message: "input is required",
        });
        res.status(400).json(invalidRequest("input is required", "missing_required_parameter"));
        return;
      }
      if (body.input !== undefined && !isValidResponsesInput(body.input)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_input",
          message: "input must be a string or array",
        });
        res.status(400).json(invalidRequest("input must be a string or array", "invalid_parameter"));
        return;
      }
      if (Array.isArray(body.input) && body.input.length === 0) {
        setFailureContext(res, {
          stage: "validation",
          kind: "empty_input",
          message: "input must contain at least one item",
        });
        res.status(400).json(invalidRequest("input must contain at least one item", "invalid_parameter"));
        return;
      }
      const inputItemError = getResponsesInputItemError(body.input);
      if (inputItemError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_input_item",
          message: inputItemError,
        });
        res.status(400).json(invalidRequest(inputItemError, "invalid_parameter"));
        return;
      }
      const toolsError = getResponsesToolsError(body.tools);
      if (toolsError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_tools",
          message: toolsError,
        });
        res.status(400).json(invalidRequest(toolsError, "invalid_parameter"));
        return;
      }
      if (!isValidResponsesToolChoice(body.tool_choice)) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_tool_choice",
          message: TOOL_CHOICE_ERROR,
        });
        res.status(400).json(invalidRequest(TOOL_CHOICE_ERROR, "invalid_parameter"));
        return;
      }
      const reasoningError = getResponsesReasoningError(body.reasoning);
      if (reasoningError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_reasoning",
          message: reasoningError,
        });
        res.status(400).json(invalidRequest(reasoningError, "invalid_parameter"));
        return;
      }
      const metadataError = getResponsesMetadataError(body.metadata);
      if (metadataError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_metadata",
          message: metadataError,
        });
        res.status(400).json(invalidRequest(metadataError, "invalid_parameter"));
        return;
      }
      const textFormatError = getResponsesTextFormatError(body.text);
      if (textFormatError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_text_format",
          message: textFormatError,
        });
        res.status(400).json(invalidRequest(textFormatError, "invalid_parameter"));
        return;
      }
      const unsupportedMetadataError = getClaudeResponsesUnsupportedMetadataError(body);
      if (unsupportedMetadataError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "unsupported_metadata",
          message: unsupportedMetadataError,
        });
        res.status(400).json(invalidRequest(unsupportedMetadataError, "invalid_parameter"));
        return;
      }
      const unsupportedTextFormatError = getClaudeResponsesUnsupportedTextFormatError(body);
      if (unsupportedTextFormatError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "unsupported_text_format",
          message: unsupportedTextFormatError,
        });
        res.status(400).json(invalidRequest(unsupportedTextFormatError, "invalid_parameter"));
        return;
      }
      const unsupportedReasoningError = getClaudeResponsesUnsupportedReasoningError(body);
      if (unsupportedReasoningError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "unsupported_reasoning",
          message: unsupportedReasoningError,
        });
        res.status(400).json(invalidRequest(unsupportedReasoningError, "invalid_parameter"));
        return;
      }
      const unsupportedToolError = getClaudeResponsesUnsupportedToolError(body);
      if (unsupportedToolError) {
        setFailureContext(res, {
          stage: "validation",
          kind: "unsupported_tool",
          message: unsupportedToolError,
        });
        res.status(400).json(invalidRequest(unsupportedToolError, "invalid_parameter"));
        return;
      }
      if (!validateResponsesStream(body, res)) {
        return;
      }
      if (!validateResponsesBackground(body, res)) {
        return;
      }
      if (!validateResponsesInstructions(body, res)) {
        return;
      }
      if (!validateResponsesStore(body, res)) {
        return;
      }
      if (!validateResponsesStreamOptions(body, res)) {
        return;
      }
      if (!validateResponsesMaxOutputTokens(body, res)) {
        return;
      }
      if (!validateResponsesNumberRange(body, res, "temperature", 0, 1)) {
        return;
      }
      if (!validateResponsesNumberRange(body, res, "top_p", 0, 1)) {
        return;
      }
      if (!validateResponsesTopLogprobs(body, res)) {
        return;
      }
      if (!validateResponsesParallelToolCalls(body, res)) {
        return;
      }
      if (!validateResponsesMaxToolCalls(body, res)) {
        return;
      }
      if (!validateResponsesServiceTier(body, res)) {
        return;
      }
      if (!validateResponsesSafetyIdentifier(body, res)) {
        return;
      }
      if (!validateResponsesUser(body, res)) {
        return;
      }
      if (!validateResponsesPromptCache(body, res)) {
        return;
      }
      if (!validateResponsesTruncation(body, res)) {
        return;
      }
      if (!validateResponsesConversation(body, res)) {
        return;
      }
      if (!validateResponsesPreviousResponseId(body, res)) {
        return;
      }
      if (!validateResponsesContextManagement(body, res)) {
        return;
      }
      if (!validateResponsesPrompt(body, res)) {
        return;
      }
      if (!validateResponsesInclude(body, res)) {
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const userAgent = req.headers["user-agent"] || "";
      const apiKey = extractApiKey(req.headers);

      let claudeBody = responsesToClaude(body);
      claudeBody = applyCloaking(claudeBody, config.cloaking, userAgent, apiKey);

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
            console.error(redactForLog(`Responses attempt ${attempt + 1} network failure: ${err.message}`));
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
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders();

            const reader = upstreamResp.body?.getReader();
            if (!reader) { res.end(); return; }

            const state = makeResponsesState();
            const decoder = new TextDecoder();
            let buffer = "";
            let clientDisconnected = false;
            let completed = false;
            let currentEvent = "";
            res.on("close", () => { clientDisconnected = true; reader.cancel().catch(() => {}); });

            try {
              while (!clientDisconnected) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                  if (line.startsWith("event:")) {
                    currentEvent = line.slice(6).trim();
                  } else if (line.startsWith("data:")) {
                    const raw = line.slice(5).trim();
                    if (!raw || raw === "[DONE]") continue;
                    try {
                      const data = JSON.parse(raw);
                      const chunks = claudeSSEToResponses(currentEvent, data, state, model);
                      for (const chunk of chunks) {
                        if (!clientDisconnected) res.write(chunk);
                      }
                      if (currentEvent === "message_stop") {
                        completed = true;
                      }
                    } catch { /* ignore parse errors */ }
                  }
                }
              }
            } catch (err) {
              if (!clientDisconnected) console.error("Responses stream error:", redactForLog(err));
            } finally {
              if (!clientDisconnected) {
                if (completed) {
                  manager.recordSuccess(account.email);
                } else {
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
            const parsed = await readClaudeJsonResponse(upstreamResp, res, manager, account.email);
            if (!parsed.ok) return;
            const claudeResp = parsed.data;
            manager.recordSuccess(account.email);
            res.json(claudeToResponses(claudeResp, model));
          }
          return;
        }

        lastStatus = upstreamResp.status;
        if (isDebugLevel(config.debug, "errors")) {
          const errText = await upstreamResp.text().catch(() => "");
          console.error(redactForLog(`Responses attempt ${attempt + 1} failed (${lastStatus}): ${errText}`));
        }

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
      console.error("Responses handler error:", redactForLog(err.message));
      setFailureContext(res, {
        stage: "internal",
        kind: "internal_error",
        message: err?.message || "Internal server error",
      });
      res.status(500).json(apiError("Internal server error", "internal_error"));
    }
  };
}
