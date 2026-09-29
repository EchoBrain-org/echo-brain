import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { validatePersonAnswerResponseV4 } from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTIC_ASK_ANSWER_RESERVE_MS_V1,
  AGENTIC_ASK_DEADLINE_MS_V1,
  AGENTIC_ASK_MAX_MODEL_CALLS_V1,
  agenticAskContextBudgetBytesV1,
  createAgenticAskV1,
  type AgenticAskAuditEntryV1,
} from "../../src/answer-composition/agentic-ask-v1.js";
import type { StructuredGenerationInput, StructuredGenerationPort } from "../../src/answer-composition/retrieval-grounded-answer-composition.js";
import type { EvidenceDeskItemV1, EvidenceDeskListInputV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from "../../src/shared/evidence-desk-v1.js";

const generation = { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 30_000 };
const checked = "2026-09-27T00:00:00.000Z";

function item(id: string, text: string | undefined = `Released body for ${id}.`, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    receipt_sha256: canonicalSha256({ receipt: id }), ...options,
  });
}

/** An inventory (list) entry: released metadata without text. */
function listedItem(id: string, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  const { text: _text, ...listed } = item(id, "unused", options);
  return Object.freeze(listed);
}

type Desk = EvidenceDeskPortV1 & { search: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; revalidate: ReturnType<typeof vi.fn> };
function desk(input: {
  readonly search?: (query: string) => readonly EvidenceDeskItemV1[];
  readonly inventory?: readonly EvidenceDeskItemV1[];
  readonly list?: (request: EvidenceDeskListInputV1) => readonly EvidenceDeskItemV1[] | EvidenceDeskResultV1;
  readonly open?: (id: string) => readonly EvidenceDeskItemV1[];
  readonly revalidate?: () => Promise<{ readonly checked_at: string }>;
  readonly scope?: EvidenceDeskPortV1["scope"];
} = {}): Desk {
  const result = (items: readonly EvidenceDeskItemV1[], truncated = false): EvidenceDeskResultV1 => ({ items, truncated, receipt_digests: [canonicalSha256({ desk: items.length })] });
  return {
    scope: input.scope ?? { kind: "global" },
    search: vi.fn(async (request: { readonly query?: string }) => request.query === undefined ? result(input.inventory ?? []) : result(input.search?.(request.query) ?? [])),
    open: vi.fn(async (request: { readonly item: string }) => result(input.open?.(request.item) ?? [])),
    list: vi.fn(async (request: EvidenceDeskListInputV1) => {
      const listed = input.list?.(request) ?? input.inventory ?? [];
      return Array.isArray(listed) ? result(listed) : listed as EvidenceDeskResultV1;
    }),
    revalidate: vi.fn(async () => input.revalidate?.() ?? { checked_at: checked }),
  } as unknown as Desk;
}

type Reply = unknown | ((input: StructuredGenerationInput) => unknown);
function scripted(replies: readonly Reply[]) {
  const inputs: StructuredGenerationInput[] = [];
  let offset = 0;
  const model: StructuredGenerationPort = {
    generate: vi.fn(async (input: StructuredGenerationInput) => {
      inputs.push(input);
      const reply = replies[offset++];
      if (reply === undefined) throw new Error(`unscripted call ${offset}`);
      return typeof reply === "function" ? (reply as (input: StructuredGenerationInput) => unknown)(input) : reply;
    }),
  };
  return { model, inputs, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, any> };
}

type NeedSpec = { need?: string; status?: string; evidence?: readonly string[] };
type PartSpec = { question?: string; needs?: readonly NeedSpec[]; notes?: string };
type ActionSpec = { tool: string; args?: Record<string, unknown> };
const step = (parts: readonly PartSpec[], actions: readonly ActionSpec[]) => ({
  parts: parts.map(part => ({
    question: part.question ?? "When is launch?",
    needs: (part.needs ?? [{}]).map(need => ({ need: need.need ?? "launch date", status: need.status ?? "open", evidence: need.evidence ?? [] })),
    notes: part.notes ?? "",
  })),
  actions: actions.map(action => ({ tool: action.tool, args: action.args ?? {} })),
});
const found = (evidence: readonly string[], need = "launch date"): PartSpec => ({ needs: [{ need, status: "found", evidence }] });
const missing = (need = "launch date"): PartSpec => ({ needs: [{ need, status: "not_found" }] });
const finish = (parts: readonly PartSpec[]) => step(parts, [{ tool: "finish" }]);
const search = (query: string): ActionSpec => ({ tool: "search", args: { query } });
const open = (id: string): ActionSpec => ({ tool: "open", args: { id } });
const answer = (sentences: readonly { text: string; evidence: readonly string[] }[], notFound: readonly string[] = []) => ({ sentences, not_found: notFound });

