import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { AuthorityPersonMembershipBinding } from "./authority-repository.js";

export interface PersonAccessAuthorization extends AuthorityPersonMembershipBinding {
  identity_binding_id: string;
  session_family_id: string;
  access_credential_sha256: Sha256Digest;
  access_expires_at: string;
  hard_reauthentication_at: string;
  person_state_sha256: Sha256Digest;
  session_state_sha256: Sha256Digest;
  checked_at: string;
}
