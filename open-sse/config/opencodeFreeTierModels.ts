import { readSyncedOpencodeFamilyModelIds } from "@/lib/db/models";
import { getModelCatalogCacheVersion } from "@/lib/db/readCache";
import { getModelsDevPricing, getSyncedCapability } from "@/lib/modelsDevSync";

interface OpencodeFreeCatalog {
  readonly version: number;
  readonly free: ReadonlySet<string> | null;
}

const OPENCODE_LEGACY_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4.1-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
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
      if (!cost || cost.input !== 0 || cost.output !== 0) continue;
      const status = getSyncedCapability(OPENCODE_CATALOG_PROVIDER_IDS[0], id)?.status;
      if (status === "deprecated") continue;
      free.add(id);
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