function ask(options: { desk: Desk; model: StructuredGenerationPort; audit?: AgenticAskAuditEntryV1[]; now?: () => number; shortcut?: boolean; context_tokens?: number; asker?: string }) {
  const audit = options.audit ?? [];
  return createAgenticAskV1({
    desk: options.desk, model: options.model, generation: { ...generation, ...(options.context_tokens === undefined ? {} : { context_tokens: options.context_tokens }) }, audit: { append: entry => { audit.push(entry); } },
    today: () => "2026-09-28",
    ...(options.asker === undefined ? {} : { asker: { display_name: options.asker } }),
    ...(options.now === undefined ? {} : { now_ms: options.now }), ...(options.shortcut === true ? { small_scope_shortcut: true } : {}),
  });
}

function slackItem(ts: string, text: string, options: { channel?: string; kind?: "public_channel" | "im"; thread?: string } = {}): EvidenceDeskItemV1 {
  const citation = { kind: "slack_message" as const, team_id: "T0001", channel_id: "C0001", message_ts: ts, ...(options.thread === undefined ? {} : { thread_ts: options.thread }), permalink: `https://acme.slack.com/archives/C0001/p${ts.replace(".", "")}`, text_sha256: canonicalSha256({ text }) };
  return Object.freeze({
    id: `desk_${canonicalSha256(citation).slice(7)}`, citation, kind: "slack_message" as const, text,
    label: `#${options.channel ?? "hw-dvt"} · Priya · 2026-09-26`, visibility: options.kind === "im" ? "only_me" as const : "team" as const,
    occurred_at: "2026-09-26", receipt_sha256: canonicalSha256({ receipt: ts }),
  });
}

