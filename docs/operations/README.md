# Operations

Operational documentation is divided by outcome.

- A **playbook** investigates an uncertain symptom, scopes impact, gathers
  evidence, and selects a known recovery path.
- A **runbook** performs a known procedure toward a declared outcome, such as
  rotating a credential, restoring state, rebuilding retrieval, or rolling
  back a release.

Use the [playbook template](../_templates/playbook.md) and
[runbook template](../_templates/runbook.md).

## Required safety information

Every operational procedure states:

- trigger and intended outcome;
- owner and escalation path;
- prerequisites, tools, permissions, and maintenance state;
- sensitive-data handling;
- ordered actions and decision points;
- expected observable evidence after each material action;
- stop conditions;
- success verification;
- rollback or safe containment; and
- last tested date and exact source or release.

Commands are not copied into architecture explanations. Architecture pages
link to the maintained procedure.

## Current procedures

- [RB-OPERATIONS-001: Deploy and rehearse minimal Authority observability](RB-OPERATIONS-001-authority-observability.md)
- [RB-OPERATIONS-002: Establish and rehearse the current Authority recovery floor](RB-OPERATIONS-002-authority-recovery-floor.md)
- [RB-OPERATIONS-003: Protect canonical source and immutable clean-beta releases](RB-OPERATIONS-003-protect-canonical-source-and-releases.md)

Existing Authority procedures remain under
[`deploy/organization-authority/`](../../deploy/organization-authority). They
will be indexed and separated from explanatory architecture incrementally.
