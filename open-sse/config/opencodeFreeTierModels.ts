import { readSyncedOpencodeFamilyModelIds } from "@/lib/db/models";
import { getModelCatalogCacheVersion } from "@/lib/db/readCache";
import { getModelsDevPricing, getSyncedCapability } from "@/lib/modelsDevSync";

interface OpencodeFreeCatalog {
  readonly version: number;
  readonly free: ReadonlySet<string> | null;
}

const OPENCODE_LEGACY_FREE_MODELS = new Set([
  "beam-free",
  "big-pickle",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "jev-1.13-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "minimax-m3.1-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
]);
const OPENCODE_CATALOG_PROVIDER_IDS = ["opencode-zen", "opencode"] as const;

let freeCatalogCache: OpencodeFreeCatalog | null = null;
let testFreeModelsOverride: ReadonlySet<string> | null = null;

export function _setOpencodeFreeModelsForTests(ids: readonly string[] | null): void {
  testFreeModelsOverride = ids === null ? null : new Set(ids);
  freeCatalogCache = null;
}

function deriveFreeIdsFromCatalog(): Set<string> | null {
  try {
    const available = readSyncedOpencodeFamilyModelIds();
    if (available.size === 0) return null;

    const pricing = getModelsDevPricing();
    const free = new Set<string>();
    for (const id of available) {
      const cost =
        pricing[OPENCODE_CATALOG_PROVIDER_IDS[0]]?.[id] ??
        pricing[OPENCODE_CATALOG_PROVIDER_IDS[1]]?.[id];
      const status = getSyncedCapability(OPENCODE_CATALOG_PROVIDER_IDS[0], id)?.status;
      if (status === "deprecated") continue;
      if (cost) {
        if (cost.input === 0 && cost.output === 0) free.add(id);
        continue;
      }
      // OpenCode's live inference catalogue exposes free ids without pricing metadata.
      // Trust the explicit free-tier naming only for models currently in that catalogue.
      if (id === "big-pickle" || id.endsWith("-free")) free.add(id);
    }
    return free;
  } catch {
    return null;
  }
}

function opencodeFreeModelCatalog(): ReadonlySet<string> | null {
  if (testFreeModelsOverride) return testFreeModelsOverride;

  const version = getModelCatalogCacheVersion();
  if (freeCatalogCache?.version === version) return freeCatalogCache.free;

  const free = deriveFreeIdsFromCatalog();
  freeCatalogCache = { version, free };
  return free;
}

/** Return whether an OpenCode model requires an API key on the given provider. */
export function isPremiumOpencodeModel(model: string, provider: string): boolean {
  if (provider === "opencode-go") return true;

  const id = model.trim();
  const catalog = opencodeFreeModelCatalog();
  if (catalog) return !catalog.has(id);
  if (id.endsWith("-free")) return false;
  return !OPENCODE_LEGACY_FREE_MODELS.has(id);
}

export function isOpencodeFreeTierModel(model: string, provider: string): boolean {
  return !isPremiumOpencodeModel(model, provider);
}
