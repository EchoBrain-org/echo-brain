# Authority client

The transport-neutral client port and bounded HTTP implementation live here.
HTTPS is required except for explicitly enabled loopback development. Redirects
are rejected, response sizes are bounded, and the enrollment grant appears only
in the authorization header. Transport success alone never establishes trust;
the enrollment/state layers verify every signed authority result.

Only a `409` from the access-lease endpoint is interpreted as the stale-state
recovery protocol. Conflicts from enrollment and every other endpoint remain
ordinary rejected requests and cannot be mistaken for an access-state update.

The permission-pilot recent-decisions method posts the exact validated signed
request and accepts only the closed response DTO under its narrower 60 KiB raw
response limit. The adjacent reader creates a fresh request for each CLI call;
neither layer persists or caches returned content.

`HttpOrganizationRecordClient` is the one client with its own request allowance:
256 KiB, matching the authority's route-scoped exemption. Responses retain the
shared small limit. It also verifies the authority-signed receipt against the
pinned descriptor and exact envelope bytes before returning it, and maps only
the exact permanent codes to a terminal rejection; everything else stays
retryable.
