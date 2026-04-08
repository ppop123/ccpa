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
    output[index] = item;
  } else {
    output.push(item);
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
    return upstreamResp.json();
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
      if (!dataStr || dataStr === "[DONE]") {
        continue;
      }

      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }

      if (currentEvent === "response.created") {
        response = mergeResponseSnapshot(response, data?.response || data);
        continue;
      }

      if (currentEvent === "response.output_text.delta") {
        if (typeof data?.delta === "string") {
          outputText += data.delta;
        }
        continue;
      }

      if (currentEvent === "response.output_item.added" || currentEvent === "response.output_item.done") {
        response = mergeOutputItem(response, data?.item, data?.output_index);
        continue;
      }

      if (currentEvent === "response.completed") {
        response = mergeResponseSnapshot(response, data?.response || data);
      }
    }
  }

  const hasOutput = Array.isArray(response.output) ? response.output.length > 0 : !!response.output;
  const hasContent = Array.isArray(response.content) ? response.content.length > 0 : !!response.content;

  if (!hasOutput && !hasContent) {
    response.output = buildOutputFromText(outputText, response.status || "completed");
  }

  return response;
}
