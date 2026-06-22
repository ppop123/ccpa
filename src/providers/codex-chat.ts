import express from "express";
import { randomUUID } from "node:crypto";
import { setFailureContext } from "../monitoring/http-usage";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { apiError, codexAuthErrorResponse, invalidRequest } from "./codex-errors";
import { CodexRequestOptions, normalizeCodexRequestBody } from "./codex-request";
import {
  CodexUpstreamInvalidResponseError,
  CodexUpstreamSseError,
  CodexUpstreamTruncatedStreamError,
  collectCodexResponseFromSse,
  extractCodexTextEvent,
  getCodexTextSuffix,
  isCodexResponseIncompleteEvent,
  parseCodexUpstreamSseError,
} from "./codex-sse";
import {
  CodexUpstreamNetworkError,
  CodexUpstreamTimeoutError,
  callCodexResponsesWithAuthRetry,
} from "./codex-upstream";

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

function convertChatCustomToolFormatToResponses(format: unknown): unknown {
  if (!isObjectRecord(format)) {
    return undefined;
  }
  if (format.type === "text") {
    return { type: "text" };
  }
  if (format.type === "grammar" && isObjectRecord(format.grammar)) {
    return {
      type: "grammar",
      definition: format.grammar.definition,
      syntax: format.grammar.syntax,
    };
  }
  return undefined;
}

