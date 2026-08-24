import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/commandCode.ts");
const protocol = await import(
  "../../open-sse/config/providers/registry/command-code/protocol.ts"
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CommandCodeExecutor CLI protocol", () => {
  it("targets the Command Code CLI agent endpoint", () => {
    assert.equal(
      new mod.CommandCodeExecutor().buildUrl(),
      "https://api.commandcode.ai/alpha/generate"
    );
  });

  it("requires credentials", async () => {
    await assert.rejects(
      () =>
        new mod.CommandCodeExecutor().execute({
          model: "meta/muse-spark-1.2-contributor",
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: true,
          credentials: {},
        }),
      /API key/
    );
  });

  it("builds the CLI envelope and translates NDJSON to OpenAI SSE", async () => {
    let sent: Record<string, unknown> | undefined;
    let sentHeaders: Headers | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      sentHeaders = new Headers(init?.headers);
      return new Response(
        [
          JSON.stringify({ type: "text-delta", text: "OK" }),
          JSON.stringify({
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
      );
    }) as typeof fetch;

    const result = await new mod.CommandCodeExecutor().execute({
      model: "cmd/meta/muse-spark-1.2-contributor",
      body: { messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 16 },
      stream: true,
      credentials: { apiKey: "fake-key" },
    });

    const payload = await result.response.text();
    assert.equal(sent?.mode, "agent");
    assert.equal(sent?.permissionMode, "default");
    assert.equal(typeof sent?.threadId, "string");
    const params = sent?.params as Record<string, unknown>;
    assert.equal(params.model, "meta/muse-spark-1.2-contributor");
    assert.equal(params.max_tokens, 512, "Muse gets enough budget for hidden reasoning");
    assert.equal(params.stream, true);
    assert.equal(sentHeaders?.get("User-Agent"), "cli");
    assert.equal(sentHeaders?.get("x-cli-environment"), "production");
    assert.equal(sentHeaders?.get("x-taste-learning"), "false");
    assert.match(payload, /"content":"OK"/);
    assert.match(payload, /"finish_reason":"stop"/);
    assert.match(payload, /"prompt_tokens":2/);
    assert.doesNotMatch(payload, /\[DONE\].*\[DONE\]/s);
    assert.match(payload, /data: \[DONE\]/);
  });

  it("continues past CLI lifecycle events before the first visible token", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          JSON.stringify({ type: "start" }),
          JSON.stringify({ type: "start-step" }),
          JSON.stringify({ type: "reasoning-start" }),
          JSON.stringify({ type: "text-delta", text: "OK" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
      )) as typeof fetch;

    const result = await new mod.CommandCodeExecutor().execute({
      model: "meta/muse-spark-1.2-contributor",
      body: { messages: [{ role: "user", content: "Reply with exactly OK." }] },
      stream: true,
      credentials: { apiKey: "fake-key" },
    });

    const payload = await result.response.text();
    assert.match(payload, /"content":"OK"/);
    assert.match(payload, /data: \[DONE\]/);
  });

  it("normalizes known bare model ids inside params", () => {
    const body = protocol.buildCommandCodeCliBody("cmd/mimo-v2.5", { messages: [] }, "s");
    assert.equal((body.params as Record<string, unknown>).model, "xiaomi/mimo-v2.5");
  });

  it("moves system turns to the CLI top-level system field", () => {
    const body = protocol.buildCommandCodeCliBody(
      "meta/muse-spark-1.2-contributor",
      {
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hi" },
        ],
      },
      "s"
    );
    assert.equal(body.system, "Be concise.");
    assert.deepEqual((body.params as Record<string, unknown>).messages, [
      { role: "user", content: "Hi" },
    ]);
  });

  it("translates OpenAI function tools to the CLI tool schema", () => {
    const body = protocol.buildCommandCodeCliBody(
      "meta/muse-spark-1.2-contributor",
      {
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look something up",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      "s"
    );
    assert.deepEqual((body.params as Record<string, unknown>).tools, [
      {
        name: "lookup",
        description: "Look something up",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });
});
