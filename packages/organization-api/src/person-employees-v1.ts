import { isCanonicalPersonEmail, isExpectedPersonEmail } from './person-session.js';
import { asPlainRecord, exactKeys } from './validation.js';

export const PERSON_EMPLOYEES_PATH_V1 = "/v1/person/employees";

export interface EmployeeInvitationV1 {
  readonly login_grant: string;
  readonly expires_at: string;
}

export interface EmployeeRosterV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-employee-roster-v1";
  readonly employees: readonly EmployeeRosterItemV1[];
}

interface EmployeeRosterItemV1 {
  readonly email: string;
  readonly display_name: string;
  readonly membership_status: "active" | "revoked";
  readonly invitation_state: "pending" | "expired" | "redeemed" | "none";
}

export function validateEmployeeInvitationV1(value: unknown): EmployeeInvitationV1 {
  const response = asPlainRecord(value, "employee invitation response is invalid");
  exactKeys(response, ["login_grant", "expires_at"], "employee invitation response is invalid");
  if (
    typeof response.login_grant !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(response.login_grant) ||
    typeof response.expires_at !== "string" ||
    !Number.isFinite(Date.parse(response.expires_at)) ||
    new Date(Date.parse(response.expires_at)).toISOString() !== response.expires_at
  ) {
    throw new Error("employee invitation response is invalid");
  }
  return Object.freeze({
    login_grant: response.login_grant,
    expires_at: response.expires_at,
  });
}

export function validateEmployeeRosterV1(value: unknown): EmployeeRosterV1 {
  const response = asPlainRecord(value, "employee roster response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "employees"],
    "employee roster response is invalid",
  );
  if (
    response.schema_version !== 1 ||
    response.kind !== "echo-clean-person-employee-roster-v1" ||
    !Array.isArray(response.employees)
  ) {
    throw new Error("employee roster response is invalid");
  }
  const employees = response.employees.map((value) => {
    const employee = asPlainRecord(value, "employee roster item is invalid");
    exactKeys(
      employee,
      ["email", "display_name", "membership_status", "invitation_state"],
      "employee roster item is invalid",
    );
    if (
      !isCanonicalPersonEmail(employee.email) ||
      typeof employee.display_name !== "string" ||
      employee.display_name.length < 1 ||
      employee.display_name.length > 200 ||
      employee.display_name !== employee.display_name.trim() ||
      employee.display_name !== employee.display_name.normalize("NFC") ||
      /[\u0000-\u001f\u007f]/.test(employee.display_name) ||
      (employee.membership_status !== "active" && employee.membership_status !== "revoked") ||
      (employee.invitation_state !== "pending" &&
        employee.invitation_state !== "expired" &&
        employee.invitation_state !== "redeemed" &&
        employee.invitation_state !== "none")
    ) {
      throw new Error("employee roster item is invalid");
    }
    return Object.freeze({
      email: employee.email,
      display_name: employee.display_name,
      membership_status: employee.membership_status,
      invitation_state: employee.invitation_state,
    }) as EmployeeRosterItemV1;
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-employee-roster-v1",
    employees: Object.freeze(employees),
  });
}

export function validateEmployeeRequestV1(value: unknown, includeName: boolean): Readonly<Record<string, string>> {
  const request = asPlainRecord(value, "employee request is invalid");
  exactKeys(request, includeName ? ["name", "email"] : ["email"], "employee request is invalid");
  if (
    typeof request.email !== "string" ||
    (includeName
      ? !isExpectedPersonEmail(request.email)
      : !isCanonicalPersonEmail(request.email)) ||
    (includeName && typeof request.name !== "string")
  ) {
    throw new Error("employee request is invalid");
  }
  return request as Readonly<Record<string, string>>;
}
