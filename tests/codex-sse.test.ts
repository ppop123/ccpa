import test from "node:test";
import assert from "node:assert/strict";

import { collectCodexResponseFromSse } from "../src/providers/codex-sse";

function makeResponse(chunks: string[], contentType?: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: contentType ? { "Content-Type": contentType } : undefined,
  });
}

test("collectCodexResponseFromSse parses SSE even when content-type is omitted", async () => {
  const response = await collectCodexResponseFromSse(makeResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.4\",\"output\":[]}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
  ]));

  assert.equal(response.id, "resp_123");
  assert.equal(response.output[0].content[0].text, "ok");
  assert.equal(response.usage.total_tokens, 2);
});

test("collectCodexResponseFromSse preserves final text-only events", async () => {
  const response = await collectCodexResponseFromSse(makeResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_done_text\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.4\",\"output\":[]}}\n\n",
    "event: response.content_part.done\ndata: {\"type\":\"response.content_part.done\",\"sequence_number\":2,\"part\":{\"type\":\"output_text\",\"text\":\"text from content part\",\"annotations\":[]}}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_done_text\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
  ]));

  assert.equal(response.output[0].content[0].text, "text from content part");
});

test("collectCodexResponseFromSse preserves output items when completed event carries an empty output array", async () => {
  const response = await collectCodexResponseFromSse(makeResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_live\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.4\",\"output\":[]}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"msg_live\",\"type\":\"message\",\"status\":\"in_progress\",\"content\":[],\"role\":\"assistant\"},\"output_index\":0}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
    "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"msg_live\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\",\"annotations\":[]}],\"role\":\"assistant\"},\"output_index\":0}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_live\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"output\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n",
  ]));

  assert.equal(response.id, "resp_live");
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].content[0].text, "ok");
  assert.equal(response.usage.total_tokens, 15);
});

test("collectCodexResponseFromSse keeps image generation partials as output items", async () => {
  const response = await collectCodexResponseFromSse(makeResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_img\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\",\"output\":[]}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"ig_123\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
    "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"item_id\":\"ig_123\",\"output_format\":\"png\",\"partial_image_b64\":\"abc123\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_img\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
  ]));

  assert.equal(response.output[0].type, "image_generation_call");
  assert.equal(response.output[0].result, "abc123");
  assert.equal(response.output[0].output_format, "png");
});
