import test from "node:test";
import assert from "node:assert/strict";

import {
  claudeStreamEventToOpenai,
  claudeToOpenai,
  createStreamState,
  openaiToClaude,
} from "../src/proxy/translator";

test("OpenAI to Claude translator drops deprecated temperature for opus 4.8", () => {
  const body = openaiToClaude({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8,
    temperature: 0.7,
  });

  assert.equal(body.model, "claude-opus-4-8");
  assert.equal(body.temperature, undefined);
});

test("Claude translator returns legacy function_call for legacy functions requests", () => {
  const resp = claudeToOpenai(
    {
      id: "msg_legacy_function_response",
      content: [{
        type: "tool_use",
        id: "toolu_weather_1",
        name: "lookup_weather",
        input: { city: "Paris" },
      }],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    },
    "claude-sonnet-4-6",
    { legacyFunctionCall: true }
  );

  assert.deepEqual(resp.choices[0].message.function_call, {
    name: "lookup_weather",
    arguments: "{\"city\":\"Paris\"}",
  });
  assert.equal(resp.choices[0].message.tool_calls, undefined);
  assert.equal(resp.choices[0].finish_reason, "function_call");
});

test("Claude stream translator emits legacy function_call deltas for legacy functions requests", () => {
  const state = createStreamState("claude-sonnet-4-6", { legacyFunctionCall: true });

  const startChunks = claudeStreamEventToOpenai("message_start", {}, state).map(JSON.parse);
  assert.deepEqual(startChunks[0].choices[0].delta, { role: "assistant", content: "" });

  const toolStartChunks = claudeStreamEventToOpenai(
    "content_block_start",
    {
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_weather_1",
        name: "lookup_weather",
        input: {},
      },
    },
    state
  ).map(JSON.parse);
  assert.deepEqual(toolStartChunks[0].choices[0].delta, {
    function_call: { name: "lookup_weather", arguments: "" },
  });

  const argChunks = claudeStreamEventToOpenai(
    "content_block_delta",
    {
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"city\":\"Paris\"}" },
    },
    state
  ).map(JSON.parse);
  assert.deepEqual(argChunks[0].choices[0].delta, {
    function_call: { arguments: "{\"city\":\"Paris\"}" },
  });

  const doneChunks = claudeStreamEventToOpenai(
    "message_delta",
    { delta: { stop_reason: "tool_use" }, usage: { input_tokens: 3, output_tokens: 4 } },
    state
  ).map(JSON.parse);
  assert.equal(doneChunks[0].choices[0].finish_reason, "function_call");
});
