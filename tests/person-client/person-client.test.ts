import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, p256KeyId } from "@echo-brain/federation-protocol";
import { organizationSlackLinkChallengeCodeSha256 } from "@echo-brain/organization-api";
import type { OrganizationAuthorityDescriptorV1 } from "@echo-brain/organization-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersonClient,
  runPersonClientCli,
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

afterEach(() => vi.restoreAllMocks());

describe("Person client", () => {
  it("reports disconnected status without a network call or private paths", async () => {
    await withHome(async (home) => {
      let networkCalled = false;
      let stdout = "";
      const status = await runPersonClientCli(["status"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: () => true },
        home_directory: home,
        fetch: async () => {
          networkCalled = true;
          throw new Error("status must not contact the Authority");
        },
      });
      expect(status).toBe(0);
      expect(networkCalled).toBe(false);
      expect(JSON.parse(stdout)).toMatchObject({
        schema_version: 1,
        kind: "echo-person-client-status-v1",
        signed_in: false,
        membership_type: null,
        connected_authority: null,
      });
      expect(stdout).not.toContain(home);
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

      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(["logout"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
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

      expect(status).toBe(0);
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

      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(["logout"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
        home_directory: home,
        fetch: async () =>
          json({ error: { code: "unavailable", message: "request failed" } }, 503),
      });

      expect(status).toBe(1);
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

  it("lists clean records for the installed Person without an identity input", async () => {
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

  it("uses the same records command for a clean Layer 2 query", async () => {
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
        expect(JSON.parse(String(init?.body))).toEqual({ query: "pricing" });
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ROTATED_SESSION.access_token}`,
        );
        return json({
          schema_version: 1,
          kind: "echo-clean-person-record-search-v1",
          generation_id: `sha256:${"a".repeat(64)}`,
          record_head: { position: 1, record_sha256: `sha256:${"b".repeat(64)}` },
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

      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(
        ["records", "--query", "pricing"],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
          home_directory: home,
          now: () => NOW,
          fetch: fetchImpl,
        },
      );
      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        result: {
          kind: "echo-clean-person-record-search-v1",
          items: [{ text: "Use simple pricing." }],
        },
      });
      expect(searchCalls).toBe(1);

      stdout = "";
      stderr = "";
      const removed = await runPersonClientCli(
        ["readable-search", "--query", "pricing"],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
          home_directory: home,
          fetch: fetchImpl,
        },
      );
      expect(removed).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("usage:");
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

      let stdout = "";
      let stderr = "";
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const status = await runPersonClientCli(
        ["ask", "--question", "What is our pricing decision?"],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
          home_directory: home,
          now: () => NOW,
          fetch: async (input, init) => {
            expect(new URL(String(input)).pathname).toBe("/v1/person/ask");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(String(init?.body))).toEqual({
              question: "What is our pricing decision?",
            });
            expect(new Headers(init?.headers).get("authorization")).toBe(
              `Bearer ${ROTATED_SESSION.access_token}`,
            );
            return json({
              schema_version: 1,
              kind: "echo-clean-person-answer-v1",
              generation_id: `sha256:${"a".repeat(64)}`,
              record_head: {
                position: 1,
                record_sha256: `sha256:${"b".repeat(64)}`,
              },
              answer: "Use simple pricing.",
              citations: [
                {
                  atom_id: `sha256:${"c".repeat(64)}`,
                  record_sha256: `sha256:${"b".repeat(64)}`,
                  policy_id: "organization-member-readable-person-v2",
                },
              ],
            });
          },
        },
      );

      expect(status).toBe(0);
      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(135_000);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        result: {
          schema_version: 1,
          kind: "echo-clean-person-answer-v1",
          generation_id: `sha256:${"a".repeat(64)}`,
          record_head: {
            position: 1,
            record_sha256: `sha256:${"b".repeat(64)}`,
          },
          answer: "Use simple pricing.",
          citations: [
            {
              atom_id: `sha256:${"c".repeat(64)}`,
              record_sha256: `sha256:${"b".repeat(64)}`,
              policy_id: "organization-member-readable-person-v2",
            },
          ],
        },
      });
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
            schema_version: 1,
            kind: "echo-clean-person-answer-v1",
            generation_id: `sha256:${"a".repeat(64)}`,
            record_head: {
              position: 1,
              record_sha256: `sha256:${"b".repeat(64)}`,
            },
            answer: "Use simple pricing.",
            citations: [
              {
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

      await expect(client.ask(" pricing")).rejects.toThrow(
        "ask request is invalid",
      );
      expect(asks).toBe(0);
      await expect(client.ask("pricing")).rejects.toThrow(
        "ask citation is invalid",
      );
      expect(asks).toBe(1);
    });
  });

  it("gives a safe retry instruction while a queried generation is unavailable", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(["records", "--query", "pricing"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/person/records") {
            return json({ error: { code: "unavailable", message: "request failed" } }, 503);
          }
          return json({ authority_descriptor: authority });
        },
      });
      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toMatchObject({
        action: "records",
        error: "Search is catching up to the latest records; retry after the next worker cycle.",
      });
    });
  });

  it("rejects malformed clean record responses and invalid CLI limits", async () => {
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

      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(["records", "--limit", "101"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
        home_directory: home,
      });
      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        action: "records",
        error: "--limit must be an integer from 1 to 100",
      });
    });
  });

  it("sends Slack link replay input without caller or route assertions", async () => {
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
                channel_id: "C123ABC",
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
            channel_id: "C123ABC",
            linked_at: NOW,
            identity_link_created: true,
          });
        },
      });

      await client.installSession("https://authority.example", ROTATED_SESSION);
      const begun = await client.beginSlackLink();
      expect(begun.challenge_code).toBe(challengeCode);
      await client.completeSlackLink({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_message_ts: begun.challenge_message_ts,
        challenge_code: begun.challenge_code,
      });

      expect(observed).toEqual([
        {
          path: "/v2/integration-links/slack/challenges",
          body: {
            challenge_code_sha256:
              organizationSlackLinkChallengeCodeSha256(challengeCode),
            request_id: "psb_00000000-0000-4000-8000-000000000113",
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
      let stdout = "";
      const loginGrant = "G".repeat(43);
      await new PersonClient({
        home_directory: home,
        now: () => "2026-08-18T00:00:00.000Z",
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", {
        ...SESSION,
        membership_type: "owner",
      });
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
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: () => true },
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
      expect(readFileSync(outputPath, "utf8")).toContain(loginGrant);
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
    });
  });

  it("renders the owner employee roster without local database access or lifecycle identifiers", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let stdout = "";
      const client = new PersonClient({
        home_directory: home,
        now: () => "2026-08-18T00:00:00.000Z",
        fetch: async () => json({ authority_descriptor: authority }),
      });
      await client.installSession("https://authority.example", {
        ...SESSION,
        membership_type: "owner",
      });
      const status = await runPersonClientCli(["employee", "list"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: () => true },
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
      ).rejects.toThrow();
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
        ).rejects.toThrow(/0700/);
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
      ).rejects.toThrow("Person Authority request failed");
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
      ).rejects.toThrow(/identity onboarding is already complete.*Authority URL/);
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
      ).rejects.toThrow();
      expect(readFileSync(output, "utf8")).toBe("created by another local writer\n");
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
      let stdout = "";
      const status = await runPersonClientCli(
        ["login", "--invitation", invitationPath],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: () => true },
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

  it("stops an expired invitation locally before it opens a browser or contacts the Authority", async () => {
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
        let stdout = "";
        let stderr = "";
        let browserOpened = false;
        let authorityContacted = false;
        const status = await runPersonClientCli(argv, {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
          home_directory: home,
          now: () => NOW,
          open_authorization_url: () => {
            browserOpened = true;
            return true;
          },
          fetch: async () => {
            authorityContacted = true;
            throw new Error("expired invitation must not contact the Authority");
          },
        });

        expect(status).toBe(1);
        expect(stdout).toBe("");
        expect(browserOpened).toBe(false);
        expect(authorityContacted).toBe(false);
        expect(JSON.parse(stderr)).toMatchObject({
          ok: false,
          action: argv[0],
          error: expect.stringContaining("has expired"),
        });
        expect(stderr).toContain("reissue");
        expect(stderr).not.toContain(loginGrant);
      }
    });
  });

  it("starts an invited employee, opens the browser, and reports ready only after one authorized read", async () => {
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
      const opened: string[] = [];
      const paths: string[] = [];
      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(
        ["start", "--invitation", invitationPath],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
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
      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(
        ["start", "--invitation", invitationPath],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
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
      let stdout = "";
      let stderr = "";
      const status = await runPersonClientCli(
        ["start", "--invitation", invitationPath],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
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
      let stdout = "";
      const status = await runPersonClientCli(
        ["login", "--authority-url", "https://authority.example"],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: () => true },
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

  it("recovers a consumed invitation once through existing-identity login", async () => {
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
      const begins: Record<string, unknown>[] = [];
      let stdout = "";
      const status = await runPersonClientCli(
        ["login", "--invitation", invitationPath],
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: () => true },
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
      expect(stdout).toContain("The invitation was already consumed.");
      expect(stdout).toContain('"phase":"installed"');
    });
  });

  it("links Slack in one command without asking for opaque challenge handles", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const challengeCode = "A".repeat(43);
      const challengeAttemptId = fixtureId("cat", 7);
      const challengeMessageTs = "1755518400.000001";
      let stdout = "";
      let stderr = "";
      await new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async () => json({ authority_descriptor: authority }),
      }).installSession("https://authority.example", ROTATED_SESSION);
      const linked = await runPersonClientCli(["slack-link"], {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
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
                channel_id: "C123ABC",
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
              channel_id: "C123ABC",
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
          source_instance_id: "founder-feed",
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
          source_instance_id: "founder-feed",
          exclusions: [
            {
              scope: "source",
              source_adapter_id: "granola",
              source_instance_id: "founder-feed",
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
        client.exclusions("granola", "founder-feed"),
      ).resolves.toMatchObject({
        subject_principal_id: SESSION.principal_id,
        exclusions: [{ scope: "source" }],
      });
    });
  });

  it("never replays a refresh credential after an ambiguous transport failure", async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let refreshCalls = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/authority-descriptor") {
            return json({ authority_descriptor: authority });
          }
          expect(path).toBe("/v2/session/refresh");
          refreshCalls += 1;
          throw new Error("connection outcome is unknown");
        },
      });
      await client.installSession("https://authority.example", SESSION);

      await expect(client.records()).rejects.toThrow(/request failed/);
      await expect(client.records()).rejects.toThrow(/sign in again/);
      expect(refreshCalls).toBe(1);
    });
  });
});
