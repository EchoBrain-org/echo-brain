import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const { swiftSourceAssemblyV1, checkSwiftSourceDirectionsV1 } = await import(pathToFileURL(join(repo, "tools/lib/swift-source-assembly.mjs")).href);
function run(command: string, args: string[], label: string, cwd: string) {
  try { execFileSync(command, args, { cwd, timeout: 60_000, stdio: "pipe" }); }
  catch (error) { throw new Error(label, { cause: error }); }
}
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

describe.skipIf(process.platform !== "darwin")("Swift compiler dependency isolation", () => {
  it("compiles shipped neutral and individual provider inputs without the bootstrap", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-swift-boundary-")); roots.push(root);
    const assembly = swiftSourceAssemblyV1(JSON.parse(readFileSync(join(repo, "product/echo-overlay/source-assembly.v1.json"), "utf8")));
    const staged = assembly.sources.map((source: string, index: number) => {
      const path = join(root, `input-${index}.swift`);
      writeFileSync(path, readFileSync(join(repo, source)));
      return path;
    });
    expect(() => checkSwiftSourceDirectionsV1(assembly, staged, run, root)).not.toThrow();
  });

  it("rejects neutral-to-provider, neutral-to-bootstrap, provider-to-bootstrap and cross-provider symbols", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-swift-direction-")); roots.push(root);
    const assembly = swiftSourceAssemblyV1({ schema_version: 1, kind: "echo-swift-source-assembly",
      bootstrap_sources: ["product/test/main.swift"], neutral_sources: ["product/test/core.swift"],
      provider_sources: ["providers/first/client.swift", "providers/second/client.swift"] });
    const staged = assembly.sources.map((_: string, index: number) => join(root, `input-${index}.swift`));
    const baseline = ["enum BootstrapOnly {}", "enum Neutral {}", "enum FirstOnly {}", "enum SecondOnly {}"];
    for (const [index, reference, owner] of [[1, "FirstOnly", "neutral"], [1, "BootstrapOnly", "neutral"],
      [2, "BootstrapOnly", "providers/first/"], [2, "SecondOnly", "providers/first/"]] as const) {
      baseline.forEach((source, i) => writeFileSync(staged[i]!, source));
      writeFileSync(staged[index]!, `${baseline[index]}\nfunc leak(_: ${reference}) {}`);
      expect(() => checkSwiftSourceDirectionsV1(assembly, staged, run, root)).toThrow(`Swift dependency direction failed for ${owner}`);
    }
    baseline.forEach((source, i) => writeFileSync(staged[i]!, source));
    expect(() => checkSwiftSourceDirectionsV1(assembly, staged, run, root)).not.toThrow();
  });
});
