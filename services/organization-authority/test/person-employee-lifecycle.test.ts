import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { PersonExternalIdentityRuntimeBundleV1 } from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  organizationPersonSlackIdentityLinkChallengeCodeSha256,
} from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import { afterEach, describe, expect, it } from "vitest";
import { SlackConnectionHealthV1 } from "../../../providers/slack/server/src/organization-control-plane/application/slack-connection-health-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../../providers/slack/server/src/organization-control-plane/application/slack-integration-contracts.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "../../../providers/slack/server/src/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
import { seedSlackConnection } from "../../../providers/slack/server/test/control-database-fixture.js";
import { startOrganizationAuthorityApiRuntime } from "../src/composition/organization-authority-api-runtime.js";
import { UNUSED_ANSWER_MODEL, ownerGenesis, port, signInHttpSession, syntheticOidcProvider } from "./fixtures/owner-session.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-employee-lifecycle-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Person employee lifecycle", () => {
  it("keeps employee lifecycle owner-only, invalidates reissued grants, revokes reads, and permits a new tenure", async () => {
    const oidc = {
      issuer: "https://issuer.example",
      client_id: "founder-client",
      redirect_uri: "https://authority.example/v2/session/oidc/callback",
      tenant: { kind: "issuer" as const },
      id_token_algorithms: ["RS256"],
    };
    const owner = ownerGenesis({ root: root(), oidc, email: "founder@example.com", authority_url: "https://authority.example", revision: "employee-lifecycle-test" });
    let email = "founder@example.com";
    const provider = syntheticOidcProvider(oidc, () => email, { subject: () => `subject-${email}` });
    const runtime = await startOrganizationAuthorityApiRuntime(
      {
        state_directory: owner.initialized.state_directory,
        host: "127.0.0.1",
        port: 19_992,
        authority_url: "https://authority.example",
        oidc,
        client_authentication: { method: "none" },
        pkce_sealing_key: owner.pkce,
      },
      { oidc_provider: provider, answer_composition_generation: UNUSED_ANSWER_MODEL },
    );
    try {
      const origin = `http://127.0.0.1:${String(runtime.address.port)}`;
      const employees = (token?: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) =>
        fetch(`${origin}/v1/person/employees`, {
          method,
          headers: {
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...extraHeaders,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const begin = (login_grant: unknown) => fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "identity_bootstrap", login_grant }),
      });
      const login = (grant: string) => signInHttpSession(origin, provider, grant, "code");
      const founder = await login(owner.login_grant);
      const founderAccess = founder.access_token as string;
      const invite = await employees(founderAccess, "POST", { name: "Jane Doe", email: "jane@example.com" });
      expect(invite.status).toBe(201);
      const first = await json(invite);
      expect(Object.keys(first).sort()).toEqual(["expires_at", "login_grant"]);

      const pendingRoster = await employees(founderAccess);
      expect(pendingRoster.status).toBe(200);
      expect(await json(pendingRoster)).toEqual({
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

      const secondEmployee = await employees(founderAccess, "POST", { name: "John Doe", email: "john@example.com" });
      expect(secondEmployee.status).toBe(201);

      // New invitations must name a mailbox-shaped address.
      const rejectedInvite = await employees(founderAccess, "POST", { name: "Alice Local", email: "alice@localhost" });
      expect(rejectedInvite.status).toBe(400);

      const duplicate = await employees(founderAccess, "POST", { name: "Jane Doe", email: "jane@example.com" });
      expect(duplicate.status).toBe(409);

      const reissue = await employees(founderAccess, "PUT", { email: "jane@example.com" });
      expect(reissue.status).toBe(201);
      const second = await json(reissue);
      const secondReissue = await employees(founderAccess, "PUT", { email: "jane@example.com" });
      expect(secondReissue.status).toBe(201);
      const third = await json(secondReissue);
      const oldGrant = await begin(first.login_grant);
      expect(oldGrant.status).toBe(401);
      const supersededGrant = await begin(second.login_grant);
      expect(supersededGrant.status).toBe(401);

      email = "jane@example.com";
      const employee = await login(third.login_grant as string);
      const employeeAccess = employee.access_token as string;
      const redundantReissue = await employees(founderAccess, "PUT", { email: "jane@example.com" });
      expect(redundantReissue.status).toBe(409);

      // A modified client can call every route and claim any local role. The
      // Authority derives the role from its own current session/membership.
      async function expectManagementDenied(token?: string) {
        for (const method of ["GET", "POST", "PUT", "DELETE"]) {
          const body = method === "POST"
            ? { name: "Unauthorized", email: "unauthorized@example.com" }
            : { email: "john@example.com" };
          const denied = await employees(token, method, method === "GET" ? undefined : body, { "content-type": "application/json", "x-echo-membership-type": "owner" });
          expect(denied.status, `${method} must reject non-owner access`).toBe(401);
          expect(await denied.text()).not.toContain("login_grant");
        }
      }
      for (const token of [employeeAccess, "forged-owner-access-token", undefined]) {
        await expectManagementDenied(token);
      }
      const forgedRole = await employees(employeeAccess, "POST", { name: "Unauthorized", email: "unauthorized@example.com", membership_type: "owner" });
      expect(forgedRole.status).toBe(400);
      const afterDenied = await employees(founderAccess);
      const afterDeniedEmployees = (await json(afterDenied)).employees as Array<Record<string, unknown>>;
      expect(afterDeniedEmployees.some((entry) => entry.email === "unauthorized@example.com")).toBe(false);
      expect(afterDeniedEmployees.find((entry) => entry.email === "john@example.com")).toMatchObject({
        membership_status: "active", invitation_state: "pending",
      });

      const redeemedRoster = await employees(founderAccess);
      expect(redeemedRoster.status).toBe(200);
      const redeemedEmployees = (await json(redeemedRoster)).employees as Array<Record<string, unknown>>;
      expect(redeemedEmployees).toEqual(
        expect.arrayContaining([
          {
            email: "jane@example.com",
            display_name: "Jane Doe",
            membership_status: "active",
            invitation_state: "redeemed",
          },
          {
            email: "john@example.com",
            display_name: "John Doe",
            membership_status: "active",
            invitation_state: "pending",
          },
        ]),
      );

      const revoke = await employees(founderAccess, "DELETE", { email: "jane@example.com" });
      expect(revoke.status).toBe(204);
      const revokedRoster = await employees(founderAccess);
      expect(revokedRoster.status).toBe(200);
      const revokedEmployees = (await json(revokedRoster)).employees as Array<Record<string, unknown>>;
      expect(revokedEmployees).toEqual(
        expect.arrayContaining([
          {
            email: "jane@example.com",
            display_name: "Jane Doe",
            membership_status: "revoked",
            invitation_state: "none",
          },
        ]),
      );
      const revokedRead = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${employeeAccess}` },
      });
      expect(revokedRead.status).toBe(401);
      await expectManagementDenied(employeeAccess);

      const replacement = await employees(founderAccess, "POST", { name: "Jane Doe Again", email: "jane@example.com" });
      expect(replacement.status).toBe(201);
      const replacementInvitation = await json(replacement);
      expect(replacementInvitation.login_grant).not.toBe(second.login_grant);
      email = "jane@example.com";
      const rehired = await login(replacementInvitation.login_grant as string);
      const rehiredRead = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${rehired.access_token as string}` },
      });
      expect(rehiredRead.status).toBe(200);
      const rehiredRoster = await employees(founderAccess);
      expect(rehiredRoster.status).toBe(200);
      const currentEmployees = (await json(rehiredRoster)).employees as Array<Record<string, unknown>>;
      expect(currentEmployees.filter((entry) => entry.email === "jane@example.com")).toEqual([
        {
          email: "jane@example.com",
          display_name: "Jane Doe Again",
          membership_status: "active",
          invitation_state: "redeemed",
        },
      ]);
    } finally {
      await runtime.close();
    }
  });
});

