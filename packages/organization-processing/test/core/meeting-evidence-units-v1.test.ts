import { describe, expect, it } from "vitest";
import type { MeetingContentBlock, MeetingDocument } from "../../src/core/contracts/meeting.js";
import {
  buildMeetingEvidenceV1,
  localDateV1,
  type MeetingEvidenceUnitV1,
} from "../../src/core/processing/meeting-evidence-units-v1.js";

function meeting(content: readonly MeetingContentBlock[], extra: Partial<MeetingDocument> = {}): MeetingDocument {
  return {
    schema_version: 1,
    id: "fixture:meeting-1",
    provenance: {
      source: { kind: "meeting-source", adapter_id: "fixture", instance_id: "primary", version: "1.0.0" },
      external_id: "meeting-1",
      canonical_revision: "sha256:fixture",
      observed_at: "2026-10-10T00:00:00.000Z",
      normalizer_version: "1.0.0",
    },
    capture: { state: "complete", components: [] },
    participants: [],
    content,
    artifacts: [],
    ...extra,
  };
}

function block(id: string, kind: MeetingContentBlock["kind"], text: string, extra: Partial<MeetingContentBlock> = {}): MeetingContentBlock {
  return { id, kind, text, ...extra };
}

function units(content: readonly MeetingContentBlock[], extra: Partial<MeetingDocument> = {}): readonly MeetingEvidenceUnitV1[] {
  return buildMeetingEvidenceV1(meeting(content, extra)).units;
}

const englishTurn = Array.from({ length: 14 }, (_, index) => `Sentence ${index + 1} covers one launch risk in detail.`).join(" ");
const chineseTurn = "我们决定下周发布测试版本并通知所有客户。".repeat(35);

const mixed = meeting([
  block("t1", "transcript", "(recording started)\nAlice: Ship Friday.\n  more detail  \nBob: Agreed.\n\nBob: I will tell support.\n"),
  block("t2", "transcript", `  ${chineseTurn}  `, { speaker_participant_id: "p1" }),
  block("t3", "transcript", `Alice: ${englishTurn}`),
  block("n1", "note", "# Decisions\n- Ship **beta**\u0085Friday\n\n   1) Tell support   \n"),
  block("s1", "summary", "## Summary\nThe team agreed to ship. Any concerns?\n"),
], { participants: [{ id: "p1", display_name: "Alice" }] });

