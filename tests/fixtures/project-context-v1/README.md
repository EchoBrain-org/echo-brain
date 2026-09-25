# Project context V1 command and HTTP fixtures

These files freeze PC-00's public examples. They are contract fixtures for
PC-01 through PC-06, not recordings of a live server and not a CLI stub that
may claim success before the corresponding route exists.

`operations.json` contains one accepted request/response pair for every
project and V2 original-context operation. `invalid.json` contains inputs that
the public codecs must reject before any mutation. Success is written by the
CLI as the exact response JSON on stdout followed by one newline; it has no
extra `{ "ok": true }` envelope, matching the existing Person update commands.

All requests carry the existing Person bearer session at transport time. The
authenticated caller's organization, principal, membership tenure, audience
roster, project-authorization revision, audit witness, and model data are
never CLI arguments or public JSON fields. `--membership-id` is different: it
is an explicit target organization-membership tenure, accepted only by project
lead member-set and member-remove operations. The server still derives and
authorizes the caller from the session, and validates that target tenure in its
own organization.

`--cursor` is an opaque, canonical base64url keyset continuation, never a
credential or authorization token. Its later implementation encodes only the
last publicly returned authorized row coordinates and a request-binding digest
over operation, project, query, limit, requester organization and membership
tenure. It contains no bearer, session, authorization revision, global state,
or project state. Every page reauthorizes and audits its own candidate set;
there is no stable multi-page snapshot. Malformed or wrong-scope cursors are
`invalid_request`. The opaque token below is an example only, not a prescribed
encoding implementation.

## HTTP mapping

| CLI argv after `person` | Method and path | Request body | Success |
| --- | --- | --- | --- |
| `projects list` | `GET /v1/person/projects?limit={limit}&cursor={cursor}` | none | `200` project list |
| `projects create` | `POST /v1/person/projects` | project create | `201` immutable create receipt |
| `projects read` | `GET /v1/person/projects/{project_id}` | none | `200` project summary |
| `projects members` | `POST /v1/person/projects/members` | project browse | `200` members page |
| `projects directory` | `POST /v1/person/projects/directory` | directory search | `200` directory page |
| `directory` | `POST /v1/person/directory` | organization directory search | `200` organization directory page |
| `projects member-set` | `POST /v1/person/projects/members/set` | member-set | `200` immutable mutation receipt |
| `projects member-remove` | `POST /v1/person/projects/members/remove` | member-remove | `200` immutable mutation receipt |
| `projects associate` | `POST /v1/person/projects/context/associate` | association | `200` immutable mutation receipt |
| `projects dissociate` | `POST /v1/person/projects/context/dissociate` | dissociation | `200` immutable mutation receipt |
| `projects feed` | `POST /v1/person/projects/context/feed` | project browse | `200` project feed |
| `projects search` | `POST /v1/person/projects/context/search` | project search | `200` project search page |
| `projects read-context` | `GET /v1/person/projects/{project_id}/context/{context_id}` | none | `200` project context read |
| `updates submit` | `POST /v2/person/updates` | V2 submit | `202` V2 receipt |
| `updates status` | `GET /v2/person/updates/{request_id}` | none | `200` V2 status |
| `updates search` | `POST /v2/person/updates/search` | V2 search | `200` V2 search result |
| `updates read` | `GET /v2/person/updates/content/{context_id}` | none | `200` V2 original read |

Only `projects list` is the capability probe used by the UI. Its `not_found`
response means **Not live yet** only at that capability-probe boundary. A
`not_found` for an individual project or original is deliberately
non-disclosing and must never be converted to a project list, global search,
or an unavailable claim.

## Error and retry mapping

The HTTP error body is always the existing closed envelope
`{ "error": { "code": "...", "message": "..." } }`. A CLI failure writes a
sanitized JSON line to stderr and exits nonzero. A canonical 4xx result for a
mutation is `mutation_outcome: "not_submitted"` and keeps its caller request
ID. A timeout, noncanonical response, malformed response, or 5xx result is
`code: "outcome_unknown"`, `mutation_outcome: "unknown"`, and keeps that same
request ID for status reconciliation or an exact replay. It never gets a new
request ID, retries against V1, converts `project` to `team`, or announces
local success.

V2 is matched-client-only. V1 remains strict and rejects every V2 field; V2
does not fall back to V1 when the Authority does not recognize the V2 path.

## Flag grammar

```text
echo-brain person projects list [--limit <1-10>] [--cursor <opaque-base64url>]
echo-brain person projects create --request-id <uuid> --name <name>
echo-brain person projects read --project-id <project-id>
echo-brain person projects members --project-id <project-id> [--limit <1-10>] [--cursor <opaque-base64url>]
echo-brain person projects directory --project-id <project-id> --query <text> [--limit <1-10>] [--cursor <opaque-base64url>]
echo-brain person directory [--query <text>] [--limit <1-10>] [--cursor <opaque-base64url>]
echo-brain person projects member-set --request-id <uuid> --project-id <project-id> --membership-id <membership-id> --role <member|lead>
echo-brain person projects member-remove --request-id <uuid> --project-id <project-id> --membership-id <membership-id>
echo-brain person projects associate --request-id <uuid> --project-id <project-id> --context-id <context-id>
echo-brain person projects dissociate --request-id <uuid> --project-id <project-id> --context-id <context-id>
echo-brain person projects feed --project-id <project-id> [--limit <1-10>] [--cursor <opaque-base64url>]
echo-brain person projects search --project-id <project-id> --query <text> [--limit <1-10>] [--cursor <opaque-base64url>]
echo-brain person projects read-context --project-id <project-id> --context-id <context-id>
echo-brain person updates submit --request-id <uuid> --title <title> --file <utf8-text-file> [--visibility <only-me|team|project>] [--audience-project-id <project-id>] [--project-id <project-id>]
```

V2 submit defaults to `--visibility only-me`, serializing
`audience: { kind: "only_me" }` and required `project_id: null`. `--visibility
project` requires exactly one `--audience-project-id`; `only-me` and `team`
forbid it. `--project-id` is optional and is the one association coordinate,
independent of the selected audience. It may equal a project audience but is
not inferred from it. The CLI rejects every unsupported or ambiguous flag
combination before HTTP, including an audience-project ID without project
visibility or a second association.

An exact 4xx response means the current attempt was rejected before a new
mutation result. It does not prove that an earlier attempt using the same
request ID did not commit. The client retains the ID and reconciles with status
or an exact replay; it never treats a 409 or an interrupted exchange as proof
that prior state was lost.
