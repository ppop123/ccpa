export class CodexUpstreamInvalidResponseError extends Error {
  public readonly status = 502;
  public readonly code = "upstream_invalid_response";

  constructor(message = "Upstream returned invalid JSON") {
    super(message);
    this.name = "CodexUpstreamInvalidResponseError";
  }
}

export class CodexUpstreamTruncatedStreamError extends Error {
  public readonly status = 502;
  public readonly code = "upstream_network_error";

  constructor(message = "Upstream stream ended before completion") {
    super(message);
    this.name = "CodexUpstreamTruncatedStreamError";
  }
}

export class CodexUpstreamSseError extends Error {
  public readonly status = 502;
  public readonly code: string;
  public readonly kind: string;

  constructor(message: string, code = "upstream_error") {
    super(message);
    this.name = "CodexUpstreamSseError";
    this.code = code;
    this.kind = code === "rate_limit_exceeded" ? "rate_limit" : "upstream_error";
  }
}

export interface CodexStreamCompletionState {
  buffer: string;
  currentEvent: string;
  completed: boolean;
  error?: {
    message: string;
    code: string;
    kind: string;
    status: number;
  };
}

export function parseCodexUpstreamSseError(currentEvent: string, data: any): CodexUpstreamSseError | null {
  const response = data?.response || data;
  const isErrorEvent = currentEvent === "error" || data?.type === "error";
  const isFailedEvent =
    currentEvent === "response.failed" ||
    data?.type === "response.failed" ||
    response?.status === "failed";

  if (!isErrorEvent && !isFailedEvent) {
    return null;
  }

  const error = response?.error || data?.error;
  const message =
    typeof data?.message === "string" && data.message
      ? data.message
      : typeof error?.message === "string" && error.message
        ? error.message
        : typeof error === "string" && error
          ? error
          : isFailedEvent
            ? "Codex upstream response failed"
            : "Codex upstream stream error";
  const code =
    typeof data?.code === "string" && data.code
      ? data.code
      : typeof error?.code === "string" && error.code
        ? error.code
        : isFailedEvent
          ? "upstream_response_failed"
          : "upstream_error";
  return new CodexUpstreamSseError(message, code);
}

export function isCodexResponseIncompleteEvent(currentEvent: string, data: any): boolean {
  const response = data?.response || data;
  return (
    currentEvent === "response.incomplete" ||
    data?.type === "response.incomplete" ||
    response?.status === "incomplete"
  );
}

export function extractCodexTextEvent(currentEvent: string, data: any): { text: string; final: boolean } | null {
  if (currentEvent === "response.output_text.delta") {
    return typeof data?.delta === "string" && data.delta
      ? { text: data.delta, final: false }
      : null;
  }

  if (currentEvent === "response.output_text.done") {
    return typeof data?.text === "string" && data.text
      ? { text: data.text, final: true }
      : null;
  }

  if (currentEvent === "response.content_part.done") {
    const part = data?.part;
    return typeof part?.text === "string" && part.text
      ? { text: part.text, final: true }
      : null;
  }

  return null;
}

export function mergeCodexFinalText(current: string, nextText: string): string {
  if (!nextText) {
    return current;
  }
  if (!current || nextText.startsWith(current)) {
    return nextText;
  }
  if (current.endsWith(nextText)) {
    return current;
  }
  return current + nextText;
}

export function getCodexTextSuffix(current: string, finalText: string): string {
  if (!finalText) {
    return "";
  }
  if (!current) {
    return finalText;
  }
  if (finalText.startsWith(current)) {
    return finalText.slice(current.length);
  }
  if (current.endsWith(finalText)) {
    return "";
  }
  return finalText;
}

export function observeCodexStreamCompletion(state: CodexStreamCompletionState, text: string): void {
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

    const dataStr = line.slice(5).trimStart();
    if (
      state.currentEvent === "response.completed" ||
      state.currentEvent === "response.incomplete" ||
      state.currentEvent === "response.done" ||
      dataStr === "[DONE]"
    ) {
      state.completed = true;
      continue;
    }

    if (!dataStr || dataStr === "[DONE]") {
      continue;
    }

    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      continue;
    }

    const upstreamError = parseCodexUpstreamSseError(state.currentEvent, data);
    if (upstreamError) {
      state.error = {
        message: upstreamError.message,
        code: upstreamError.code,
        kind: upstreamError.kind,
        status: upstreamError.status,
      };
      state.completed = false;
      continue;
    }

    if (isCodexResponseIncompleteEvent(state.currentEvent, data)) {
      state.completed = true;
    }
  }
}

function mergeResponseSnapshot(current: any, nextValue: any): any {
  if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) {
    return current;
  }

  const nextOutput = Array.isArray(nextValue.output)
    ? (nextValue.output.length > 0 ? nextValue.output : current?.output)
    : nextValue.output || current?.output;
  const nextContent = Array.isArray(nextValue.content)
    ? (nextValue.content.length > 0 ? nextValue.content : current?.content)
    : nextValue.content || current?.content;

  return {
    ...current,
    ...nextValue,
    usage: nextValue.usage || current?.usage,
    output: nextOutput,
    content: nextContent,
  };
}

