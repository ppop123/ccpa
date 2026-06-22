import { randomUUID } from "node:crypto";

// ── Model alias resolution ──

const MODEL_ALIASES: Record<string, string> = {
  opus:                      "claude-opus-4-6",
  sonnet:                    "claude-sonnet-4-6",
  haiku:                     "claude-haiku-4-5-20251001",
  "claude-opus-4-8":         "claude-opus-4-8",
  "claude-opus-4-6":         "claude-opus-4-6",
  "claude-sonnet-4-6":       "claude-sonnet-4-6",
  "claude-haiku-4-5":        "claude-haiku-4-5-20251001",
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// ── Reasoning effort → Claude thinking config ──

const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 32768,
};

function applyThinking(claudeBody: any, reasoningEffort: string): void {
  if (reasoningEffort === "none") {
    claudeBody.thinking = { type: "disabled" };
    return;
  }
  const budget = EFFORT_TO_BUDGET[reasoningEffort];
  if (budget) {
    claudeBody.thinking = { type: "enabled", budget_tokens: budget };
    // budget must be < max_tokens
    if (claudeBody.max_tokens <= budget) {
      claudeBody.max_tokens = budget + 4096;
    }
  } else {
    // "auto" or unknown → adaptive
    claudeBody.thinking = { type: "enabled", budget_tokens: 8192 };
  }
}

function disableThinkingIfToolChoiceForced(claudeBody: any): void {
  const tcType = claudeBody.tool_choice?.type;
  if (tcType === "any" || tcType === "tool") {
    delete claudeBody.thinking;
  }
}

// ── OpenAI image_url → Claude image ──

function convertContentParts(parts: any[]): any[] {
  return parts.map((part: any) => {
    if (part.type === "image_url" && part.image_url?.url) {
      const url: string = part.image_url.url;
      if (url.startsWith("data:")) {
        // data:image/png;base64,iVBOR...
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
      }
      // Remote URL
      return { type: "image", source: { type: "url", url } };
    }
    return part;
  });
}

// ── OpenAI tool_choice → Claude tool_choice ──

function convertToolChoice(tc: any): any {
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return { type: "none" };
  if (tc?.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  return tc;
}

// ── OpenAI tools → Claude tools ──

function convertTools(tools: any[]): any[] {
  const converted = tools.map((t: any) => {
    if (t.type === "function" && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      };
    }
    return t;
  });
  // Prompt cache breakpoint on the last tool: tool definitions are large
  // and stable across turns — caching them slashes input tokens on multi-turn calls.
  // Claude allows up to 4 cache_control breakpoints; placing one at the tools
  // tail caches the entire tools array as a single prefix.
  if (converted.length > 0) {
    const last = converted[converted.length - 1];
    if (last && typeof last === "object" && !last.cache_control) {
      converted[converted.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
    }
  }
  return converted;
}

// ── OpenAI chat completion request → Claude messages request ──

export function openaiToClaude(body: any): any {
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 8192;
  const claudeBody: any = {
    model: resolveModel(body.model || "claude-sonnet-4-6"),
    max_tokens: maxTokens,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) claudeBody.temperature = body.temperature;
  if (body.top_p !== undefined) claudeBody.top_p = body.top_p;
  if (body.stop !== undefined && body.stop !== null) {
    claudeBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }

  // Thinking / reasoning
  if (body.reasoning_effort) {
    applyThinking(claudeBody, body.reasoning_effort);
  }

  const messages: any[] = [];
  const systemParts: any[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content?.map((c: any) => c.text).join("\n");
      systemParts.push({ type: "text", text });
    } else if (msg.role === "tool") {
      // OpenAI tool result → Claude tool_result
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }],
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant message with tool_calls → Claude assistant with tool_use blocks
      const content: any[] = [];
      if (msg.content) {
        content.push({ type: "text", text: typeof msg.content === "string" ? msg.content : "" });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name || "",
          input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        });
      }
      messages.push({ role: "assistant", content });
    } else {
      // Convert image parts if content is array
      let content = msg.content;
      if (Array.isArray(content)) {
        content = convertContentParts(content);
      }
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content,
      });
    }
  }

  if (systemParts.length) claudeBody.system = systemParts;
  claudeBody.messages = messages;

  // Tools
  if (body.tools) claudeBody.tools = convertTools(body.tools);
  if (body.tool_choice) claudeBody.tool_choice = convertToolChoice(body.tool_choice);

  // Disable thinking when tool_choice forces tool use
  if (claudeBody.thinking && claudeBody.tool_choice) {
    disableThinkingIfToolChoiceForced(claudeBody);
  }

  return claudeBody;
}

// ── Claude response → OpenAI chat completion response (non-streaming) ──

interface ChatTranslationOptions {
  legacyFunctionCall?: boolean;
}

