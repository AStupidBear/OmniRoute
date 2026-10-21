import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrecisionComboModelStep,
  buildGlobalModelList,
  buildManualComboModelStep,
} from "../../src/lib/combos/builderDraft.ts";
import { resolveProviderAlias, parseModel } from "../../open-sse/services/model.ts";
import { _setOpencodeFreeModelsForTests } from "../../open-sse/config/opencodeFreeTierModels.ts";

// Issue #11433: combo entries preserve the configured provider's public alias.
// The `opencode/` prefix routes free models to OpenCode's public inference
// provider while premium models continue to resolve to OpenCode Zen.

test('resolveProviderAlias("opencode") retains the explicit Zen gateway mapping', () => {
  _setOpencodeFreeModelsForTests(["big-pickle"]);
  try {
    assert.equal(resolveProviderAlias("opencode"), "opencode-zen");
    assert.equal(parseModel("opencode/big-pickle").provider, "opencode");
    assert.equal(parseModel("opencode/gpt-5.4").provider, "opencode-zen");
  } finally {
    _setOpencodeFreeModelsForTests(null);
  }
});

test("issue #11433 fix: buildPrecisionComboModelStep honors an explicit modelPrefix override", () => {
  // The combo builder call sites now thread through the already-computed
  // routing-alias prefix (e.g. "unc") instead of letting the step default to
  // the raw providerId, so the serialized `model` field round-trips to the
  // correct provider.
  const step = buildPrecisionComboModelStep({
    providerId: "uncloseai",
    modelId: "some-model",
    modelPrefix: "unc",
  });

  assert.equal(step.providerId, "uncloseai");
  assert.equal(step.model, "unc/some-model");

  const parsed = parseModel(step.model);
  assert.equal(parsed.provider, step.providerId);
});

test("issue #11433 fix: buildGlobalModelList derives modelPrefix from qualifiedModel for a no-auth provider", () => {
  // Mirrors what src/lib/combos/builderOptions.ts::rewriteQualifiedModelPrefix
  // produces for a no-auth provider entry: `qualifiedModel` is already
  // rewritten to the alias prefix, and buildGlobalModelList must not rebuild
  // `model` from the raw providerId.
  const [entry] = buildGlobalModelList([
    {
      providerId: "uncloseai",
      displayName: "UncloseAI",
      connectionCount: 0,
      connections: [],
      models: [{ id: "some-model", name: "Some Model", qualifiedModel: "unc/some-model" }],
    },
  ]);

  assert.equal(entry.step.providerId, "uncloseai");
  assert.equal(entry.step.model, "unc/some-model");
  assert.equal(parseModel(entry.step.model).provider, entry.step.providerId);
});

test("issue #11433 fix: buildManualComboModelStep preserves a user-typed <alias>/<model> prefix", () => {
  // buildManualComboModelStep resolves the typed alias ("unc") back to the
  // canonical providerId ("uncloseai") before building the step, and must keep
  // the typed prefix instead of rebuilding `model` from the canonical id.
  const step = buildManualComboModelStep({
    value: "unc/some-model",
    providers: [{ providerId: "uncloseai", alias: "unc" }],
  });

  assert.ok(step);
  assert.equal(step?.providerId, "uncloseai");
  assert.equal(step?.model, "unc/some-model");
  assert.equal(parseModel(step!.model).provider, step!.providerId);
});
