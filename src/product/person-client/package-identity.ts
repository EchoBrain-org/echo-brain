import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PackagedPersonClientBuildIdentityV1 {
  readonly schema_version: 1;
  readonly kind: "echo-packaged-build-identity";
  readonly product_version: string;
  readonly source_sha: string;
  readonly source_kind: "materialized-commit" | "worktree-head-unverified";
}

function packageRoot(moduleUrl: string): URL {
  return moduleUrl.includes("/dist/")
    ? new URL("../", moduleUrl)
    : new URL("./", moduleUrl);
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as unknown;
}

function exactBuildIdentity(value: unknown): PackagedPersonClientBuildIdentityV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Person client build identity is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "kind,product_version,schema_version,source_kind,source_sha" ||
    record.schema_version !== 1 ||
    record.kind !== "echo-packaged-build-identity" ||
    typeof record.product_version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      record.product_version,
    ) ||
    typeof record.source_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.source_sha) ||
    (record.source_kind !== "materialized-commit" &&
      record.source_kind !== "worktree-head-unverified")
  ) {
    throw new Error("Person client build identity is invalid");
  }
  return Object.freeze({
    schema_version: 1,
    kind: "echo-packaged-build-identity",
    product_version: record.product_version,
    source_sha: record.source_sha,
    source_kind: record.source_kind,
  });
}

/**
 * The status surface uses this only for non-secret artifact provenance. It
 * deliberately never opens the private Person session store.
 */
export function readPackagedPersonClientBuildIdentity(
  moduleUrl = import.meta.url,
): PackagedPersonClientBuildIdentityV1 {
  const root = packageRoot(moduleUrl);
  const manifest = readJson(new URL("package.json", root));
  const identity = exactBuildIdentity(
    readJson(new URL("dist/build-identity.v1.json", root)),
  );
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    (manifest as Record<string, unknown>).version !== identity.product_version
  ) {
    throw new Error("Person client package version does not match its build identity");
  }
  return identity;
}