function mapStopReason(reason: string, options: ChatTranslationOptions = {}): string {
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return options.legacyFunctionCall ? "function_call" : "tool_calls";
  return "stop";
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

export function claudeToOpenai(
  claudeResp: any,
  model: string,
  options: ChatTranslationOptions = {}
): any {
  let textContent = "";
  const toolCalls: any[] = [];
  let reasoning = "";

  if (Array.isArray(claudeResp.content)) {
    for (const block of claudeResp.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "thinking" && block.thinking) {
        reasoning += (reasoning ? "\n\n" : "") + block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
  }

  const message: any = { role: "assistant", content: textContent || null };
  const legacyFunctionCall = options.legacyFunctionCall
    ? applyLegacyFunctionCallResponse(message, toolCalls)
    : false;
  if (toolCalls.length && !legacyFunctionCall) message.tool_calls = toolCalls;

  // Surface Claude prompt-caching counters in OpenAI-shape usage so callers can
  // measure cache hit rate. prompt_tokens_details.cached_tokens matches OpenAI's
  // own convention; the *_input_tokens fields preserve Claude's exact names for
  // anyone reading the raw shim output.
  const cacheCreation = claudeResp.usage?.cache_creation_input_tokens || 0;
  const cacheRead = claudeResp.usage?.cache_read_input_tokens || 0;
  const inputTokens = claudeResp.usage?.input_tokens || 0;
  const outputTokens = claudeResp.usage?.output_tokens || 0;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(claudeResp.stop_reason, options),
    }],
    usage: {
      prompt_tokens: inputTokens + cacheCreation + cacheRead,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + cacheCreation + cacheRead + outputTokens,
      prompt_tokens_details: {
        cached_tokens: cacheRead,
      },
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    },
  };
}

// ── Streaming state tracker ──

export interface StreamState {
  chatId: string;
  model: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  nextToolIndex: number;
  includeUsage: boolean;
  legacyFunctionCall: boolean;
}

export function createStreamState(
  model: string,
  options: { includeUsage?: boolean; legacyFunctionCall?: boolean } = {}
): StreamState {
  return {
    chatId: `chatcmpl-${randomUUID()}`,
    model,
    toolCalls: new Map(),
    nextToolIndex: 0,
    includeUsage: !!options.includeUsage,
    legacyFunctionCall: !!options.legacyFunctionCall,
  };
}

function makeChunk(state: StreamState, delta: any, finishReason: string | null, usage?: any): string {
  const chunk: any = {
    id: state.chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage && !state.includeUsage) {
    chunk.usage = usage;
  } else if (state.includeUsage) {
    chunk.usage = null;
  }
  return JSON.stringify(chunk);
}

function makeUsageChunk(state: StreamState, usage: any): string {
  return JSON.stringify({
    id: state.chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [],
    usage,
  });
}

// ── Claude SSE event → OpenAI SSE chunk(s) ──

export function claudeStreamEventToOpenai(
  event: string,
  data: any,
  state: StreamState
): string[] {
  const chunks: string[] = [];

  if (event === "message_start") {
    chunks.push(makeChunk(state, { role: "assistant", content: "" }, null));
    return chunks;
  }

  if (event === "content_block_start") {
    const block = data.content_block;
    if (block?.type === "tool_use") {
      const idx = state.nextToolIndex++;
      state.toolCalls.set(data.index, { id: block.id, name: block.name, args: "" });
      if (state.legacyFunctionCall) {
        chunks.push(makeChunk(state, {
          function_call: { name: block.name, arguments: "" },
        }, null));
      } else {
        chunks.push(makeChunk(state, {
          tool_calls: [{
            index: idx,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        }, null));
      }
    }
    // thinking / redacted_thinking block start — no output needed
    return chunks;
  }

  if (event === "content_block_delta") {
    const deltaType = data.delta?.type;

    if (deltaType === "text_delta") {
      chunks.push(makeChunk(state, { content: data.delta.text }, null));
    } else if (deltaType === "thinking_delta") {
      // Emit as reasoning_content for clients that support it
      chunks.push(makeChunk(state, { reasoning_content: data.delta.thinking }, null));
    } else if (deltaType === "redacted_thinking_delta") {
      // Redacted (encrypted) thinking blocks — discard, never forward to clients
    } else if (deltaType === "input_json_delta") {
      const tc = state.toolCalls.get(data.index);
      if (tc) {
        tc.args += data.delta.partial_json;
        if (state.legacyFunctionCall) {
          chunks.push(makeChunk(state, {
            function_call: { arguments: data.delta.partial_json },
          }, null));
        } else {
          // Find the OpenAI tool index
          let tcIdx = 0;
          for (const [blockIdx] of state.toolCalls) {
            if (blockIdx === data.index) break;
            tcIdx++;
          }
          chunks.push(makeChunk(state, {
            tool_calls: [{
              index: tcIdx,
              function: { arguments: data.delta.partial_json },
            }],
          }, null));
        }
      }
    }
    return chunks;
  }

  if (event === "content_block_stop") {
    // No explicit output needed
    return chunks;
  }

  if (event === "message_delta") {
    const finishReason = mapStopReason(data.delta?.stop_reason || "end_turn", {
      legacyFunctionCall: state.legacyFunctionCall,
    });
    let usage: any | undefined;
    if (data.usage) {
      const cacheCreation = data.usage.cache_creation_input_tokens || 0;
      const cacheRead = data.usage.cache_read_input_tokens || 0;
      const inputTokens = data.usage.input_tokens || 0;
      const outputTokens = data.usage.output_tokens || 0;
      usage = {
        prompt_tokens: inputTokens + cacheCreation + cacheRead,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + cacheCreation + cacheRead + outputTokens,
        prompt_tokens_details: { cached_tokens: cacheRead },
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      };
    }
    chunks.push(makeChunk(state, {}, finishReason, state.includeUsage ? undefined : usage));
    if (state.includeUsage && usage) {
      chunks.push(makeUsageChunk(state, usage));
    }
    return chunks;
  }

  if (event === "message_stop") {
    chunks.push("[DONE]");
    return chunks;
  }

  return chunks;
}
