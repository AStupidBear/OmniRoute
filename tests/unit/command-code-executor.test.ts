import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-command-code-executor-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { REGISTRY, getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { CommandCodeExecutor } = await import("../../open-sse/executors/commandCode.ts");
const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.ts");
const core = await import("../../src/lib/db/core.ts");

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; init: Record<string, unknown>; body?: Record<string, unknown> };

const PINNED_COMMAND_CODE_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5",
  "MiniMaxAI/MiniMax-M2.7",
  "MiniMaxAI/MiniMax-M2.5",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
];

const CLI_URL = "https://api.commandcode.ai/alpha/generate";

function captureFetch(body: Record<string, unknown>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Command Code provider catalog has pinned models and alias lookup", () => {
  const entry = REGISTRY["command-code"];
  assert.ok(entry);
  assert.equal(entry.alias, "cmd");
  assert.equal(entry.executor, "command-code");
  assert.equal(entry.baseUrl, "https://api.commandcode.ai");
  assert.equal(entry.chatPath, "/alpha/generate");
  assert.deepEqual(
    entry.models.map((model) => model.id),
    PINNED_COMMAND_CODE_MODELS
  );
  assert.equal(getRegistryEntry("cmd"), entry);
});

test("getExecutor returns the specialized Command Code executor", () => {
  assert.equal(hasSpecializedExecutor("command-code"), true);
  assert.ok(getExecutor("command-code") instanceof CommandCodeExecutor);
  assert.ok(getExecutor("cmd") instanceof CommandCodeExecutor);
});

test("Command Code executor posts the CLI envelope to /alpha/generate", async () => {
  const calls = captureFetch({});
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      [
        JSON.stringify({ type: "text-delta", text: "OK" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
        "",
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );
  };
  const executor = getExecutor("command-code");
  const { response, url, headers } = await executor.execute({
    model: "gpt-5.4-mini",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: {
      stream: false,
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Hi" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      max_tokens: 42,
    },
  });

  assert.equal(url, CLI_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLI_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(headers.Authorization, "Bearer cc_test_key");
  assert.equal(headers["x-command-code-version"], "1.32.1");
  assert.equal(headers["x-cli-environment"], "production");
  assert.equal(headers["x-project-slug"], "omniroute");

  const posted = calls[0].body as Record<string, unknown>;
  const params = posted.params as Record<string, unknown>;
  assert.equal(posted.mode, "agent");
  assert.equal(posted.permissionMode, "default");
  assert.equal(params.model, "gpt-5.4-mini");
  assert.equal(params.stream, true);
  assert.equal(params.max_tokens, 42);
  assert.equal((params.messages as Array<{ role: string }>)[0].role, "user");
  const tool = (params.tools as Array<{ name: string }>)[0];
  assert.equal(tool.name, "lookup", "tools use the CLI function shape");
  assert.match(await response.text(), /"content":"OK"/);
});

test("Command Code executor preserves reasoning and thinking fields in params", async () => {
  const calls = captureFetch({});
  await getExecutor("command-code").execute({
    model: "deepseek/deepseek-v4-pro",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: {
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      effort: "high",
      extra_body: { enable_thinking: true },
    },
  });

  const posted = calls[0].body.params as Record<string, unknown>;
  assert.equal(posted.reasoning_effort, "high");
  assert.deepEqual(posted.thinking, { type: "enabled" });
  assert.equal(posted.effort, "high");
  assert.deepEqual(posted.extra_body, { enable_thinking: true });
});

test("Command Code executor honors body.model rewrite from payload rules", async () => {
  const calls = captureFetch({});
  await getExecutor("command-code").execute({
    model: "deepseek-v4-pro-max",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: {
      stream: false,
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "max",
    },
  });

  const posted = calls[0].body.params as Record<string, unknown>;
  assert.equal(posted.model, "deepseek/deepseek-v4-pro");
  assert.equal(posted.reasoning_effort, "max");
});

test("Command Code executor maps unsupported minimal reasoning_effort to low (upstream 400 regression)", async () => {
  const calls = captureFetch({});
  // `minimal` (a Muse Spark catalog tier) must be downgraded to `low` before
  // the wire body is built, on BOTH the combo and single-model paths.
  await getExecutor("command-code").execute({
    model: "poolside/laguna-s-2.1-free",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: {
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "minimal",
    },
  });

  const posted = calls[0].body.params as Record<string, unknown>;
  assert.equal(posted.reasoning_effort, "low", "minimal must map to low");
});

test("Command Code executor translates CLI NDJSON to OpenAI SSE", async () => {
  globalThis.fetch = async () =>
    new Response(
      [
        JSON.stringify({ type: "start" }),
        JSON.stringify({ type: "text-delta", text: "Hello" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        }),
        "",
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );

  const { response } = await getExecutor("command-code").execute({
    model: "gpt-5.4",
    stream: true,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }] },
  });

  const text = await response.text();
  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /"prompt_tokens":2/);
  assert.match(text, /data: \[DONE\]/);
});

