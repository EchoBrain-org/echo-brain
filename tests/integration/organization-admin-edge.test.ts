import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from "@echo-brain/organization-api";
import { organizationAuthorityPinSha256 } from "@echo-brain/organization-protocol";
import { SqliteOrganizationAuthorityRepository } from "../../services/organization-authority/src/adapters/persistence/sqlite/sqlite-authority-repository.js";
import { DevelopmentFileOrganizationAuthoritySigner } from "../../services/organization-authority/src/adapters/security/development-file-authority-signer.js";
import { startOrganizationAuthority } from "../../services/organization-authority/src/composition/runtime.js";
import {
  organizationAdminClientCertificateIdentity,
  startOrganizationAdminEdge,
} from "../../services/organization-admin-edge/src/edge.js";
import {
  createTestPki,
  type TestCertificate,
  type TestPki,
} from "../../services/organization-admin-edge/test/support/pki.js";

const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const MEMBERSHIP_COMMAND_ID = "adm_00000000-0000-4000-8000-000000000010";
const INVITATION_COMMAND_ID = "adm_00000000-0000-4000-8000-000000000011";
const ADMIN_TOKEN = "test-admin-token-with-at-least-32-bytes";
const PROXY_TOKEN = "test-proxy-origin-token-with-at-least-32-bytes";
const ADMIN_HOSTNAME = "admin.edge.test";
const ADMIN_ORIGIN = `https://${ADMIN_HOSTNAME}`;
const EMPLOYEE_ORIGIN = "https://employee.authority.test";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface RecordingProxy {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  readonly errors: unknown[];
  close(): Promise<void>;
}

interface EdgeResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface EdgeRequestOptions {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: Buffer | string;
  readonly headers?: OutgoingHttpHeaders;
  readonly certificate?: TestCertificate | null;
  readonly host?: string;
  readonly servername?: string;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function startRecordingProxy(
  targetOrigin: string,
): Promise<RecordingProxy> {
  const requests: RecordedRequest[] = [];
  const errors: unknown[] = [];
  const target = new URL(targetOrigin);
  const server = createHttpServer((request, response) => {
    void (async (): Promise<void> => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: { ...request.headers },
        body,
      });
      await new Promise<void>((resolve, reject) => {
        const upstream = httpRequest(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            method: request.method,
            path: request.url,
            headers: request.headers,
            agent: false,
          },
          (upstreamResponse) => {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              upstreamResponse.headers,
            );
            upstreamResponse.once("error", reject);
            upstreamResponse.once("end", resolve);
            upstreamResponse.pipe(response);
          },
        );
        upstream.once("error", reject);
        upstream.end(body);
      });
    })().catch((error: unknown) => {
      errors.push(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-length": "0" });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("recording proxy did not bind a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    errors,
    close: () => closeServer(server),
  };
}

function issueAdditionalTrustedClient(pki: TestPki): TestCertificate {
  const keyName = "admin-three.key.pem";
  const requestName = "admin-three.csr.pem";
  const certificateName = "admin-three.cert.pem";
  const extensionName = "admin-three.ext";
  writeFileSync(
    join(pki.directory, extensionName),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=admin-three",
      "-keyout",
      keyName,
      "-out",
      requestName,
    ],
    { cwd: pki.directory, stdio: ["ignore", "ignore", "pipe"] },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "2",
      "-in",
      requestName,
      "-CA",
      "ca.cert.pem",
      "-CAkey",
      "ca.key.pem",
      "-set_serial",
      "1004",
      "-extfile",
      extensionName,
      "-out",
      certificateName,
    ],
    { cwd: pki.directory, stdio: ["ignore", "ignore", "pipe"] },
  );
  const certificatePath = realpathSync(join(pki.directory, certificateName));
  const privateKeyPath = realpathSync(join(pki.directory, keyName));
  chmodSync(certificatePath, 0o600);
  chmodSync(privateKeyPath, 0o600);
  return {
    certificate_path: certificatePath,
    private_key_path: privateKeyPath,
    certificate: readFileSync(certificatePath),
    private_key: readFileSync(privateKeyPath),
  };
}