describe("buildMeetingEvidenceV1", () => {
  it("keeps every unit an exact trimmed slice of its block, deterministically", () => {
    const evidence = buildMeetingEvidenceV1(mixed);
    expect(evidence.units.length).toBeGreaterThan(8);
    const blocks = new Map(mixed.content.map((entry) => [entry.id, entry.text]));
    for (const unit of evidence.units) {
      expect(unit.text).toBe(blocks.get(unit.block_id)?.slice(unit.start, unit.end));
      expect(unit.text.length).toBeGreaterThan(0);
      expect(unit.text).toBe(unit.text.trim());
      expect(unit.display).not.toMatch(/\s{2}|\n|\u0085/);
    }
    expect(buildMeetingEvidenceV1(mixed)).toEqual(evidence);
  });

  it("parses Label: turns, continuation lines, and same-speaker merges, ignoring times and URLs", () => {
    const text = [
      "(recording started)",
      "Alice: We should ship Friday.",
      "that gives QA two days",
      "Bob: Agreed.",
      "",
      "Bob: I will tell support.",
      "10:30 we reconvene",
      "Carol: Notes are at",
      "http://x.test/plan: the launch doc",
      "and x.test/faq: answers",
      "Dana: 🚀 Launch it",
    ].join("\n");
    const result = units([block("t1", "transcript", text)]);
    expect(result.map(({ id, speaker, display }) => ({ id, speaker, display }))).toEqual([
      { id: "T1", speaker: null, display: "(recording started)" },
      { id: "T2", speaker: "Alice", display: "We should ship Friday. that gives QA two days" },
      { id: "T3", speaker: "Bob", display: "Agreed. I will tell support. 10:30 we reconvene" },
      { id: "T4", speaker: "Carol", display: "Notes are at http://x.test/plan: the launch doc and x.test/faq: answers" },
      { id: "T5", speaker: "Dana", display: "🚀 Launch it" },
    ]);
    expect(result[2]?.text).toBe("Agreed.\n\nBob: I will tell support.\n10:30 we reconvene");
    expect(result[1]?.start).toBe(text.indexOf("We should"));
  });

  it("merges same-speaker turns only while the merged body stays within 400 characters", () => {
    const text = [`Dana: ${"a".repeat(199)}`, `Dana: ${"b".repeat(200)}`, "Dana: c", "Eli: d", "Dana: e"].join("\n");
    const result = units([block("t1", "transcript", text)]);
    expect(result.map(({ id, speaker, display }) => [id, speaker, display.length])).toEqual([
      ["T1", "Dana", 400],
      ["T2", "Dana", 1],
      ["T3", "Eli", 1],
      ["T4", "Dana", 1],
    ]);
  });

  it("treats a speaker-attributed block as one turn named by the participant", () => {
    const result = units([
      block("t1", "transcript", "Bob: not a label here\nsecond line", { speaker_participant_id: "p1" }),
      block("t2", "transcript", "Hello.", { speaker_participant_id: "p2" }),
      block("t3", "transcript", "Hi.", { speaker_participant_id: "p9" }),
    ], { participants: [{ id: "p1", display_name: "Alice" }, { id: "p2" }] });
    expect(result.map(({ id, speaker, text }) => [id, speaker, text])).toEqual([
      ["T1", "Alice", "Bob: not a label here\nsecond line"],
      ["T2", "p2", "Hello."],
      ["T3", "p9", "Hi."],
    ]);
  });

  it("splits long English and Chinese turns at sentence ends into numbered parts", () => {
    const result = units([
      block("t1", "transcript", `Alice: ${englishTurn}\nBob: Short.`),
      block("t2", "transcript", chineseTurn, { speaker_participant_id: "p1" }),
    ], { participants: [{ id: "p1", display_name: "Wei" }] });
    const english = result.filter((unit) => unit.id.startsWith("T1."));
    const chinese = result.filter((unit) => unit.id.startsWith("T3."));
    expect(english.map((unit) => unit.id)).toEqual(["T1.1", "T1.2"]);
    expect(english.map((unit) => unit.display).join(" ")).toBe(englishTurn);
    expect(english.every((unit) => unit.text.length <= 400 && unit.text.endsWith(".") && unit.speaker === "Alice")).toBe(true);
    expect(result.find((unit) => unit.id === "T2")?.display).toBe("Short.");
    expect(chinese.map((unit) => [unit.id, unit.text.length, unit.speaker])).toEqual([["T3.1", 400, "Wei"], ["T3.2", 300, "Wei"]]);
    expect(chinese.every((unit) => unit.text.endsWith("。"))).toBe(true);
  });

  it("caps every unit at 600 characters, splitting at whitespace, else between code points", () => {
    const words = `Alice: ${"word ".repeat(400).trim()}`;
    const unbroken = `${"x".repeat(399)}${"🚀".repeat(800)}`;
    const result = units([
      block("t1", "transcript", words),
      block("t2", "transcript", unbroken),
      block("t3", "transcript", `Dana: a${" ".repeat(700)}\nDana: b`),
      block("n1", "note", `- Short line\n- ${"note ".repeat(140).trim()}`),
    ]);
    expect(result.every((unit) => unit.text.length <= 600 && !/\p{Cs}/u.test(unit.text))).toBe(true);
    expect(result.filter((unit) => unit.block_id === "t1").every((unit) => /^(?:word ?)+$/u.test(unit.text) && unit.text.endsWith("word"))).toBe(true);
    expect(result.filter((unit) => unit.block_id === "t1")).toHaveLength(5);
    expect(result.filter((unit) => unit.block_id === "t2").map((unit) => unit.text.length)).toEqual([399, 400, 400, 400, 400]);
    expect(result.filter((unit) => unit.kind === "note").map((unit) => unit.id)).toEqual(["N1", "N2.1", "N2.2"]);
  });

  it("splits a long run of periods in linear time", () => {
    const startedAt = performance.now();
    const result = units([block("n1", "note", `${".".repeat(40_000)}a`)]);
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(result.map((unit) => unit.text).join("")).toBe(`${".".repeat(40_000)}a`);
  });

  it("splits notes into lines with heading sections and without bullet markers", () => {
    const text = "# Decisions\n- Ship **beta** Friday\n* Keep scope\n\n## **Follow-ups**\n1. Dana updates docs\n  2) Eli books room\n• Confirm budget\n-\nPlain line";
    const result = units([block("n1", "note", text), block("n2", "note", "Next block line")]);
    expect(result.map(({ id, text: unitText, section }) => [id, unitText, section])).toEqual([
      ["N1", "Ship **beta** Friday", "Decisions"],
      ["N2", "Keep scope", "Decisions"],
      ["N3", "Dana updates docs", "Follow-ups"],
      ["N4", "Eli books room", "Follow-ups"],
      ["N5", "Confirm budget", "Follow-ups"],
      ["N6", "Plain line", "Follow-ups"],
      ["N7", "Next block line", null],
    ]);
    expect(result.every((unit) => unit.kind === "note" && unit.speaker === null)).toBe(true);
  });

  it("prefixes AI-written blocks S, people's notes N, and transcript-like blocks T", () => {
    const result = units([
      block("note", "note", "Human note"),
      block("summary", "summary", "AI summary"),
      block("agenda", "agenda", "Agenda item"),
      block("caption", "caption", "Caption line"),
      block("ai-note", "note", "AI-written note", { origin: "source_ai" }),
      block("chapter", "chapter", "Chapter title"),
      block("chat", "chat_message", "Chat line"),
      block("ai-chat", "chat_message", "Bot recap", { origin: "source_ai" }),
      block("doc", "artifact_text", "Doc text"),
      block("decision", "provider_decision", "Provider decision"),
    ]);
    expect(result.map((unit) => `${unit.id}:${unit.kind}:${unit.block_id}`)).toEqual([
      "N1:note:note", "S1:summary:summary", "N2:note:agenda", "T1:transcript:caption", "S2:summary:ai-note",
      "S3:summary:chapter", "T2:transcript:chat", "S4:summary:ai-chat", "N3:note:doc", "S5:summary:decision",
    ]);
  });

  it("returns no units for an empty or whitespace-only meeting", () => {
    expect(units([])).toEqual([]);
    expect(units([block("t1", "transcript", ""), block("n1", "note", "  \n\t \n"), block("s1", "summary", " ")])).toEqual([]);
  });

  it("flags units whose display consists only of questions", () => {
    const lines = ["Can we ship Friday?", "Who owns it? When is it due?", "We ship Friday. Any concerns?", "Ship it!", "我们周五发布吗？", `${"Why? ".repeat(60)}Done.`];
    expect(units([block("n1", "note", lines.join("\n"))]).map((unit) => unit.question)).toEqual([true, true, false, false, true, false]);
  });
});

