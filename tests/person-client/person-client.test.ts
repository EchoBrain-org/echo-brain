import { SlackPersonClient } from '@echo-brain/provider-slack-client/person/slack-person-client';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import * as packageIdentity from "../../src/product/person-client/package-identity.js";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, p256KeyId } from "@echo-brain/federation-protocol";
import type { PersonSourceEvidenceCitationV1 } from "@echo-brain/organization-api";
import { organizationPersonSlackIdentityLinkChallengeCodeSha256 } from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import type { OrganizationAuthorityDescriptorV1 } from "@echo-brain/organization-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmployeeMutationError,
  PersonClient,
  PersonSessionStore,
  type PersonClientCliDependencies,
} from "../../src/product/person-client/index.js";

function fixtureId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

const ORGANIZATION_IDS = {
  authority: fixtureId("oau", 1),
  organization: fixtureId("org", 1),
  principal: fixtureId("prn", 1),
  membership: fixtureId("mem", 1),
} as const;

function authorityDescriptor(): OrganizationAuthorityDescriptorV1 {
  const { publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(publicKeyDer)) {
    throw new Error("unexpected authority public-key export");
  }
  return {
    schema_version: 1,
    kind: "echo-organization-authority",
    authority_id: ORGANIZATION_IDS.authority,
    organization_id: ORGANIZATION_IDS.organization,
    signing_key: {
      key_id: p256KeyId(publicKeyDer),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: publicKeyDer.toString("base64"),
    },
  };
}

const NOW = "2026-08-18T00:02:00.000Z";
const SESSION = {
  organization_id: ORGANIZATION_IDS.organization,
  principal_id: ORGANIZATION_IDS.principal,
  membership_id: ORGANIZATION_IDS.membership,
  display_name: "Example Person",
  membership_type: "employee",
  identity_binding_id: fixtureId("oib", 1),
  session_family_id: fixtureId("psf", 1),
  access_token: "A".repeat(43),
  refresh_token: "R".repeat(43),
  access_expires_at: "2026-08-18T00:01:00.000Z",
  refresh_expires_at: "2026-08-25T00:00:00.000Z",
  hard_reauthentication_at: "2026-08-25T00:00:00.000Z",
} as const;

const ROTATED_SESSION = {
  ...SESSION,
  access_token: "B".repeat(43),
  refresh_token: "S".repeat(43),
  access_expires_at: "2026-08-18T00:12:00.000Z",
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(canonicalJson(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "echo-person-")));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function runCli(
  argv: readonly string[],
  dependencies: Omit<PersonClientCliDependencies, "stdout" | "stderr"> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runPersonClientCli(argv, {
    ...dependencies,
    stdout: { write: (value) => ((stdout += String(value)), true) },
    stderr: { write: (value) => ((stderr += String(value)), true) },
  });
  return { code, stdout, stderr };
}

afterEach(() => vi.restoreAllMocks());