function edgeRequest(
  port: number,
  pki: TestPki,
  options: EdgeRequestOptions,
): Promise<EdgeResponse> {
  const method = options.method ?? "GET";
  const body =
    typeof options.body === "string"
      ? Buffer.from(options.body, "utf8")
      : options.body;
  const headers: OutgoingHttpHeaders = {
    ...options.headers,
    host: options.host ?? ADMIN_HOSTNAME,
  };
  if (body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(body.length);
  }
  if (
    method === "POST" &&
    headers.origin === undefined &&
    headers.Origin === undefined
  ) {
    headers.origin = ADMIN_ORIGIN;
  }
  const certificate =
    options.certificate === undefined ? pki.admin_one : options.certificate;
  return new Promise<EdgeResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: options.servername ?? ADMIN_HOSTNAME,
        method,
        path: options.path,
        headers,
        ca: pki.ca_certificate,
        ...(certificate === null
          ? {}
          : {
              cert: certificate.certificate,
              key: certificate.private_key,
            }),
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.setTimeout(10_000, () =>
      request.destroy(new Error("administrator edge test request timed out")),
    );
    request.once("error", reject);
    request.end(body);
  });
}

function cookieHeader(response: EdgeResponse): {
  readonly header: string;
  readonly set: string[];
} {
  const set = response.headers["set-cookie"];
  if (!Array.isArray(set)) {
    throw new Error("administrator login did not return cookie headers");
  }
  return {
    header: set.map((cookie) => cookie.split(";", 1)[0]!).join("; "),
    set,
  };
}