function toResponsesPromptCacheRetention(value: string): string {
  return value === "in_memory" ? "in-memory" : value;
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

function formatGeneratedImageMarkdown(b64: string, format: string): string {
  return `![generated image](data:image/${format};base64,${b64})`;
}

function imageMarkdownFromGenerationItem(item: any): string {
  const imageB64 = item?.result || item?.b64_json || item?.image_b64;
  if (typeof imageB64 !== "string" || !imageB64) {
    return "";
  }
  const format = typeof item?.output_format === "string" && item.output_format ? item.output_format : "png";
  return formatGeneratedImageMarkdown(imageB64, format);
}

function normalizeOutputText(upstream: any): string {
  if (Array.isArray(upstream?.output)) {
    // Collect message text and image markdown from all items so we can return
    // both when the model produces a chat reply alongside an image_generation_call.
    // Image FIRST so chat clients that only parse the leading markdown find it;
    // text after, separated by a blank line.
    let messageText = "";
    let imageMarkdown = "";

    for (const item of upstream.output) {
      if (item?.type === "image_generation_call") {
        const generatedImage = imageMarkdownFromGenerationItem(item);
        if (generatedImage && !imageMarkdown) {
          imageMarkdown = generatedImage;
        }
        continue;
      }
      if (item?.role === "assistant" || item?.type === "message") {
        const text = normalizeMessageContent(item?.content);
        if (text && !messageText) {
          messageText = text;
        }
      }
    }

    if (imageMarkdown && messageText) return `${imageMarkdown}\n\n${messageText}`;
    if (imageMarkdown) return imageMarkdown;
    if (messageText) return messageText;
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

function emitChatChunk(
  model: string,
  chatId: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  includeUsageField = false
): string {
  // OpenAI streaming contract: every chunk in a completion shares one id. Prior
  // code regenerated uuid per chunk, which broke clients that group chunks by id.
  const chunk: any = {
    id: chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };

  if (usage) {
    chunk.usage = usage;
  } else if (includeUsageField) {
    chunk.usage = null;
  }

  return JSON.stringify(chunk);
}

function emitChatUsageChunk(
  model: string,
  chatId: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): string {
  return JSON.stringify({
    id: chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  });
}

function writeSseData(res: express.Response, data: string): void {
  res.write(`data: ${data}\n\n`);
}

function mapFinishReason(status: any): string {
  if (status === "incomplete") {
    return "length";
  }
  return "stop";
}

// Image-generation auto-detect: enables gpt-5.5 → image-2 path either by an
// explicit {type:"image_generation"} tool, a modalities=["image"] hint, or
// a natural-language draw request (Chinese / English). Without this, callers
// who say "画一只猫" get ASCII art back because the model isn't told it can
// reach for a real image tool.
function hasImageGenerationTool(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some((tool: any) => tool?.type === "image_generation");
}

function hasImageGenerationToolChoice(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return false;
  }

  const choice = toolChoice as any;
  if (choice.type === "image_generation") {
    return true;
  }
  if (choice.type === "allowed_tools") {
    return hasImageGenerationTool(choice.allowed_tools?.tools);
  }
  return false;
}

function isImageGenerationRequest(messages: any[]): boolean {
  const text = messages
    .map((message) => normalizeMessageContent(message?.content) || "")
    .join("\n")
    .toLowerCase();

  if (!text) {
    return false;
  }

  return (
    /生图|文生图|画一张|画张|生成.*图|生成.*图片|做一张.*图|做张.*图/.test(text) ||
    // 画 + 数词 + 量词（"画一只 / 画两张 / 画三幅 / 画一个 ..."）
    /画\s*[一二三四五六七八九十两双几]\s*[只张幅个匹条头副朵串幢座位道支]/.test(text) ||
    // 绘制 / 画出 / 创作 + （可选）名词
    /(画出|绘制|创作|绘画|插画)[一-龥]{0,8}(图|画|插|海报|风景|猫|狗|人|物|花|景|场景|角色)/.test(text) ||
    /\b(generate|create|draw|make|render)\b.{0,40}\b(image|picture|icon|illustration|logo|poster|art|painting|portrait)\b/.test(text)
  );
}

function shouldEnableImageGeneration(body: any, messages: any[]): boolean {
  if (hasImageGenerationTool(body?.tools)) {
    return true;
  }
  if (hasImageGenerationToolChoice(body?.tool_choice)) {
    return true;
  }
  if (Array.isArray(body?.modalities) && body.modalities.includes("image")) {
    return true;
  }
  return isImageGenerationRequest(messages);
}

function shouldUseLegacyFunctionCallResponse(body: any): boolean {
  return body?.tools === undefined && Array.isArray(body?.functions);
}

function extractToolCalls(upstream: any): any[] {
  if (!Array.isArray(upstream?.output)) return [];
  const calls: any[] = [];
  for (const item of upstream.output) {
    if (item?.type === "function_call") {
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      calls.push({
        id: item.call_id || item.id || `call_${randomUUID()}`,
        type: "function",
        function: { name: item.name, arguments: args },
      });
    } else if (item?.type === "custom_tool_call") {
      calls.push({
        id: item.call_id || item.id || `call_${randomUUID()}`,
        type: "custom",
        custom: {
          name: item.name,
          input: typeof item.input === "string" ? item.input : String(item.input ?? ""),
        },
      });
    }
  }
  return calls;
}

function applyLegacyFunctionCallResponse(message: any, toolCalls: any[]): boolean {
  const functionCall = toolCalls.find((toolCall) => toolCall?.type === "function" && toolCall.function);
  if (!functionCall) {
    return false;
  }

  message.function_call = {
    name: functionCall.function.name,
    arguments:
      typeof functionCall.function.arguments === "string"
        ? functionCall.function.arguments
        : JSON.stringify(functionCall.function.arguments ?? {}),
  };
  return true;
}

function normalizeResponse(
  upstream: any,
  model: string,
  options: { legacyFunctionCall?: boolean } = {}
): any {
  const completionText = normalizeOutputText(upstream);
  const toolCalls = extractToolCalls(upstream);
  const message: any = { role: "assistant", content: completionText || null };
  const legacyFunctionCall = options.legacyFunctionCall
    ? applyLegacyFunctionCallResponse(message, toolCalls)
    : false;
  if (toolCalls.length) {
    if (!legacyFunctionCall) {
      message.tool_calls = toolCalls;
    }
  }
  const finishReason = legacyFunctionCall
    ? "function_call"
    : toolCalls.length
    ? "tool_calls"
    : upstream?.status === "incomplete"
      ? "length"
      : "stop";
  const response: any = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: upstream?.model || model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: normalizeUsage(upstream),
  };
  if (typeof upstream?.service_tier === "string") {
    response.service_tier = upstream.service_tier;
  }
  return response;
}

function convertChatToolsToResponses(tools: any): any[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .map((t: any) => {
      if (t?.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object", properties: {} },
          strict: t.function.strict ?? false,
        };
      }
      if (t?.type === "custom" && t.custom) {
        const tool: any = {
          type: "custom",
          name: t.custom.name,
        };
        if (t.custom.description !== undefined) {
          tool.description = t.custom.description;
        }
        const format = convertChatCustomToolFormatToResponses(t.custom.format);
        if (format !== undefined) {
          tool.format = format;
        }
        return tool;
      }
      return t;
    })
    .filter(Boolean);
  return out.length ? out : undefined;
}

