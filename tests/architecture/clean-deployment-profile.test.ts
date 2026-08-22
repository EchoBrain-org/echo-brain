import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const DEPLOYMENT = "deploy/organization-authority";

function deploymentFile(name: string): string {
  return readFileSync(resolve(REPO, DEPLOYMENT, name), "utf8");
}

describe("clean founder deployment profile", () => {
  it("selects the dedicated clean live entrypoint and a fresh clean state mount", () => {
    const compose = deploymentFile("compose.clean-v1.yaml");

    expect(compose).toContain("name: echo-organization-authority-clean-v1");
    expect(compose).toContain(
      "services/organization-authority/dist/clean-live-main.js",
    );
    expect(compose).toContain("./clean-data:/echo-clean");
    expect(compose).toContain("/echo-clean/state");
    expect(compose).toContain("/v1/authority-descriptor");
    expect(compose).not.toContain("dist/main.js");
    expect(compose).not.toContain("/echo/authority.json");
    expect(compose).not.toContain("./data:/echo");
  });

  it("keeps clean ingress free of the retired authenticated proxy contract", () => {
    const caddyfile = deploymentFile("Caddyfile.clean-v1");

    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:39479");
    for (const forbidden of [
      "X-Echo-Proxy-Authorization",
      "X-Echo-Authenticated-Client-Id",
      "X-Echo-Proxy-Source-Address",
      "trusted-proxy",
    ]) {
      expect(caddyfile).not.toContain(forbidden);
    }
  });

  it("does not make legacy machine lifecycle surfaces part of the clean profile", () => {
    const cleanFiles = [
      deploymentFile("compose.clean-v1.yaml"),
      deploymentFile("Caddyfile.clean-v1"),
    ].join("\n");

    for (const forbidden of ["installation", "enrollment", "lease"]) {
      expect(cleanFiles).not.toContain(forbidden);
    }
  });
});