function bodyText(response: EdgeResponse): string {
  return response.body.toString("utf8");
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

describe("real organization administrator edge", () => {
  it("enforces the TLS boundary and completes the browser administrator flow against a persistent authority", async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "echo-admin-edge-integration-")),
    );
    chmodSync(directory, 0o700);
    const cleanups: Array<() => Promise<void> | void> = [
      () => rmSync(directory, { recursive: true, force: true }),
    ];
    try {
      const pki = createTestPki(ADMIN_HOSTNAME);
      cleanups.push(() => pki.cleanup());
      const untrustedPki = createTestPki("untrusted.edge.test");
      cleanups.push(() => untrustedPki.cleanup());
      const nonAllowlistedClient = issueAdditionalTrustedClient(pki);

      const keyDirectory = join(directory, "keys");
      const signer = DevelopmentFileOrganizationAuthoritySigner.open({
        directory: keyDirectory,
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
      });
      const authorityDescriptor = await signer.inspect();
      const authorityPin = organizationAuthorityPinSha256(authorityDescriptor);
      const databasePath = join(directory, "authority.sqlite");
      const repository = new SqliteOrganizationAuthorityRepository(
        databasePath,
      );
      try {
        repository.initialize({
          descriptor: authorityDescriptor,
          authority_pin_sha256: authorityPin,
          organization_display_name: "Example Company",
          maximum_active_lease_ttl_ms: 60_000,
          initialized_at: "2026-01-01T00:00:00.000Z",
        });
      } finally {
        repository.close();
      }

      const authority = await startOrganizationAuthority({
        state_directory: directory,
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        key_directory: keyDirectory,
        organization_display_name: "Example Company",
        authority_pin_sha256: authorityPin,
        database_path: databasePath,
        admin_token: ADMIN_TOKEN,
        trusted_proxy_token: PROXY_TOKEN,
        host: "127.0.0.1",
        port: 0,
        active_lease_ttl_ms: 60_000,
        access_request_maximum_age_ms: 60_000,
      });
      cleanups.push(() => authority.close());
      const authorityOrigin = `http://127.0.0.1:${String(
        authority.address.port,
      )}`;
      const recordingProxy = await startRecordingProxy(authorityOrigin);
      cleanups.push(() => recordingProxy.close());

      const adminOneIdentity = organizationAdminClientCertificateIdentity(
        new X509Certificate(pki.admin_one.certificate),
      );
      const adminTwoIdentity = organizationAdminClientCertificateIdentity(
        new X509Certificate(pki.admin_two.certificate),
      );
      const edge = await startOrganizationAdminEdge({
        listener: { host: "127.0.0.1", port: 0 },
        public_origin: ADMIN_ORIGIN,
        employee_authority_base_url: EMPLOYEE_ORIGIN,
        authority_origin: recordingProxy.origin,
        tls: {
          certificate_chain: pki.server.certificate,
          private_key: pki.server.private_key,
          client_ca_bundle: pki.ca_certificate,
        },
        trusted_proxy_token: PROXY_TOKEN,
        allowed_admin_client_spki_sha256: new Set([
          adminOneIdentity.pin,
          adminTwoIdentity.pin,
        ]),
      });
      cleanups.push(() => edge.close());
      const request = (options: EdgeRequestOptions): Promise<EdgeResponse> =>
        edgeRequest(edge.address.port, pki, options);

      const rejectedOriginCount = recordingProxy.requests.length;
      await expect(
        request({ path: "/admin/login", certificate: null }),
      ).rejects.toThrow();
      await expect(
        request({
          path: "/admin/login",
          certificate: untrustedPki.admin_one,
        }),
      ).rejects.toThrow();
      expect(
        (
          await request({
            path: "/admin/login",
            certificate: nonAllowlistedClient,
          })
        ).status,
      ).toBe(403);
      await expect(
        request({
          path: "/admin/login",
          servername: "attacker.edge.test",
        }),
      ).rejects.toThrow();
      expect(
        (
          await request({
            path: "/admin/login",
            host: "attacker.edge.test",
          })
        ).status,
      ).toBe(421);
      expect(
        (
          await request({
            path: "/admin/login",
            method: "POST",
            body: formBody({ credential: ADMIN_TOKEN }),
            headers: {
              "content-type":
                "application/x-www-form-urlencoded; charset=utf-8",
              origin: "https://attacker.edge.test",
            },
          })
        ).status,
      ).toBe(403);
      for (const forbidden of [
        { path: "/v1/enrollments", method: "POST" as const },
        { path: "/v1/access-leases", method: "POST" as const },
        { path: "/v1/admin/overview", method: "GET" as const },
        { path: "/_echo/runtime-status", method: "GET" as const },
      ]) {
        const response = await request({
          ...forbidden,
          ...(forbidden.method === "POST"
            ? {
                body: "{}",
                headers: { "content-type": "application/json" },
              }
            : {}),
        });
        expect(response.status, forbidden.path).toBe(404);
      }
      expect(recordingProxy.requests).toHaveLength(rejectedOriginCount);

      const loginPage = await request({
        path: "/admin/login",
        headers: {
          [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
            "Echo-Proxy attacker-controlled-token",
          [TRUSTED_PROXY_CLIENT_ID_HEADER]:
            "cid_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "x-echo-admin-csrf": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          "x-echo-authenticated-client-role": "owner",
          "x-echo-proxy-token-shadow": "attacker-controlled",
          forwarded: "for=192.0.2.1",
          "x-forwarded-for": "192.0.2.1",
          "x-real-ip": "192.0.2.1",
          via: "attacker",
        },
      });
      expect(loginPage.status).toBe(200);
      expect(bodyText(loginPage)).toContain("Organization authority");
      const proxiedLoginPage = recordingProxy.requests.at(-1);
      expect(proxiedLoginPage).toBeDefined();
      expect(proxiedLoginPage!.method).toBe("GET");
      expect(proxiedLoginPage!.url).toBe("/admin/login");
      expect(proxiedLoginPage!.headers.host).toBe(ADMIN_HOSTNAME);
      expect(
        proxiedLoginPage!.headers[TRUSTED_PROXY_AUTHORIZATION_HEADER],
      ).toBe(`Echo-Proxy ${PROXY_TOKEN}`);
      expect(proxiedLoginPage!.headers[TRUSTED_PROXY_CLIENT_ID_HEADER]).toBe(
        adminOneIdentity.client_id,
      );
      expect(proxiedLoginPage!.headers["x-echo-admin-csrf"]).toBe(
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      );
      for (const stripped of [
        "x-echo-authenticated-client-role",
        "x-echo-proxy-token-shadow",
        "forwarded",
        "x-forwarded-for",
        "x-real-ip",
        "via",
      ]) {
        expect(proxiedLoginPage!.headers[stripped], stripped).toBeUndefined();
      }

      const login = await request({
        path: "/admin/login",
        method: "POST",
        body: formBody({ credential: ADMIN_TOKEN }),
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
      });
      expect(login.status).toBe(303);
      expect(login.headers.location).toBe("/admin");
      expect(login.headers["strict-transport-security"]).toBe(
        "max-age=31536000",
      );
      const cookies = cookieHeader(login);
      expect(cookies.set).toHaveLength(2);
      for (const cookie of cookies.set) {
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Path=/admin");
        expect(cookie).not.toContain(ADMIN_TOKEN);
      }
      expect(cookies.header).toContain("echo_admin_session=");
      expect(cookies.header).toContain("echo_admin_csrf=");

      const dashboard = await request({
        path: "/admin",
        headers: { cookie: cookies.header },
      });
      expect(dashboard.status).toBe(200);
      const dashboardHtml = bodyText(dashboard);
      expect(dashboardHtml).toContain("Example Company");
      const csrfMatch = dashboardHtml.match(
        /<meta name="echo-admin-csrf" content="([A-Za-z0-9_-]{43})">/,
      );
      if (csrfMatch?.[1] === undefined) {
        throw new Error(
          "administrator dashboard did not expose its CSRF token",
        );
      }
      const csrfToken = csrfMatch[1];

      const otherClient = await request({
        path: "/admin",
        certificate: pki.admin_two,
        headers: { cookie: cookies.header },
      });
      expect(otherClient.status).toBe(303);
      expect(otherClient.headers.location).toBe("/admin/login");
      expect(otherClient.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("echo_admin_session="),
          expect.stringContaining("Max-Age=0"),
        ]),
      );
      expect(
        recordingProxy.requests.at(-1)?.headers[TRUSTED_PROXY_CLIENT_ID_HEADER],
      ).toBe(adminTwoIdentity.client_id);

      const membership = await request({
        path: "/admin/memberships",
        method: "POST",
        body: formBody({
          _csrf: csrfToken,
          command_id: MEMBERSHIP_COMMAND_ID,
          display_name: "Employee One",
          membership_type: "employee",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          cookie: cookies.header,
        },
      });
      expect(membership.status).toBe(303);
      expect(membership.headers.location).toBe("/admin");

      const dashboardWithMember = await request({
        path: "/admin",
        headers: { cookie: cookies.header },
      });
      expect(dashboardWithMember.status).toBe(200);
      const memberHtml = bodyText(dashboardWithMember);
      expect(memberHtml).toContain("Employee One");
      const membershipMatch = memberHtml.match(
        /mem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
      );
      if (membershipMatch === null) {
        throw new Error("created membership was not rendered");
      }
      const membershipId = membershipMatch[0];

      const edgeConfigOriginCount = recordingProxy.requests.length;
      const edgeConfig = await request({ path: "/admin/edge-config" });
      expect(edgeConfig.status).toBe(200);
      expect(JSON.parse(bodyText(edgeConfig))).toEqual({
        authority_base_url: EMPLOYEE_ORIGIN,
      });
      expect(edgeConfig.headers["cache-control"]).toBe("no-store");
      expect(edgeConfig.headers["strict-transport-security"]).toBe(
        "max-age=31536000",
      );
      expect(recordingProxy.requests).toHaveLength(edgeConfigOriginCount);

      const enrollmentGrant = Buffer.alloc(32, 7);
      const enrollmentGrantBase64url = enrollmentGrant.toString("base64url");
      const enrollmentGrantDigest = `sha256:${createHash("sha256")
        .update(enrollmentGrant)
        .digest("hex")}`;
      const invitation = await request({
        path: `/admin/memberships/${membershipId}/enrollment-grants`,
        method: "POST",
        body: JSON.stringify({
          command_id: INVITATION_COMMAND_ID,
          enrollment_grant_sha256: enrollmentGrantDigest,
          lifetime_seconds: 3600,
        }),
        headers: {
          "content-type": "application/json; charset=utf-8",
          cookie: cookies.header,
          "x-echo-admin-csrf": csrfToken,
        },
      });
      expect(invitation.status).toBe(201);
      const invitationText = bodyText(invitation);
      expect(invitationText).not.toContain(enrollmentGrantBase64url);
      const invitationPayload = record(
        JSON.parse(invitationText) as unknown,
        "invitation response",
      );
      expect(invitationPayload.authority_pin_delivery).toBe(
        "separate_secure_channel_required",
      );
      expect(
        record(invitationPayload.invitation, "invitation registration"),
      ).toMatchObject({
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        membership_id: membershipId,
        enrollment_grant_sha256: enrollmentGrantDigest,
      });

      const revocation = await request({
        path: `/admin/memberships/${membershipId}/revocations`,
        method: "POST",
        body: formBody({
          _csrf: csrfToken,
          reason: "employment ended",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          cookie: cookies.header,
        },
      });
      expect(revocation.status).toBe(303);
      expect(revocation.headers.location).toBe("/admin");

      const revokedDashboard = await request({
        path: "/admin",
        headers: { cookie: cookies.header },
      });
      expect(revokedDashboard.status).toBe(200);
      expect(bodyText(revokedDashboard)).toContain("Employee One");
      expect(bodyText(revokedDashboard)).toContain(
        '<span class="status">revoked</span>',
      );
      expect(bodyText(revokedDashboard)).toContain(
        '<span class="muted">Revoked members</span><strong>1</strong>',
      );
      expect(recordingProxy.errors).toEqual([]);
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          "organization administrator edge integration cleanup failed",
        );
      }
    }
  });
});
