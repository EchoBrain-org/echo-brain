import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";

type Person = Pick<PersonAccessAuthorization, "organization_id" | "principal_id" | "membership_id">;

/** The same person: organization, principal and membership. Their session may have changed. */
export function samePersonV1(left: Person, right: Person): boolean {
  return left.organization_id === right.organization_id && left.principal_id === right.principal_id && left.membership_id === right.membership_id;
}

/** The bearer-derived tuple must remain current at release; checked_at may advance. */
export function samePersonReleaseAuthorizationV1(
  initial: PersonAccessAuthorization,
  current: PersonAccessAuthorization,
): boolean {
  return (
    initial.organization_id === current.organization_id &&
    initial.principal_id === current.principal_id &&
    initial.membership_id === current.membership_id &&
    initial.membership_type === current.membership_type &&
    initial.identity_binding_id === current.identity_binding_id &&
    initial.session_family_id === current.session_family_id &&
    initial.access_credential_sha256 === current.access_credential_sha256 &&
    initial.person_state_sha256 === current.person_state_sha256 &&
    initial.session_state_sha256 === current.session_state_sha256
  );
}
