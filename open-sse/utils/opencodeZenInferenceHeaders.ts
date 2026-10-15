import { createHash, randomBytes } from "crypto";
import { setUserAgentHeader } from "../executors/base.ts";

/** The CLI identity used by OmniQuant's working LiteLLM OpenCode Zen adapter. */
export const OPENCODE_ZEN_INFERENCE_USER_AGENT = "opencode/latest/2.0.29/cli";

const VALID_USER_AGENT = /^opencode\/(?:latest|stable)\/(\d+)\.(\d+)\.(\d+)\/cli$/i;
const VALID_SESSION_ID = /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_HEADER_NAMES = [
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
  "conversation-id",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function encodeBase62(value: bigint, width: number): string {
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % BigInt(BASE62.length));
    encoded = BASE62[remainder] + encoded;
    value /= BigInt(BASE62.length);
  }
  return encoded.padStart(width, BASE62[0]);
}

function translateSessionId(seed: string, clientTool: string): string {
  const normalized = seed.trim();
  if (VALID_SESSION_ID.test(normalized)) return normalized;

  const digest = createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${normalized}`)
    .digest();
  const timestampPrefix = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) >> 4n;
  const descendingTimestamp = ~((timestampPrefix << 12n) | 1n) & ((1n << 48n) - 1n);
  const suffix = BigInt(`0x${digest.subarray(5, 15).toString("hex")}`);
  return `ses_${descendingTimestamp.toString(16).padStart(12, "0")}${encodeBase62(suffix, 14)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(", ")}]`;
  const object = record(value);
  if (object) {
    const fields = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${stableJson(object[key])}`);
    return `{${fields.join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function firstUserContent(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const message = value.find((item) => record(item)?.role === "user");
  return record(message)?.content;
}

function sessionSeed(body: unknown, clientHeaders: Record<string, string>): string | undefined {
  for (const name of SESSION_HEADER_NAMES) {
    const value = headerValue(clientHeaders, name)?.trim();
    if (value) return value;
  }

  const input = record(body);
  const metadata = record(input?.metadata);
  for (const value of [input?.conversation_id, metadata?.session_id, input?.previous_response_id]) {
    if (typeof value === "string" && value) return value;
  }

  const messages = input?.messages ?? input?.input;
  const content =
    firstUserContent(messages) ?? (typeof input?.input === "string" ? input.input : undefined);
  if (content === undefined || content === null || content === "") return undefined;
  return stableJson(content);
}

function projectId(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  body: unknown
): string {
  const metadata = record(record(body)?.metadata);
  const seed =
    headerValue(clientHeaders, "x-opencode-project") ||
    process.env.OPENCODE_PROJECT?.trim() ||
    (typeof metadata?.project_id === "string" ? metadata.project_id : "") ||
    headerValue(headers, "x-opencode-project") ||
    "global";
  if (/^[0-9a-f]{40}$/.test(seed)) return seed;
  return createHash("sha256").update(`opencode-project\0${seed}`).digest("hex").slice(0, 40);
}

/** Apply the keyless `/inference/v1` identity contract used by LiteLLM Router. */
export function applyOpencodeZenInferenceHeaders(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  body: unknown
): void {
  const existingUserAgent =
    headerValue(clientHeaders, "user-agent") || headerValue(headers, "user-agent") || "";
  const configuredUserAgent = process.env.OPENCODE_USER_AGENT?.trim() || "";
  const userAgent = VALID_USER_AGENT.test(existingUserAgent)
    ? existingUserAgent
    : VALID_USER_AGENT.test(configuredUserAgent)
      ? configuredUserAgent
      : OPENCODE_ZEN_INFERENCE_USER_AGENT;
  setUserAgentHeader(headers, userAgent);

  headers.Accept = "application/json, text/event-stream";
  headers["x-opencode-client"] = "cli";
  headers["x-opencode-project"] = projectId(headers, clientHeaders, body);
  delete headers["x-opencode-request"];

  const seed = sessionSeed(body, clientHeaders);
  const sessionId = seed
    ? translateSessionId(seed, "cli")
    : translateSessionId(randomBytes(16).toString("hex"), "litellm");
  headers["x-opencode-session"] = sessionId;
  headers["x-opencode-session-id"] = sessionId;
  headers["x-session-affinity"] = sessionId;
  delete headers["x-session-id"];
  delete headers["X-Session-Id"];
  headers["X-Session-Id"] = sessionId;
}
