# Organization protocol fixtures

`organization-record-payload-conformance.v1.json` is the shared pin between
this package's organization-record payload contract and the core
`DecisionBrief` validator. Core imports no protocol packages, so this fixture,
not shared runtime code, keeps the two independently owned validators aligned.

Every `valid` case must pass both validators and every `invalid` case must fail
both. `record_only_invalid` names deliberate cases where the protocol contract
is stricter and records that core still accepts them. Tightening either side
without updating the explicit agreement fails its corresponding suite.

The fixture contains meeting and decision data only. It contains no private
key, bearer credential, provider token, transport response, or database row.