test("Command Code executor translates CLI NDJSON to OpenAI JSON for non-stream requests", async () => {
  globalThis.fetch = async () =>
    new Response(
      [
        JSON.stringify({ type: "text-delta", text: "Hello" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        }),
        "",
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );

  const { response } = await getExecutor("command-code").execute({
    model: "gpt-5.4-mini",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }] },
  });

  const json = await response.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.model, "gpt-5.4-mini");
  assert.equal(json.choices[0].message.content, "Hello");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.deepEqual(json.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test("Command Code executor surfaces upstream errors", async () => {
  globalThis.fetch = async () =>
    new Response("bad key", { status: 401, statusText: "Unauthorized" });
  const upstreamFailure = await getExecutor("command-code").execute({
    model: "gpt-5.4-mini",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }] },
  });
  assert.equal(upstreamFailure.response.status, 401);
  assert.equal(await upstreamFailure.response.text(), "bad key");
});

test("Command Code executor omits max_tokens when the client does not supply one", async () => {
  const calls = captureFetch({});
  await getExecutor("command-code").execute({
    model: "zai-org/GLM-5.1",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }] },
  });
  const posted = calls[0].body.params as Record<string, unknown>;
  assert.ok(!("max_tokens" in posted), "must not fabricate max_tokens");
  assert.ok(!("max_completion_tokens" in posted), "must not fabricate max_completion_tokens");
});

test("Command Code executor clamps an oversized client-supplied max_tokens to the endpoint ceiling", async () => {
  const calls = captureFetch({});
  // A client asking for more than the 200000 endpoint ceiling is clamped down.
  await getExecutor("command-code").execute({
    model: "deepseek/deepseek-v4-pro",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }], max_tokens: 500000 },
  });
  assert.equal((calls[0].body.params as Record<string, unknown>).max_tokens, 200000);
});

test("Command Code executor honors a smaller client-provided max_tokens", async () => {
  const calls = captureFetch({});
  await getExecutor("command-code").execute({
    model: "zai-org/GLM-5.1",
    stream: false,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }], max_tokens: 2048 },
  });
  assert.equal((calls[0].body.params as Record<string, unknown>).max_tokens, 2048);
});

test("Command Code stream emits usage from the CLI finish event", async () => {
  globalThis.fetch = async () =>
    new Response(
      [
        JSON.stringify({ type: "text-delta", text: "Hi" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
        }),
        "",
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );

  const { response } = await getExecutor("command-code").execute({
    model: "gpt-5.4-mini",
    stream: true,
    credentials: { apiKey: "cc_test_key" },
    body: { messages: [{ role: "user", content: "Hi" }] },
  });

  const text = await response.text();
  assert.ok(text.includes('"prompt_tokens":10'));
  assert.ok(text.includes('"completion_tokens":6'));
  assert.ok(text.includes('"total_tokens":16'));
  assert.ok(text.includes("data: [DONE]"));
});
