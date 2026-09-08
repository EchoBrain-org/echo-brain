@main
private enum EchoOverlaySourceFixtureMain {
    private static let recordHash = "sha256:" + String(repeating: "b", count: 64)
    private static let otherRecordHash = "sha256:" + String(repeating: "d", count: 64)
    private static let atomHash = "sha256:" + String(repeating: "c", count: 64)
    private static let otherAtomHash = "sha256:" + String(repeating: "e", count: 64)
    private static let policy = "organization-member-readable-person-v2"
    private static let restrictedPolicy = "restricted-reviewer-person-v2"

    static func main() {
        let mode = CommandLine.arguments.dropFirst().first ?? ""
        let passed: Bool
        switch mode {
        case "valid-answer":
            if case .success(let answer) = CliRunner.parseSuccess(answerData(citations: [citation()])), answer.sources.count == 1 {
                passed = true
            } else { passed = false }
        case "duplicate-atom":
            let duplicate = citation()
            if case .failure = CliRunner.parseSuccess(answerData(citations: [duplicate, duplicate])) {
                passed = true
            } else { passed = false }
        case "grouped-record":
            if case .success(let answer) = CliRunner.parseSuccess(answerData(citations: [
                citation(), citation(atom: otherAtomHash),
            ])), answer.sources.count == 1, answer.sources[0].label == "Source 1" {
                passed = true
            } else { passed = false }
        case "inconsistent-policy":
            if case .failure = CliRunner.parseSuccess(answerData(citations: [
                citation(), citation(atom: otherAtomHash, policyID: restrictedPolicy),
            ])) {
                passed = true
            } else { passed = false }
        case "answer-scalar-limit":
            if case .success = CliRunner.parseSuccess(answerData(answer: String(repeating: "é", count: 12_000))),
               case .failure = CliRunner.parseSuccess(answerData(answer: String(repeating: "é", count: 12_001))) {
                passed = true
            } else { passed = false }
        case "unknown-citation-field":
            var invalid = citation()
            invalid["unexpected"] = true
            if case .failure = CliRunner.parseSuccess(answerData(citations: [invalid])) {
                passed = true
            } else { passed = false }
        case "cancelled-source-work":
            let running = RunningAsk()
            running.cancel()
            passed = running.state().cancelled
        case "valid-source":
            passed = CliRunner.parseSourceRecord(sourceData(), source: source())?.title == "Quarterly planning"
        case "large-source":
            let large = String(repeating: "x", count: 130 * 1024)
            let detail = CliRunner.parseSourceRecord(sourceData(decisionText: large), source: source())
            passed = detail?.decisions.first?.hasSuffix("… (truncated)") == true
        case "mismatched-source":
            passed = CliRunner.parseSourceRecord(sourceData(hash: otherRecordHash), source: source()) == nil
        case "mismatched-policy":
            passed = CliRunner.parseSourceRecord(sourceData(policyID: restrictedPolicy), source: source()) == nil
        case "empty-source":
            passed = CliRunner.parseSourceRecord(sourceData(records: []), source: source()) == nil
        default:
            passed = false
        }
        Darwin.exit(passed ? EXIT_SUCCESS : EXIT_FAILURE)
    }

    private static func citation(
        atom: String = atomHash,
        policyID: String = policy
    ) -> [String: Any] {
        ["atom_id": atom, "record_sha256": recordHash, "policy_id": policyID]
    }

    private static func source() -> DisplaySource {
        DisplaySource(label: "Source 1", recordSha256: recordHash, policyID: policy)
    }

    private static func answerData(
        answer: String = "Approved answer.",
        citations: [[String: Any]] = [citation()]
    ) -> Data {
        data([
            "ok": true,
            "result": [
                "schema_version": 1,
                "kind": "echo-clean-person-answer-v1",
                "generation_id": "sha256:" + String(repeating: "a", count: 64),
                "record_head": ["position": 1, "record_sha256": recordHash],
                "answer": answer,
                "citations": citations,
            ],
        ])
    }

    private static func sourceData(
        hash: String = recordHash,
        policyID: String = policy,
        decisionText: String = "Keep the current plan.",
        records: [[String: Any]]? = nil
    ) -> Data {
        let record: [String: Any] = [
            "position": 1,
            "approval_id": "apr_fixture",
            "record_sha256": hash,
            "envelope": [
                "record_sha256": hash,
                "body": [
                    "event": [
                        "kind": "approved",
                        "policy_id": policyID,
                        "approved_snapshot": [
                            "approved_payload": [
                                "brief": [
                                    "meeting": ["title": "Quarterly planning"],
                                    "decisions": [["id": "d1", "kind": "decision", "text": decisionText]],
                                    "actions": [["id": "a1", "kind": "action", "text": "Publish the plan."]],
                                    "rationales": [["id": "r1", "kind": "rationale", "text": "The evidence supports it."]],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]
        return data([
            "ok": true,
            "result": [
                "schema_version": 1,
                "kind": "echo-clean-person-record-list-v1",
                "records": records ?? [record],
            ],
        ])
    }

    private static func data(_ value: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: value, options: [])
    }
}
