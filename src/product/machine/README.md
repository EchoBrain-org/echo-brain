# Machine scope

This module owns capabilities tied to one employee installation: private-key
lifecycle, local operating-system integration, and other machine-bound ports.

Portable trust formats belong in the protocol workspaces: this module imports
canonicalization, identifiers, and the P-256 signature profile straight from
`@echo-brain/federation-protocol`, not through the product federation
compatibility shims. Organization code may depend on these narrow machine
ports, but not on federation storage or identity implementations.
