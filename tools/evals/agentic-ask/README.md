# Agentic Ask semantic development cases

[topic-bound-pronouns.execution.v1.json](topic-bound-pronouns.execution.v1.json)
contains three synthetic questions and their corpus. Only this file is runtime
fixture input. The separate
[expectations](topic-bound-pronouns.expectations.v1.json) contain the external
semantic oracle; never load that file into runtime setup, model prompts,
retrieval or cache keys. Both files contain no uploaded user content. This is a
development fixture, not a holdout or qualification result.

The cases check three distinct intents against the same readable corpus:

- pending choices in two named proposal reviews, with an unrelated action
  assigned to the asker available as a distraction;
- the asker's assigned work across projects;
- decisions already approved for the named project.

## Bounded comparison

Compare baseline `1fb665b` with the clean candidate commit using the current
Answer Lab model/spend adapter and each commit's production Ask loop. Do not extend the
frozen A1 450-attempt matrix or use the legacy V3-answer demo evaluator, which
does not support the current V4 response.

1. Pin both product commits, the execution and expectations file hashes, the model and provider policy,
   then build each product checkout. Use the same DeepSeek V3.2/OpenRouter
   settings as the release under investigation; preserve the adapter's spend
   reservations and a total cap of USD 1.
2. Supply identical synthetic evidence through the production loop's existing
   desk port. The fixture gives the synthetic asker all four items and explicitly
   names Jules as the ORBIT action owner. Deterministic test IDs exist only in
   this port fixture; do not write them into databases or search indexes. This
   exercises composition and model behavior, not real approval or authorization.
3. Interleave baseline and candidate, one fresh request per case and commit:
   six Ask attempts total. Use global scope and synthetic `asked_by: Jules`.
   Do not change provider or model mid-run.
4. Retain the same evidence as the existing V3-port attempt capture: request,
   result/error, desk calls, model inputs/outputs, final audit entries and
   citations. Map the oracle IDs to the synthetic desk items before the run.
   Store results in a new private directory with mode 0600 files.
5. Independently grade the meaning of each answer against every required part
   and material failure condition. Inspect the supporting citations and the
   evidence actually shown to the model. Report required parts shown to a
   model, required parts answered, unrelated claims, unsupported approval or
   ownership claims, request time, call count and spend for each attempt.

The existing `loop-dev-run.ts` can override its questions, but its approved
meeting corpus is fixed. These cases use a small desk-port adapter around the
production loop and the existing model/spend adapter; this JSON is not a
directly executable runner configuration. Import the built production code
rather than copying composition into another evaluator.

## Acceptance and limitations

Every candidate case must answer all required parts with supporting fixture
citations and no material failures. The two control cases must retain correct
ownership and approval semantics. A valid JSON response, `outcome: answered`,
or a string match is insufficient. Scripted unit tests prove the evidence and
permission boundaries; they do not prove model compliance with these prompts.

The six-attempt run is a bounded development comparison, not a repeatability,
approval, authorization or deployed-route qualification. A later release still
needs the exact staged candidate's global
and project-scoped review comparison checked semantically, alongside the
operator playbook's existing client, permission and canary checks. Record those
live checks separately; do not mark them passed from this fixture or unit tests.
