# Authority client

The transport-neutral client port and bounded HTTP implementation live here.
HTTPS is required except for explicitly enabled loopback development. Redirects
are rejected, response sizes are bounded, and the enrollment grant appears only
in the authorization header. Transport success alone never establishes trust;
the enrollment/state layers verify every signed authority result.