describe("agentic Ask: research loop", () => {
  it("searches, finishes, writes one answer, and lays out one cited paragraph", async () => {
    const launch = item("launch", "Launch is approved for Tuesday.");
    const evidence = desk({ search: () => [launch] });
    const audit: AgenticAskAuditEntryV1[] = [];
    const script = scripted([
      step([{}], [search("launch date")]),
      finish([found(["E1"])]),
      answer([{ text: "Launch is Tuesday.", evidence: ["E1"] }]),
    ]);
    const result = await ask({ desk: evidence, model: script.model, audit }).answer({ question: "When is launch?" });

    expect(validatePersonAnswerResponseV4(result)).toEqual(result);
    expect(result.direct).toBeUndefined();
    expect(result).toMatchObject({ outcome: "answered" });
    expect(result.parts).toEqual([{ question: "When is launch?", status: "answered", statements: [{ text: "Launch is Tuesday.", citation_indexes: [0], private: false }] }]);
    expect(result.citations).toEqual([{ citation: launch.citation, kind: "decision", label: "Meeting launch", visibility: "team" }]);
    // Every model call and the release are fenced by a cumulative revalidation.
    expect(evidence.revalidate).toHaveBeenCalledTimes(4);
    expect(audit).toEqual([expect.objectContaining({ outcome: "answered", rounds: 2, model_calls: 3, repairs: 0, citation_count: 1 })]);
    expect(audit[0]!.generations.map(value => value.role)).toEqual(["step", "step", "answer"]);
  });

  it("shows the model only short ids and sources, never desk identities or citations", async () => {
    const launch = item("launch", "Launch is approved for Tuesday.");
    const script = scripted([
      step([{}], [search("launch")]),
      finish([found(["E1"])]),
      answer([{ text: "Launch is Tuesday.", evidence: ["E1"] }]),
    ]);
    await ask({ desk: desk({ search: () => [launch] }), model: script.model }).answer({ question: "When is launch?" });
    for (const input of script.inputs) {
      expect(input.user_prompt).not.toContain(launch.id);
      expect(input.user_prompt).not.toContain(launch.citation.kind === "approved_record" ? launch.citation.atom_id : "");
    }
    expect(script.prompt(1).last_results[0].results[0]).toMatchObject({ id: "E1", source: "meeting", preview: "Launch is approved for Tuesday.", full: true });
    expect(script.prompt(1).plan).toEqual([{ part: 1, question: "When is launch?", notes: "", needs: [{ need: "launch date", status: "open", evidence: [] }] }]);
  });

  it("lists a keyword-free source, opens an item, and cites its full text", async () => {
    const listed = listedItem("plan", { kind: "document_passage", label: "Atlas plan.md" });
    const passage = item("plan", `Atlas plan.md\n${"Background. ".repeat(40)}The launch window is October.`, { kind: "document_passage", label: "Atlas plan.md" });
    const evidence = desk({ list: () => [listed], open: () => [passage] });
    const script = scripted([
      step([{ question: "Summarize this project", needs: [{ need: "project goal" }] }], [{ tool: "list", args: { source: "documents" } }]),
      step([{ question: "Summarize this project", needs: [{ need: "project goal" }] }], [open("E1")]),
      finish([{ question: "Summarize this project", needs: [{ need: "project goal", status: "found", evidence: ["E1"] }] }]),
      answer([{ text: "Atlas launches in October.", evidence: ["E1"] }]),
    ]);
    const result = await ask({ desk: evidence, model: script.model }).answer({ question: "Summarize this project" });
    expect(evidence.list).toHaveBeenCalledWith(expect.objectContaining({ source: "document", limit: 50 }));
    expect(script.prompt(1).last_results[0]).toMatchObject({ tool: "list", source: "document", items: [{ id: "E1", source: "document", title: "Atlas plan.md" }], more: false });
    expect(script.prompt(2).opened[0]).toMatchObject({ id: "E1", text: passage.text });
    expect(evidence.open).toHaveBeenCalledWith(expect.objectContaining({ item: listed.id }));
    expect(result.outcome).toBe("answered");
  });

  it("pages list results by code and filters meeting actions by status", async () => {
    const actions = Array.from({ length: 60 }, (_, index) => listedItem(`action-${index}`, { kind: "action", attributes: { status: index % 2 === 0 ? "open" : "Done" } }));
    const evidence = desk({ list: () => ({ items: actions.slice(0, 50), truncated: false, receipt_digests: [], next_cursor: "page-2" }) });
    const listArgs = { source: "Meetings", status: "open" };
    const script = scripted([
      step([{ needs: [{ need: "open actions" }] }], [{ tool: "list", args: listArgs }]),
      step([{ needs: [{ need: "open actions" }] }], [{ tool: "list", args: listArgs }]),
      finish([{ needs: [{ need: "open actions", status: "not_found" }] }]),
    ]);
    await ask({ desk: evidence, model: script.model }).answer({ question: "What is still open?" });
    expect(evidence.list).toHaveBeenNthCalledWith(1, expect.objectContaining({ source: "meeting", kinds: ["action"] }));
    const first = script.prompt(1).last_results[0];
    expect(first.items).toHaveLength(25);
    expect(first.more).toBe(true);
    // The second call pages past the 25 open actions of the first fetch using the desk cursor.
    expect(evidence.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page-2" }));
  });

  it("keeps actions that record no status, and filters actions by owner", async () => {
    const actions = [
      listedItem("dashboard", { kind: "action", attributes: { owner: "Jules", due_at: "2026-09-11" } }),
      listedItem("addendum", { kind: "action", attributes: { owner: "Colin", due_at: "2026-09-05" } }),
      listedItem("closed", { kind: "action", attributes: { owner: "Jules", status: "done" } }),
      listedItem("unowned", { kind: "action", attributes: { due_at: "2026-09-04" } }),
    ];
    const evidence = desk({ list: () => actions });
    const script = scripted([
      step([{ needs: [{ need: "open actions" }] }], [{ tool: "list", args: { source: "meetings", kind: "action", status: "open" } }, { tool: "list", args: { source: "meetings", owner: "jules" } }]),
      finish([{ needs: [{ need: "open actions", status: "not_found" }] }]),
      finish([{ needs: [{ need: "open actions", status: "not_found" }] }]),
    ]);
    await ask({ desk: evidence, model: script.model }).answer({ question: "What does Jules own?" });
    const [byStatus, byOwner] = script.prompt(1).last_results;
    // An action with no confirmed owner says so; it is never filled in from what it mentions.
    expect(byStatus.items.map((item: { attributes: { owner: string } }) => item.attributes.owner)).toEqual(["Jules", "Colin", "none recorded"]);
    expect(byStatus.note).toContain("do not record open or done");
    expect(byOwner.items.map((item: { attributes: { owner: string } }) => item.attributes.owner)).toEqual(["Jules", "Jules"]);
    expect(evidence.list).toHaveBeenLastCalledWith(expect.objectContaining({ source: "meeting", kinds: ["action"] }));
  });

  it("normalizes list arguments and explains the ones it rejects", async () => {
    const script = scripted([
      step([{}], [
        { tool: "list", args: { source: "slack", channel: "#hw-dvt", since: "7d" } },
        { tool: "list", args: { source: "slack" } },
        { tool: "list", args: { source: "wiki" } },
        { tool: "list", args: { source: "meetings", kind: "ideas" } },
      ]),
      finish([missing()]),
      finish([missing()]),
    ]);
    const evidence = desk();
    await ask({ desk: evidence, model: script.model }).answer({ question: "When is launch?" });
    expect(evidence.list).toHaveBeenCalledTimes(1);
    expect(evidence.list).toHaveBeenCalledWith(expect.objectContaining({ source: "slack", channel: "hw-dvt", since: "2026-09-21" }));
    expect(script.prompt(1).last_results.slice(1)).toEqual([
      expect.objectContaining({ error: expect.stringContaining("slack needs a channel") }),
      expect.objectContaining({ error: expect.stringContaining("\"meetings\", \"documents\" or \"slack\"") }),
      expect.objectContaining({ error: expect.stringContaining("kind must be") }),
    ]);
  });

  it("keeps long search hits as previews until opened, and refuses to cite unread text", async () => {
    const long = item("long", `${"Context. ".repeat(60)}Owner is Colin.`);
    const script = scripted([
      step([{ needs: [{ need: "owner" }] }], [search("owner")]),
      finish([found(["E1"], "owner")]),
      step([found(["E1"], "owner")], [open("E1")]),
      finish([found(["E1"], "owner")]),
      answer([{ text: "Colin owns it.", evidence: ["E1"] }]),
    ]);
    const result = await ask({ desk: desk({ search: () => [long], open: () => [long] }), model: script.model }).answer({ question: "Who owns it?" });
    expect(script.prompt(1).last_results[0].results[0].full).toBe(false);
    expect(script.prompt(2).last_results[0].error).toContain("cites no item whose full text you have read");
    expect(result.outcome).toBe("answered");
  });

  it("previews a long search hit where the query matched, not only its head", async () => {
    const transcript = item("transcript", `Transcript: Calibration\n${"Anika: We reviewed the pilot numbers. ".repeat(12)}Jules: I will publish the dashboard by September 11.\n\nZhen: Thanks.`, { kind: "note", label: "Transcript: Calibration" });
    const unmatched = item("unmatched", `${"Nothing relevant here at all. ".repeat(12)}The end.`);
    const script = scripted([
      step([{ needs: [{ need: "what Jules took on" }] }], [search("Jules dashboard")]),
      finish([missing()]),
      finish([missing()]),
    ]);
    await ask({ desk: desk({ search: () => [transcript, unmatched] }), model: script.model }).answer({ question: "What is Jules working on?" });
    const [hit, other] = script.prompt(1).last_results[0].results;
    expect(hit.full).toBe(false);
    // It starts at a whole word, with some lead before the match.
    expect(transcript.text).toContain(` ${hit.preview.slice(1, 30)}`);
    expect(hit.preview.indexOf("Jules")).toBeGreaterThan(20);
    expect(hit.preview).toContain("Jules: I will publish the dashboard by September 11.");
    expect([...hit.preview].length).toBeLessThanOrEqual(240);
    // No query word: the head, as before.
    expect(other.preview.startsWith("Nothing relevant here")).toBe(true);
    // Later steps keep the matched window for items not yet opened.
    expect(script.prompt(2).seen.find((entry: { id: string }) => entry.id === hit.id).preview).toBe(hit.preview);
  });

  it("rejects a not_found need searched fewer than twice once, then accepts it", async () => {
    const script = scripted([
      step([{}], [search("launch")]),
      finish([missing()]),
      finish([missing()]),
    ]);
    const result = await ask({ desk: desk(), model: script.model }).answer({ question: "When is launch?" });
    expect(script.prompt(2).last_results[0].error).toContain("fewer than two searches or a list");
    expect(result).toMatchObject({ outcome: "not_found", citations: [], parts: [{ status: "not_found", gap: expect.any(String) }] });
    expect(script.inputs).toHaveLength(3); // no answer call without evidence
  });

  it("keeps a need the model silently dropped, so finish names it", async () => {
    const launch = item("launch", "Launch is Tuesday.");
    const script = scripted([
      step([{ needs: [{ need: "launch date" }, { need: "launch owner" }] }], [search("launch")]),
      finish([found(["E1"])]),
      finish([{ needs: [{ need: "launch date", status: "found", evidence: ["E1"] }, { need: "launch owner", status: "not_found" }] }]),
      answer([{ text: "Launch is Tuesday.", evidence: ["E1"] }], ["launch owner"]),
    ]);
    const result = await ask({ desk: desk({ search: () => [launch] }), model: script.model }).answer({ question: "When is launch and who owns it?" });
    expect(script.prompt(2).last_results[0].error).toContain("need \"launch owner\" is still open");
    expect(script.prompt(2).plan[0].needs.map((need: { need: string }) => need.need)).toEqual(["launch date", "launch owner"]);
    expect(result).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not found: launch owner." }] });
  });

  it("returns tool errors for unknown ids and invalid queries instead of failing", async () => {
    const script = scripted([
      step([{}], [open("E99"), search("!!!")]),
      finish([missing()]),
      finish([missing()]),
    ]);
    const evidence = desk();
    await ask({ desk: evidence, model: script.model }).answer({ question: "When is launch?" });
    expect(script.prompt(1).last_results).toEqual([
      expect.objectContaining({ tool: "open", error: expect.stringContaining("unknown id") }),
      expect.objectContaining({ tool: "search", error: expect.stringContaining("keywords") }),
    ]);
    expect(evidence.open).not.toHaveBeenCalled();
  });

  it("does not rerun a search it already ran", async () => {
    const evidence = desk({ search: () => [item("a")] });
    const script = scripted([
      step([{}], [search("launch date")]),
      step([{}], [search("Launch   date")]),
      finish([found(["E1"])]),
      answer([{ text: "Tuesday.", evidence: ["E1"] }]),
    ]);
    await ask({ desk: evidence, model: script.model }).answer({ question: "When is launch?" });
    expect(evidence.search).toHaveBeenCalledTimes(1);
    expect(script.prompt(2).last_results[0].note).toContain("already searched");
  });

  it("stops researching after two steps that find nothing new", async () => {
    const script = scripted([
      step([{}], [search("alpha")]),
      step([{}], [search("beta")]),
      step([{}], [search("gamma")]),
    ]);
    const result = await ask({ desk: desk(), model: script.model }).answer({ question: "When is launch?" });
    expect(script.inputs).toHaveLength(2);
    expect(result.outcome).toBe("not_found");
  });

  it("repairs once with the concrete parser reason and the shape", async () => {
    const script = scripted([
      { answer_parts: [{ question: "When is launch?" }] },
      step([{}], [search("launch")]),
      finish([found(["E1"])]),
      answer([{ text: "Tuesday.", evidence: ["E1"] }]),
    ]);
    const audit: AgenticAskAuditEntryV1[] = [];
    await ask({ desk: desk({ search: () => [item("a")] }), model: script.model, audit }).answer({ question: "When is launch?" });
    expect(script.inputs[1]!.system_prompt).toContain("Your previous reply could not be used: \"parts\" must be an array (got keys \"answer_parts\")");
    expect(script.inputs[1]!.system_prompt).toContain("{\"parts\":[{\"question\"");
    expect(audit[0]).toMatchObject({ repairs: 1, model_calls: 4 });
  });

  it("accepts schema-permitted but untidy output (whitespace, casing, id spellings, A2 input fields)", async () => {
    const script = scripted([
      { parts: [{ question: "  When is launch?  ", needs: [" launch date "], notes: "" }], actions: [{ tool: "Search", input: " launch " }] },
      { parts: [{ question: "When is launch? ", needs: [{ need: "Launch date", status: "Answered", evidence: ["e1", "[E1]"] }], notes: "line one\nline two" }], actions: [{ tool: "finish" }] },
      { sentences: [{ text: " Launch is Tuesday. ", evidence: ["1"] }], not_found: [""] },
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result).toMatchObject({ outcome: "answered", parts: [{ question: "When is launch?", status: "answered", statements: [{ text: "Launch is Tuesday." }] }] });
  });

  it("drops sentences whose evidence is unknown or unread and keeps the rest", async () => {
    const script = scripted([
      step([{}], [search("launch")]),
      finish([found(["E1"])]),
      answer([{ text: "Invented.", evidence: ["E9"] }, { text: "Tuesday.", evidence: ["E1", "E9"] }]),
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result.parts[0]!.statements).toEqual([{ text: "Tuesday.", citation_indexes: [0], private: false }]);
  });

  it("marks sentences private when they cite private evidence", async () => {
    const script = scripted([
      step([{}], [search("launch")]),
      finish([found(["E1"])]),
      answer([{ text: "Tuesday.", evidence: ["E1"] }]),
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a", "Tuesday.", { visibility: "only_me" })] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result.parts[0]!.statements[0]!.private).toBe(true);
  });

  it("reads Slack like any source and cites it with a Slack citation", async () => {
    const record = item("review", "DVT build starts Oct 12.", { label: "DVT review · Sep 24" });
    const slack = slackItem("1758873600.000100", "Vendor says fixtures may slip to Oct 16.", { kind: "im" });
    const script = scripted([
      step([{ needs: [{ need: "approved start" }, { need: "latest vendor date" }] }], [search("DVT fixtures")]),
      finish([{ needs: [{ need: "approved start", status: "found", evidence: ["E1"] }, { need: "latest vendor date", status: "found", evidence: ["E2"] }] }]),
      answer([
        { text: "The Sep 24 review approved a DVT start of Oct 12.", evidence: ["E1"] },
        { text: "In a DM on Sep 26 the vendor said fixtures may slip to Oct 16; no new date is approved.", evidence: ["E2"] },
      ]),
    ]);
    const result = await ask({ desk: desk({ search: () => [record, slack] }), model: script.model }).answer({ question: "Is DVT on track?" });
    expect(script.prompt(1).last_results[0].results[1]).toMatchObject({ id: "E2", source: "slack", kind: "slack_message", date: "2026-09-26", full: true });
    expect(validatePersonAnswerResponseV4(result)).toEqual(result);
    expect(result.citations[1]).toMatchObject({ kind: "slack_message", citation: { kind: "slack_message", channel_id: "C0001" }, visibility: "only_me" });
    expect(result.parts[0]!.statements.map(value => value.private)).toEqual([false, true]);
  });

  it("tells the model when the scope is one project and Slack is not limited to it", async () => {
    const script = scripted([finish([missing()]), finish([missing()])]);
    await ask({ desk: desk({ scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000002" } as EvidenceDeskPortV1["scope"] }), model: script.model }).answer({ question: "When is launch?" });
    expect(script.prompt(0).scope).toContain("Slack is not");
  });

  it("tells every call who is asking and today's date, and no audit keeps the name", async () => {
    const launch = item("launch", "Jules owns the vendor follow-up, due Oct 3.");
    const audit: AgenticAskAuditEntryV1[] = [];
    const script = scripted([
      step([{}], [search("Jules actions")]),
      finish([found(["E1"])]),
      answer([{ text: "You own the vendor follow-up, due Oct 3.", evidence: ["E1"] }]),
    ]);
    await ask({ desk: desk({ search: () => [launch] }), model: script.model, audit, asker: "  Jules Moreau " }).answer({ question: "What do I owe this week?" });
    for (const index of [0, 1, 2]) expect(script.prompt(index)).toMatchObject({ asked_by: "Jules Moreau", today: "2026-09-28" });
    expect(JSON.stringify(audit)).not.toContain("Jules");
  });

  it.each([["an empty name", "  "], ["a control character", "Jules\u0007"], ["an overlong name", "J".repeat(201)]])("leaves out %s, and says only today's date", async (_label, name) => {
    const script = scripted([finish([missing()]), finish([missing()])]);
    await ask({ desk: desk({}), model: script.model, asker: name }).answer({ question: "What do I owe?" });
    expect(script.prompt(0)).not.toHaveProperty("asked_by");
    expect(script.prompt(0).today).toBe("2026-09-28");
  });

  it("sizes the scratchpad from the model's context window", async () => {
    expect(agenticAskContextBudgetBytesV1(131_072, "x".repeat(9_000), 1_500)).toBeGreaterThan(300_000);
    expect(agenticAskContextBudgetBytesV1(undefined, "", 1_500)).toBeLessThan(90_000);
    const passages = Array.from({ length: 12 }, (_, index) => item(`p${index}`, `${index} `.repeat(1_400).trim(), { kind: "document_passage" }));
    const actions = passages.map((_, index) => open(`E${index + 1}`));
    const script = scripted([
      step([{}], [search("atlas")]),
      step([{}], actions.slice(0, 4)), step([{}], actions.slice(4, 8)), step([{}], actions.slice(8, 12)),
      finish([missing()]), finish([missing()]),
      answer([{ text: "x.", evidence: ["E1"] }]),
    ]);
    const evidence = desk({ search: () => passages, open: id => passages.filter(value => value.id === id) });
    await ask({ desk: evidence, model: script.model, context_tokens: 16_000 }).answer({ question: "When is launch?" });
    // A small window cannot hold 12 opened passages of about 3 KB each; the rest shrink back to previews.
    const shown = script.prompt(4).opened.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(12);
    expect(script.prompt(4).seen.length).toBe(12 - shown);
  });
});

describe("agentic Ask: failures never lose found evidence", () => {
  const unavailable = () => Object.assign(new Error("OpenRouter request failed"), { diagnostic: { failure_class: "adapter_timeout" } });

  it("shows cited records when the answer call fails twice", async () => {
    const script = scripted([
      step([{}], [search("launch")]),
      finish([found(["E1"])]),
      { wrong: true }, { still: "wrong" },
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a", "Launch is Tuesday.")] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: "Launch is Tuesday.", citation_indexes: [0] }] }] });
  });

  it("shows the most recently opened records when the answer fails and nothing was cited", async () => {
    const passage = item("plan", "Atlas launches in October.", { kind: "document_passage" });
    const script = scripted([
      step([{ question: "Summarize this project" }], [search("atlas")]),
      step([{ question: "Summarize this project" }], [open("E1")]),
      () => { throw unavailable(); },
      () => { throw unavailable(); },
      { wrong: true }, { still: "wrong" },
    ]);
    const result = await ask({ desk: desk({ search: () => [passage], open: () => [passage] }), model: script.model }).answer({ question: "Summarize this project" });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: "Atlas launches in October." }] }] });
  });

  it("retries a timed-out research step once unchanged, then answers from what was found", async () => {
    const script = scripted([
      step([{}], [search("launch")]),
      () => { throw unavailable(); },
      () => { throw unavailable(); },
      answer([{ text: "Tuesday.", evidence: ["E1"] }]),
    ]);
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model, audit }).answer({ question: "When is launch?" });
    expect(result.outcome).toBe("answered");
    expect(script.inputs[2]!.system_prompt).toBe(script.inputs[1]!.system_prompt);
    expect(audit[0]).toMatchObject({ outcome: "answered", fallbacks: 1, repairs: 1, model_calls: 4 });
  });

  it("opens by title when the model passes a seen title instead of an id", async () => {
    const listed = listedItem("mrd", { kind: "document_passage", label: "SCOUT-MRD-v0.1.md" });
    const passage = item("mrd", "SCOUT is an indoor courier robot.", { kind: "document_passage", label: "SCOUT-MRD-v0.1.md" });
    const evidence = desk({ list: () => [listed], open: () => [passage] });
    const script = scripted([
      step([{}], [{ tool: "list", args: { source: "documents" } }]),
      step([{}], [open("SCOUT-MRD-v0.1")]),
      finish([found(["E1"])]),
      answer([{ text: "An indoor courier robot.", evidence: ["E1"] }]),
    ]);
    await ask({ desk: evidence, model: script.model }).answer({ question: "What is SCOUT?" });
    expect(evidence.open).toHaveBeenCalledWith(expect.objectContaining({ item: listed.id, neighbours: 2 }));
    expect(script.prompt(2).last_results[0]).toMatchObject({ tool: "open", opened: ["E1"] });
  });

  it("keeps research inside its budget so the answer always has its reserve", async () => {
    let clock = 0;
    const timeouts: Array<{ role: string; timeout: number; at: number }> = [];
    const model: StructuredGenerationPort = {
      generate: vi.fn(async (input: StructuredGenerationInput) => {
        const role = input.system_prompt.startsWith("You write") ? "answer" : "step";
        timeouts.push({ role, timeout: input.timeout_ms, at: clock });
        if (role === "answer") { clock += 5_000; return answer([{ text: "Tuesday.", evidence: ["E1"] }]); }
        // A slow provider: every research step runs to its timeout.
        clock += input.timeout_ms;
        if (timeouts.length === 1) return step([{}], [search("launch")]);
        throw unavailable();
      }),
    };
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model, audit, now: () => clock }).answer({ question: "When is launch?" });
    expect(result.outcome).toBe("answered");
    for (const call of timeouts.filter(value => value.role === "step")) expect(call.at + call.timeout).toBeLessThanOrEqual(AGENTIC_ASK_DEADLINE_MS_V1 - AGENTIC_ASK_ANSWER_RESERVE_MS_V1);
    expect(timeouts.at(-1)!.role).toBe("answer");
    expect(audit[0]!.outcome).toBe("answered");
  });

  it("never exceeds the model-call budget under repeated invalid output", async () => {
    const model: StructuredGenerationPort = { generate: vi.fn(async () => ({ nonsense: true })) };
    const result = await ask({ desk: desk(), model }).answer({ question: "When is launch?" });
    expect((model.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(AGENTIC_ASK_MAX_MODEL_CALLS_V1);
    expect(result.outcome).toBe("not_found");
  });

  it("treats a revalidation failure as terminal and never falls back around it", async () => {
    let checks = 0;
    const evidence = desk({ search: () => [item("a")], revalidate: async () => { checks += 1; if (checks === 2) throw new Error("membership revoked"); return { checked_at: checked }; } });
    const audit: AgenticAskAuditEntryV1[] = [];
    const script = scripted([step([{}], [search("launch")]), finish([found(["E1"])])]);
    await expect(ask({ desk: evidence, model: script.model, audit }).answer({ question: "When is launch?" })).rejects.toThrow("membership revoked");
    expect(script.inputs).toHaveLength(1);
    expect(audit).toEqual([]);
  });

  it("audits a hung model at the hard deadline as timed_out", async () => {
    vi.useFakeTimers();
    try {
      const audit: AgenticAskAuditEntryV1[] = [];
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const model: StructuredGenerationPort = { generate: vi.fn(async () => { entered(); return new Promise<never>(() => undefined); }) };
      const pending = ask({ desk: desk(), model, audit }).answer({ question: "When is launch?" });
      await started;
      const rejected = expect(pending).rejects.toMatchObject({ name: "AgenticAskDeadlineErrorV1" });
      await vi.advanceTimersByTimeAsync(AGENTIC_ASK_DEADLINE_MS_V1);
      await rejected;
      expect(audit).toEqual([expect.objectContaining({ outcome: "timed_out", model_calls: 1, prompt_sha256: null, response_sha256: null })]);
    } finally { vi.useRealTimers(); }
  });

  it("does not publish after cancellation and writes a cancelled audit", async () => {
    const controller = new AbortController();
    const audit: AgenticAskAuditEntryV1[] = [];
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const model: StructuredGenerationPort = { generate: vi.fn(async () => { entered(); return new Promise<never>(() => undefined); }) };
    const pending = ask({ desk: desk(), model, audit }).answer({ question: "When is launch?", signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(audit.at(-1)).toMatchObject({ outcome: "cancelled", model_calls: 1, generations: [{ role: "step", finish_reason: null, usage: null }] });
  });
});

describe("agentic Ask: small-scope preload", () => {
  it("opens a small complete scope before step 1 so the model can finish at once", async () => {
    const listed = [listedItem("a"), listedItem("b")];
    const opened = new Map([[listed[0]!.id, item("a", "Full text A.")], [listed[1]!.id, item("b", "Full text B.")]]);
    const evidence = desk({ inventory: listed, open: id => [opened.get(id)!] });
    const script = scripted([
      finish([found(["E1"])]),
      answer([{ text: "A.", evidence: ["E1"] }]),
    ]);
    const result = await ask({ desk: evidence, model: script.model, shortcut: true }).answer({ question: "When is launch?" });
    expect(evidence.search).toHaveBeenCalledWith(expect.objectContaining({ inventory_mode: "items" }));
    expect(script.prompt(0).opened.map((value: { text: string }) => value.text)).toEqual(expect.arrayContaining(["Full text A.", "Full text B."]));
    expect(result.outcome).toBe("answered");
  });
});
