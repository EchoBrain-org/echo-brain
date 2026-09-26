# Adapters

Organization Authority implementations of application ports:

- `documents/` extracts bounded document text (see its README);
- `files/` stages document uploads and writes private onboarding invitations;
- `oidc/` owns OIDC Person-session transport;
- `persistence/sqlite/` owns the service's SQLite repositories;
- `security/` owns session cryptography and the file-backed Authority signer;
- `sources/` exposes Person documents to the processing source port; and
- `system/` owns the Authority clock.

The signer keeps its V1 key filename `authority-development-key.v1.json` for
compatibility; that filename is not the component identity. Authority database
opening and migrations live in `packages/organization-authority-kernel`, and
provider adapters live in the `providers/` workspaces.
