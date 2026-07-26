# Presentation

The bounded loopback JSON/HTTP server lives here. The local installation still
owns signing, private-key use, authority-result verification, and evidence storage.
Presentation depends only on `OrganizationAuthorityHttpApplication`, the narrow
set of application use cases its routes expose. It never queries persistence,
signs documents, or treats hidden controls as authorization.

The minimal `/admin` browser console also lives here as isolated routes,
escaped server-rendered views, static CSP-safe assets, and bounded in-memory
sessions. It calls the same application use cases as JSON HTTP; it does not
open SQLite or create a second server. The login credential is exchanged for a
proxy-identity-bound process session, every mutation requires CSRF and a
matching HTTPS origin, and raw invitation grants remain browser-local. The
browser obtains the employee-facing authority origin from the administrator
edge's local `GET /admin/edge-config` deployment-metadata response before
creating an invitation; this authority presentation neither serves that route
nor infers an employee origin from the administrator request Host.

Every request must carry a canonical client-identity digest asserted by the
authenticated TLS terminator. The origin authenticates that loopback proxy hop
with its separate shared token before using the identity as the rate-limit key.
Production composition always installs this resolver; direct server tests must
provide an explicit resolver. HTTP authentication challenges are selected by
route and are never inferred from a generic 401.
