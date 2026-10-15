/** Shared model classification for OpenCode's public and key-backed routes. */
const OPENCODE_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

export function isOpencodeFreeTierModel(model: string, provider: string): boolean {
  // OpenCode Go has no free tier; other OpenCode surfaces expose these free models.
  if (provider === "opencode-go") return false;
  return model.endsWith("-free") || OPENCODE_FREE_MODELS.has(model);
}

export function isPremiumOpencodeModel(model: string, provider: string): boolean {
  return !isOpencodeFreeTierModel(model, provider);
}