describe("meeting evidence header", () => {
  it("reads the local date from the actual start, then the scheduled start, in the meeting zone", () => {
    const header = (time?: MeetingDocument["time"]) => buildMeetingEvidenceV1(meeting([], time === undefined ? {} : { time })).header.date;
    expect(header({ actual_start_at: "2026-10-09T23:30:00Z", scheduled_start_at: "2026-10-01T00:00:00Z", timezone: "Asia/Shanghai" }))
      .toEqual({ local_date: "2026-10-10", weekday: "Saturday", time_zone: "Asia/Shanghai" });
    expect(header({ scheduled_start_at: "2026-10-09T23:30:00Z" })).toEqual({ local_date: "2026-10-09", weekday: "Friday", time_zone: "UTC" });
    expect(header({ actual_start_at: "2026-10-09T23:30:00Z", timezone: "Not/AZone" })).toEqual({ local_date: "2026-10-09", weekday: "Friday", time_zone: "UTC" });
    expect(header({ actual_start_at: "not a time" })).toBeNull();
    expect(header({})).toBeNull();
    expect(header()).toBeNull();
    expect(localDateV1("2026-10-10T03:00:00Z", "America/Los_Angeles")).toBe("2026-10-09");
    expect(localDateV1("2026-10-10T03:00:00Z", "Not/AZone")).toBe("2026-10-10");
    expect(localDateV1("", undefined)).toBeNull();
  });

  it("lists de-duplicated participant names in document order without bots", () => {
    const { header } = buildMeetingEvidenceV1(meeting([], {
      title: "Launch review",
      participants: [
        { id: "p1", display_name: "Alice" },
        { id: "p2", display_name: "Alice" },
        { id: "p3" },
        { id: "p4", display_name: "Notetaker", roles: ["bot"] },
        { id: "p5", display_name: "Bob", roles: ["attendee"] },
      ],
    }));
    expect(header).toEqual({ title: "Launch review", date: null, participants: ["Alice", "p3", "Bob"] });
    expect(buildMeetingEvidenceV1(meeting([])).header.title).toBeNull();
  });
});
