# Qualification and evidence

Qualification proves that an exact source, artifact, configuration, state
generation, and environment passed an exact matrix. It is distinct from CI,
deployment, and release.

## Reusable matrices and immutable runs

- A **qualification matrix** is living documentation. It states the cases a
  capability or component must pass.
- A **qualification report** is immutable. It records one run against exact
  identities and links the evidence for each assertion.
- A **raw receipt** is bounded proof from the run. Private receipts remain in
  access-controlled storage.

Use the [qualification matrix template](../_templates/qualification-matrix.md)
and [qualification report template](../_templates/qualification.md). Matrix
front matter and its table carry the same assertion IDs; completed reports
must record an outcome and evidence for that exact assertion set.

Current indexes and matrices:

- [Sanitized private evidence index](evidence-index.md)
- [Provider adapter adversarial matrix V1](adapter-matrix-v1.md)
- [Job A stopped-state matrix V1](job-a-stopped-matrix-v1.md)
- [Job A stopped-state proof](QUAL-20260813-174902-001-job-a-stopped.md)

## Evidence index rules

A tracked evidence entry contains only sanitized metadata:

- stable qualification and assertion IDs;
- source commit and artifact digest;
- configuration or state-generation identity when relevant;
- result;
- opaque evidence ID and SHA-256 digest;
- sensitivity class;
- verification date and actor.

Do not copy provider payloads, secrets, credentials, personal content, real
receipt filenames, local paths, private object keys, instance IDs, volume IDs,
or resolver mappings into tracked documentation.

One receipt proves only its named assertions. A stopped-state assertion is not
the same as a qualification run that halted. Each report separately records
run completion, overall result, stop reason where applicable, and per-assertion
outcomes. A stopped-state proof does not automatically prove every failure
pattern discovered during the wider run.

## Status vocabulary

Use explicit claims: `source-tested`, `artifact-tested`, `deployed`,
`founder-live-qualified`, `client-live-qualified`, or `released`. Never use
`done` or `landed` as a substitute for these distinctions.