describe("Person client", () => {
  it.each([false, true])("distinguishes same-version client builds in status (signed in: %s)", async (signedIn) => {
    await withHome(async (home) => {
      if (signedIn) await new PersonClient({ home_directory: home, now: () => NOW,
        fetch: async () => json({ authority_descriptor: authorityDescriptor() }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      const readIdentity = packageIdentity.readPackagedPersonClientBuildIdentity;
      for (const [source_sha, source_kind] of [["a".repeat(40), "materialized-commit"], ["b".repeat(40), "worktree-head-unverified"]] as const) {
        const packageRoot = join(home, source_sha);
        mkdirSync(join(packageRoot, "dist"), { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-internal.6" }));
        writeFileSync(join(packageRoot, "dist/build-identity.v1.json"), JSON.stringify({
          schema_version: 1, kind: "echo-packaged-build-identity", product_version: "0.1.0-internal.6", source_sha, source_kind,
        }));
        const identity = readIdentity(pathToFileURL(join(packageRoot, "dist/package-identity.js")).href);
        vi.spyOn(packageIdentity, "readPackagedPersonClientBuildIdentity").mockReturnValue(identity);
        const fetch = vi.fn();
        const { code, stdout } = await runCli(["status"], { home_directory: home, fetch });
        expect(code).toBe(0);
        const status = JSON.parse(stdout);
        expect(status).toMatchObject({ signed_in: signedIn, installed_version: "0.1.0-internal.6", client_build: { source_sha, source_kind } });
        expect(status).not.toHaveProperty("authority_build");
        expect(fetch).not.toHaveBeenCalled();
      }
    });
  });

  it("reports disconnected status without a network call or private paths", async () => {
    await withHome(async (home) => {
      let networkCalled = false;
      const { code, stdout } = await runCli(["status"], {
        home_directory: home,
        fetch: async () => {
          networkCalled = true;
          throw new Error("status must not contact the Authority");
        },
      });
      expect(code).toBe(0);
      expect(networkCalled).toBe(false);
      expect(JSON.parse(stdout)).toMatchObject({
        schema_version: 1,
        kind: "echo-person-client-status-v1",
        signed_in: false,
        display_name: null,
        membership_type: null,
        connected_authority: null,
      });
      expect(stdout).not.toContain(home);
    });
  });

  it("reports the server-issued membership name for an installed session", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);

      const { code, stdout } = await runCli(["status"], {
        home_directory: home,
        fetch: async () => {
          throw new Error("status must not contact the Authority");
        },
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        signed_in: true,
        display_name: "Example Person",
      });
      expect(stdout).not.toContain(ROTATED_SESSION.access_token);
      expect(stdout).not.toContain(ROTATED_SESSION.refresh_token);
    });
  });

  it("treats an explicitly revoked session as a successful local logout without masking server failures", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);

      const { code, stdout, stderr } = await runCli(["logout"], {
        home_directory: home,
        fetch: async (input, init) => {
          expect(new URL(String(input)).pathname).toBe("/v2/session/revocations");
          expect(init?.method).toBe("POST");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${ROTATED_SESSION.access_token}`,
          );
          return json(
            { error: { code: "unauthorized", message: "request failed" } },
            401,
          );
        },
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true });
      expect(stderr).toBe("");
      expect(() => new PersonClient({ home_directory: home }).sessionSummary()).toThrow(
        /sign in again/,
      );
    });

    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);

      const { code, stdout, stderr } = await runCli(["logout"], {
        home_directory: home,
        fetch: async () =>
          json({ error: { code: "unavailable", message: "request failed" } }, 503),
      });

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        action: "logout",
        error: "Person Authority rejected the request",
      });
      expect(() => new PersonClient({ home_directory: home }).sessionSummary()).toThrow(
        /sign in again/,
      );
    });
  });

  it("limits development HTTP origins to numeric loopback", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        allow_insecure_loopback: true,
        fetch: async () => json({ authority_descriptor: authority }),
      });

      await expect(
        client.installSession("http://127.0.0.1:39478", ROTATED_SESSION),
      ).resolves.toMatchObject({
        authority_origin: "http://127.0.0.1:39478",
      });
      await expect(client.beginLogin("http://localhost:39478")).rejects.toThrow(
        /HTTPS origin/,
      );
    });
  });

  it("rotates one expired access session before listing records", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const paths: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/v1/authority-descriptor") {
          expect(init?.method).toBe("GET");
          return json({ authority_descriptor: authority });
        }
        if (path === "/v2/session/refresh") {
          expect(new Headers(init?.headers).get("authorization")).toBeNull();
          expect(JSON.parse(String(init?.body))).toEqual({
            refresh_token: SESSION.refresh_token,
          });
          return json(ROTATED_SESSION);
        }
        expect(path).toBe("/v1/person/records");
        expect(new URL(String(input)).search).toBe("");
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ROTATED_SESSION.access_token}`,
        );
        return json({
          schema_version: 1,
          kind: "echo-clean-person-record-list-v1",
          records: [],
        });
      };
      const client = new PersonClient({
        home_directory: home,
        fetch: fetchImpl,
        now: () => NOW,
        random_uuid: () => "00000000-0000-4000-8000-000000000111",
      });

      await client.installSession("https://authority.example", SESSION);
      await expect(client.records()).resolves.toMatchObject({
        records: [],
      });
      expect(paths).toEqual([
        "/v1/authority-descriptor",
        "/v2/session/refresh",
        "/v1/person/records",
      ]);
      expect(client.sessionSummary().access_expires_at).toBe(
        ROTATED_SESSION.access_expires_at,
      );
    });
  });

  it("accepts an updated server-owned membership name on refresh", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          expect(path).toBe("/v2/session/refresh");
          return json({ ...ROTATED_SESSION, display_name: "Other Person" });
        },
      });
      await client.installSession("https://authority.example", SESSION);

      await expect(client.refresh()).resolves.toMatchObject({
        display_name: "Other Person",
      });
      expect(client.sessionSummary().display_name).toBe("Other Person");
    });
  });

  it("lists Person records for the installed Person without an identity input", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          expect(url.pathname).toBe("/v1/person/records");
          expect(url.search).toBe("?limit=2");
          expect(init?.method).toBe("GET");
          expect(init?.body).toBeUndefined();
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${ROTATED_SESSION.access_token}`,
          );
          return json({
            schema_version: 1,
            kind: "echo-clean-person-record-list-v1",
            records: [
              {
                position: 2,
                approval_id: fixtureId("apr", 2),
                record_sha256: `sha256:${"a".repeat(64)}`,
                envelope: { kind: "approved" },
              },
              {
                position: 1,
                approval_id: fixtureId("apr", 1),
                record_sha256: `sha256:${"b".repeat(64)}`,
                envelope: { kind: "approved" },
              },
            ],
          });
        },
      });

      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.records(2)).resolves.toMatchObject({
        kind: "echo-clean-person-record-list-v1",
        records: [{ position: 2 }, { position: 1 }],
      });
    });
  });

  it("retrieves one exact readable cited record without approximating through a page", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const recordSha256 = `sha256:${"d".repeat(64)}` as const;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/authority-descriptor") {
          return json({ authority_descriptor: authority });
        }
        expect(url.pathname + url.search).toBe(
          `/v1/person/records?record_sha256=${recordSha256}`,
        );
        expect(init?.method).toBe("GET");
        return json({
          schema_version: 1,
          kind: "echo-clean-person-record-list-v1",
          records: [{
            position: 1,
            approval_id: fixtureId("apr", 1),
            record_sha256: recordSha256,
            envelope: { old: true },
          }],
        });
      };
      const client = new PersonClient({ home_directory: home, now: () => NOW, fetch: fetchImpl });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.records(undefined, undefined, recordSha256)).resolves.toMatchObject({
        kind: "echo-clean-person-record-list-v1",
        records: [{ position: 1, record_sha256: recordSha256 }],
      });
    });
  });

  it.each([
    { record_approved_by: { display_name: "Maya Chen" } },
    {},
    undefined,
  ])("negotiates optional source metadata and accepts older Authorities: %j", async (metadata) => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const recordSha256 = `sha256:${"d".repeat(64)}` as const;
      const fetchImpl: typeof fetch = async (input, init) => {
        if (new URL(String(input)).pathname === "/v1/authority-descriptor") return json({ authority_descriptor: authority });
        expect(new Headers(init?.headers).get("x-echo-person-record-version")).toBe("2");
        return json({ schema_version: 1, kind: "echo-clean-person-record-list-v1", records: [{
          position: 1, approval_id: fixtureId("apr", 1), record_sha256: recordSha256,
          envelope: { approved: true }, ...(metadata === undefined ? {} : { source_metadata: metadata }),
        }] });
      };
      const client = new PersonClient({ home_directory: home, now: () => NOW, fetch: fetchImpl });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      const result = await client.records(undefined, undefined, recordSha256);
      expect(result).toMatchObject({ records: [{ envelope: { approved: true } }] });
      if (result.kind !== "echo-clean-person-record-list-v1") throw new Error("unexpected search result");
      expect(result.records[0]?.source_metadata).toEqual(metadata);
    });
  });

  it.each([
    { record_approved_by: { display_name: "Maya", email: "private@example.test" } },
    { record_approved_by: { display_name: "spoof\u202ename" } },
    { record_approved_by: { display_name: "" } },
    { participants: [] },
  ])("rejects malformed source metadata: %j", async (metadata) => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const fetchImpl: typeof fetch = async (input) => {
        if (new URL(String(input)).pathname === "/v1/authority-descriptor") return json({ authority_descriptor: authority });
        return json({ schema_version: 1, kind: "echo-clean-person-record-list-v1", records: [{
          position: 1, approval_id: fixtureId("apr", 1), record_sha256: `sha256:${"d".repeat(64)}`,
          envelope: {}, source_metadata: metadata,
        }] });
      };
      const client = new PersonClient({ home_directory: home, now: () => NOW, fetch: fetchImpl });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.records()).rejects.toThrow();
    });
  });

  it("rejects invalid and combined exact-record options before network access", async () => {
    for (const argv of [
      ["records", "--record-sha256", "sha256:nope"],
      ["records", "--record-sha256", `sha256:${"a".repeat(64)}`, "--limit", "1"],
      ["records", "--record-sha256", `sha256:${"a".repeat(64)}`, "--query", "x"],
    ]) {
      let called = false;
      const { code: status } = await runCli(argv, {
        fetch: async () => { called = true; throw new Error("unexpected network"); },
      });
      expect(status).toBe(2);
      expect(called).toBe(false);
    }
  });

  it("uses the same records command for a readable-search query", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let searchCalls = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/authority-descriptor") {
          return json({ authority_descriptor: authority });
        }
        searchCalls += 1;
        expect(url.pathname).toBe("/v1/person/records");
        expect(url.search).toBe("");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ query: "pricing", limit: 5 });
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ROTATED_SESSION.access_token}`,
        );
        return json({
          schema_version: 2,
          kind: "echo-clean-person-record-search-v2",
          items: [
            {
              atom_id: `sha256:${"c".repeat(64)}`,
              record_sha256: `sha256:${"b".repeat(64)}`,
              kind: "decision",
              text: "Use simple pricing.",
              policy_id: "organization-member-readable-person-v2",
            },
          ],
        });
      };
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: fetchImpl,
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);

      const first = await runCli(
        ["records", "--query", "pricing", "--limit", "5"],
        {
          home_directory: home,
          now: () => NOW,
          fetch: fetchImpl,
        },
      );
      expect(first.code).toBe(0);
      expect(first.stderr).toBe("");
      expect(JSON.parse(first.stdout)).toMatchObject({
        ok: true,
        result: {
          kind: "echo-clean-person-record-search-v2",
          items: [{ text: "Use simple pricing." }],
        },
      });
      expect(searchCalls).toBe(1);

      const removed = await runCli(
        ["readable-search", "--query", "pricing"],
        {
          home_directory: home,
          fetch: fetchImpl,
        },
      );
      expect(removed.code).toBe(2);
      expect(removed.stdout).toBe("");
      expect(removed.stderr).toContain("usage:");
    });
  });

  it("asks one bounded question through the installed Person session and preserves answer bindings", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);

      const timeout = vi.spyOn(AbortSignal, "timeout");
      const result = await runCli(
        ["ask", "--question", "What is our pricing decision?"],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            expect(new URL(String(input)).pathname).toBe("/v2/person/ask");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(String(init?.body))).toEqual({
              schema_version: 2,
              question: "What is our pricing decision?",
            });
            expect(new Headers(init?.headers).get("authorization")).toBe(
              `Bearer ${ROTATED_SESSION.access_token}`,
            );
            return json({
              schema_version: 3,
              kind: "echo-clean-person-answer-v3",
              answer: "Use simple pricing.",
              scope: { kind: "global" },
              citations: [
                {
                  kind: "approved_record",
                  atom_id: `sha256:${"c".repeat(64)}`,
                  record_sha256: `sha256:${"b".repeat(64)}`,
                  policy_id: "organization-member-readable-person-v2",
                },
              ],
            });
          },
        },
      );

      expect(result.code).toBe(0);
      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(135_000);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        result: {
          schema_version: 3,
          kind: "echo-clean-person-answer-v3",
          answer: "Use simple pricing.",
          scope: { kind: "global" },
          citations: [
            {
              kind: "approved_record",
              atom_id: `sha256:${"c".repeat(64)}`,
              record_sha256: `sha256:${"b".repeat(64)}`,
              policy_id: "organization-member-readable-person-v2",
            },
          ],
        },
      });
    });
  });

  it("maps --project to a strict V2 Ask coordinate and accepts immutable source evidence", async () => {
    await withHome(async home => {
      const projectId = "prj_00000000-0000-4000-8000-000000000019";
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authorityDescriptor() });
          }
          expect(new URL(String(input)).pathname).toBe("/v2/person/ask");
          expect(JSON.parse(String(init?.body))).toEqual({ schema_version: 2, question: "What is in this project?", project_id: projectId });
          return json({
            schema_version: 3,
            kind: "echo-clean-person-answer-v3",
            answer: "The MRD is available.",
            scope: { kind: "project", project_id: projectId },
            citations: [{
              kind: "source_revision",
              source_id: `source:${"a".repeat(64)}`,
              revision_id: `sha256:${"b".repeat(64)}`,
              source_sha256: `sha256:${"c".repeat(64)}`,
              representation_sha256: `sha256:${"d".repeat(64)}`,
              anchor_sha256: `sha256:${"e".repeat(64)}`,
              document_id: `doc_${"f".repeat(64)}`,
              label: "MRD",
            }],
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.ask("What is in this project?", projectId as `prj_${string}`)).resolves.toMatchObject({
        scope: { kind: "project", project_id: projectId },
        citations: [{ kind: "source_revision", label: "MRD" }],
      });
    });
  });

  it("reads an Ask source citation through the bounded proof endpoint", async () => {
    await withHome(async home => {
      const sourceId = `source:${"a".repeat(64)}`;
      const revisionId = `sha256:${"b".repeat(64)}`;
      const sourceSha = `sha256:${"c".repeat(64)}`;
      const representationSha = `sha256:${"d".repeat(64)}`;
      const anchorSha = `sha256:${"e".repeat(64)}`;
      await new PersonClient({ home_directory: home, now: () => NOW, fetch: async () => json({ authority_descriptor: authorityDescriptor() }) })
        .installSession("https://authority.example", ROTATED_SESSION);
      const { code: status, stdout } = await runCli([
        "ask-source", "--source-id", sourceId, "--revision-id", revisionId,
        "--source-sha256", sourceSha, "--representation-sha256", representationSha,
        "--anchor-sha256", anchorSha,
      ], {
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          expect(new URL(String(input)).pathname).toBe("/v2/person/ask/source");
          expect(JSON.parse(String(init?.body))).toEqual({
            schema_version: 1,
            scope: { kind: "global" },
            citation: { kind: "source_revision", source_id: sourceId, revision_id: revisionId, source_sha256: sourceSha, representation_sha256: representationSha, anchor_sha256: anchorSha },
          });
          return json({
            schema_version: 1,
            kind: "echo-person-source-evidence-v1",
            scope: { kind: "global" },
            citation: { kind: "source_revision", source_id: sourceId, revision_id: revisionId, source_sha256: sourceSha, representation_sha256: representationSha, anchor_sha256: anchorSha, label: "MRD" },
            text: "MRD\n\nReview before launch.",
          });
        },
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, result: { citation: { label: "MRD" }, text: "MRD\n\nReview before launch." } });
    });
  });

  it("rejects Ask scope or source evidence coordinates changed by the response", async () => {
    await withHome(async home => {
      const projectId = "prj_00000000-0000-4000-8000-000000000019" as `prj_${string}`;
      const sourceId: `source:${string}` = `source:${"a".repeat(64)}`;
      const citation = {
        kind: "source_revision" as const,
        source_id: sourceId,
        revision_id: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
        source_sha256: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
        representation_sha256: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
        anchor_sha256: `sha256:${"e".repeat(64)}` as `sha256:${string}`,
      } satisfies PersonSourceEvidenceCitationV1;
      const client = new PersonClient({ home_directory: home, now: () => NOW, fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/authority-descriptor") return json({ authority_descriptor: authorityDescriptor() });
        if (path === "/v2/person/ask") return json({ schema_version: 3, kind: "echo-clean-person-answer-v3", answer: "Answer.", citations: [], scope: { kind: "global" } });
        return json({ schema_version: 1, kind: "echo-person-source-evidence-v1", scope: { kind: "global" }, citation: { ...citation, label: "MRD" }, text: "MRD" });
      } });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.ask("What is current?", projectId)).rejects.toMatchObject({ code: "invalid_response" });
      await expect(client.askSourceEvidence({ schema_version: 1, scope: { kind: "project", project_id: projectId }, citation })).rejects.toMatchObject({ code: "invalid_response" });
    });
  });

  it("does not return an Ask answer after the local account changes while its response is pending", async () => {
    await withHome(async home => {
      let resolveResponse: ((response: Response) => void) | undefined;
      const pendingResponse = new Promise<Response>(resolve => { resolveResponse = resolve; });
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async input => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authorityDescriptor() });
          }
          return pendingResponse;
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      const answer = client.ask("What is current?");
      await Promise.resolve();
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_id: fixtureId("mem", 2), principal_id: fixtureId("prn", 2), session_family_id: fixtureId("psf", 2),
      });
      resolveResponse?.(json({
        schema_version: 3, kind: "echo-clean-person-answer-v3", answer: "Prior account answer.",
        citations: [], scope: { kind: "global" },
      }));
      await expect(answer).rejects.toThrow("current account");
    });
  });

  it("does not return an Ask source proof after the local account changes while its response is pending", async () => {
    await withHome(async home => {
      const citation = {
        kind: "source_revision" as const,
        source_id: `source:${"a".repeat(64)}` as `source:${string}`,
        revision_id: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
        source_sha256: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
        representation_sha256: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
        anchor_sha256: `sha256:${"e".repeat(64)}` as `sha256:${string}`,
      } satisfies PersonSourceEvidenceCitationV1;
      let resolveResponse: ((response: Response) => void) | undefined;
      const pendingResponse = new Promise<Response>(resolve => { resolveResponse = resolve; });
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async input => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authorityDescriptor() });
          }
          return pendingResponse;
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      const proof = client.askSourceEvidence({ schema_version: 1, scope: { kind: "global" }, citation });
      await Promise.resolve();
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_id: fixtureId("mem", 3), principal_id: fixtureId("prn", 3), session_family_id: fixtureId("psf", 3),
      });
      resolveResponse?.(json({
        schema_version: 1, kind: "echo-person-source-evidence-v1", scope: { kind: "global" },
        citation: { ...citation, label: "Prior account source" }, text: "Prior account proof.",
      }));
      await expect(proof).rejects.toThrow("current account");
    });
  });

  it("accepts 32 unique question terms and rejects 33 before the request", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let asks = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          asks += 1;
          return json({
            schema_version: 3,
            kind: "echo-clean-person-answer-v3",
            answer: "Bounded answer.",
            scope: { kind: "global" },
            citations: [],
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      const question = (count: number) =>
        Array.from({ length: count }, (_, index) => `term${index}`).join(" ");

      await expect(client.ask(question(32))).resolves.toMatchObject({
        answer: "Bounded answer.",
      });
      await expect(client.ask(question(33))).rejects.toMatchObject({ code: "query_term_count" });
      expect(asks).toBe(1);
    });
  });

  it.each(["ask", "search"])("rejects retired global metadata in a %s response", async (mode) => {
    await withHome(async (home) => {
      const client = new PersonClient({ home_directory: home, now: () => NOW, fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/authority-descriptor") return json({ authority_descriptor: authorityDescriptor() });
        return json({ schema_version: mode === "ask" ? 3 : 2, ...(mode === "ask"
          ? { kind: "echo-clean-person-answer-v3", answer: "Insufficient accessible evidence to answer this question.", citations: [], scope: { kind: "global" } }
          : { kind: "echo-clean-person-record-search-v2", items: [] }),
        generation_id: `sha256:${"a".repeat(64)}`, record_head: { position: 9, record_sha256: `sha256:${"b".repeat(64)}` } });
      } });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(mode === "ask" ? client.ask("pricing") : client.records(undefined, "pricing")).rejects.toThrow(
        mode === "ask" ? "malformed response" : "response is invalid",
      );
    });
  });

  it("rejects invalid questions and malformed answer bindings before any answer is released", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let asks = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          asks += 1;
          return json({
            schema_version: 3,
            kind: "echo-clean-person-answer-v3",
            answer: "Use simple pricing.",
            scope: { kind: "global" },
            citations: [
              {
                kind: "approved_record",
                atom_id: `sha256:${"c".repeat(64)}`,
                record_sha256: `sha256:${"b".repeat(64)}`,
                policy_id: "organization-member-readable-person-v2",
                unexpected: true,
              },
            ],
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);

      await expect(client.ask(" pricing")).rejects.toMatchObject({ code: "query_whitespace" });
      expect(asks).toBe(0);
      await expect(client.ask("pricing")).rejects.toThrow(
          "malformed response",
      );
      expect(asks).toBe(1);
    });
  });

  it("accepts only the machine-readable authorship-unsupported outcome", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          expect(new Headers(init?.headers).get("x-echo-person-answer-version")).toBeNull();
          return json({
            schema_version: 3,
            kind: "echo-clean-person-answer-v3",
            answer: "I can summarize decisions in accessible records, but cannot determine whether you personally made them.",
            citations: [],
            scope: { kind: "global" },
            outcome: "authorship_unsupported",
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.ask("Which decisions did I make?")).resolves.toMatchObject({
        outcome: "authorship_unsupported",
      });
    });
  });

  it.each([
    ["ask", "--question", "What happened?"], ["records"],
    ["records", "--query", "pricing"],
    ["records", "--record-sha256", `sha256:${"a".repeat(64)}`],
  ])("preserves typed Authority failures through the composed CLI: %j", async (...argv) => {
    await withHome(async home => {
      const authority = authorityDescriptor();
      await new PersonClient({ home_directory: home, now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      for (const [code, httpStatus] of [["invalid_output", 502], ["unavailable", 503], ["unauthorized", 401], ["invalid_request", 400]] as const) {
        const result = await runCli(argv, {
          home_directory: home, now: () => NOW,
          fetch: async () => json({ error: { code, message: "private provider body" } }, httpStatus),
        });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code, status: httpStatus });
        expect(result.stderr).not.toMatch(/private provider body|catching up/);
        if (argv[0] === "ask" && code === "invalid_output") {
          expect(JSON.parse(result.stderr).error).toBe("Answer generation returned an invalid response.");
        }
      }
    });
  });

  it("keeps malformed Authority bodies and unknown failures out of CLI errors", async () => {
    await withHome(async home => {
      const authority = authorityDescriptor();
      await new PersonClient({ home_directory: home, now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      let stderr = "";
      const options = { home_directory: home, now: () => NOW,
        stderr: { write: (value: string) => ((stderr += String(value)), true) },
        stdout: { write: () => { throw new Error("no success expected"); } },
        fetch: async () => new Response("private provider body", { status: 503 }),
      };
      expect(await runPersonClientCli(["ask", "--question", "What happened?"], options)).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({ code: "invalid_response", status: 503 });
      expect(stderr).not.toContain("private provider body");
      const spy = vi.spyOn(PersonClient.prototype, "ask").mockRejectedValueOnce(new Error("private internal detail"));
      try {
        stderr = "";
        expect(await runPersonClientCli(["ask", "--question", "What happened?"], options)).toBe(1);
        expect(JSON.parse(stderr).error).toBe("Person request could not be completed");
      } finally { spy.mockRestore(); }
    });
  });

  it("reports actionable bounded query rules without echoing input or calling transport", async () => {
    await withHome(async home => {
    for (const [text, code] of [
      ["", "query_empty"], [" x", "query_whitespace"], ["e\u0301", "query_normalization"],
      ["x\ny", "query_controls"], ["x ".repeat(121).trim(), "query_too_long"],
      ["!!!", "query_term_count"], [Array.from({ length: 33 }, (_, i) => `t${i}`).join(" "), "query_term_count"],
      ["é".repeat(33), "query_term_too_long"],
    ]) {
      for (const argv of [["ask", "--question", text], ["records", "--query", text]]) {
        let stderr = "";
        const status = await runPersonClientCli(argv, {
          home_directory: home,
          stderr: { write: value => ((stderr += String(value)), true) },
          stdout: { write: () => { throw new Error("no success output expected"); } },
          fetch: async () => { throw new Error("must not reach transport"); },
        });
        expect(status).toBe(1);
        expect(JSON.parse(stderr)).toMatchObject({ code });
      }
    }
    for (const limit of ["-1", "0", "101"]) {
      const { code: status, stderr } = await runCli(["records", "--limit", limit], {
        home_directory: home,
      });
      expect(status).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({ code: "invalid_limit" });
      expect(stderr).toContain("1 to 100");
    }
    });
  });

  it("rejects malformed Person record responses and invalid CLI limits", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          return json({
            schema_version: 1,
            kind: "echo-clean-person-record-list-v1",
            records: [
              {
                position: 1,
                approval_id: fixtureId("apr", 1),
                record_sha256: `sha256:${"z".repeat(64)}`,
                envelope: {},
                unexpected: true,
              },
            ],
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.records()).rejects.toMatchObject({
        code: "invalid_response",
      });

      const result = await runCli(["records", "--limit", "101"], {
        home_directory: home,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        action: "records",
        error: "--limit must be an integer from 1 to 100",
      });
    });
  });

  it("reads authenticated tools without making Slack a prerequisite for employee records", async () => {
    await withHome(async home => {
      let tools: unknown = [];
      const calls: string[] = [];
      const client = new PersonClient({ home_directory: home, now: () => NOW, fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/authority-descriptor") return json({ authority_descriptor: authorityDescriptor() });
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ROTATED_SESSION.access_token}`);
        calls.push(path);
        if (path === "/v1/person/records") return json({ schema_version: 1, kind: "echo-clean-person-record-list-v1", records: [] });
        if (path === "/v2/person/ask") return json({ schema_version: 3, kind: "echo-clean-person-answer-v3", answer: "No approved records.", citations: [], scope: { kind: "global" } });
        expect(path).toBe("/v3/person/tools");
        if (tools === "failure") return new Response("provider raw body", { status: 503 });
        return json({ schema_version: 3, kind: "echo-organization-person-tools", organization_id: SESSION.organization_id, membership_id: SESSION.membership_id, tools });
      } });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      expect((await client.tools()).tools).toEqual([]);
      expect(await client.records(1)).toMatchObject({ records: [] });
      expect((await client.ask("What is approved?")).answer).toBe("No approved records.");
      tools = [{ tool_id: "calendar", display_name: "Calendar", availability: "enabled", personal_status: "linked", external_scope_id: "calendar-workspace", external_subject_id: "calendar-user" }];
      expect((await client.tools()).tools[0]?.personal_status).toBe("linked");
      expect(await client.records(1)).toMatchObject({ records: [] });
      expect((await client.ask("What is approved?")).answer).toBe("No approved records.");
      tools = "failure";
      await expect(client.tools()).rejects.toThrow();
      expect(calls).not.toContain("/v2/integration-links/slack/challenges");
    });
  });

  it("discards tools status when the account changes during the read", async () => {
    await withHome(async home => {
      const descriptor = authorityDescriptor();
      const client: PersonClient = new PersonClient({ home_directory: home, now: () => NOW, fetch: async input => {
        if (new URL(String(input)).pathname === "/v1/authority-descriptor") return json({ authority_descriptor: descriptor });
        await client.installSession("https://authority.example", { ...ROTATED_SESSION, membership_id: fixtureId("mem", 2), principal_id: fixtureId("prn", 2), session_family_id: fixtureId("psf", 2) });
        return json({ schema_version: 3, kind: "echo-organization-person-tools", organization_id: SESSION.organization_id, membership_id: SESSION.membership_id, tools: [] });
      } });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(client.tools()).rejects.toThrow("current account");
    });
  });

  it("opens a bounded Slack browser connection without printing authorization state", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const attempt = fixtureId("sbl", 7);
      const authorizationUrl = "https://slack.com/openid/connect/authorize?client_id=client&state=private-state";
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      let opened = "";
      const { code: status, stdout } = await runCli(["slack-connect-begin"], {
        home_directory: home,
        now: () => NOW,
        random_uuid: () => "00000000-0000-4000-8000-000000000007",
        open_authorization_url: (url) => { opened = url; return true; },
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v2/person/external-identities/slack/browser/begin") {
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ROTATED_SESSION.access_token}`);
            expect(JSON.parse(String(init?.body))).toEqual({ request_id: "psb_00000000-0000-4000-8000-000000000007" });
            return json({
              schema_version: 1,
              kind: "echo-person-slack-browser-link-v1",
              attempt_id: attempt,
              authorization_url: authorizationUrl,
              expires_at: "2026-08-18T00:17:00.000Z",
            }, 201);
          }
          throw new Error(`unexpected request ${path}`);
        },
      });
      expect(status).toBe(0);
      expect(opened).toBe(authorizationUrl);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        phase: "waiting-for-slack",
        attempt_id: attempt,
        expires_at: "2026-08-18T00:17:00.000Z",
      });
      expect(stdout).not.toContain(authorizationUrl);
      expect(stdout).not.toContain("private-state");
    });
  });

  it("refuses untrusted or malformed Slack browser authorization URLs before opening them", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      for (const authorization_url of [
        "https://evil.example/openid/connect/authorize",
        "https://slack.com:444/openid/connect/authorize",
        "https://slack.com/oauth/v2/authorize",
      ]) {
        let opened = false;
        let stderr = "";
        const status = await runPersonClientCli(["slack-connect-begin"], {
          stdout: { write: () => true },
          stderr: { write: (value) => ((stderr += String(value)), true) },
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => { opened = true; return true; },
          fetch: async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v2/person/external-identities/slack/browser/begin") return json({
              schema_version: 1,
              kind: "echo-person-slack-browser-link-v1",
              attempt_id: fixtureId("sbl", 8),
              authorization_url,
              expires_at: "2026-08-18T00:17:00.123Z",
            }, 201);
            throw new Error(`unexpected request ${path}`);
          },
        });
        expect(status).toBe(1);
        expect(opened).toBe(false);
        expect(stderr).toContain("Slack browser authorization URL is invalid");
      }
    });
  });

  it("rejects a completed Slack browser link when the local account changes", async () => {
    await withHome(async (home) => {
      const descriptor = authorityDescriptor();
      const client: PersonClient = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") return json({ authority_descriptor: descriptor });
          await client.installSession("https://authority.example", {
            ...ROTATED_SESSION,
            membership_id: fixtureId("mem", 9), principal_id: fixtureId("prn", 9), session_family_id: fixtureId("psf", 9),
          });
          return json({
            schema_version: 1,
            kind: "echo-person-slack-browser-link-status-v1",
            attempt_id: fixtureId("sbl", 9),
            status: "complete",
            failure_reason: null,
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(new SlackPersonClient(client).slackBrowserLinkStatus(fixtureId("sbl", 9))).rejects.toThrow("current account");
    });
  });

  it("cancels a pending Slack browser attempt without exposing its authorization URL", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const attempt = fixtureId("sbl", 10);
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      const { code: status, stdout } = await runCli(
        ["slack-connect-cancel", "--attempt-id", attempt],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            expect(new URL(String(input)).pathname).toBe(
              "/v2/person/external-identities/slack/browser/cancel",
            );
            expect(JSON.parse(String(init?.body))).toEqual({ attempt_id: attempt });
            return json({
              schema_version: 1,
              kind: "echo-person-slack-browser-link-status-v1",
              attempt_id: attempt,
              status: "cancelled",
              failure_reason: null,
            });
          },
        },
      );
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, attempt_id: attempt, status: "cancelled" });
      expect(stdout).not.toContain("authorization_url");
    });
  });

  it("disconnects the current person's Slack link without accepting an identity argument", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      let requests = 0;
      const { code: status, stdout } = await runCli(["slack-disconnect"], {
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          requests += 1;
          expect(new URL(String(input)).pathname).toBe(
            "/v2/person/external-identities/slack/disconnect",
          );
          expect(init?.method).toBe("POST");
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ROTATED_SESSION.access_token}`);
          expect(JSON.parse(String(init?.body))).toEqual({});
          return json({
            schema_version: 2,
            kind: "echo-organization-person-tools",
            organization_id: SESSION.organization_id,
            membership_id: SESSION.membership_id,
            tools: [{ provider: "slack", availability: "enabled", personal_status: "unlinked", workspace_id: "T123ABC", account_id: null }],
          });
        },
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        result: { tools: [{ provider: "slack", personal_status: "unlinked" }] },
      });

      let stderr = "";
      const invalid = await runPersonClientCli(["slack-disconnect", "--slack-user", "U123"], {
        stdout: { write: () => true },
        stderr: { write: (value) => ((stderr += String(value)), true) },
        home_directory: home,
      });
      expect(invalid).toBe(2);
      expect(stderr).toContain("Unknown option '--slack-user'");
      expect(requests).toBe(1);
    });
  });

  it("rejects a malformed disconnect response and a session switch during disconnect", async () => {
    await withHome(async (home) => {
      const descriptor = authorityDescriptor();
      const client: PersonClient = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") return json({ authority_descriptor: descriptor });
          if (path !== "/v2/person/external-identities/slack/disconnect") throw new Error(`unexpected request ${path}`);
          await client.installSession("https://authority.example", {
            ...ROTATED_SESSION,
            membership_id: fixtureId("mem", 11), principal_id: fixtureId("prn", 11), session_family_id: fixtureId("psf", 11),
          });
          return json({
            schema_version: 2,
            kind: "echo-organization-person-tools",
            organization_id: SESSION.organization_id,
            membership_id: SESSION.membership_id,
            tools: [{ provider: "slack", availability: "enabled", personal_status: "unlinked", workspace_id: "T123ABC", account_id: "U123PERSON" }],
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(new SlackPersonClient(client).disconnectSlack()).rejects.toThrow("malformed response");
    });

    await withHome(async (home) => {
      const descriptor = authorityDescriptor();
      const client: PersonClient = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") return json({ authority_descriptor: descriptor });
          await client.installSession("https://authority.example", {
            ...ROTATED_SESSION,
            membership_id: fixtureId("mem", 12), principal_id: fixtureId("prn", 12), session_family_id: fixtureId("psf", 12),
          });
          return json({
            schema_version: 2,
            kind: "echo-organization-person-tools",
            organization_id: SESSION.organization_id,
            membership_id: SESSION.membership_id,
            tools: [{ provider: "slack", availability: "enabled", personal_status: "unlinked", workspace_id: "T123ABC", account_id: null }],
          });
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(new SlackPersonClient(client).disconnectSlack()).rejects.toThrow("current account");
    });
  });

  it("sends Slack identity-link replay input without caller or route assertions", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const challengeCode = "A".repeat(43);
      const challengeAttemptId = fixtureId("cat", 1);
      const challengeMessageTs = "1755518400.000001";
      const observed: Array<{ path: string; body: Record<string, unknown> }> =
        [];
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        random_bytes: (size) => new Uint8Array(size),
        random_uuid: () => "00000000-0000-4000-8000-000000000113",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${ROTATED_SESSION.access_token}`,
          );
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          observed.push({ path, body });
          if (path === "/v2/integration-links/slack/challenges") {
            return json(
              {
                schema_version: 2,
                kind: "echo-organization-person-slack-link-begin-response",
                challenge_attempt_id: challengeAttemptId,
                provider: "slack",
                provider_tenant_id: "T123ABC",
                channel_id: "D123ABC",
                challenge_message_ts: challengeMessageTs,
                expires_at: "2026-08-18T00:17:00.000Z",
              },
              201,
            );
          }
          expect(path).toBe("/v2/integration-links/slack/completions");
          return json({
            schema_version: 2,
            kind: "echo-organization-person-slack-link-result",
            identity_link_id: fixtureId("clm", 1),
            connection_id: fixtureId("con", 1),
            organization_id: SESSION.organization_id,
            principal_id: SESSION.principal_id,
            membership_id: SESSION.membership_id,
            provider: "slack",
            provider_tenant_id: "T123ABC",
            provider_subject_id: "U123PERSON",
            channel_id: "D123ABC",
            linked_at: NOW,
            identity_link_created: true,
          });
        },
      });

      await client.installSession("https://authority.example", ROTATED_SESSION);
      const begun = await new SlackPersonClient(client).beginSlackIdentityLink("U123PERSON");
      expect(begun.challenge_code).toBe(challengeCode);
      await new SlackPersonClient(client).completeSlackIdentityLink({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_message_ts: begun.challenge_message_ts,
        challenge_code: begun.challenge_code,
      });

      expect(observed).toEqual([
        {
          path: "/v2/integration-links/slack/challenges",
          body: {
            challenge_code_sha256:
              organizationPersonSlackIdentityLinkChallengeCodeSha256(challengeCode),
            request_id: "psb_00000000-0000-4000-8000-000000000113",
            recipient_user_id: "U123PERSON",
          },
        },
        {
          path: "/v2/integration-links/slack/completions",
          body: {
            challenge_attempt_id: challengeAttemptId,
            challenge_code: challengeCode,
            challenge_message_ts: challengeMessageTs,
            request_id: "psc_00000000-0000-4000-8000-000000000113",
          },
        },
      ]);
      for (const { body } of observed) {
        expect(body).not.toHaveProperty("schema_version");
        expect(body).not.toHaveProperty("kind");
        expect(body).not.toHaveProperty("authority_id");
        expect(body).not.toHaveProperty("organization_id");
        expect(body).not.toHaveProperty("subject_principal_id");
        expect(body).not.toHaveProperty("http_method");
        expect(body).not.toHaveProperty("http_path");
      }
    });
  });

  it("writes an owner-issued employee invitation privately without rendering its grant or IDs", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const outputPath = join(home, "employee-onboarding.json");
      const loginGrant = "G".repeat(43);
      await new PersonClient({
        home_directory: home,
        now: () => "2026-08-18T00:00:00.000Z",
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", {
        ...SESSION,
        membership_type: "owner",
      });
      const { code: status, stdout } = await runCli(
        [
          "employee",
          "invite",
          "--name",
          "Jane Doe",
          "--email",
          "jane@example.com",
          "--out",
          outputPath,
        ],
        {
          home_directory: home,
          now: () => "2026-08-18T00:00:00.000Z",
          fetch: async (input, init) => {
            expect(new URL(String(input)).pathname).toBe("/v1/person/employees");
            expect(init?.method).toBe("POST");
            expect(new Headers(init?.headers).get("authorization")).toBe(
              `Bearer ${SESSION.access_token}`,
            );
            expect(JSON.parse(String(init?.body))).toEqual({
              name: "Jane Doe",
              email: "jane@example.com",
            });
            return json({ login_grant: loginGrant, expires_at: "2026-08-18T00:15:00.000Z" }, 201);
          },
        },
      );
      expect(status).toBe(0);
      expect(stdout).not.toContain(loginGrant);
      expect(stdout).not.toContain("mem_");
      expect(stdout).not.toContain("prn_");
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        output_path: outputPath,
        expires_at: "2026-08-18T00:15:00.000Z",
      });
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
        schema_version: 2,
        login_grant: loginGrant,
        expected_email: "jane@example.com",
      });
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
    });
  });

  it("writes a versioned expected-account artifact when reissuing an employee invitation", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const outputPath = join(home, "employee-reissued-onboarding.json");
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          expect(path).toBe("/v1/person/employees");
          expect(init?.method).toBe("PUT");
          expect(JSON.parse(String(init?.body))).toEqual({
            email: "jane@example.com",
          });
          return json(
            {
              login_grant: "G".repeat(43),
              expires_at: "2026-08-18T00:15:00.000Z",
            },
            201,
          );
        },
      });
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });

      await client.reissueEmployee({
        email: "jane@example.com",
        output_path: outputPath,
      });

      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
        schema_version: 2,
        expected_email: "jane@example.com",
      });
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
    });
  });

  it("keeps legacy durable employee identities usable without emitting an expected-email artifact", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const outputPath = join(home, "legacy-employee-reissued-onboarding.json");
      const observed: Array<{ path: string; method: string; body?: unknown }> = [];
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          observed.push({
            path,
            method: init?.method ?? "GET",
            ...(init?.body === undefined
              ? {}
              : { body: JSON.parse(String(init.body)) }),
          });
          if (init?.method === "GET") {
            return json({
              schema_version: 1,
              kind: "echo-clean-person-employee-roster-v1",
              employees: [
                {
                  email: "alice@localhost",
                  display_name: "Alice Legacy",
                  membership_status: "active",
                  invitation_state: "pending",
                },
              ],
            });
          }
          if (init?.method === "PUT") {
            return json({
              login_grant: "G".repeat(43),
              expires_at: "2026-08-18T00:15:00.000Z",
            }, 201);
          }
          return new Response(null, { status: 204 });
        },
      });
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });

      await expect(client.employees()).resolves.toMatchObject({
        employees: [expect.objectContaining({ email: "alice@localhost" })],
      });
      await client.reissueEmployee({
        email: "alice@localhost",
        output_path: outputPath,
      });
      await expect(client.revokeEmployee("alice@localhost")).resolves.toBeUndefined();
      await expect(
        client.inviteEmployee({
          name: "Alice Legacy",
          email: "alice@localhost",
          output_path: join(home, "strict-new-invite.json"),
        }),
      ).rejects.toThrow(/canonical lowercase mailbox/);

      expect(observed).toEqual([
        { path: "/v1/person/employees", method: "GET" },
        {
          path: "/v1/person/employees",
          method: "PUT",
          body: { email: "alice@localhost" },
        },
        {
          path: "/v1/person/employees",
          method: "DELETE",
          body: { email: "alice@localhost" },
        },
      ]);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
        schema_version: 1,
        kind: "echo-person-onboarding-invitation",
        authority_url: "https://authority.example",
        login_grant: "G".repeat(43),
        expires_at: "2026-08-18T00:15:00.000Z",
      });
    });
  });

  it("renders the owner employee roster without local database access or lifecycle identifiers", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => "2026-08-18T00:00:00.000Z",
        fetch: async () => json({ authority_descriptor: authority }),
      });
      await client.installSession("https://authority.example", {
        ...SESSION,
        membership_type: "owner",
      });
      const { code: status, stdout } = await runCli(["employee", "list"], {
        home_directory: home,
        now: () => "2026-08-18T00:00:00.000Z",
        fetch: async (input, init) => {
          expect(new URL(String(input)).pathname).toBe("/v1/person/employees");
          expect(init?.method).toBe("GET");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${SESSION.access_token}`,
          );
          return json({
            schema_version: 1,
            kind: "echo-clean-person-employee-roster-v1",
            employees: [
              {
                email: "jane@example.com",
                display_name: "Jane Doe",
                membership_status: "active",
                invitation_state: "pending",
              },
            ],
          });
        },
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        result: {
          schema_version: 1,
          kind: "echo-clean-person-employee-roster-v1",
          employees: [
            {
              email: "jane@example.com",
              display_name: "Jane Doe",
              membership_status: "active",
              invitation_state: "pending",
            },
          ],
        },
      });
      expect(stdout).not.toContain("mem_");
      expect(stdout).not.toContain("prn_");
    });
  });

  it("preflights an existing employee invitation output before remote issuance", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let mutations = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          mutations += 1;
          throw new Error("remote mutation must not run");
        },
      });
      await client.installSession("https://authority.example", {
        ...SESSION,
        membership_type: "owner",
      });
      const output = join(home, "already-exists.json");
      writeFileSync(output, "reserved\n", { mode: 0o600 });
      await expect(
        client.inviteEmployee({ name: "Jane Doe", email: "jane@example.com", output_path: output }),
      ).rejects.toMatchObject({
        code: "invitation_output_invalid",
        mutation_outcome: "not_submitted",
      } satisfies Partial<EmployeeMutationError>);
      expect(mutations).toBe(0);
    });
  });

  it("preflights a non-private employee invitation parent before remote issuance", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let mutations = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          mutations += 1;
          throw new Error("remote mutation must not run");
        },
      });
      await client.installSession("https://authority.example", {
        ...SESSION,
        membership_type: "owner",
      });
      chmodSync(home, 0o755);
      try {
      await expect(
        client.reissueEmployee({ email: "jane@example.com", output_path: join(home, "invite.json") }),
      ).rejects.toMatchObject({
        code: "invitation_output_invalid",
        mutation_outcome: "not_submitted",
      } satisfies Partial<EmployeeMutationError>);
      } finally {
        chmodSync(home, 0o700);
      }
      expect(mutations).toBe(0);
    });
  });

  it("leaves no employee invitation artifact when remote issuance fails", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const output = join(home, "invite.json");
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          throw new Error("network failed");
        },
      });
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });
      await expect(
        client.inviteEmployee({ name: "Jane Doe", email: "jane@example.com", output_path: output }),
      ).rejects.toMatchObject({
        code: "outcome_unknown",
        mutation_outcome: "unknown",
      } satisfies Partial<EmployeeMutationError>);
      expect(existsSync(output)).toBe(false);
    });
  });

  it("explains that a bound employee signs in without reissuing an invitation", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const output = join(home, "invite.json");
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          return json(
            { error: { code: "conflict", message: "request failed" } },
            409,
          );
        },
      });
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });
      await expect(
        client.reissueEmployee({
          email: "jane@example.com",
          output_path: output,
        }),
      ).rejects.toMatchObject({
        code: "employee_onboarding_complete",
        mutation_outcome: "rejected",
      } satisfies Partial<EmployeeMutationError>);
      expect(existsSync(output)).toBe(false);
    });
  });

  it("preserves a local output that wins the post-preflight race", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const output = join(home, "invite.json");
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          writeFileSync(output, "created by another local writer\n", { mode: 0o600 });
          return json({ login_grant: "G".repeat(43), expires_at: "2026-08-18T00:15:00.000Z" }, 201);
        },
      });
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });
      await expect(
        client.inviteEmployee({ name: "Jane Doe", email: "jane@example.com", output_path: output }),
      ).rejects.toMatchObject({
        code: "invitation_save_failed",
        mutation_outcome: "committed",
      } satisfies Partial<EmployeeMutationError>);
      expect(readFileSync(output, "utf8")).toBe("created by another local writer\n");
    });
  });

  it("marks local employee authorization failures as not submitted", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let mutations = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          mutations += 1;
          throw new Error("employee write must not run");
        },
      });
      await client.installSession("https://authority.example", ROTATED_SESSION);

      await expect(
        client.inviteEmployee({
          name: "Jane Doe",
          email: "jane@example.com",
          output_path: join(home, "employee-invitation.json"),
        }),
      ).rejects.toMatchObject({
        code: "owner_access_required",
        mutation_outcome: "not_submitted",
      } satisfies Partial<EmployeeMutationError>);
      expect(mutations).toBe(0);
    });
  });

  it("marks Authority authorization rejection after an employee write as rejected", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let employeeWrites = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          employeeWrites += 1;
          return json({ error: { code: "unauthorized", message: "request failed" } }, 401);
        },
      });
      await client.installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });

      await expect(
        client.inviteEmployee({
          name: "Jane Doe",
          email: "jane@example.com",
          output_path: join(home, "employee-invitation.json"),
        }),
      ).rejects.toMatchObject({
        code: "owner_access_required",
        mutation_outcome: "rejected",
      } satisfies Partial<EmployeeMutationError>);
      expect(employeeWrites).toBe(1);
    });
  });

  it.each([401, 409])(
    "treats a malformed %i employee-write error as an unknown outcome",
    async (statusCode) => {
      await withHome(async (home) => {
        const authority = authorityDescriptor();
        const client = new PersonClient({
          home_directory: home,
          now: () => NOW,
          fetch: async (input) => {
            if (new URL(String(input)).pathname === "/v1/authority-descriptor") {
              return json({ authority_descriptor: authority });
            }
            return json({ unexpected: "error shape" }, statusCode);
          },
        });
        await client.installSession("https://authority.example", {
          ...ROTATED_SESSION,
          membership_type: "owner",
        });

        await expect(
          client.inviteEmployee({
            name: "Jane Doe",
            email: "jane@example.com",
            output_path: join(home, `employee-invitation-${statusCode}.json`),
          }),
        ).rejects.toMatchObject({
          code: "outcome_unknown",
          mutation_outcome: "unknown",
        } satisfies Partial<EmployeeMutationError>);
      });
    },
  );

  it("reports a duplicate employee as a typed rejected CLI mutation", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", {
        ...ROTATED_SESSION,
        membership_type: "owner",
      });
      let stderr = "";
      const outputPath = join(home, "employee-invitation.json");
      const status = await runPersonClientCli(
        [
          "employee",
          "invite",
          "--name",
          "Jane Doe",
          "--email",
          "jane@example.com",
          "--out",
          outputPath,
        ],
        {
          stderr: { write: (value) => ((stderr += String(value)), true) },
          stdout: { write: () => true },
          home_directory: home,
          now: () => NOW,
          fetch: async (input) => {
            expect(new URL(String(input)).pathname).toBe("/v1/person/employees");
            return json({ error: { code: "conflict", message: "request failed" } }, 409);
          },
        },
      );

      expect(status).toBe(1);
      expect(existsSync(outputPath)).toBe(false);
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        action: "employee-invite",
        code: "employee_already_exists",
        mutation_outcome: "rejected",
        error: "Person Authority rejected the request",
      });
    });
  });

  it("completes invitation login through a one-use loopback browser handoff", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      const loginGrant = "G".repeat(43);
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: loginGrant,
          expires_at: "2026-08-18T00:15:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      const { code: status, stdout } = await runCli(
        ["login", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v2/session/oidc/begin") {
              const begunRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
              expect(begunRequest).toMatchObject({
                kind: "identity_bootstrap",
                login_grant: loginGrant,
              });
              const handoff = begunRequest.loopback_handoff as Record<string, unknown>;
              expect(handoff.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/[A-Za-z0-9_-]{43}$/);
              expect(handoff.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url as string, {
                  method: "POST",
                  headers: {
                    "content-type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({
                    token: handoff.token as string,
                    session: Buffer.from(canonicalJson(SESSION as never), "utf8").toString("base64url"),
                  }),
                });
              });
              return json(
                {
                  authorization_url:
                    "https://identity.example/authorize?state=state",
                  expires_at: "2026-08-18T00:10:00.000Z",
                },
                201,
              );
            }
            expect(path).toBe("/v1/authority-descriptor");
            return json({ authority_descriptor: authority });
          },
        },
      );

      expect(status).toBe(0);
      const lines = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        phase: "open-browser",
        authorization_url: "https://identity.example/authorize?state=state",
      });
      expect(lines[1]).toMatchObject({ phase: "installed", ok: true });
      expect(lines[0].instruction).toBe(
        "Open authorization_url to complete sign-in in your browser.",
      );
      expect(stdout).not.toContain(loginGrant);
      expect(stdout).not.toContain(SESSION.access_token);
      expect(stdout).not.toContain(SESSION.refresh_token);
    });
  });

  it("keeps an invitation account private while preserving a manual-browser fallback", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      const expectedEmail = "founder+private@example.com";
      const loginGrant = "G".repeat(43);
      const hintedAuthorizationUrl = `https://identity.example/authorize?state=state&login_hint=${encodeURIComponent(expectedEmail)}&prompt=select_account`;
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 2,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: loginGrant,
          expires_at: "2026-08-18T00:15:00.000Z",
          expected_email: expectedEmail,
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      const opened: string[] = [];
      const { code: status, stdout } = await runCli(
        ["start", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: (url) => {
            opened.push(url);
            return false;
          },
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v2/session/oidc/begin") {
              const request = JSON.parse(String(init?.body)) as Record<
                string,
                unknown
              >;
              expect(request.login_hint).toBe(expectedEmail);
              const handoff = request.loopback_handoff as Record<
                string,
                string
              >;
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({
                    token: handoff.token,
                    session: Buffer.from(
                      canonicalJson(ROTATED_SESSION as never),
                      "utf8",
                    ).toString("base64url"),
                  }),
                });
              });
              return json(
                {
                  authorization_url: hintedAuthorizationUrl,
                  expires_at: "2026-08-18T00:10:00.000Z",
                },
                201,
              );
            }
            if (path === "/v1/authority-descriptor") {
              return json({ authority_descriptor: authority });
            }
            expect(path).toBe("/v1/person/records");
            return json({
              schema_version: 1,
              kind: "echo-clean-person-record-list-v1",
              records: [],
            });
          },
        },
      );

      expect(status).toBe(0);
      // The directly opened URL remains hinted, but the manual fallback never
      // writes private invitation metadata to stdout.
      expect(opened).toEqual([hintedAuthorizationUrl]);
      const lines = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines[0]).toMatchObject({
        phase: "open-browser",
        authorization_url:
          "https://identity.example/authorize?state=state&prompt=select_account",
        browser_opened: false,
        instruction:
          "Sign in with the account named in the private invitation. Open authorization_url to complete sign-in in your browser.",
      });
      expect(lines[0]).not.toHaveProperty("expected_account");
      expect(stdout).not.toContain(expectedEmail);
      expect(stdout).not.toContain(encodeURIComponent(expectedEmail));
      expect(stdout).not.toContain("login_hint");
    });
  });

  it("does not leak a private invitation account after a wrong-account sign-in", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      const expectedEmail = "founder+private@example.com";
      const hintedAuthorizationUrl = `https://identity.example/authorize?state=state&login_hint=${encodeURIComponent(expectedEmail)}`;
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 2,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: "G".repeat(43),
          expires_at: "2026-08-18T00:15:00.000Z",
          expected_email: expectedEmail,
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const opened: string[] = [];
      const { code: status, stdout, stderr } = await runCli(
        ["start", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: (url) => {
            opened.push(url);
            return true;
          },
          fetch: async (input, init) => {
            expect(new URL(String(input)).pathname).toBe("/v2/session/oidc/begin");
            const request = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            expect(request.login_hint).toBe(expectedEmail);
            const handoff = request.loopback_handoff as Record<string, string>;
            queueMicrotask(() => {
              void globalThis.fetch(handoff.url, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  token: handoff.token,
                  error: "retryable",
                }),
              });
            });
            return json(
              {
                authorization_url: hintedAuthorizationUrl,
                expires_at: "2026-08-18T00:10:00.000Z",
              },
              201,
            );
          },
        },
      );

      expect(status).toBe(1);
      expect(opened).toEqual([hintedAuthorizationUrl]);
      const openBrowserReceipt = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(openBrowserReceipt).not.toHaveProperty("authorization_url");
      expect(stdout).not.toContain("https://identity.example/authorize");
      expect(stdout).not.toContain("state=state");
      for (const output of [stdout, stderr]) {
        expect(output).not.toContain(expectedEmail);
        expect(output).not.toContain(encodeURIComponent(expectedEmail));
        expect(output).not.toContain("login_hint");
        expect(output).not.toContain(
          "echo-organization-authority-person-admin",
        );
      }
      expect(stderr).toContain("invitation remains usable");
      expect(stderr).toContain("account named in the private invitation");
    });
  });

  it("lets the Authority distinguish expired unused invitations from existing identities", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "expired-person-onboarding.json");
      const loginGrant = "G".repeat(43);
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: loginGrant,
          expires_at: "2026-08-18T00:01:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);

      for (const argv of [
        ["login", "--invitation", invitationPath],
        ["start", "--invitation", invitationPath],
      ]) {
        let browserOpened = false;
        let authorityRequests = 0;
        const begins: Record<string, unknown>[] = [];
        const { code: status, stdout, stderr } = await runCli(argv, {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => {
            browserOpened = true;
            return true;
          },
          fetch: async (input, init) => {
            expect(new URL(String(input)).pathname).toBe("/v2/session/oidc/begin");
            authorityRequests += 1;
            begins.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return json({ error: { code: "unauthorized", message: "request failed" } }, 401);
          },
        });

        expect(status).toBe(1);
        expect(stdout).toBe("");
        expect(browserOpened).toBe(false);
        expect(authorityRequests).toBe(2);
        expect(begins[0]).toMatchObject({
          kind: "identity_bootstrap",
          login_grant: loginGrant,
        });
        expect(begins[1]).toMatchObject({ kind: "existing_identity_login" });
        expect(begins[1]).not.toHaveProperty("login_grant");
        expect(JSON.parse(stderr)).toMatchObject({
          ok: false,
          action: argv[0],
          error: expect.stringContaining("no existing ECHO identity was found"),
        });
        expect(stderr).toContain("reissue");
        expect(stderr).not.toContain(loginGrant);
      }
    });
  });

  it("lets the Authority accept an invitation despite modest client clock skew", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      const loginGrant = "G".repeat(43);
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: loginGrant,
          expires_at: "2026-08-18T00:01:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      const opened: string[] = [];
      const paths: string[] = [];
      const { code: status, stdout, stderr } = await runCli(
        ["start", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: (url) => {
            opened.push(url);
            return true;
          },
          fetch: async (input, init) => {
            const url = new URL(String(input));
            paths.push(`${url.pathname}${url.search}`);
            if (url.pathname === "/v2/session/oidc/begin") {
              const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
              expect(request).toMatchObject({
                kind: "identity_bootstrap",
                login_grant: loginGrant,
              });
              const handoff = request.loopback_handoff as Record<string, string>;
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url, {
                  method: "POST",
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                    token: handoff.token,
                    session: Buffer.from(
                      canonicalJson(ROTATED_SESSION as never),
                      "utf8",
                    ).toString("base64url"),
                  }),
                });
              });
              return json({
                authorization_url: "https://identity.example/authorize?state=state",
                expires_at: "2026-08-18T00:10:00.000Z",
              }, 201);
            }
            if (url.pathname === "/v1/authority-descriptor") {
              return json({ authority_descriptor: authority });
            }
            expect(url.pathname).toBe("/v1/person/records");
            expect(url.search).toBe("?limit=1");
            return json({
              schema_version: 1,
              kind: "echo-clean-person-record-list-v1",
              records: [],
            });
          },
        },
      );

      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(opened).toEqual([
        "https://identity.example/authorize?state=state",
      ]);
      expect(paths).toContain("/v1/person/records?limit=1");
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({
        ok: true,
        phase: "ready",
        membership_type: "employee",
        connected_authority: "https://authority.example",
        permission_aware_read: "passed",
      });
      expect(stdout).not.toContain(loginGrant);
      expect(stdout).not.toContain(ROTATED_SESSION.access_token);
      expect(stdout).not.toContain(ROTATED_SESSION.refresh_token);
    });
  });

  it("never treats an existing same-organization session as proof that a new invitation was onboarded", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: "G".repeat(43),
          expires_at: "2026-08-18T00:15:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      let networkCalls = 0;
      const { code: status, stdout, stderr } = await runCli(
        ["start", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => {
            throw new Error("browser must not open for an existing session");
          },
          fetch: async () => {
            networkCalls += 1;
            return json(
              { error: { code: "forbidden", message: "request failed" } },
              403,
            );
          },
        },
      );
      expect(status).toBe(1);
      expect(networkCalls).toBe(0);
      expect(stdout).not.toContain('"phase":"ready"');
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        action: "start",
        error: expect.stringContaining("already signed in"),
      });
    });
  });

  it("refuses browser login while this Mac already has a Person session", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      let networkCalls = 0;
      const { code: status, stdout, stderr } = await runCli(
        ["login", "--authority-url", "https://authority.example"],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async () => {
            networkCalls += 1;
            throw new Error("browser login must not start for an existing session");
          },
        },
      );

      expect(status).toBe(1);
      expect(networkCalls).toBe(0);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        action: "login",
        error: expect.stringContaining("already signed in"),
      });
    });
  });

  it("does not report ready when the post-login permission-aware read is denied", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      const loginGrant = "G".repeat(43);
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: loginGrant,
          expires_at: "2026-08-18T00:15:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      const { code: status, stdout, stderr } = await runCli(
        ["start", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => true,
          fetch: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v2/session/oidc/begin") {
              const request = JSON.parse(String(init?.body)) as Record<
                string,
                unknown
              >;
              const handoff = request.loopback_handoff as Record<string, string>;
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({
                    token: handoff.token,
                    session: Buffer.from(
                      canonicalJson(ROTATED_SESSION as never),
                      "utf8",
                    ).toString("base64url"),
                  }),
                });
              });
              return json({
                authorization_url:
                  "https://identity.example/authorize?state=state",
                expires_at: "2026-08-18T00:10:00.000Z",
              }, 201);
            }
            if (url.pathname === "/v1/authority-descriptor") {
              return json({ authority_descriptor: authority });
            }
            expect(url.pathname).toBe("/v1/person/records");
            return json(
              { error: { code: "forbidden", message: "request failed" } },
              403,
            );
          },
        },
      );
      expect(status).toBe(1);
      expect(stdout).not.toContain('"phase":"ready"');
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        action: "start",
      });
    });
  });

  it("retries onboarding after a transient readiness failure without a manual logout", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      const loginGrant = "G".repeat(43);
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: loginGrant,
          expires_at: "2026-08-18T00:15:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      const beginKinds: unknown[] = [];
      let readAttempts = 0;
      let revocationAttempts = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v2/session/oidc/begin") {
          const request = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          beginKinds.push(request.kind);
          if (beginKinds.length === 2) {
            return json(
              { error: { code: "unauthorized", message: "request failed" } },
              401,
            );
          }
          const handoff = request.loopback_handoff as Record<string, string>;
          queueMicrotask(() => {
            void globalThis.fetch(handoff.url, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                token: handoff.token,
                session: Buffer.from(
                  canonicalJson(ROTATED_SESSION as never),
                  "utf8",
                ).toString("base64url"),
              }),
            });
          });
          return json(
            {
              authorization_url:
                "https://identity.example/authorize?state=state",
              expires_at: "2026-08-18T00:10:00.000Z",
            },
            201,
          );
        }
        if (url.pathname === "/v1/authority-descriptor") {
          return json({ authority_descriptor: authority });
        }
        if (url.pathname === "/v1/person/records") {
          readAttempts += 1;
          if (readAttempts === 1) {
            return json(
              { error: { code: "unavailable", message: "request failed" } },
              503,
            );
          }
          return json({
            schema_version: 1,
            kind: "echo-clean-person-record-list-v1",
            records: [],
          });
        }
        expect(url.pathname).toBe("/v2/session/revocations");
        revocationAttempts += 1;
        return json(
          { error: { code: "unavailable", message: "request failed" } },
          503,
        );
      };

      let firstStdout = "";
      let firstStderr = "";
      const firstStatus = await runPersonClientCli(
        ["start", "--invitation", invitationPath],
        {
          stdout: {
            write: (value) => ((firstStdout += String(value)), true),
          },
          stderr: {
            write: (value) => ((firstStderr += String(value)), true),
          },
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => true,
          fetch,
        },
      );

      expect(firstStatus).toBe(1);
      expect(firstStdout).not.toContain('"phase":"ready"');
      expect(JSON.parse(firstStderr)).toMatchObject({
        ok: false,
        action: "start",
      });
      expect(() =>
        new PersonClient({ home_directory: home }).sessionSummary(),
      ).toThrow();

      let retryStdout = "";
      let retryStderr = "";
      const retryStatus = await runPersonClientCli(
        ["start", "--invitation", invitationPath],
        {
          stdout: {
            write: (value) => ((retryStdout += String(value)), true),
          },
          stderr: {
            write: (value) => ((retryStderr += String(value)), true),
          },
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => true,
          fetch,
        },
      );

      expect(retryStatus).toBe(0);
      expect(retryStderr).toBe("");
      expect(retryStdout).toContain('"phase":"ready"');
      expect(beginKinds).toEqual([
        "identity_bootstrap",
        "identity_bootstrap",
        "existing_identity_login",
      ]);
      expect(readAttempts).toBe(2);
      expect(revocationAttempts).toBe(1);
    });
  });

  it("reauthenticates through the same loopback handoff without an invitation", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const { code: status, stdout } = await runCli(
        ["login", "--authority-url", "https://authority.example"],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v2/session/oidc/begin") {
              const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
              expect(request.kind).toBe("existing_identity_login");
              const handoff = request.loopback_handoff as Record<string, string>;
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({
                    token: handoff.token,
                    session: Buffer.from(canonicalJson(SESSION as never), "utf8").toString("base64url"),
                  }),
                });
              });
              return json(
                {
                  authorization_url: "https://identity.example/authorize?state=state",
                  expires_at: "2026-08-18T00:10:00.000Z",
                },
                201,
              );
            }
            expect(path).toBe("/v1/authority-descriptor");
            return json({ authority_descriptor: authority });
          },
        },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('"phase":"installed"');
    });
  });

  it("opens the existing-identity browser handoff only when requested", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const authorizationUrl = "https://identity.example/authorize?state=state";
      const opened: string[] = [];
      const { code: status, stdout, stderr } = await runCli(
        ["login", "--authority-url", "https://authority.example", "--open-browser"],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: (url) => {
            opened.push(url);
            return true;
          },
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v2/session/oidc/begin") {
              const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
              expect(request.kind).toBe("existing_identity_login");
              const handoff = request.loopback_handoff as Record<string, string>;
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url, {
                  method: "POST",
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                    token: handoff.token,
                    session: Buffer.from(canonicalJson(ROTATED_SESSION as never), "utf8").toString("base64url"),
                  }),
                });
              });
              return json({ authorization_url: authorizationUrl, expires_at: "2026-08-18T00:10:00.000Z" }, 201);
            }
            expect(path).toBe("/v1/authority-descriptor");
            return json({ authority_descriptor: authority });
          },
        },
      );

      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(opened).toEqual([authorizationUrl]);
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ ok: true, phase: "open-browser", browser_opened: true });
      expect(lines[0]).not.toHaveProperty("authorization_url");
      expect(lines[1]).toMatchObject({ ok: true, phase: "installed" });
      expect(stdout).not.toContain(authorizationUrl);
      expect(stdout).not.toContain(ROTATED_SESSION.access_token);
      expect(stdout).not.toContain(ROTATED_SESSION.refresh_token);
      expect(new PersonClient({ home_directory: home }).sessionSummary()).toMatchObject({
        membership_type: "employee",
      });
    });
  });

  it("fails a requested browser launch without installing a Person session", async () => {
    await withHome(async (home) => {
      const authorizationUrl = "https://identity.example/authorize?state=state";
      const opened: string[] = [];
      const { code: status, stdout, stderr } = await runCli(
        ["login", "--authority-url", "https://authority.example", "--open-browser"],
        {
          home_directory: home,
          now: () => NOW,
          open_authorization_url: (url) => {
            opened.push(url);
            return false;
          },
          fetch: async (input) => {
            expect(new URL(String(input)).pathname).toBe("/v2/session/oidc/begin");
            return json({ authorization_url: authorizationUrl, expires_at: "2026-08-18T00:10:00.000Z" }, 201);
          },
        },
      );

      expect(status).toBe(1);
      expect(opened).toEqual([authorizationUrl]);
      expect(stdout).toBe("");
      expect(stderr).toContain("Person browser could not be opened");
      expect(stderr).not.toContain(authorizationUrl);
      expect(() => new PersonClient({ home_directory: home }).sessionSummary()).toThrow();
    });
  });

  it("recovers an expired consumed invitation through existing-identity login", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "person-onboarding.json");
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: "G".repeat(43),
          expires_at: "2026-08-18T00:01:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const authority = authorityDescriptor();
      const begins: Record<string, unknown>[] = [];
      const { code: status, stdout } = await runCli(
        ["login", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v2/session/oidc/begin") {
              const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
              begins.push(request);
              if (begins.length === 1) {
                return json({ error: { code: "unauthorized", message: "request failed" } }, 401);
              }
              expect(request.kind).toBe("existing_identity_login");
              expect(request).not.toHaveProperty("login_grant");
              const handoff = request.loopback_handoff as Record<string, string>;
              queueMicrotask(() => {
                void globalThis.fetch(handoff.url, {
                  method: "POST",
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                    token: handoff.token,
                    session: Buffer.from(canonicalJson(SESSION as never), "utf8").toString("base64url"),
                  }),
                });
              });
              return json({
                authorization_url: "https://identity.example/authorize?state=state",
                expires_at: "2026-08-18T00:10:00.000Z",
              }, 201);
            }
            return json({ authority_descriptor: authority });
          },
        },
      );
      expect(status).toBe(0);
      expect(begins).toHaveLength(2);
      expect(stdout).toContain(
        "An existing ECHO identity was found.",
      );
      expect(stdout).toContain('"phase":"installed"');
    });
  });

  it("promptly asks for invitation reissue when recovery finds no bound identity", async () => {
    await withHome(async (home) => {
      const invitationPath = join(home, "expired-person-onboarding.json");
      writeFileSync(
        invitationPath,
        `${canonicalJson({
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: "G".repeat(43),
          expires_at: "2026-08-18T00:01:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(invitationPath, 0o600);
      const begins: Record<string, unknown>[] = [];
      const { code: status, stdout, stderr } = await runCli(
        ["login", "--invitation", invitationPath],
        {
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            if (new URL(String(input)).pathname !== "/v2/session/oidc/begin") {
              throw new Error("unexpected Authority request");
            }
            const request = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            begins.push(request);
            if (begins.length === 1) {
              return json(
                { error: { code: "unauthorized", message: "request failed" } },
                401,
              );
            }
            const handoff = request.loopback_handoff as Record<string, string>;
            queueMicrotask(() => {
              void globalThis.fetch(handoff.url, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  token: handoff.token,
                  error: "identity_not_bound",
                }),
              });
            });
            return json(
              {
                authorization_url:
                  "https://identity.example/authorize?state=state",
                expires_at: "2026-08-18T00:10:00.000Z",
              },
              201,
            );
          },
        },
      );

      expect(status).toBe(1);
      expect(begins.map((request) => request.kind)).toEqual([
        "identity_bootstrap",
        "existing_identity_login",
      ]);
      expect(stdout).toContain('"phase":"open-browser"');
      expect(stdout).not.toContain('"phase":"installed"');
      expect(stderr).toContain("no active ECHO identity");
      expect(stderr).toContain("Select the invited Google account");
      expect(stderr).toContain("reissue the invitation");
    });
  });

  it("links Slack in one command without asking for opaque challenge handles", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const challengeCode = "A".repeat(43);
      const challengeAttemptId = fixtureId("cat", 7);
      const challengeMessageTs = "1755518400.000001";
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      const { code: linked, stdout, stderr } = await runCli(["slack-link", "--slack-user", "U123PERSON"], {
        home_directory: home,
        now: () => NOW,
        random_bytes: () => Buffer.from(challengeCode, "base64url"),
        random_uuid: () => "00000000-0000-4000-8000-000000000008",
        read_input: () => "\n",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v2/integration-links/slack/challenges")
            return json(
              {
                schema_version: 2,
                kind: "echo-organization-person-slack-link-begin-response",
                challenge_attempt_id: challengeAttemptId,
                provider: "slack",
                provider_tenant_id: "T123ABC",
                channel_id: "D123ABC",
                challenge_message_ts: challengeMessageTs,
                expires_at: "2026-08-18T00:17:00.000Z",
              },
              201,
            );
          if (path === "/v2/integration-links/slack/completions") {
            expect(JSON.parse(String(init?.body))).toMatchObject({
              challenge_code: challengeCode,
              challenge_attempt_id: challengeAttemptId,
              challenge_message_ts: challengeMessageTs,
            });
            return json({
              schema_version: 2,
              kind: "echo-organization-person-slack-link-result",
              identity_link_id: fixtureId("clm", 7),
              connection_id: fixtureId("con", 7),
              organization_id: SESSION.organization_id,
              principal_id: SESSION.principal_id,
              membership_id: SESSION.membership_id,
              provider: "slack",
              provider_tenant_id: "T123ABC",
              provider_subject_id: "U123PERSON",
              channel_id: "D123ABC",
              linked_at: NOW,
              identity_link_created: true,
            });
          }
          throw new Error(`unexpected request ${path}`);
        },
      });
      expect(linked, stderr).toBe(0);
      expect(stdout).toContain('"phase":"reply-in-slack"');
      expect(stdout).toContain('"phase":"linked"');
      expect(stdout).not.toContain(challengeAttemptId);
      expect(stdout).not.toContain(challengeMessageTs);
    });
  });

  it("lists only the signed-in Person's exclusions for one exact source", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const fetchImpl: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/authority-descriptor") {
          return json({ authority_descriptor: authority });
        }
        expect(path).toBe("/v2/member-exclusions/list");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ROTATED_SESSION.access_token}`,
        );
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        expect(request).toMatchObject({
          subject_principal_id: SESSION.principal_id,
          source_adapter_id: "granola",
          source_instance_id: "test-meeting-source",
        });
        expect(request).not.toHaveProperty("target_principal_id");
        expect(request).not.toHaveProperty("target_membership_id");
        return json({
          schema_version: 2,
          kind: "echo-organization-member-exclusion-list-response",
          authority_id: authority.authority_id,
          organization_id: SESSION.organization_id,
          subject_principal_id: SESSION.principal_id,
          membership_id: SESSION.membership_id,
          source_adapter_id: "granola",
          source_instance_id: "test-meeting-source",
          exclusions: [
            {
              scope: "source",
              source_adapter_id: "granola",
              source_instance_id: "test-meeting-source",
            },
          ],
        });
      };
      const client = new PersonClient({
        home_directory: home,
        fetch: fetchImpl,
        now: () => NOW,
        random_uuid: () => "00000000-0000-4000-8000-000000000112",
      });

      await client.installSession("https://authority.example", ROTATED_SESSION);
      await expect(
        client.meetingIngestionExclusions("granola", "test-meeting-source"),
      ).resolves.toMatchObject({
        subject_principal_id: SESSION.principal_id,
        exclusions: [{ scope: "source" }],
      });
    });
  });

  function refreshingClient(home: string, reply: () => Response) {
    const authority = authorityDescriptor();
    const calls = { refresh: 0 };
    const client = new PersonClient({
      home_directory: home,
      now: () => NOW,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/authority-descriptor") {
          return json({ authority_descriptor: authority });
        }
        expect(path).toBe("/v2/session/refresh");
        calls.refresh += 1;
        return reply();
      },
    });
    return { client, calls };
  }

  // What undici rejects with: the socket error, carrying the step that failed.
  const failed = (code: string, syscall: string) =>
    Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
  const unreachable = (code: string, syscall = "connect") => (): Response => {
    throw new TypeError("fetch failed", { cause: failed(code, syscall) });
  };

  it.each([
    ["the name cannot be looked up", unreachable("ENOTFOUND", "getaddrinfo")],
    ["the connection is refused", unreachable("ECONNREFUSED")],
    ["every address is unreachable", (): Response => {
      throw new TypeError("fetch failed", { cause: Object.assign(new AggregateError([
        failed("EHOSTUNREACH", "connect"),
        failed("ENETUNREACH", "connect"),
      ]), { code: "EHOSTUNREACH" }) });
    }],
  ])("keeps the session when %s, and refreshes again on the next call", async (_, reply) => {
    await withHome(async (home) => {
      const { client, calls } = refreshingClient(home, reply);
      await client.installSession("https://authority.example", SESSION);

      await expect(client.records()).rejects.toThrow(/request failed/);
      expect(client.sessionSummary().membership_id).toBe(SESSION.membership_id);
      await expect(client.records()).rejects.toThrow(/request failed/);
      expect(calls.refresh).toBe(2);
      const store = new PersonSessionStore(home);
      expect([store.paths.refresh_claim, store.paths.refreshing].filter(existsSync)).toEqual([]);
    });
  });

  it.each([
    ["an ambiguous transport failure", (): Response => { throw new Error("connection outcome is unknown"); }],
    ["a reset after sending", unreachable("ECONNRESET", "read")],
    ["a lost route on a connected socket", unreachable("EHOSTUNREACH", "read")],
    ["a refused write after connecting", unreachable("EADDRNOTAVAIL", "write")],
    ["one of several addresses failing after connecting", (): Response => {
      throw new TypeError("fetch failed", { cause: Object.assign(new AggregateError([
        failed("ECONNREFUSED", "connect"),
        failed("EHOSTUNREACH", "read"),
      ]), { code: "ECONNREFUSED" }) });
    }],
    ["a server failure", () => json({ error: { code: "unavailable", message: "unavailable" } }, 503)],
    ["an unreadable reply", () => json({ ...ROTATED_SESSION, access_token: "short" })],
  ])("never replays a refresh credential after %s, and signs out cleanly", async (_, reply) => {
    await withHome(async (home) => {
      const { client, calls } = refreshingClient(home, reply);
      await client.installSession("https://authority.example", SESSION);

      await expect(client.records()).rejects.toThrow(/Person Authority/);
      await expect(client.records()).rejects.toThrow(/sign in again|Person session/);
      expect(calls.refresh).toBe(1);
      const store = new PersonSessionStore(home);
      expect([store.paths.live, store.paths.refresh_claim, store.paths.refreshing].filter(existsSync)).toEqual([]);
    });
  });

  it.each([
    ["refuses the refresh", () => json({ error: { code: "unauthorized", message: "person authentication failed" } }, 401)],
    ["rotates another identity", () => json({ ...ROTATED_SESSION, membership_id: fixtureId("mem", 2) })],
  ])("signs out cleanly when the Authority %s", async (_, reply) => {
    await withHome(async (home) => {
      const { client, calls } = refreshingClient(home, reply);
      await client.installSession("https://authority.example", SESSION);

      await expect(client.records()).rejects.toThrow(/sign in again/);
      await expect(client.records()).rejects.toThrow(/sign in again/);
      expect(calls.refresh).toBe(1);
      const store = new PersonSessionStore(home);
      expect([store.paths.live, store.paths.refresh_claim, store.paths.refreshing].filter(existsSync)).toEqual([]);
    });
  });
});

