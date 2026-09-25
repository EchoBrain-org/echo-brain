# PC-06 synthetic scenario

`scenario.ts` supplies only invented people and original text. Alice belongs to
Alpha and Beta, Bob to Alpha, Carol to Beta, and Dana initially to neither.
The harness generates opaque project/context identifiers through the real
repository and commits its state to a disposable temporary V7 database.

Run from the PC-06 worktree with its own dependencies and build outputs:

```sh
npm run build
./node_modules/.bin/vitest run --config vitest.config.ts services/organization-authority/test/project-context-integration
```

The synthetic harness exercises frozen codecs, PC-01 transactions, release
audits, keyset cursors, immutable originals/replay, and the enrichment eligibility
adapter. Authentication is a supplied fixture binding. Final-fence races are
same-transaction fault injection. The response timeout happens after a real
repository commit; it is not a network timeout. Restart closes/reopens SQLite,
not the Authority/proxy lifecycle. Enrichment uses a test-only completion seam,
not the runtime worker. Unsupported-client assertions cover frozen codecs and
expected fixtures, not a running CLI or UI.

Table-delta assertions cover the repository's lack of meeting/approval work or
new queue tables. Frozen operation fixtures exclude Ask. Actual runtime
scheduling, record/Ask dispatch, HTTP release, CLI outcome handling and native
UI availability require the committed PC-02 through PC-05 integrations.

Those integrations now have separate application, CLI/HTTP and default-runtime
test files. The CLI/HTTP suite runs the real Person CLI against the loopback
HTTP server. Person authentication/model seams in the CLI suite are fixtures;
the default-runtime test uses real Person session state with synthetic OIDC.
The macOS-only Swift proof that compiled the native session and upload clients
was removed with the Swift app. The evidence ledger distinguishes these layers
from the original synthetic checkpoint and from unexecuted live qualification.

This directory adds fixtures without changing the shared PC-00/PC-01 fixtures.
See the [evidence ledger](../../../docs/operations/project-context-v1/README.md).
