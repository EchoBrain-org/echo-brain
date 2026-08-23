import { AuthorityOperationError } from "../domain/errors.js";
import type { CleanPersonEmployeeLifecycleApplication } from "../application/clean-person-employee-lifecycle.js";

export const CLEAN_PERSON_EMPLOYEES_PATH_V1 = "/v1/person/employees";

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

export interface CleanPersonEmployeeHttpApplication {
  invite(input: { access_token: string; body: unknown }): {
    login_grant: string;
    expires_at: string;
  };
  reissue(input: { access_token: string; body: unknown }): {
    login_grant: string;
    expires_at: string;
  };
  revoke(input: { access_token: string; body: unknown }): void;
}

export function createCleanPersonEmployeeHttpApplication(
  lifecycle: CleanPersonEmployeeLifecycleApplication,
): CleanPersonEmployeeHttpApplication {
  return Object.freeze({
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
