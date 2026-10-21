import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-opencode-prefix-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getComboBuilderOptions } = await import("../../src/lib/combos/builderOptions.ts");
const { parseModel } = await import("../../open-sse/services/model.ts");
const { _setOpencodeFreeModelsForTests } =
  await import("../../open-sse/config/opencodeFreeTierModels.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("no-auth OpenCode combo models use the oc/ prefix", async () => {
  const payload = await getComboBuilderOptions();
  const opencode = payload.providers.find((provider) => provider.providerId === "opencode");
  assert.ok(opencode, "OpenCode Free must appear in combo builder options");

  const bigPickle = opencode.models.find((model) => model.id === "big-pickle");
  assert.ok(bigPickle, "big-pickle must appear under OpenCode Free");
  assert.equal(bigPickle.qualifiedModel, "oc/big-pickle");
  for (const model of opencode.models) {
    assert.ok(model.qualifiedModel.startsWith("oc/"), model.qualifiedModel);
  }
});

test("configured no-auth OpenCode accounts keep free models on the inference route", async () => {
  await providersDb.createProviderConnection({
    provider: "opencode",
    authType: "none",
    name: "OpenCode Free account",
  });

  const payload = await getComboBuilderOptions();
  const opencode = payload.providers.find(
    (provider) => provider.providerId === "opencode" && provider.connectionCount > 0
  );
  assert.ok(opencode);
  const bigPickle = opencode.models.find((model) => model.id === "big-pickle");
  assert.ok(bigPickle);
  assert.equal(bigPickle.qualifiedModel, "opencode/big-pickle");
  assert.equal(parseModel(bigPickle.qualifiedModel).provider, "opencode");
});

test("OpenCode prefixes select the free inference route or paid Zen route by model", () => {
  _setOpencodeFreeModelsForTests(["big-pickle"]);
  try {
    assert.equal(parseModel("oc/big-pickle").provider, "opencode");
    assert.equal(parseModel("opencode/big-pickle").provider, "opencode");
    assert.equal(parseModel("opencode/gpt-5.4").provider, "opencode-zen");
  } finally {
    _setOpencodeFreeModelsForTests(null);
  }
});
