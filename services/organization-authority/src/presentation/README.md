# Presentation

The bounded loopback JSON/HTTP server lives here. The local installation still
owns signing, private-key use, authority-result verification, and evidence storage.
Presentation depends only on `OrganizationAuthorityHttpApplication`, the narrow
set of application use cases its routes expose. It never queries persistence,
signs documents, or treats hidden controls as authorization. No browser UI or
rendering framework is selected.

Every request must carry a canonical client-identity digest asserted by the
authenticated TLS terminator. The origin authenticates that loopback proxy hop
with its separate shared token before using the identity as the rate-limit key.
Production composition always installs this resolver; direct server tests must
provide an explicit resolver. HTTP authentication challenges are selected by
route and are never inferred from a generic 401.
