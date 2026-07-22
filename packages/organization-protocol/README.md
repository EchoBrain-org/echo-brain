# Organization protocol

**Status:** Accepted workspace boundary; no promoted implementation

This package reserves ownership for signed facts that cross the
installation/authority trust boundary. The experimental authority descriptor,
enrollment request, and enrollment receipt are evidence for promotion, not an
accepted stable schema set. Organization access, revocation, ingest, and receipt
document shapes remain deferred.

It depends only on `@echo-brain/federation-protocol`. It owns no transport
routes, invitation delivery, database rows, admin commands, signing
implementation, or UI. Invitation representation and transport remain
deferred rather than becoming an implicit signed-document format.
