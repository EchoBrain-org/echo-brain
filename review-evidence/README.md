Evidence for [the diagnosis](../REVIEW.md), pinned to landed main `3b663a74ec5d64e2f99b80ca590429df1415e02d`.

- `scope.json`: source identity, review bounds, and validation limits.
- `landed-commits.tsv`: all 68 first-parent landing commits in the window.
- `changed-files.tsv`: complete base-to-head changed-path inventory.
- `ci.json`: latest ten main runs and selected job/step/suite timing evidence from GitHub.
- `validation.txt`: local gate outcome and test summary from a separate clean checkout of the pinned source.
- `provider-probes.jsonl`: actual offline validator and telemetry-parser results.
- `boundary-probe.jsonl`: baseline checker success and the eight violations exposed by classifying existing shared files as neutral.
- `dead-references.txt`: reference search for the unused V1 writer and installation-era API types.

The probe source files have `.txt` suffixes so they do not join the product's runtime or test suite. To repeat them, install dependencies and build in this worktree, then run:

```sh
node --input-type=module < review-evidence/provider-probes.mjs.txt
python3 review-evidence/boundary-probe.py.txt
```

The first script uses synthetic values and emits observations. It intentionally shows the current rejection of a different provider rather than asserting that today's closed schemas accept it. The second extracts the pinned commit to a temporary directory and changes only that copy's manifest, then deletes the copy.

These are architecture probes, not a real-provider qualification. They make no AWS, staging, or external-provider calls. Successful extraction later overwrites normalized token counts, so the shared-parser probe alone does not establish broken successful Ollama extraction.
