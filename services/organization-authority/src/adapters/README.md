# Adapters

This directory contains Organization Authority implementations of application
ports and infrastructure boundaries:

- `persistence/` owns Authority SQLite repositories and database opening;
- `oidc/` owns OIDC transport and protocol integration;
- `runtime/` owns clock and other host-runtime ports; and
- `security/` owns private-file credentials, session cryptography, and the
  file-backed Organization Authority signer.

`security/file-organization-authority-signer.ts` names the component by its
storage responsibility. Its persisted V1 key filename remains
`authority-development-key.v1.json` for compatibility; that filename is not
the component identity.

Meeting-source, decision-processor, and delivery-provider adapters live under
`processing/adapters/`. Provider-specific composition belongs in a named
runtime bundle under `composition/`, never in a provider-neutral runtime root.