function convertChatToolChoiceToResponses(tc: any): any {
  if (tc == null) return undefined;
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if (typeof tc === "string") {
    throw new CodexChatValidationError(CHAT_TOOL_CHOICE_ERROR);
  }
  if (tc?.type === "function" && tc.function?.name) {
    return { type: "function", name: tc.function.name };
  }
  if (tc?.type === "custom" && tc.custom?.name) {
    return { type: "custom", name: tc.custom.name };
  }
  if (tc?.type === "image_generation") {
    return tc;
  }
  if (tc?.type === "allowed_tools") {
    return {
      type: "allowed_tools",
      mode: tc.allowed_tools.mode,
      tools: tc.allowed_tools.tools.map((tool: any) => {
        if (tool?.type === "function") {
          return { type: "function", name: tool.function.name };
        }
        if (tool?.type === "custom") {
          return { type: "custom", name: tool.custom.name };
        }
        return tool;
      }),
    };
  }
  throw new CodexChatValidationError(CHAT_TOOL_CHOICE_ERROR);
}

class CodexChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexChatValidationError";
  }
}

function validateChatStream(body: any, res: express.Response): boolean {
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

function validateChatMaxTokens(body: any, res: express.Response): boolean {
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

function validateChatN(body: any, res: express.Response): boolean {
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

function failChatValidation(
  res: express.Response,
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

function validateChatReasoningEffort(body: any, res: express.Response): boolean {
  const value = body?.reasoning_effort;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string" && VALID_REASONING_EFFORTS.has(value)) {
    return true;
  }

  return failChatValidation(res, "invalid_reasoning_effort", REASONING_EFFORT_ERROR);
}

function validateChatModalities(body: any, res: express.Response): boolean {
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

function validateChatParallelToolCalls(body: any, res: express.Response): boolean {
  const value = body?.parallel_tool_calls;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }

  return failChatValidation(
    res,
    "invalid_parallel_tool_calls",
    "parallel_tool_calls must be a boolean"
  );
}

function validateChatServiceTier(body: any, res: express.Response): boolean {
  const value = body?.service_tier;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string" && VALID_SERVICE_TIERS.has(value)) {
    return true;
  }

  return failChatValidation(res, "invalid_service_tier", SERVICE_TIER_ERROR);
}

function validateChatStore(body: any, res: express.Response): boolean {
  const value = body?.store;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }

  return failChatValidation(res, "invalid_store", "store must be a boolean");
}

function validateChatStreamOptions(body: any, res: express.Response): boolean {
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

  return true;
}

function validateChatWebSearchOptions(body: any, res: express.Response): boolean {
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

function validateChatVerbosity(body: any, res: express.Response): boolean {
  const value = body?.verbosity;
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string" && VALID_CHAT_VERBOSITIES.has(value)) {
    return true;
  }

  return failChatValidation(res, "invalid_verbosity", VERBOSITY_ERROR);
}

function validateChatPromptCache(body: any, res: express.Response): boolean {
  if (body?.prompt_cache_key !== undefined && typeof body.prompt_cache_key !== "string") {
    return failChatValidation(res, "invalid_prompt_cache_key", "prompt_cache_key must be a string");
  }

  const retention = body?.prompt_cache_retention;
  if (retention === undefined) {
    return true;
  }
  if (typeof retention === "string" && VALID_CHAT_PROMPT_CACHE_RETENTIONS.has(retention)) {
    return true;
  }

  return failChatValidation(res, "invalid_prompt_cache_retention", PROMPT_CACHE_RETENTION_ERROR);
}

function validateChatSafetyIdentifier(body: any, res: express.Response): boolean {
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
  return true;
}

function validateChatUser(body: any, res: express.Response): boolean {
  const value = body?.user;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return failChatValidation(res, "invalid_user", "user must be a string");
  }
  return true;
}

