# PC-06 synthetic scenario

`scenario.ts` supplies only invented people and original text. Alice belongs to
Alpha and Beta, Bob to Alpha, Carol to Beta, and Dana initially to neither.
The harness generates opaque project/context identifiers through the real
repository and commits its state to a disposable temporary V9 database.

Run from the repository root:

```sh
npm run build
./node_modules/.bin/vitest run --config vitest.config.ts services/organization-authority/test/project-context-integration
```

The synthetic harness drives frozen codecs, PC-01 transactions and the
enrichment eligibility adapter. Authentication is a supplied fixture binding.
Restart closes/reopens SQLite, not the Authority/proxy lifecycle. Enrichment
uses a test-only completion seam, not the runtime worker.

`synthetic.test.ts` keeps one table-delta case: an upload and its enrichment
add no meeting/approval work or new queue tables, and the frozen operation
fixtures exclude Ask. The other synthetic cases were removed after `e5f7e97`
because the SQLite, application and HTTP tests cover them. Actual runtime
scheduling, record/Ask dispatch, HTTP release and CLI outcome
handling require the committed PC-02 through PC-04 integrations.

Those integrations have separate CLI/HTTP and default-runtime test files here.
The application-level cases live in the service's project-context application
tests. The CLI/HTTP suite runs the real Person CLI against the loopback
HTTP server. Person authentication/model seams in the CLI suite are fixtures;
the default-runtime test uses real Person session state with synthetic OIDC.

This directory adds fixtures without changing the shared PC-00/PC-01 fixtures.
