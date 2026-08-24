import { randomUUID } from "node:crypto";
import { REGISTRY } from "../config/providerRegistry.ts";
import { getOriginalFetch } from "../utils/proxyFetch.ts";
import {
  buildCommandCodeCliBody,
  buildCommandCodeCliHeaders,
  normalizeCommandCodeWireModel,
} from "../config/providers/registry/command-code/protocol.ts";
import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  sanitizeReasoningEffortForProvider,
  type ExecuteInput,
} from "./base.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageFrom(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const input = numberValue(value.inputTokens ?? value.promptTokens);
  const output = numberValue(value.outputTokens ?? value.completionTokens);
  const total =
    numberValue(value.totalTokens) ??
    (input !== undefined && output !== undefined ? input + output : undefined);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { prompt_tokens: input }),
    ...(output === undefined ? {} : { completion_tokens: output }),
    ...(total === undefined ? {} : { total_tokens: total }),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function openAiChunk(
  id: string,
  model: string,
  delta: JsonRecord,
  finishReason: unknown = null,
  usage?: JsonRecord
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function cliEventToChunk(event: JsonRecord, id: string, model: string): JsonRecord | null {
  if (event.type === "text-delta")
    return openAiChunk(id, model, { content: String(event.text ?? "") });
  if (event.type === "reasoning-delta") {
    return openAiChunk(id, model, { reasoning_content: String(event.text ?? event.delta ?? "") });
  }
  if (event.type === "finish-step" || event.type === "finish") {
    const reason =
      event.finishReason === "length"
        ? "length"
        : event.finishReason === "error"
          ? "error"
          : "stop";
    return openAiChunk(id, model, {}, reason, usageFrom(event.usage));
  }
  if (event.type === "error") {
    return { error: { message: String(event.message ?? event.error ?? "Command Code CLI error") } };
  }
  return null;
}

async function readCliEvents(response: Response): Promise<JsonRecord[]> {
  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const normalizedLine = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (normalizedLine === "[DONE]") return [];
      try {
        const value = JSON.parse(normalizedLine);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

function createCommandCodeOpenAiStream(
  upstream: Response,
  model: string,
  id = `chatcmpl-${randomUUID()}`
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body?.getReader();
  let buffer = "";
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      if (!reader || finished) {
        if (!finished) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        finished = true;
        controller.close();
        return;
      }
      // The CLI emits lifecycle events (start, start-step, reasoning-start, …)
      // before the first visible token. Keep reading until an event produces a
      // client-facing chunk; returning from pull with no enqueue leaves the
      // downstream reader waiting forever after the first lifecycle frame.
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim() && emitLine(buffer.trim(), controller)) return;
          if (!finished) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          finished = true;
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        let emitted = false;
        for (const line of lines) {
          emitted = emitLine(line.trim(), controller) || emitted;
        }
        if (emitted) return;
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });

  function emitLine(line: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!line || finished) return false;
    const normalizedLine = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (normalizedLine === "[DONE]") return false;
    try {
      const event = JSON.parse(normalizedLine);
      if (!isRecord(event)) return false;
      const chunk = cliEventToChunk(event, id, model);
      if (!chunk) return false;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (event.type === "finish-step" || event.type === "finish" || event.type === "error") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        finished = true;
        void reader?.cancel().catch(() => undefined);
      }
      return true;
    } catch {
      // Ignore CLI keepalive/diagnostic lines that are not JSON events.
      return false;
    }
  }
}

async function cliResponseToChatCompletion(upstream: Response, model: string): Promise<Response> {
  const events = await readCliEvents(upstream);
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: JsonRecord | undefined;
  for (const event of events) {
    if (event.type === "text-delta") content += String(event.text ?? "");
    if (event.type === "reasoning-delta") reasoning += String(event.text ?? event.delta ?? "");
    if (event.type === "finish-step" || event.type === "finish") {
      finishReason = event.finishReason === "length" ? "length" : "stop";
      usage = usageFrom(event.usage);
    }
  }
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export class CommandCodeExecutor extends BaseExecutor {
  constructor(provider = "command-code") {
    super(provider, REGISTRY["command-code"]);
  }

  buildUrl() {
    const baseUrl = (this.config.baseUrl || "https://api.commandcode.ai").replace(/\/$/, "");
    // A persisted provider row may still contain the former Provider API path.
    // Command Code Go access is only available through the CLI agent protocol;
    // do not let stale database configuration route it back to /provider/v1.
    return `${baseUrl}/alpha/generate`;
  }

  async execute({ model, body, stream, credentials, signal, upstreamExtraHeaders }: ExecuteInput) {
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!apiKey) throw new Error("Command Code API key required");
    const sessionId = randomUUID();
    const wireModel = normalizeCommandCodeWireModel(model);
    const headers = buildCommandCodeCliHeaders(apiKey, sessionId);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
    // The CLI endpoint is NDJSON even when the client-facing response is SSE.
    // Do not let client Accept headers change the upstream wire format.
    headers.Accept = "application/x-ndjson";
    const sanitizedBody = sanitizeReasoningEffortForProvider(body, this.provider, model);
    const transformedBody = buildCommandCodeCliBody(model, sanitizedBody, sessionId);
    const url = this.buildUrl();
    // Command Code's CLI is a direct control-plane connection. The global
    // OmniRoute fetch wrapper may inherit a stale account proxy context; use
    // the native fetch for production while retaining the test stub.
    const fetchImpl = process.env.NODE_ENV === "production" ? getOriginalFetch() : globalThis.fetch;
    const upstream = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal: signal || undefined,
    });
    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "");
      return {
        response: new Response(errorText || `Command Code API error ${upstream.status}`, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        }),
        url,
        headers,
        transformedBody,
      };
    }
    const response = stream
      ? new Response(createCommandCodeOpenAiStream(upstream, wireModel), {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        })
      : {
          response: await cliResponseToChatCompletion(upstream, wireModel),
          url,
          headers,
          transformedBody,
        };
    return response instanceof Response ? { response, url, headers, transformedBody } : response;
  }
}