const AUTHORITY_URL = "https://authority.example";
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: `${AUTHORITY_URL}/v2/session/oidc/callback`,
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

/**
 * An Authority whose organization has Slack connected, served over HTTP with the Slack provider's own link runtime on
 * the state's control database. Slack is a fake that confirms whichever user a DM-code proof names. While
 * `flags.stop_between_writes` is set, a removal stops after the Authority's write and before the provider's, as a
 * process that died there would.
 */
async function slackConnectedAuthority() {
  const owner = ownerGenesis({ root: root(), oidc: OIDC, email: "founder@example.com", authority_url: AUTHORITY_URL, revision: "employee-slack-link-test" });
  const { state_directory, authority_id, organization_id, state_lineage_id } = owner.initialized;
  const control = openOrganizationControlDatabase(join(state_directory, "integrations.sqlite"), { fileMustExist: true });
  // The seeded connection is workspace T01, app A01, bot B01 and bot user U_BOT.
  seedSlackConnection(control, { contract: { authority_id, organization_id, state_lineage_id } });
  const slack = createSlackPersonExternalIdentityRuntimeBundleV1({
    provider: {
      verifyConnection: async () => ({ team_id: "T01", enterprise_id: null, bot_user_id: "U_BOT", bot_id: "B01", app_id: "A01",
        granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, verification_evidence_sha256: canonicalSha256("connection") }),
      openIdentityLinkDirectMessage: async (_token, user, team) => ({ team_id: team, channel_id: `D${user.slice(1)}`, recipient_user_id: user }),
      postIdentityLinkChallenge: async (_token, input) => ({ team_id: "T01", channel_id: input.channel_id, challenge_message_ts: "100.000001" }),
      observeIdentityLinkChallenge: async (_token, input) => ({ team_id: "T01", user_id: input.recipient_user_id, channel_id: input.channel_id,
        challenge_message_ts: input.challenge_message_ts, reply_message_ts: "100.000002", verification_evidence_sha256: canonicalSha256("observed") }),
    },
    bot_token_source: { botToken: async () => "xoxb-employee-lifecycle" },
    connection_health: new SlackConnectionHealthV1(),
    // The owner's setup routes are not called here.
    organization_setup: { authority_url: AUTHORITY_URL, nango: { client: {} as never, callback_url: "https://nango.example/oauth/callback" }, manifest_provider: {} as never },
  });
  const flags = { stop_between_writes: false };
  const bundle: PersonExternalIdentityRuntimeBundleV1 = {
    open(input) {
      const opened = slack.open(input);
      return {
        ...opened,
        endMembershipLinks(membership) {
          if (flags.stop_between_writes) throw new Error("simulated stop between the two writes");
          opened.endMembershipLinks(membership);
        },
      };
    },
  };
  let email = "founder@example.com";
  const provider = syntheticOidcProvider(OIDC, () => email, { subject: () => `subject-${email}` });
  const start = async () => startOrganizationAuthorityApiRuntime(
    { state_directory, host: "127.0.0.1", port: await port(), authority_url: AUTHORITY_URL, oidc: OIDC,
      client_authentication: { method: "none" }, pkce_sealing_key: owner.pkce },
    { oidc_provider: provider, answer_composition_generation: UNUSED_ANSWER_MODEL, external_identity_runtime_bundle: bundle },
  );
  let runtime = await start();
  const origin = () => `http://127.0.0.1:${String(runtime.address.port)}`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${origin()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
  };
  const signIn = (login_grant: string, address: string) => {
    email = address;
    return signInHttpSession(origin(), provider, login_grant, "code");
  };
  const founder = (await signIn(owner.login_grant, "founder@example.com")).access_token;
  type Person = { readonly access_token: string };
  /** Begins a DM-code proof that `slackUser` is this person, as `person tools connect --tool slack --method dm-code` does. */
  const beginLink = async (person: Person, slackUser: string) => {
    const code = randomBytes(32).toString("base64url");
    const begun = await call("POST", ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, person.access_token, {
      request_id: `psb_${randomUUID()}`, recipient_user_id: slackUser,
      challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(code),
    });
    return { ...begun, code };
  };
  const roster = async () => (await call("GET", "/v1/person/employees", founder)).body.employees;
  const rows = (sql: string) => control.prepare(sql).all();
  return {
    flags,
    /** The owner invites this person, who signs in as a new membership. */
    async join(name: string, address: string) {
      const invited = await call("POST", "/v1/person/employees", founder, { name, email: address });
      expect(invited.status).toBe(201);
      return signIn(invited.body.login_grant as string, address);
    },
    /** `by`, the owner unless given, removes the employee; answers the removal's HTTP status. */
    remove: async (address: string, by: Person = { access_token: founder }) =>
      (await call("DELETE", "/v1/person/employees", by.access_token, { email: address })).status,
    roster,
    /** The HTTP status of a read with this person's session. */
    reads: async (person: Person) => (await call("GET", "/v1/person/records", person.access_token)).status,
    beginLink,
    /** The whole proof: the person replies with the code, and the Authority links the Slack user or refuses. */
    async link(person: Person, slackUser: string) {
      const begun = await beginLink(person, slackUser);
      expect(begun.status).toBe(201);
      return call("POST", ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, person.access_token, {
        request_id: `psc_${randomUUID()}`, challenge_attempt_id: begun.body.challenge_attempt_id,
        challenge_message_ts: begun.body.challenge_message_ts, challenge_code: begun.code,
      });
    },
    /** Every Slack link the control database holds, oldest first. */
    slackLinks: () => rows("SELECT membership_id, provider_subject_id, current_status FROM organization_external_human_link_current ORDER BY rowid"),
    /** Every DM-code proof the control database holds, oldest first. */
    linkProofs: () => rows("SELECT membership_id, status FROM organization_person_slack_link_challenges ORDER BY rowid"),
    /** Everything a removal settles, in both databases. */
    settled: async () => ({
      roster: await roster(),
      links: rows("SELECT * FROM organization_external_human_link_current ORDER BY rowid"),
      proofs: rows("SELECT * FROM organization_person_slack_link_challenges ORDER BY rowid"),
    }),
    /** The Authority process stops and starts again on the same state. */
    async restart() {
      await runtime.close();
      runtime = await start();
    },
    async close() {
      await runtime.close();
      control.close();
    },
  };
}

