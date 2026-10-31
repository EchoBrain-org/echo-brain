import type { EmployeeInvitationV1, EmployeeRosterV1 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonEmployeeLifecycleApplication } from "../application/person-employee-lifecycle.js";

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    keys.some((key) => typeof record[key] !== "string")
  ) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return record;
}

export interface PersonEmployeeHttpApplication {
  list(input: { access_token: string }): EmployeeRosterV1;
  invite(input: { access_token: string; body: unknown }): EmployeeInvitationV1;
  reissue(input: { access_token: string; body: unknown }): EmployeeInvitationV1;
  revoke(input: { access_token: string; body: unknown }): void;
}

export function createPersonEmployeeHttpApplication(
  lifecycle: PersonEmployeeLifecycleApplication,
): PersonEmployeeHttpApplication {
  return Object.freeze({
    list: ({ access_token }: { access_token: string }) =>
      lifecycle.list({ access_token }),
    invite: ({ access_token, body }: { access_token: string; body: unknown }) => {
      const request = exactObject(body, ["name", "email"]);
      return lifecycle.invite({
        access_token,
        name: request.name as string,
        email: request.email as string,
      });
    },
    reissue: ({ access_token, body }: { access_token: string; body: unknown }) => {
      const request = exactObject(body, ["email"]);
      return lifecycle.reissue({ access_token, email: request.email as string });
    },
    revoke: ({ access_token, body }: { access_token: string; body: unknown }) => {
      const request = exactObject(body, ["email"]);
      lifecycle.revoke({ access_token, email: request.email as string });
    },
  });
}