function validateChatSeed(body: any, res: express.Response): boolean {
  const value = body?.seed;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < CHAT_SEED_MIN || value > CHAT_SEED_MAX) {
    return failChatValidation(res, "invalid_seed", CHAT_SEED_ERROR);
  }
  return failChatValidation(res, "unsupported_seed", "seed is unsupported");
}

function validateChatMetadata(body: any, res: express.Response): boolean {
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

  return true;
}

function validateChatLogprobs(body: any, res: express.Response): boolean {
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
  res: express.Response,
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

function validateChatPrediction(body: any, res: express.Response): boolean {
  if (body?.prediction === undefined) {
    return true;
  }
  const error = getChatPredictionError(body.prediction);
  if (error) {
    return failChatValidation(res, "invalid_prediction", error);
  }
  return failChatValidation(res, "unsupported_prediction", "prediction is unsupported");
}

function validateChatResponseFormat(body: any, res: express.Response): boolean {
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
    return true;
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

  return true;
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

function validateChatStop(body: any, res: express.Response): boolean {
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
      continue;
    }
    if (tool.type === "custom") {
      const customError = getChatCustomToolError(tool, prefix);
      if (customError) {
        return customError;
      }
      continue;
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

function validateChatTools(body: any, res: express.Response): boolean {
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

function validateLegacyChatFunctions(body: any, res: express.Response): boolean {
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

function validateLegacyChatFunctionCall(body: any, res: express.Response): boolean {
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

function isValidChatToolChoice(toolChoice: unknown): boolean {
  if (toolChoice === undefined || toolChoice === null) {
    return true;
  }
  if (typeof toolChoice === "string") {
    return VALID_CHAT_TOOL_CHOICE_STRINGS.has(toolChoice);
  }
  if (!isObjectRecord(toolChoice)) {
    return false;
  }

  if (toolChoice.type === "image_generation") {
    return true;
  }
  if (toolChoice.type === "allowed_tools") {
    return isValidAllowedToolsChoice(toolChoice);
  }
  if (toolChoice.type === "custom") {
    return isObjectRecord(toolChoice.custom) && isNonEmptyString(toolChoice.custom.name);
  }
  if (toolChoice.type !== "function") {
    return false;
  }
  return isObjectRecord(toolChoice.function) && isNonEmptyString(toolChoice.function.name);
}

function validateChatToolChoice(body: any, res: express.Response): boolean {
  if (isValidChatToolChoice(body?.tool_choice)) {
    return true;
  }

  setFailureContext(res, {
    stage: "validation",
    kind: "invalid_tool_choice",
    message: CHAT_TOOL_CHOICE_ERROR,
  });
  res.status(400).json(invalidRequest(CHAT_TOOL_CHOICE_ERROR, "invalid_parameter"));
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

function validateChatMessageRoles(body: any, res: express.Response): boolean {
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
          continue;
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

function normalizeChatContentForResponses(role: string, content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  return content.map((part: any) => {
    if (part.type === "text") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text,
      };
    }
    if (part.type === "image_url") {
      const out: any = {
        type: "input_image",
        image_url: part.image_url.url,
      };
      if (part.image_url.detail !== undefined) {
        out.detail = part.image_url.detail;
      }
      return out;
    }
    return part;
  });
}

function normalizeToolMessageOutput(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return JSON.stringify(content ?? "");
}

function collectChatToolCallTypes(messages: any[]): Map<string, "function" | "custom"> {
  const toolCallTypes = new Map<string, "function" | "custom">();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (typeof toolCall?.id !== "string" || !toolCall.id) {
        continue;
      }
      if (toolCall.type === "custom") {
        toolCallTypes.set(toolCall.id, "custom");
      } else if (toolCall.type === "function") {
        toolCallTypes.set(toolCall.id, "function");
      }
    }
  }
  return toolCallTypes;
}

function convertChatResponseFormatToResponses(responseFormat: any): any | undefined {
  if (responseFormat === undefined) {
    return undefined;
  }
  if (responseFormat.type === "text" || responseFormat.type === "json_object") {
    return { type: responseFormat.type };
  }

  const jsonSchema = responseFormat.json_schema;
  const format: any = {
    type: "json_schema",
    name: jsonSchema.name,
    schema: jsonSchema.schema,
  };
  if (jsonSchema.description !== undefined) {
    format.description = jsonSchema.description;
  }
  if (jsonSchema.strict !== undefined) {
    format.strict = jsonSchema.strict;
  }
  return format;
}

function mergeTextConfig(req: any, patch: Record<string, unknown>): void {
  req.text = {
    ...(isObjectRecord(req.text) ? req.text : {}),
    ...patch,
  };
}

// chat/completions 消息历史 → Responses API input（含多轮工具续接）
function convertMessagesToInput(messages: any[]): any[] {
  const input: any[] = [];
  const toolCallTypes = collectChatToolCallTypes(messages);
  for (const message of messages) {
    const role = message?.role;
    // 工具结果 → function/custom tool output
    if (role === "tool") {
      const outputType = toolCallTypes.get(message.tool_call_id) === "custom"
        ? "custom_tool_call_output"
        : "function_call_output";
      input.push({
        type: outputType,
        call_id: message.tool_call_id,
        output: normalizeToolMessageOutput(message.content),
      });
      continue;
    }
    // assistant 带 tool_calls → （可选文本）+ function/custom tool call 项
    if (
      role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length
    ) {
      if (message.content) {
        input.push({ role: "assistant", content: normalizeChatContentForResponses("assistant", message.content) });
      }
      for (const tc of message.tool_calls) {
        if (tc?.type === "function" && tc.function) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments ?? {}),
          });
        } else if (tc?.type === "custom" && tc.custom) {
          input.push({
            type: "custom_tool_call",
            call_id: tc.id,
            name: tc.custom.name,
            input: tc.custom.input,
          });
        }
      }
      continue;
    }
    // 普通消息
    input.push({ role, content: normalizeChatContentForResponses(role, message.content) });
  }
  return input;
}