describe("Person employee removal and the Slack link", () => {
  it("ends a removed employee's Slack link and pending link proof, and changes nothing when the removal is repeated", async () => {
    const authority = await slackConnectedAuthority();
    try {
      const jane = await authority.join("Jane Doe", "jane@example.com");
      const john = await authority.join("John Doe", "john@example.com");
      expect((await authority.link(jane, "U0JANE")).status).toBe(200);
      // John has begun a proof he has not finished.
      expect((await authority.beginLink(john, "U0JOHN")).status).toBe(201);
      const janeLink = { membership_id: jane.membership_id, provider_subject_id: "U0JANE" };
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "active" }]);

      expect(await authority.remove("jane@example.com")).toBe(204);
      expect(await authority.remove("john@example.com")).toBe(204);
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "revoked" }]);
      expect(authority.linkProofs()).toEqual([
        { membership_id: jane.membership_id, status: "completed" },
        { membership_id: john.membership_id, status: "expired" },
      ]);

      const settled = await authority.settled();
      expect(await authority.remove("jane@example.com")).toBe(404);
      expect(await authority.remove("john@example.com")).toBe(404);
      expect(await authority.settled()).toEqual(settled);
    } finally {
      await authority.close();
    }
  });

  it("keeps the employee removed when the removal stops between its two writes, and finishes when it is run again", async () => {
    const authority = await slackConnectedAuthority();
    try {
      const jane = await authority.join("Jane Doe", "jane@example.com");
      const john = await authority.join("John Doe", "john@example.com");
      expect((await authority.link(jane, "U0JANE")).status).toBe(200);
      const janeLink = { membership_id: jane.membership_id, provider_subject_id: "U0JANE" };
      const removed = expect.objectContaining({ email: "jane@example.com", membership_status: "revoked" });

      authority.flags.stop_between_writes = true;
      expect(await authority.remove("jane@example.com")).toBe(500);
      // The Authority's write stands: Jane is removed and her session is refused. The link write never happened.
      expect(await authority.roster()).toContainEqual(removed);
      expect(await authority.reads(jane)).toBe(401);
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "active" }]);

      // The Authority starts again. Only an owner can run the removal again: an employee's attempt writes nothing.
      authority.flags.stop_between_writes = false;
      await authority.restart();
      expect(await authority.remove("jane@example.com", john)).toBe(401);
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "active" }]);
      // The owner's run finishes it, and answers as for any employee already removed.
      expect(await authority.remove("jane@example.com")).toBe(404);
      expect(await authority.roster()).toContainEqual(removed);
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "revoked" }]);
    } finally {
      await authority.close();
    }
  });

  it("lets a person removed and invited again link the same Slack account with their own proof, and still refuses a current member's Slack account", async () => {
    const authority = await slackConnectedAuthority();
    try {
      const jane = await authority.join("Jane Doe", "jane@example.com");
      const john = await authority.join("John Doe", "john@example.com");
      expect((await authority.link(jane, "U0JANE")).status).toBe(200);
      const janeLink = { membership_id: jane.membership_id, provider_subject_id: "U0JANE" };
      // Jane is a current member, so nobody else can take her Slack account.
      expect((await authority.link(john, "U0JANE")).status).toBe(409);
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "active" }]);

      // Jane is removed and her link is left active, as a removal that never reached its link write leaves it.
      authority.flags.stop_between_writes = true;
      await authority.remove("jane@example.com");
      authority.flags.stop_between_writes = false;
      expect(authority.slackLinks()).toEqual([{ ...janeLink, current_status: "active" }]);

      const rehired = await authority.join("Jane Doe", "jane@example.com");
      expect(rehired.membership_id).not.toBe(jane.membership_id);
      const relinked = await authority.link(rehired, "U0JANE");
      expect(relinked.status).toBe(200);
      expect(relinked.body).toMatchObject({ principal_id: rehired.principal_id, membership_id: rehired.membership_id,
        provider_subject_id: "U0JANE", identity_link_created: true });
      expect(authority.slackLinks()).toEqual([
        { ...janeLink, current_status: "revoked" },
        { membership_id: rehired.membership_id, provider_subject_id: "U0JANE", current_status: "active" },
      ]);
    } finally {
      await authority.close();
    }
  });
});