describe("Person client status recovery", () => {
  it("reports signed-out status for a session written by an older release", async () => {
    await withHome(async (home) => {
      const store = new PersonSessionStore(home);
      mkdirSync(store.paths.directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        store.paths.live,
        `${JSON.stringify({
          schema_version: 1,
          kind: "echo-person-client-session",
          authority_origin: "https://authority.example",
          authority_id: ORGANIZATION_IDS.authority,
          session: SESSION,
          legacy_device_id: "dev_1",
        })}\n`,
        { mode: 0o600 },
      );

      const result = await runCli(["status"], {
        home_directory: home,
        fetch: async () => {
          throw new Error("status must not contact the Authority");
        },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        signed_in: false,
        display_name: null,
        connected_authority: null,
      });
    });
  });
});


describe('Person updates CLI', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const contextId = `ctx_${'a'.repeat(64)}`;
  const receipt = { schema_version: 2, kind: 'echo-person-update-receipt-v2', request_id: requestId, context_id: contextId, project_id: null, audience: { kind: 'only_me' }, received_at: NOW, state: 'received' };
  it('uploads only the explicit bounded file, preserves receipts/status, and refreshes the existing session', async () => {
    await withHome(async home => {
      await new PersonClient({ home_directory: home, now: () => NOW, fetch: async () => json({ authority_descriptor: authorityDescriptor() }) }).installSession('https://authority.example', SESSION);
      const file = join(home, 'update.txt'); writeFileSync(file, 'We agreed to ship.\n');
      const calls: string[] = []; let output = ''; let errors = '';
      const network: typeof fetch = async (url, init) => {
        const path = new URL(String(url)).pathname; calls.push(`${init?.method} ${path}`);
        if (path === '/v2/session/refresh') return json(ROTATED_SESSION);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ROTATED_SESSION.access_token}`);
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toEqual({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId, title: 'Release', text: 'We agreed to ship.\n', project_id: null, audience: { kind: 'only_me' } });
          return json(receipt, 202);
        }
        return json({ schema_version: 2, kind: 'echo-person-update-status-v2', request_id: requestId, context_id: contextId, project_id: null, audience: { kind: 'only_me' }, received_at: NOW, status: 'stored', metadata: 'pending' });
      };
      const deps = { home_directory: home, now: () => NOW, fetch: network, stdout: { write: (value: string) => { output += value; } }, stderr: { write: (value: string) => { errors += value; } } };
      expect(await runPersonClientCli(['updates', 'submit', '--request-id', requestId, '--title', 'Release', '--file', file], deps)).toBe(0);
      expect(JSON.parse(output)).toEqual(receipt); output = '';
      expect(await runPersonClientCli(['updates', 'status', '--request-id', requestId], deps)).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ status: 'stored', metadata: 'pending' });
      expect(calls).toEqual(['POST /v2/session/refresh', 'POST /v2/person/updates', `GET /v2/person/updates/${requestId}`]);
      expect(errors).toBe('');
    });
  });
  it.each(['lost', 'malformed', 'conflict'] as const)('handles %s without a mutation retry or payload leakage', async mode => {
    await withHome(async home => {
      await new PersonClient({ home_directory: home, now: () => NOW, fetch: async () => json({ authority_descriptor: authorityDescriptor() }) }).installSession('https://authority.example', ROTATED_SESSION);
      const file = join(home, 'update.txt'); writeFileSync(file, 'private submitted content'); let errors = '';
      const network = vi.fn<typeof fetch>(async () => { if (mode === 'lost') throw new Error('private transport data'); if (mode === 'malformed') return json({ ...receipt, text: 'private response content' }, 202); return json({ error: { code: 'conflict', message: 'private error content' } }, 409); });
      expect(await runPersonClientCli(['updates', 'submit', '--request-id', requestId, '--title', 'Release', '--file', file], { home_directory: home, now: () => NOW, fetch: network, stdout: { write: () => {} }, stderr: { write: value => { errors += value; } } })).toBe(1);
      expect(network).toHaveBeenCalledTimes(1);
      expect(errors).not.toContain('private');
      if (mode === 'conflict') expect(JSON.parse(errors)).toMatchObject({ code: 'conflict', status: 409 });
      else { expect(errors).toContain('outcome is unknown'); expect(errors).toContain('same request ID'); }
    });
  });
  it.each([Buffer.alloc(8193, 'x'), Buffer.from([0xc3, 0x28]), Buffer.from('text\0nul')])('refuses invalid input files before any network request', async bytes => {
    await withHome(async home => {
      const file = join(home, 'update.txt'); writeFileSync(file, bytes); const network = vi.fn();
      expect(await runPersonClientCli(['updates', 'submit', '--request-id', requestId, '--title', 'Release', '--file', file], { home_directory: home, fetch: network, stdout: { write: () => {} }, stderr: { write: () => {} } })).toBe(1);
      expect(network).not.toHaveBeenCalled();
    });
  });
  it('requires a request ID and explains organizational custody in help', async () => {
    let help = ''; const network = vi.fn();
    expect(await runPersonClientCli(['updates', 'submit', '--help'], { fetch: network, stdout: { write: value => { help += value; } } })).toBe(0);
    expect(help).toContain('Saves this UTF-8 file'); expect(help).toContain('Team makes it readable'); expect(help).toContain('same ID');
    expect(await runPersonClientCli(['updates', 'submit', '--title', 'Release', '--file', '/unused'], { fetch: network, stderr: { write: () => {} } })).toBe(2);
    expect(network).not.toHaveBeenCalled();
  });
  it('uses an explicit Team selection and reads/searches only validated upload responses', async () => {
    await withHome(async home => {
      await new PersonClient({ home_directory: home, now: () => NOW, fetch: async () => json({ authority_descriptor: authorityDescriptor() }) }).installSession('https://authority.example', ROTATED_SESSION);
      const file = join(home, 'memo.md'); writeFileSync(file, 'Client prefers a morning call.'); let output = ''; let errors = '';
      const calls: string[] = [];
      const network: typeof fetch = async (url, init) => {
        const path = new URL(String(url)).pathname; calls.push(path);
        if (path.endsWith('/search')) {
          expect(JSON.parse(String(init?.body))).toEqual({ query: 'client', limit: 3 });
          return json({ schema_version: 2, kind: 'echo-person-upload-search-v2', results: [{ context_id: contextId, received_at: NOW, audience: { kind: 'team' }, title: 'Memo', excerpt: 'Client prefers a morning call.' }] });
        }
        if (path.includes('/content/')) return json({ schema_version: 2, kind: 'echo-person-upload-content-v2', context_id: contextId, received_at: NOW, audience: { kind: 'team' }, title: 'Memo', text: 'Client prefers a morning call.' });
        expect(JSON.parse(String(init?.body)).audience).toEqual({ kind: 'team' });
        return json({ ...receipt, audience: { kind: 'team' } }, 202);
      };
      const dependencies = { home_directory: home, now: () => NOW, fetch: network, stdout: { write: (value: string) => { output += value; } }, stderr: { write: (value: string) => { errors += value; } } };
      expect(await runPersonClientCli(['updates', 'submit', '--request-id', requestId, '--title', 'Memo', '--file', file, '--visibility', 'team'], dependencies), errors).toBe(0); output = '';
      expect(await runPersonClientCli(['updates', 'search', '--query', 'client', '--limit', '3'], dependencies), errors).toBe(0);
      expect(JSON.parse(output).results[0].context_id).toBe(contextId); output = '';
      expect(await runPersonClientCli(['updates', 'read', '--context-id', contextId], dependencies), errors).toBe(0);
      expect(JSON.parse(output).text).toBe('Client prefers a morning call.');
      expect(calls).toEqual(['/v2/person/updates', '/v2/person/updates/search', `/v2/person/updates/content/${contextId}`]);
      expect(errors).toBe('');
    });
  });

});