function canonicalizeChatRequest(body: any, stream: boolean, requestOptions?: CodexRequestOptions): any {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const input = convertMessagesToInput(messages);

  const req: any = {
    model: body?.model || "gpt-5.4",
    input,
    stream,
  };
  if (typeof body?.store === "boolean") {
    req.store = body.store;
  }
  const maxCompletionTokens = body?.max_completion_tokens ?? body?.max_tokens;
  if (maxCompletionTokens !== undefined) {
    req.max_output_tokens = maxCompletionTokens;
  }
  if (body?.temperature !== undefined) {
    req.temperature = body.temperature;
  }
  if (body?.top_p !== undefined) {
    req.top_p = body.top_p;
  }
  if (body?.stop !== undefined && body.stop !== null) {
    req.stop = body.stop;
  }
  if (body?.parallel_tool_calls !== undefined) {
    req.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body?.stream_options?.include_obfuscation !== undefined) {
    req.stream_options = { include_obfuscation: body.stream_options.include_obfuscation };
  }
  const textFormat = convertChatResponseFormatToResponses(body?.response_format);
  if (textFormat !== undefined) {
    mergeTextConfig(req, { format: textFormat });
  }
  if (body?.verbosity !== undefined) {
    mergeTextConfig(req, { verbosity: body.verbosity });
  }
  if (body?.service_tier !== undefined) {
    req.service_tier = body.service_tier;
  }
  if (body?.prompt_cache_key !== undefined) {
    req.prompt_cache_key = body.prompt_cache_key;
  }
  if (body?.prompt_cache_retention !== undefined) {
    req.prompt_cache_retention = toResponsesPromptCacheRetention(body.prompt_cache_retention);
  }
  if (body?.safety_identifier !== undefined) {
    req.safety_identifier = body.safety_identifier;
  }
  if (body?.user !== undefined) {
    req.user = body.user;
  }
  if (body?.metadata !== undefined) {
    req.metadata = body.metadata;
  }
  if (body?.reasoning_effort !== undefined) {
    req.reasoning = { effort: body.reasoning_effort };
  }

  // 1. Convert OpenAI tools → Responses API tools (function-shape passthrough).
  //    {type:"image_generation"} survives this because the mapper returns it as-is.
  const tools = convertChatToolsToResponses(body?.tools);
  if (tools) {
    req.tools = tools;
  }

  // 2. Convert OpenAI tool_choice if the caller set one.
  const toolChoice = convertChatToolChoiceToResponses(body?.tool_choice);
  if (toolChoice !== undefined) {
    req.tool_choice = toolChoice;
  }

  // 3. Image-generation auto-detect: if the caller didn't explicitly include
  //    {type:"image_generation"} but a draw intent was detected, add it; in
  //    either path, pin tool_choice so gpt-5.5 doesn't fall back to ASCII art.
  if (shouldEnableImageGeneration(body, messages)) {
    const existing: any[] = Array.isArray(req.tools) ? req.tools : [];
    if (!existing.some((t: any) => t?.type === "image_generation")) {
      existing.push({ type: "image_generation" });
    }
    req.tools = existing;
    if (req.tool_choice === undefined) {
      req.tool_choice = { type: "image_generation" };
    }
  }

  return normalizeCodexRequestBody(req, requestOptions);
}

