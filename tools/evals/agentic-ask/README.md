# Synthetic Agentic Ask evaluation

This is an opt-in behavior evaluation for the shared Ask research loop. It
uses the shipped Ask and OpenRouter generation bundle, but the evidence desk is
entirely synthetic. It never contacts Jira, Slack, Linear, or another work
tool, and it never writes a tool payload into ECHO.

Build the workspace, then run it only with an explicit private credential-file
path and explicit consent to make model requests:

```sh
npm run build:workspaces
npm run eval:agentic-ask -- --run --credential-file /absolute/private/credential-file
```

The bundle owns the credential read. The evaluator only verifies that the path
exists; it neither reads nor prints the credential. Without `--run`, it exits
before loading the bundle or making a network request.

The default suite has nine bounded cases:

| Case | What it checks |
| --- | --- |
| `approved-meeting` | Finds and opens an approved meeting record before citing it. |
| `ticket-jira-label` | Uses generic ticket discovery and an opaque open for a Jira-shaped work-item label. |
| `ticket-linear-label` | Repeats the same generic ticket behavior for a Linear-shaped label. |
| `mixed-meeting-and-ticket` | Covers both the approved decision and current ticket state when both are asked for. |
| `ticket-context-unavailable` | Does not present a response as complete when current ticket context is unavailable. |
| `empty-source` | Returns an honest no-evidence result without citations. |
| `later-page-discovery` | Continues browsing until it can discover and open an item beyond the first visible list page. |
| `held-out-long-release-decision` | Answers a long release-identifier question from a fully sufficient approved record without adding false missing context. |
| `held-out-multipart-missing-date-owner` | States the supported decision, returns a partial result, and names only the unsupported date and owner. |

The evaluator grades source/citation coverage, discovery before an actual desk
open, opaque-handle safety, truthful completion states, and reader-visible
decision/gap facts in the two held-out cases. It does not require one exact
search query or tool order. A fake-handle model reply remains a
deterministic unit-test concern; this live-model evaluator only observes the
real controller's desk operations.

Use `--cases`, `--trials`, `--max-model-calls`, and `--timeout-ms` to make a
small diagnostic run. Bounds are fixed at nine cases, three trials, twelve
model calls per case, 72 calls per invocation, and 85 seconds per case. The
default is one trial, six calls per case, and 60 seconds.

`--provider-route friendli` or `--provider-route baidu` is a separate local
route diagnosis mode. The normal evaluator uses the unmodified production
bundle. Route diagnosis uses a local adapter because the bundle deliberately
does not expose a transport hook; it preserves the adapter's existing request
properties, sets `only` to the requested lowercase provider slug with fallback
disabled, and records only the public provider name returned by OpenRouter. It never records headers,
authorization, request bodies, or response bodies.

The report is mode `0600` in a fresh private temporary directory unless an
absolute `--out-dir` is selected. It stores hashes, case ids, aggregate model
usage, outcome/citation-source counts, and safe traces only for failed cases.
It deliberately omits credentials, prompts, planner replies, provider response
payloads, and opaque handles. Each result retains only its final rendered
statement text and gap text because all fixture evidence is synthetic; this is
for human review of reader-visible behavior. The normal production-bundle mode has no routed
provider metadata. Route diagnosis records only a requested route and safe
provider name, without intercepting global transport.

Each successful research call also records a structural diagnostic: part count,
need-status counts, action names, and whether it chose only `finish` or any
read action. It omits need text, notes, queries, ids, prompts, and the raw
research reply. This lets a reviewer distinguish repeated research from an
early finish decision without adding content capture.

This is an evaluation and diagnosis tool. It is not a production canary, a
release gate, or evidence that a provider route will be stable.
