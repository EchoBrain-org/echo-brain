# Echo Brain macOS signing helper source

This directory contains source and templates only. It intentionally contains no
certificate, private signing key, provisioning profile, concrete Apple Team ID,
or prebuilt executable.

The helper is the only process allowed to use an installation private key. It
supports the version-1 JSON protocol consumed by
`src/product/federation/foundation/macos-installation-signer.ts`:

- `create` creates or reuses the installation's Secure Enclave P-256 key.
- `describe` returns its public descriptor or `null` when it is absent.
- `sign` checks `expected_key_id`, signs the supplied message bytes with
  ECDSA-P256/SHA-256, and returns strict low-S X9.62 DER.
- `delete` is an abort-only cleanup command. It recomputes and checks
  `expected_key_id` before deleting the exact verified key reference, returns
  `false` when no key exists, and refuses a fingerprint mismatch without
  deleting.

Every request is one JSON object on standard input. Every response is one JSON
object on standard output. The helper has no software-key fallback, private-key
export, or unrestricted delete command.

## Required signing configuration

Seed packaging must create an app-like bundle and replace both occurrences of
`__ECHO_SIGNER_KEYCHAIN_ACCESS_GROUP_REQUIRED__` with one exact keychain access
group authorized by its embedded provisioning profile. It must also expand
`PRODUCT_BUNDLE_IDENTIFIER` to one stable bundle ID. The Apple Team ID, bundle
ID, and access group must remain unchanged across releases or an upgraded helper
will lose access to existing installation keys.

The signed bundle must:

1. use a stable Apple development team and application identifier;
2. carry a provisioning profile that authorizes the keychain access group;
3. enable the hardened runtime and retain the exact entitlements template;
4. run in the logged-in user's context, never as a system LaunchDaemon;
5. be verified after signing and again after packaging/installing; and
6. reject packaging if either template placeholder or an unexpanded `$(` build
   setting remains.

`com.apple.application-identifier` and the team identifier are supplied by the
signing identity/profile. Do not invent or manually hard-code those restricted
entitlements here.

The helper requests
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. After a reboot, signing is
expected to fail closed until the user has unlocked the Mac once.
