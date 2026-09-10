import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOptionalPrivateAuthoritySlackBrowserOauthConfiguration,
  readPrivateAuthoritySlackSigningSecret,
} from "../../src/adapters/security/private-file-credentials.js";

const roots: string[] = [];

function privateFile(value: string): string {
  const root = mkdtempSync(join(tmpdir(), "echo-slack-signing-secret-"));
  roots.push(root);
  const path = join(root, "signing-secret");
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("private Slack signing-secret file reader", () => {
  it("accepts a bounded visible-ASCII value from a current-user 0600 regular file", () => {
    const path = privateFile("a".repeat(32));
    expect(readPrivateAuthoritySlackSigningSecret(`file:${path}`)).toBe(
      "a".repeat(32),
    );
  });

  it("rejects short, non-visible, non-private, and symlinked inputs", () => {
    expect(() =>
      readPrivateAuthoritySlackSigningSecret(`file:${privateFile("a".repeat(31))}`),
    ).toThrow(/authority credential/);
    expect(() =>
      readPrivateAuthoritySlackSigningSecret(
        `file:${privateFile(`${"a".repeat(31)}\n`)}`,
      ),
    ).toThrow(/authority credential/);

    const publicPath = privateFile("a".repeat(32));
    chmodSync(publicPath, 0o644);
    expect(() =>
      readPrivateAuthoritySlackSigningSecret(`file:${publicPath}`),
    ).toThrow(/authority credential/);

    const target = privateFile("a".repeat(32));
    const link = join(roots[roots.length - 1]!, "link");
    symlinkSync(target, link);
    expect(() =>
      readPrivateAuthoritySlackSigningSecret(`file:${link}`),
    ).toThrow(/authority credential/);
  });
});

describe("private Slack browser OAuth configuration reader", () => {
  it("accepts formatted exact-shape JSON from a private file", () => {
    const path = privateFile(
      '{ "client_id": "1234567890.1234567890", "client_secret": "secret-value" }',
    );
    expect(readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(`file:${path}`)).toEqual({
      client_id: "1234567890.1234567890",
      client_secret: "secret-value",
    });
  });

  it("keeps a missing optional file on the legacy connection path", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-slack-browser-oauth-"));
    roots.push(root);
    expect(readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
      `file:${join(root, "missing")}`,
    )).toBeUndefined();
  });

  it("rejects malformed, public, and symlinked browser OAuth configuration", () => {
    const malformed = privateFile('{"client_id":"only"}');
    expect(() => readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
      `file:${malformed}`,
    )).toThrow(/authority credential/);

    const publicPath = privateFile('{"client_id":"123.456","client_secret":"secret"}');
    chmodSync(publicPath, 0o644);
    expect(() => readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
      `file:${publicPath}`,
    )).toThrow(/authority credential/);

    const target = privateFile('{"client_id":"123.456","client_secret":"secret"}');
    const link = join(roots[roots.length - 1]!, "browser-oauth-link");
    symlinkSync(target, link);
    expect(() => readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
      `file:${link}`,
    )).toThrow(/authority credential/);
  });
});