function mergeOutputItem(current: any, item: any, outputIndex?: number): any {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return current;
  }

  const output = Array.isArray(current?.output) ? [...current.output] : [];
  const index =
    typeof outputIndex === "number" && outputIndex >= 0
      ? outputIndex
      : output.findIndex((candidate) => candidate?.id && candidate.id === item.id);

  if (index >= 0) {
    output[index] = mergeOutputItemValue(output[index], item);
  } else {
    output.push(item);
  }

  return {
    ...current,
    output,
  };
}

function mergeOutputItemValue(currentItem: any, nextItem: any): any {
  if (currentItem?.type !== "image_generation_call" && nextItem?.type !== "image_generation_call") {
    return nextItem;
  }

  const result = nextItem?.result || nextItem?.b64_json || nextItem?.image_b64 || currentItem?.result;
  const outputFormat = nextItem?.output_format || currentItem?.output_format;
  const background = nextItem?.background ?? currentItem?.background;

  return {
    ...currentItem,
    ...nextItem,
    ...(typeof result === "string" && result ? { result } : {}),
    ...(typeof outputFormat === "string" && outputFormat ? { output_format: outputFormat } : {}),
    ...(background !== undefined ? { background } : {}),
  };
}

function mergeImagePartial(current: any, data: any): any {
  const itemId = typeof data?.item_id === "string" ? data.item_id : null;
  const b64 = typeof data?.partial_image_b64 === "string" ? data.partial_image_b64 : "";
  if (!itemId || !b64) {
    return current;
  }

  const output = Array.isArray(current?.output) ? [...current.output] : [];
  const index = output.findIndex((item) => item?.id === itemId);
  const currentItem = index >= 0
    ? output[index]
    : { id: itemId, type: "image_generation_call", status: "in_progress" };
  const nextItem = {
    type: "image_generation_call",
    result: b64,
    output_format: data?.output_format || "png",
    ...(data?.background !== undefined ? { background: data.background } : {}),
  };

  const merged = mergeOutputItemValue(currentItem, nextItem);
  if (index >= 0) {
    output[index] = merged;
  } else {
    output.push(merged);
  }

  return {
    ...current,
    output,
  };
}

function buildOutputFromText(outputText: string, status: string): any[] {
  if (!outputText) {
    return [];
  }

  return [{
    type: "message",
    role: "assistant",
    status,
    content: [
      {
        type: "output_text",
        text: outputText,
        annotations: [],
      },
    ],
  }];
}

export async function collectCodexResponseFromSse(upstreamResp: Response): Promise<any> {
  const contentType = upstreamResp.headers.get("content-type") || "";
  if (/application\/json/i.test(contentType)) {
    try {
      return await upstreamResp.json();
    } catch {
      throw new CodexUpstreamInvalidResponseError();
    }
  }

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    throw new Error("Codex upstream response body is unavailable");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let response: any = {};
  let outputText = "";
  let completed = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
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
      if (!dataStr) {
        continue;
      }
      if (dataStr === "[DONE]") {
        completed = true;
        continue;
      }

      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }

      const upstreamError = parseCodexUpstreamSseError(currentEvent, data);
      if (upstreamError) {
        throw upstreamError;
      }

      if (isCodexResponseIncompleteEvent(currentEvent, data)) {
        completed = true;
        response = mergeResponseSnapshot(response, data?.response || data);
        continue;
      }

      if (currentEvent === "response.created") {
        response = mergeResponseSnapshot(response, data?.response || data);
        continue;
      }

      const textEvent = extractCodexTextEvent(currentEvent, data);
      if (textEvent) {
        outputText = textEvent.final
          ? mergeCodexFinalText(outputText, textEvent.text)
          : outputText + textEvent.text;
        continue;
      }

      if (currentEvent === "response.image_generation_call.partial_image") {
        response = mergeImagePartial(response, data);
        continue;
      }

      if (currentEvent === "response.output_item.added" || currentEvent === "response.output_item.done") {
        response = mergeOutputItem(response, data?.item, data?.output_index);
        continue;
      }

      if (currentEvent === "response.completed") {
        completed = true;
        response = mergeResponseSnapshot(response, data?.response || data);
        continue;
      }

      if (currentEvent === "response.done") {
        completed = true;
      }
    }
  }

  if (!completed) {
    throw new CodexUpstreamTruncatedStreamError();
  }

  const hasOutput = Array.isArray(response.output) ? response.output.length > 0 : !!response.output;
  const hasContent = Array.isArray(response.content) ? response.content.length > 0 : !!response.content;

  if (!hasOutput && !hasContent) {
    response.output = buildOutputFromText(outputText, response.status || "completed");
  }

  return response;
}
