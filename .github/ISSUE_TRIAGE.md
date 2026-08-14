# Issue intake and weekly triage

This repository separates **capturing a finding** from **committing to fix it**. Opening an issue records evidence without interrupting current work. Priority, ownership, and release timing are triage decisions.

## Capture

Choose the shortest suitable form:

- **Quick capture** for a preliminary observation or concern.
- **Bug or regression** for reproducible incorrect behavior.

Both forms add `needs-triage`. New issues intentionally have no assignee or milestone.

Never put credentials, tokens, private user data, or exploitable security details in a public issue. Use [private vulnerability reporting](https://github.com/EchoBrain-org/echo-brain/security/advisories/new) instead.

## Metadata rules

| Metadata | Meaning | When to set it |
| --- | --- | --- |
| Type | Bug, task, or feature | During capture or triage |
| Area | The subsystem that owns the finding | During triage |
| Impact | What can happen if the issue remains | Capture, then confirm during triage |
| Priority | When the issue should be addressed | During triage |
| Observed in | Version, commit, run, or image where it was found | During capture when known |
| Milestone | The release committed to resolving it | Only after scheduling |
| Assignee | The person actively responsible | When ownership is accepted |

Use GitHub Issue Types when available. Otherwise use the existing `bug`, `enhancement`, and `documentation` labels. Do not encode type, priority, or release version in the title.

Severity and priority are different. Severity describes impact; priority describes scheduling. This repository uses priority labels:

- `priority:P0`: interrupt current work for an active security exposure, data corruption, production outage, or release-integrity compromise.
- `priority:P1`: resolve before the next relevant release.
- `priority:P2`: valid normal backlog work.
- `priority:P3`: opportunistic improvement.

## Weekly sweep

Start with the [oldest Inbox issue](https://github.com/EchoBrain-org/echo-brain/issues?q=is%3Aissue%20state%3Aopen%20label%3Aneeds-triage%20sort%3Acreated-asc):

```text
repo:EchoBrain-org/echo-brain is:issue is:open label:"needs-triage" sort:created-asc
```

For each issue:

1. If sensitive material or exploitable security details were posted publicly, move coordination to private vulnerability reporting, ask the reporter to redact or delete the material immediately, and close the public issue with a generic note that reveals no details.
2. Search for duplicates; link the canonical issue and close duplicates.
3. Clarify the observation, expected behavior, impact, and sanitized evidence.
4. Set the issue type, one primary `area:*` label, and one `priority:*` label.
5. Choose exactly one disposition:
   - **Act now:** assign an owner and begin P0 handling.
   - **Commit:** add acceptance criteria, an owner, and the target release milestone.
   - **Backlog:** keep the issue open without an assignee or milestone.
   - **Close:** record why it is duplicate, invalid, or not planned.
6. Add parent, sub-issue, or blocking relationships when ordering matters.
7. Remove `needs-triage` after the decision is recorded.

The sweep is complete when the Inbox query returns zero issues. A milestone is a delivery commitment, not a record of where the issue was observed.

## Weekly report

```text
Inbox cleared: <count>
Immediate: <issues or none>
Committed to releases: <issues or none>
Backlogged: <issues or none>
Closed: <issues or none>
Founder decisions needed: <issues or none>
Release risks: <issues or none>
```

At the current repository size, Issues, labels, milestones, and the Inbox query are the workflow. Add a GitHub Project only when multiple owners need a shared status board; if one is added, keep status there rather than duplicating it with labels.
