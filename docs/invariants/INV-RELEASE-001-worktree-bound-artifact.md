---
schema_version: 1
id: INV-RELEASE-001
kind: invariant
title: Artifact identity is bound to the exact source worktree
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
normative: MUST
enforcement_status: not-implemented
enforcement_scope: Operator procedure only; systemic build-environment sanitation remains open
failure_pattern_ids:
  - FP-RELEASE-001
---

# INV-RELEASE-001: Artifact identity is bound to the exact source worktree

## Statement

Every packaging command MUST run with its process working directory and Git
identity bound to the exact clean source worktree. Before install,
qualification, or publication, the artifact's embedded source identity MUST
match the external build claim.

## Scope and failure behavior

An identity mismatch quarantines the bytes. The artifact is never relabeled or
repaired after the fact. A newly built artifact resets exact-artifact
qualification.

## Enforcement and verification

Founder-live operation detected and quarantined a wrong-worktree archive, then
rebuilt correctly. The repository build tooling still needs a systemic guard
against inherited Git environment and working-directory mistakes.
