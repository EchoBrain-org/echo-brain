import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../../../../../packages/organization-control-plane/src/canonical/canonical-json.js";
import { FileOrganizationSecretStore } from "../../../../../../packages/organization-control-plane/src/security/file-secret-store.js";
import {
  findPendingSlackAppCredentialsV1,
  findSlackAppCredentialsByReferenceSha256V1,
  parseSlackAppCredentialsV1,
  serializeSlackAppCredentialsV1,
  SLACK_APP_CREDENTIALS_KIND_V1,
  type SlackAppCredentialsV1,
} from "../../../src/organization-control-plane/application/slack-app-credentials-v1.js";

const pending: SlackAppCredentialsV1 = {
  kind: SLACK_APP_CREDENTIALS_KIND_V1,
  app_id: "A0123ABCD",
  client_id: "123.456",
  client_secret: "c".repeat(32),
  signing_secret: "s".repeat(32),
  nango_connection_id: null,
};

const directories: string[] = [];

function tempSecrets(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "echo-slack-app-credentials-")));
  directories.push(value);
  return value;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Slack app credentials V1 serialization", () => {
  it("round-trips a pending and a connected bundle", () => {
    expect(parseSlackAppCredentialsV1(serializeSlackAppCredentialsV1(pending))).toEqual(pending);
    const connected = { ...pending, nango_connection_id: "conn_1234567890" };
    expect(parseSlackAppCredentialsV1(serializeSlackAppCredentialsV1(connected))).toEqual(
      connected,
    );
  });

  it("rejects extra keys and never echoes values", () => {
    const raw = JSON.stringify({ ...pending, extra: "x" });
    expect(() => parseSlackAppCredentialsV1(raw)).toThrow("Slack app credentials are invalid");
    let caught: unknown;
    try {
      parseSlackAppCredentialsV1(JSON.stringify({ ...pending, client_secret: "" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("ccccc");
  });

  it("rejects an app_id, client_id, or nango_connection_id that does not match its shape", () => {
    expect(() =>
      serializeSlackAppCredentialsV1({ ...pending, app_id: "not-an-app-id" }),
    ).toThrow("Slack app credentials are invalid");
    expect(() =>
      serializeSlackAppCredentialsV1({ ...pending, client_id: "not-a-client-id" }),
    ).toThrow("Slack app credentials are invalid");
    expect(() =>
      serializeSlackAppCredentialsV1({ ...pending, nango_connection_id: "" }),
    ).toThrow("Slack app credentials are invalid");
  });

  it("rejects malformed JSON without ever echoing the input", () => {
    expect(() => parseSlackAppCredentialsV1("{not json")).toThrow(
      "Slack app credentials are invalid",
    );
  });
});

describe("findPendingSlackAppCredentialsV1", () => {
  it("finds the single pending bundle and ignores plain legacy bot-token secrets", () => {
    const store = new FileOrganizationSecretStore(tempSecrets());
    store.create("xoxb-plain-legacy-token");
    const reference = store.create(serializeSlackAppCredentialsV1(pending));
    expect(findPendingSlackAppCredentialsV1(store)?.reference).toEqual(reference);
  });

  it("returns undefined when no pending bundle exists", () => {
    const store = new FileOrganizationSecretStore(tempSecrets());
    store.create("xoxb-plain-legacy-token");
    store.create(
      serializeSlackAppCredentialsV1({ ...pending, nango_connection_id: "conn_1234567890" }),
    );
    expect(findPendingSlackAppCredentialsV1(store)).toBeUndefined();
  });

  it("refuses two pending bundles", () => {
    const store = new FileOrganizationSecretStore(tempSecrets());
    store.create(serializeSlackAppCredentialsV1(pending));
    store.create(serializeSlackAppCredentialsV1({ ...pending, app_id: "A0999ZZZZ" }));
    expect(() => findPendingSlackAppCredentialsV1(store)).toThrow(
      "more than one pending Slack app setup exists",
    );
  });
});

describe("findSlackAppCredentialsByReferenceSha256V1", () => {
  it("finds the credential bundle whose reference digest matches", () => {
    const store = new FileOrganizationSecretStore(tempSecrets());
    const reference = store.create(serializeSlackAppCredentialsV1(pending));
    const found = findSlackAppCredentialsByReferenceSha256V1(store, canonicalSha256(reference));
    expect(found.reference).toEqual(reference);
    expect(found.credentials).toEqual(pending);
  });

  it("throws when no reference matches the digest", () => {
    const store = new FileOrganizationSecretStore(tempSecrets());
    store.create(serializeSlackAppCredentialsV1(pending));
    expect(() =>
      findSlackAppCredentialsByReferenceSha256V1(store, "sha256:00".padEnd(71, "0") as `sha256:${string}`),
    ).toThrow("Slack credential is missing");
  });

  it("throws when more than one reference matches the digest", () => {
    const store = new FileOrganizationSecretStore(tempSecrets());
    const reference = store.create(serializeSlackAppCredentialsV1(pending));
    const digest = canonicalSha256(reference);
    const duplicateStore: Pick<typeof store, "listReferences" | "read"> = {
      listReferences: () => [reference, reference],
      read: (ref) => store.read(ref),
    };
    expect(() => findSlackAppCredentialsByReferenceSha256V1(duplicateStore, digest)).toThrow(
      "Slack credential is missing",
    );
  });
});
