import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-opencode-private-migration-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
const originalEncryptionKey = process.env.STORAGE_ENCRYPTION_KEY;
process.env.STORAGE_ENCRYPTION_KEY = "migration-207-private-test-key";

const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  if (originalEncryptionKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = originalEncryptionKey;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("migration 207 preserves private OpenCode Free connections and model settings", () => {
  const db = core.getDbInstance();
  const applied = db
    .prepare("SELECT version FROM _omniroute_migrations WHERE version = 207")
    .get() as { version: number } | undefined;
  assert.ok(applied, "migration 207 remains recorded in the upstream migration sequence");

  for (const provider of ["opencode", "oc"]) {
    db.prepare(
      "INSERT INTO provider_connections " +
        "(id, provider, auth_type, name, provider_specific_data, is_active, created_at, updated_at) " +
        "VALUES (?, ?, 'apikey', ?, ?, 1, datetime('now'), datetime('now'))"
    ).run(
      `${provider}-connection`,
      provider,
      `${provider}-account`,
      JSON.stringify({ fingerprints: [`${provider}-fingerprint`], autoSync: true })
    );
    db.prepare(
      "INSERT INTO key_value (namespace, key, value) VALUES ('customModels', ?, '[]')"
    ).run(provider);
  }

  const before = db
    .prepare(
      "SELECT id, provider, provider_specific_data FROM provider_connections " +
        "WHERE provider IN ('opencode', 'oc') ORDER BY provider"
    )
    .all();
  const migration = fs.readFileSync(
    path.join(process.cwd(), "src/lib/db/migrations/207_remove_opencode_free_provider.sql"),
    "utf8"
  );

  db.exec(migration);
  db.exec(migration);

  assert.deepEqual(
    db
      .prepare(
        "SELECT id, provider, provider_specific_data FROM provider_connections " +
          "WHERE provider IN ('opencode', 'oc') ORDER BY provider"
      )
      .all(),
    before
  );
  assert.deepEqual(
    db.prepare("SELECT key FROM key_value WHERE namespace = 'customModels' ORDER BY key").all(),
    [{ key: "oc" }, { key: "opencode" }]
  );
});
