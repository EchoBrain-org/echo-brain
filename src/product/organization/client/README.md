# Authority client

The transport-neutral client port and bounded HTTP implementation live here.
HTTPS is required except for explicitly enabled loopback development. Redirects
are rejected, response sizes are bounded, and the enrollment grant appears only
in the authorization header. Transport success alone never establishes trust;
the enrollment/state layers verify every signed authority result.

Only a `409` from the access-lease endpoint is interpreted as the stale-state
recovery protocol. Conflicts from enrollment and every other endpoint remain
ordinary rejected requests and cannot be mistaken for an access-state update.