async function streamCodexChatResponses(
  upstreamResp: Response,
  res: express.Response,
  model: string,
  options: { includeUsage?: boolean; legacyFunctionCall?: boolean } = {}
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // One chat id shared by every chunk in this completion (OpenAI streaming spec).
  const chatId = `chatcmpl-${randomUUID()}`;

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
  let buffer = "";
  let currentEvent = "";
  let sentRoleChunk = false;
  let sentFinalChunk = false;
  let sentUsageChunk = false;
  let sentDone = false;
  let completed = false;
  let clientDisconnected = false;
  let upstreamSseError: CodexUpstreamSseError | null = null;
  let streamedText = "";
  let pendingUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  let pendingFinishReason: string | null = null;
  let toolCallIndex = 0;
  let sawToolCall = false;
  const emittedImageMarkdown = new Set<string>();
  const includeUsage = !!options.includeUsage;
  const legacyFunctionCall = !!options.legacyFunctionCall;
  const emitChunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  ) => emitChatChunk(model, chatId, delta, finishReason, usage, includeUsage);

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

      for (const rawLine of lines) {
        if (clientDisconnected) break;

        const line = rawLine.trimEnd();
        if (!line) {
          currentEvent = "";
          continue;
        }

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (!line.startsWith("data:")) {
          continue;
        }

        const dataStr = line.slice(5).trimStart();
        if (dataStr === "[DONE]") {
          completed = true;
          if (!sentDone) {
            writeSseData(res, "[DONE]");
            sentDone = true;
          }
          continue;
        }

        let data: any;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const parsedUpstreamError = parseCodexUpstreamSseError(currentEvent, data);
        if (parsedUpstreamError) {
          upstreamSseError = parsedUpstreamError;
          completed = false;
          break;
        }

        if (currentEvent === "response.created") {
          if (!sentRoleChunk) {
            writeSseData(res, emitChunk({ role: "assistant" }));
            sentRoleChunk = true;
          }
          continue;
        }

        const textEvent = extractCodexTextEvent(currentEvent, data);
        if (textEvent) {
          if (!sentRoleChunk) {
            writeSseData(res, emitChunk({ role: "assistant" }));
            sentRoleChunk = true;
          }
          const text = textEvent.final
            ? getCodexTextSuffix(streamedText, textEvent.text)
            : textEvent.text;
          if (text) {
            streamedText += text;
            writeSseData(res, emitChunk({ content: text }));
          }
          continue;
        }

        if (
          currentEvent === "response.image_generation_call.partial_image" ||
          currentEvent === "response.output_item.partial_image"
        ) {
          const b64 = typeof data?.partial_image_b64 === "string" ? data.partial_image_b64 : "";
          if (b64) {
            if (!sentRoleChunk) {
              writeSseData(res, emitChunk({ role: "assistant" }));
              sentRoleChunk = true;
            }
            const format = typeof data?.output_format === "string" && data.output_format ? data.output_format : "png";
            const markdown = formatGeneratedImageMarkdown(b64, format);
            if (!emittedImageMarkdown.has(markdown)) {
              emittedImageMarkdown.add(markdown);
              writeSseData(res, emitChunk({ content: markdown }));
            }
          }
          continue;
        }

        if (
          currentEvent === "response.output_item.done" &&
          data?.item?.type === "image_generation_call"
        ) {
          const markdown = imageMarkdownFromGenerationItem(data.item);
          if (markdown) {
            if (!sentRoleChunk) {
              writeSseData(res, emitChunk({ role: "assistant" }));
              sentRoleChunk = true;
            }
            if (!emittedImageMarkdown.has(markdown)) {
              emittedImageMarkdown.add(markdown);
              writeSseData(res, emitChunk({ content: markdown }));
            }
          }
          continue;
        }

        if (
          currentEvent === "response.output_item.done" &&
          data?.item?.type === "function_call"
        ) {
          if (!sentRoleChunk) {
            writeSseData(res, emitChunk({ role: "assistant" }));
            sentRoleChunk = true;
          }
          const item = data.item;
          const args =
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {});
          if (legacyFunctionCall) {
            writeSseData(
              res,
              emitChunk({
                function_call: {
                  name: item.name,
                  arguments: args,
                },
              })
            );
          } else {
            writeSseData(
              res,
              emitChunk({
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: item.call_id || item.id || `call_${randomUUID()}`,
                    type: "function",
                    function: { name: item.name, arguments: args },
                  },
                ],
              })
            );
          }
          toolCallIndex++;
          sawToolCall = true;
          continue;
        }

        if (
          currentEvent === "response.output_item.done" &&
          data?.item?.type === "custom_tool_call"
        ) {
          if (!sentRoleChunk) {
            writeSseData(res, emitChunk({ role: "assistant" }));
            sentRoleChunk = true;
          }
          const item = data.item;
          writeSseData(
            res,
            emitChunk({
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: item.call_id || item.id || `call_${randomUUID()}`,
                  type: "custom",
                  custom: {
                    name: item.name,
                    input: typeof item.input === "string" ? item.input : String(item.input ?? ""),
                  },
                },
              ],
            })
          );
          toolCallIndex++;
          sawToolCall = true;
          continue;
        }

        if (currentEvent === "response.completed" || isCodexResponseIncompleteEvent(currentEvent, data)) {
          completed = true;
          const upstreamResponse = data?.response || data;
          const usage = upstreamResponse?.usage || data?.usage;
          pendingUsage = usage
            ? {
                prompt_tokens: usage.input_tokens || 0,
                completion_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
              }
            : pendingUsage;
          pendingFinishReason = sawToolCall
            ? legacyFunctionCall ? "function_call" : "tool_calls"
            : mapFinishReason(upstreamResponse?.status || data?.status);
          if (!sentFinalChunk) {
            writeSseData(
              res,
              emitChunk({}, pendingFinishReason || "stop", includeUsage ? undefined : pendingUsage)
            );
            sentFinalChunk = true;
          }
          if (includeUsage && pendingUsage && !sentUsageChunk) {
            writeSseData(res, emitChatUsageChunk(model, chatId, pendingUsage));
            sentUsageChunk = true;
          }
          continue;
        }

        if (currentEvent === "response.done") {
          completed = true;
          if (!sentDone) {
            writeSseData(res, "[DONE]");
            sentDone = true;
          }
          continue;
        }
      }

      if (upstreamSseError) {
        break;
      }
    }
  } catch {
    completed = false;
  } finally {
    if (!clientDisconnected) {
      if (upstreamSseError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: upstreamSseError.kind,
          message: upstreamSseError.message,
          upstreamStatus: upstreamSseError.status,
        });
        res.end();
        return;
      }
      if (!completed) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: "Upstream stream ended before completion",
          upstreamStatus: 502,
        });
        res.end();
        return;
      }
      if (!sentFinalChunk) {
        writeSseData(res, emitChunk({}, pendingFinishReason || "stop", includeUsage ? undefined : pendingUsage));
      }
      if (includeUsage && pendingUsage && !sentUsageChunk) {
        writeSseData(res, emitChatUsageChunk(model, chatId, pendingUsage));
      }
      if (!sentDone) {
        writeSseData(res, "[DONE]");
      }
      res.end();
    }
  }
}

