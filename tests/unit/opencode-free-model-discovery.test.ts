import { test } from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_MODELS_CONFIG } from "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts";

test("OpenCode inference discovery keeps Free models while Zen and Go retain their full catalogs", () => {
  const models = [
    { id: "big-pickle" },
    { id: "deepseek-v4.1-flash-free" },
    { id: "muse-spark-1.3" },
    { name: "missing-model-id" },
  ];
  const payload = { data: models };

  assert.deepEqual(PROVIDER_MODELS_CONFIG.opencode.parseResponse(payload), models.slice(0, 2));
  assert.deepEqual(PROVIDER_MODELS_CONFIG["opencode-zen"].parseResponse(payload), models);
  assert.deepEqual(PROVIDER_MODELS_CONFIG["opencode-go"].parseResponse(payload), models);
});
