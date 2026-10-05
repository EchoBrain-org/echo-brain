import { describe, expect, it } from "vitest";
import { analyzeOriginalContextPacketV1, scoreOriginalContextPacketV1 } from "../src/adapters/persistence/sqlite/original-context-bm25-v1.js";

function scores(texts: readonly string[], terms: readonly string[]): readonly number[] {
  const analyses = texts.map(text => analyzeOriginalContextPacketV1(text, terms));
  const frequencies = new Map<string, number>();
  for (const analysis of analyses) for (const term of analysis.frequencies.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const average = analyses.reduce((sum, analysis) => sum + analysis.length, 0) / analyses.length;
  return analyses.map(analysis => scoreOriginalContextPacketV1(analysis, terms, analyses.length, average, frequencies));
}

describe("original-context BM25", () => {
  it("rewards rare substantive terms with saturating TF and length normalization", () => {
    const ranked = scores([
      "common rare rare rare",
      "common incidental words words words words words words words words",
      "common",
    ], ["common", "rare"]);
    expect(ranked[0]).toBeGreaterThan(ranked[1]!);
    expect(ranked[1]).toBeLessThan(ranked[2]!);
    const tf = scores(["signal", "signal signal", "signal signal signal signal"], ["signal"]);
    expect(tf[1]! - tf[0]!).toBeGreaterThan(tf[2]! - tf[1]!);
  });

  it("is deterministic and gives ordinary decision terms no category boost", () => {
    const first = scores(["decision", "approved"], ["decision", "approved"]);
    const second = scores(["decision", "approved"], ["decision", "approved"]);
    expect(first).toEqual(second);
    expect(first[0]).toBe(first[1]);
  });
});
