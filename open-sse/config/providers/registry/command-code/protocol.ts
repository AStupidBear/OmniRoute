import { cwd } from "node:process";

type JsonRecord = Record<string, unknown>;

const MAX_COMMAND_CODE_TOKENS = 200_000;
const COMMAND_CODE_MUSE_MIN_TOKENS = 512;
const COMMAND_CODE_BARE_MODEL_VENDOR_PREFIX: Readonly<Record<string, string>> = {
  "mimo-v2.5": "xiaomi/mimo-v2.5",
  "mimo-v2.5-pro": "xiaomi/mimo-v2.5-pro",
};

const COMMAND_CODE_CLI_VERSION = "1.32.1";
const COMMAND_CODE_PROJECT_SLUG = "omniroute";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_COMMAND_CODE_TOKENS);
}

function applyMuseBudget(model: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return model.includes("muse-spark") ? Math.max(value, COMMAND_CODE_MUSE_MIN_TOKENS) : value;
}

function projectConfig(): JsonRecord {
  const workingDir = cwd();
  const branch = process.env.GIT_BRANCH || process.env.GITHUB_REF_NAME || "unknown";
  return {
    workingDir,
    date: new Date().toISOString().slice(0, 10),
    environment: process.env.NODE_ENV || "production",
    structure: [],
    isGitRepo: true,
    currentBranch: branch,
    mainBranch: process.env.GIT_MAIN_BRANCH || "main",
    gitStatus: "",
    recentCommits: [],
  };
}

export function normalizeCommandCodeWireModel(model: string): string {
  const trimmed = String(model || "").trim();
  if (!trimmed) return trimmed;
  const bare = trimmed.replace(/^(?:command-code|cmd)\//, "");
  if (bare.includes("/")) return bare;
  return COMMAND_CODE_BARE_MODEL_VENDOR_PREFIX[bare] ?? bare;
}

function normalizeCommandCodeTools(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    if (!isRecord(tool)) return [];
    const fn = isRecord(tool.function) ? tool.function : undefined;
    if (fn && typeof fn.name === "string") {
      return [
        {
          name: fn.name,
          ...(typeof fn.description === "string" ? { description: fn.description } : {}),
          input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object" },
        },
      ];
    }
    // Command Code's native web tools use the Claude-style top-level shape.
    if (typeof tool.name === "string" && isRecord(tool.input_schema)) return [tool];
    return [];
  });
}

/** Build the request envelope used by Command Code's CLI agent endpoint. */
export function buildCommandCodeCliBody(
  model: string,
  body: unknown,
  sessionId: string
): JsonRecord {
  const input = isRecord(body) ? body : {};
  const wireModel = normalizeCommandCodeWireModel(
    typeof input.model === "string" && input.model.trim() ? input.model : model
  );
  const maxTokens = applyMuseBudget(
    wireModel,
    clampMaxTokens(input.max_tokens ?? input.max_completion_tokens)
  );
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const systemParts: string[] = typeof input.system === "string" ? [input.system] : [];
  const messages = rawMessages.flatMap((message) => {
    if (!isRecord(message)) return [];
    if (message.role === "system") {
      if (typeof message.content === "string") systemParts.push(message.content);
      return [];
    }
    // The CLI protocol only accepts user/assistant turns. Preserve tool
    // results as user text so tool definitions can still be forwarded.
    if (message.role !== "user" && message.role !== "assistant") {
      return [{ ...message, role: "user" }];
    }
    return [message];
  });

  const params: JsonRecord = {
    model: wireModel,
    messages,
    tools: normalizeCommandCodeTools(input.tools),
    stream: true,
  };
  if (maxTokens !== undefined) params.max_tokens = maxTokens;
  for (const key of [
    "temperature",
    "top_p",
    "reasoning_effort",
    "thinking",
    "effort",
    "extra_body",
  ]) {
    if (input[key] !== undefined) params[key] = input[key];
  }

  const result: JsonRecord = {
    config: projectConfig(),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "default",
    threadId: sessionId,
    mode: "agent",
    params,
  };
  const system = systemParts.join("\n\n");
  if (system) result.system = system;
  return result;
}

export function buildCommandCodeCliHeaders(
  apiKey: string,
  sessionId: string
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "cli",
    "x-command-code-version": process.env.COMMAND_CODE_CLI_VERSION || COMMAND_CODE_CLI_VERSION,
    "x-cli-environment": "production",
    "x-project-slug": COMMAND_CODE_PROJECT_SLUG,
    "x-taste-learning": "false",
    "x-session-id": sessionId,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/x-ndjson",
  };
}
