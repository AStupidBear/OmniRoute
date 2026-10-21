import type { RegistryEntry } from "../../shared.ts";
import { opencode_zenProvider } from "./zen/index.ts";

const freeModels = opencode_zenProvider.models.filter(
  (model) => model.id === "big-pickle" || model.id.endsWith("-free")
);

export const opencodeProvider: RegistryEntry = {
  id: "opencode",
  alias: "oc",
  format: "openai",
  executor: "opencode",
  baseUrl: "https://opencode.ai/inference/v1",
  modelsUrl: "https://opencode.ai/inference/v1/models",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  passthroughModels: true,
  defaultContextLength: opencode_zenProvider.defaultContextLength,
  toolNameMaxLength: opencode_zenProvider.toolNameMaxLength,
  models: freeModels,
};
