# Ask Answer Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask answers read like a short document: a lead, sections, bullets and tables, citations beside each claim, sources collapsed, a quiet coverage note.

**Architecture:** The statements stay the cited claims. A V8 answer part may carry `layout` (answer layout v1, ADR-0045): blocks that group the part's statements in order. The client asks for it with `x-echo-answer-layout: 1`; the writer marks each sentence's form and section; code checks citations as before, tabulates list statements, and builds the layout; the desktop renders blocks with its own typography.

**Tech Stack:** TypeScript, vitest, Preact (desktop renderer), Electron.

**Spec:** `docs/decisions/ADR-0045-ask-answer-layout.md` and the "Ask Answer Format" design canvas (https://claude.ai/artifact/4YzoHaKTmbsv5RZkpepi4E): Today, Proposed, Building blocks, Structure fits the question.

## Global Constraints

- Contract (done, Task 0): `packages/organization-api/src/person-answer-layout-v1.ts`. Block kinds `lead | heading | paragraph | bullets | table`; every statement in exactly one block, in order; a lead first, 1–2 statements; a heading never last and never followed by a heading; at most 6 headings and 24 blocks; bullets ≥ 2 statements; table 2–6 unique columns (≤ 100 bytes), 1–25 rows, one cell per column (≤ 300 bytes, may be empty, not all empty), each row cites 1–40 indexes, all among its statements' citations, and the rows together cite all of them; optional caption ≤ 600 bytes. All text single-line, NFC, trimmed.
- Header `x-echo-answer-layout` (`PERSON_ASK_ANSWER_LAYOUT_HEADER_V1`), value `1`. Absent = no layout; any other value = `invalid_request`.
- Layout only on the V8 answer (`/v7/person/ask`), only when asked, only on a part with statements (`answered`/`partial`). Without the header the response is unchanged in shape.
- Statement text, citations, privacy, W1–W6 (ADR-0041) unchanged. Layout adds no claim and no citation.
- Desktop typography (design canvas, Building blocks): lead 18/1.5, first statement 500, second 400; heading 14/600, 26 px above (within the answer's gap), 2 below; bullets 15/1.6, 8 between, 5 px faint dot; table 13.5, header 12 faint, ISO dates in mono shown as "Oct 14"; citation chip 16 px tall, mono 10, 6 px after the claim; sources one collapsed line ("4 sources · name · name"), 44 px tall; coverage note 12.5 faint with an info mark, after the answer. Signal colour only for a late due date of the asker's own row.
- Copy and code comments follow the repo's plain style. No em dashes in new UI copy.
- Implementer and reviewer subagents run on Opus.

## Review Focus

- A writer reply with forms but a statement later dropped (W1, repeat, fit): the layout must still cover exactly the kept statements, in order.
- A list statement whose names cover several members ("and N more"): the table's rows cite exactly the statement's citations; the caption says how many are not shown.
- An answer that must shrink to its 64 KiB bound: compaction drops `layout` and the answer still validates.
- An old Authority (no layout) on the new desktop, and the new Authority without the header: both render exactly as today, notices as the quiet coverage note.
- A table on a phone-width window: it scrolls in its own box; the page never scrolls sideways.

---

### Task 0: Contract (done on `feat/ask-answer-layout`)

`person-answer-layout-v1.ts`, `person-answer-v4.ts` (V8 part accepts `layout`), test `packages/organization-api/test/person-answer-layout-v1.test.ts`, ADR-0045, option stubs `CreateAskRendererV1Options.layout` and `AgenticAskOptions.answer_layout` (passed as `layout: responseVersion === 8 && options.answer_layout === true`).

### Task A: Writer forms and the layout (kernel)

**Files:**
- Modify: `packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1-model-protocol.ts` (answerSchema, AnswerSentence, Answer, parseAnswer, ANSWER_PROMPT)
- Modify: `packages/organization-authority-kernel/src/answer-composition/agentic-list-evidence-v1.ts` (`agenticListStatementV1` also returns `caption` and its name groups)
- Modify: `packages/organization-authority-kernel/src/answer-composition/renderers/ask-renderer-v1.ts`
- Create: `packages/organization-authority-kernel/src/answer-composition/renderers/ask-layout-v1.ts` (pure layout builder)
- Test: `packages/organization-authority-kernel/test/answer-composition/renderers/ask-layout-v1.test.ts`, `.../renderers/ask-renderer-v1.test.ts`, the protocol's parse tests

**Interfaces:**
- Consumes: `PersonAnswerBlockV1`, `validatePersonAnswerLayoutV1` (Task 0); `options.layout`.
- Produces: `AnswerSentence = { text; evidence; form?: "lead" | "bullet" | "row"; section?: string; cells?: readonly string[] }`; `Answer.tables: readonly { section: string; columns: readonly string[] }[]`; `buildAskLayoutV1(statements: readonly AskLayoutStatementV1[]): readonly PersonAnswerBlockV1[]` where `AskLayoutStatementV1 = { citation_indexes: readonly number[]; shape: { kind: "lead" | "text" | "bullet" } & { section?: string } | { kind: "row"; section?: string; columns: readonly string[]; cells: readonly string[] } | { kind: "list"; caption: string; columns: readonly string[]; rows: readonly { cells: readonly string[]; citation_indexes: readonly number[] }[] } }`.

Writer schema (strict-mode compatible, optional properties as `listUse` already has): each sentence `{text, evidence, form?: "lead"|"text"|"bullet"|"row", section?: ≤ 60 chars, cells?: ≤ 6 strings ≤ 120 chars}`; top level `tables?: ≤ 3 × {section ≤ 60, columns: 2–6 strings ≤ 40}`. Parse: unknown form → text; `text` form → no `form`; a `row` whose section declares no table → `bullet`; a `row` with empty text gets `"<column>: <cell>; …."` from its non-empty cells; cells padded or cut to the columns (counted with `observeCoreModelCorrectionV1`).

Prompt: one new bullet group under "Write a direct answer": the lead is the conclusion in one or two sentences (`form: "lead"`); `section` only when the answer covers two or more distinct topics; `bullet` for parallel items; `row` with `cells` under a declared table for three or more items sharing owner, date or status fields; a sentence still cites its evidence whatever its form; never a form for list members code states. Update the reply example to show `form` and `section`.

Renderer, when `options.layout` (V8 only): order the layout entries before the fit loop: writer leads (first two; later leads become text), then list statements, then the other writer sentences grouped by section in order of first appearance (unsectioned first). With no writer lead, the first unsectioned text sentence is the lead. A list statement naming two or more names becomes a `list` shape: columns `Item` then whichever of `Status`, `Owner`, `Due` any named member records (fewer than two columns → plain text shape); one row per name (a name covering several members cites all of them); caption = the statement's count phrase, plus "; and N more" when names do not cover every selected member. After the fit loop build the layout from the kept statements: lead block; a heading at each section's first block; consecutive bullets ≥ 2 → bullets (one → paragraph); consecutive text → one paragraph; consecutive rows of one section → one table; each list → its own table. Validate with `validatePersonAnswerLayoutV1` (the response validator does). Headings past 6 fold into the previous section. Never a layout on records_only or not_found.

- [ ] Write failing tests: `buildAskLayoutV1` for the THERM shape (lead, Decisions bullets, table) and each rule above; `parseAnswer` keeps forms, sections, cells, tables and converts as stated; the renderer with `layout: true` returns a V8 part whose `layout` validates, leads first; with `layout: false` the response has no `layout` and its statements equal today's for the same reply; a list of 3 tickets renders as one table with caption and per-row citations; a reply that does not fit 64 KiB drops `layout`.
- [ ] Run them, see them fail.
- [ ] Implement.
- [ ] Run `npx vitest run packages/organization-authority-kernel` (after `npm run build`); update pinned prompt or baseline expectations only where the prompt text changed.
- [ ] Commit `feat(kernel): the writer marks forms and Ask lays its answer out (ADR-0045)`.

### Task B: Ask for layout on the wire (authority and client)

**Files:**
- Modify: `services/organization-authority/src/presentation/organization-authority-http-server.ts` (read the header beside `askTimeContext`; invalid → `invalid_request`)
- Modify: the Ask HTTP applications and `services/organization-authority/src/composition/person-live-answer-route-v1.ts` (and any route that passes `time_context` to the agentic Ask) to pass `answer_layout`
- Modify: `src/product/person-client/authority-client.ts` (`askHeaders` sends `x-echo-answer-layout: 1`)
- Test: the authority's Ask HTTP tests and `tests/person-client/*`

**Interfaces:**
- Consumes: `validatePersonAskAnswerLayoutHeaderV1`, `PERSON_ASK_ANSWER_LAYOUT_HEADER_V1`, `PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V1` (Task 0); `AgenticAskOptions.answer_layout` (Task 0).
- Produces: every Ask the person client sends carries the header; the `/v7` route passes `answer_layout: true` to the agentic Ask exactly when the header is `1`.

- [ ] Write failing tests: the client's Ask requests (plain and progress) send the header; the authority passes `answer_layout: true` with the header and `false`/absent without it; an invalid header value is refused as `invalid_request` before the Ask runs.
- [ ] Run, see them fail. Implement. Run the touched suites.
- [ ] Commit `feat(authority,client): ask for answer layout on every Ask (ADR-0045)`.

### Task C: Render the layout (desktop)

**Files:**
- Modify: `product/echo-desktop/src/shared/protocol.ts` (`AnswerPart.layout?: readonly AnswerBlock[]`, mirroring `PersonAnswerBlockV1`)
- Modify: `product/echo-desktop/src/renderer/screens/ask.tsx` (`AgenticAnswer`, `SourceList`, coverage note), `product/echo-desktop/src/renderer/answer.ts` (`answerMarkdown`, row ids), `product/echo-desktop/src/renderer/store.ts` (`copyAnswer`, source pane focus for table rows), `product/echo-desktop/src/renderer/styles.css`
- Modify: `product/echo-desktop/src/host/test-authority.ts` (a THERM-like answer with layout when the request carries the header)
- Test: `product/echo-desktop/test/unit/*` (renderer and views), one Playwright e2e if the harness allows

**Interfaces:**
- Consumes: the V8 part's `layout` as the host's validated answer carries it (Task 0 types).
- Produces: `answerMarkdown(answer: Answer, sourceNames: readonly string[]): string` (Markdown: lead paragraph, `### heading`, `- bullet`, GFM tables, `[n]` after each claim, a Sources list).

Rendering: a part with `layout` renders its blocks; without it, exactly as today. Lead, heading, paragraph (statements inline as one prose paragraph, each still lit on its own), bullets, table (caption above; a table that opens the answer with no lead shows its caption in lead type; markers in the first cell from the row's citations; ISO dates as "Oct 14" in mono; a late due date of the asker's own row in signal text; the table scrolls in its own box). Each statement and each row can open the source pane and be lit, like a statement today. Sources: collapsed to one toggle line by default, opened by a click or when a citation opens the pane. `notice` and `gap` render as one quiet coverage note after the answer (keep their test ids); `assumption` and the off-scope banner stay on top. Copy answer writes `answerMarkdown`.

- [ ] Write failing unit tests for each rendering rule, the collapsed sources, the coverage note's place, `answerMarkdown`, and the fixture's layout over the host's validator.
- [ ] Run, see them fail. Implement. Run the desktop's unit tests and typecheck.
- [ ] Commit `feat(desktop): render Ask answers by their layout (ADR-0045)`.

### Task D: Integrate and verify (integration owner)

- [ ] Merge A, B, C into `feat/ask-answer-layout` (disjoint files).
- [ ] One end-to-end test: a `/v7` Ask over HTTP with the header and a stubbed writer reply with forms returns a laid-out V8 answer that the person client and the desktop's `answerView` accept.
- [ ] Whole-branch review on Opus; fix findings.
- [ ] `npm run check` and the desktop's check, once, on the final candidate. Draft PR.