export function createCodexChatCompletionsHandler(
  authStore: CodexAuthStore,
  requestOptions?: CodexRequestOptions
): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      let body = req.body || {};
      if (!Array.isArray(body.messages)) {
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
      if (!validateChatNumberRange(body, res, "temperature", 0, 2)) {
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

      let snapshot;
      try {
        snapshot = authStore.load();
      } catch (error) {
        if (error instanceof CodexAuthError) {
          const authError = codexAuthErrorResponse(error.message);
          res.status(authError.status).json(authError.body);
          return;
        }
        throw error;
      }

      const normalizedBody = normalizeLegacyChatFunctionFields(body);
      const legacyFunctionCallResponse = shouldUseLegacyFunctionCallResponse(body);
      const stream = !!normalizedBody.stream;
      let canonicalRequest;
      try {
        canonicalRequest = canonicalizeChatRequest(normalizedBody, stream, requestOptions);
      } catch (error) {
        if (error instanceof CodexChatValidationError) {
          setFailureContext(res, {
            stage: "validation",
            kind: "invalid_request",
            message: error.message,
          });
          res.status(400).json(invalidRequest(error.message));
          return;
        }
        throw error;
      }
      const upstreamRequest = {
        ...canonicalRequest,
        stream: true,
      };
      const { response: upstreamResp } = await callCodexResponsesWithAuthRetry(
        authStore,
        snapshot,
        upstreamRequest,
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

      if (stream) {
        await streamCodexChatResponses(upstreamResp, res, canonicalRequest.model, {
          includeUsage: body?.stream_options?.include_usage === true,
          legacyFunctionCall: legacyFunctionCallResponse,
        });
        return;
      }

      const upstreamJson = await collectCodexResponseFromSse(upstreamResp);
      res.json(normalizeResponse(upstreamJson, canonicalRequest.model, {
        legacyFunctionCall: legacyFunctionCallResponse,
      }));
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

      res.status(500).json(apiError(error?.message || "Internal server error", "internal_error"));
    }
  };
}
