@main
private enum EchoOverlaySourceFixtureMain {
    private static let recordHash = "sha256:" + String(repeating: "b", count: 64)
    private static let otherRecordHash = "sha256:" + String(repeating: "d", count: 64)
    private static let atomHash = "sha256:" + String(repeating: "c", count: 64)
    private static let otherAtomHash = "sha256:" + String(repeating: "e", count: 64)
    private static let policy = "organization-member-readable-person-v2"
    private static let restrictedPolicy = "restricted-reviewer-person-v2"

    @MainActor
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
        case "optional-source-metadata":
            let detail = CliRunner.parseSourceRecord(contextData(), source: source())
            passed = detail?.approvedBy == "Maya Chen"
                && detail?.participants == ["Maya Chen", "Priya Natarajan"]
                && detail?.date != nil
                && detail?.shortDate != nil
                && detail?.decisions.first?.evidence.first?.quote == "We need to finish permission checks before launch."
                && detail?.decisions.first?.evidence.first?.timestamp != nil
        case "absent-source-metadata":
            let detail = CliRunner.parseSourceRecord(sourceData(), source: source())
            passed = detail?.approvedBy == nil && detail?.participants.isEmpty == true
                && detail?.date == nil && detail?.decisions.first?.evidence.isEmpty == true
        case "source-card-layout", "source-card-minimal", "source-card-narrow":
            _ = NSApplication.shared
            NSApp.setActivationPolicy(.prohibited)
            passed = OverlayController.proveSourceCard(
                record: CliRunner.parseSourceRecord(mode == "source-card-minimal" ? sourceData() : contextData(), source: source())!,
                screenshot: ProcessInfo.processInfo.environment["ECHO_OVERLAY_FIXTURE_OUTPUT"].map { "\($0)/\(mode).png" },
                narrow: mode == "source-card-narrow"
            )
        case "untitled-source":
            let detail = CliRunner.parseSourceRecord(sourceData(meeting: ["id": "meeting-fixture"]), source: source())
            passed = detail?.title == "Untitled meeting"
                && detail?.decisions.map(\.text) == ["Keep the current plan."]
                && detail?.actions.map(\.text) == ["Publish the plan."]
                && detail?.rationales.map(\.text) == ["The evidence supports it."]
        case "panel-resigns-key":
            _ = NSApplication.shared
            NSApp.setActivationPolicy(.prohibited)
            passed = OverlayController.proveInactivePanelFocusLoss(source: source())
        case "large-source":
            let large = String(repeating: "x", count: 130 * 1024)
            let detail = CliRunner.parseSourceRecord(sourceData(decisionText: large), source: source())
            passed = detail?.decisions.first?.text.hasSuffix("… (truncated)") == true
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
        meeting: [String: Any] = ["id": "meeting-fixture", "title": "Quarterly planning"],
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
                                    "meeting": meeting,
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

    private static func contextData() -> Data {
        var root = try! JSONSerialization.jsonObject(with: sourceData(meeting: [
            "id": "meeting-fixture", "title": "Customer dashboard launch review",
            "time": ["scheduled_start_at": "2026-09-08T17:00:00Z", "timezone": "America/Los_Angeles"],
            "participants": [
                ["id": "p1", "display_name": "Maya Chen", "roles": ["invitee"]],
                ["id": "p2", "display_name": "Priya Natarajan"],
                ["id": "p3", "display_name": "Maya Chen"],
                ["id": "opaque-id", "identities": [["kind": "email", "value": "private@example.test"]]],
            ],
        ])) as! [String: Any]
        var result = root["result"] as! [String: Any]
        var records = result["records"] as! [[String: Any]]
        records[0]["source_metadata"] = ["record_approved_by": ["display_name": "Maya Chen"]]
        var envelope = records[0]["envelope"] as! [String: Any]
        var body = envelope["body"] as! [String: Any]
        var event = body["event"] as! [String: Any]
        var snapshot = event["approved_snapshot"] as! [String: Any]
        var payload = snapshot["approved_payload"] as! [String: Any]
        var brief = payload["brief"] as! [String: Any]
        brief["decisions"] = [["id": "d1", "kind": "decision", "status": "decided", "text": "Move the customer dashboard launch from September 15 to September 29.", "evidence": [[
            "quote": "We need to finish permission checks before launch.", "started_at": "2026-09-08T17:31:00Z",
        ]]]]
        brief["actions"] = [["id": "a1", "kind": "action", "text": "Engineering completes the permission checks; share the revised timeline with Sales."]]
        brief["rationales"] = [["id": "r1", "kind": "rationale", "text": "Shipping with incomplete permission checks risks exposing another customer's data."]]
        payload["brief"] = brief; snapshot["approved_payload"] = payload; event["approved_snapshot"] = snapshot
        body["event"] = event; envelope["body"] = body; records[0]["envelope"] = envelope
        result["records"] = records; root["result"] = result
        return data(root)
    }
}

// Exercise the real panel delegate and its private presentation state without
// showing a window, activating ECHO, reading a session, or launching a client.
extension OverlayController {
    fileprivate static func proveSourceCard(record: SourceRecord, screenshot: String?, narrow: Bool) -> Bool {
        let controller = OverlayController()
        controller.panel.setFrame(NSRect(x: 0, y: 0, width: narrow ? 700 : 1180, height: 720), display: false)
        controller.currentSources = [record.source]
        controller.sourceRecords = [record.source.recordSha256: record]
        controller.sourcePaneOpen = true
        controller.sourcePaneWidth?.constant = narrow ? 700 : 420
        controller.answerColumnTrailing?.constant = narrow ? 0 : -420
        controller.answerColumn?.isHidden = narrow
        controller.sourcePane.isHidden = false
        controller.sourceScrollView.isHidden = false
        controller.composer.string = "Why did we delay the customer dashboard launch?"
        controller.answerView.textStorage?.setAttributedString(NSAttributedString(
            string: "The launch moved from September 15 to September 29 because customer permission checks were incomplete.\n\nEngineering will complete the checks. The recorded follow-up is to share the revised timeline with Sales.",
            attributes: Self.answerAttributes
        ))
        controller.identityLabel.stringValue = "Signed in as Jordan"
        controller.statusLabel.stringValue = "Answer ready"
        controller.answerHeader.isHidden = false
        controller.answerScrollView.isHidden = false
        controller.emptyAnswerLabel.isHidden = true
        controller.sourcesButton.title = "Back to answer"
        controller.sourcesButton.isEnabled = true
        controller.copyButton.isEnabled = true
        controller.refreshSourceChips()
        controller.renderSelectedSource()
        guard let content = controller.panel.contentView else { return false }
        content.layoutSubtreeIfNeeded()
        func labels(_ view: NSView) -> [String] {
            (view as? NSTextField).map { [$0.stringValue] } ?? view.subviews.flatMap(labels)
        }
        let text = labels(controller.sourceDetails)
        guard text.contains(record.title), text.contains("Visibility"),
              text.contains("Participants") == !record.participants.isEmpty,
              text.contains("Record approved by") == (record.approvedBy != nil),
              !text.contains("Present"),
              !controller.answerScrollView.isHidden,
              controller.sourceDetails.frame.width > 200
        else { return false }
        if let screenshot {
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return false }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { return false }
            do { try png.write(to: URL(fileURLWithPath: screenshot)) } catch { return false }
        }
        if narrow {
            controller.panel.setFrame(NSRect(x: 0, y: 0, width: 780, height: 720), display: false)
            controller.windowDidResize(Notification(name: NSWindow.didResizeNotification, object: controller.panel))
            guard controller.sourcePaneWidth?.constant == content.bounds.width else { return false }
        }
        let nextSource = DisplaySource(label: "Source 2", recordSha256: "sha256:" + String(repeating: "f", count: 64), policyID: record.source.policyID)
        controller.currentSources.append(nextSource)
        controller.sourceRecords[nextSource.recordSha256] = SourceRecord(source: nextSource, title: "Follow-up review", visibility: record.visibility, date: nil, shortDate: nil, approvedBy: nil, participants: [], decisions: [], actions: [], rationales: [])
        let button = NSButton()
        button.tag = 1
        controller.selectSource(button)
        let nextText = labels(controller.sourceDetails)
        guard nextText.contains("Follow-up review"), !nextText.contains("Record approved by"),
              !nextText.contains("Participants"), !controller.answerView.string.isEmpty else { return false }
        controller.closeSourcePane()
        return !controller.sourcePaneOpen && controller.sourcePane.isHidden && controller.answerColumn?.isHidden == false
    }

    fileprivate static func proveInactivePanelFocusLoss(source: DisplaySource) -> Bool {
        let controller = OverlayController()
        let pending = RunningAsk()
        let requestID = UUID()
        controller.currentSources = [source]
        controller.sourceRecords[source.recordSha256] = SourceRecord(source: source, title: "Private meeting title", visibility: "Only the approver", date: nil, shortDate: nil, approvedBy: "Private approver", participants: ["Private participant"], decisions: [], actions: [], rationales: [])
        controller.sourcePaneOpen = true
        controller.sourcePane.isHidden = false
        controller.refreshSourceChips()
        controller.answerView.string = "An existing approved answer."
        controller.appendDetail(controller.sourceLabel("Private source details"))
        controller.sourceScrollView.isHidden = false
        controller.activeSources = pending
        controller.sourceRequestIdentifier = requestID
        guard !NSApp.isActive else { return false }

        controller.panel.delegate?.windowDidResignKey?(
            Notification(name: NSWindow.didResignKeyNotification, object: controller.panel)
        )
        // A completed read from before focus loss must also remain withheld.
        controller.handleSources(.unavailable, identifier: requestID)
        let passed = !NSApp.isActive
            && controller.sourceDetails.arrangedSubviews.isEmpty
            && controller.sourceRecords.isEmpty
            && controller.sourcePane.isHidden
            && !controller.sourcePaneOpen
            && (controller.sourceChips.documentView as? NSStackView)?.arrangedSubviews.compactMap { ($0 as? NSButton)?.title }.contains(where: { $0.contains("Private") }) == false
            && controller.sourceScrollView.isHidden
            && controller.currentSources.count == 1
            && controller.sourcesButton.isEnabled
            && controller.answerView.string == "An existing approved answer."
            && controller.activeSources == nil
            && controller.sourceRequestIdentifier == nil
            && pending.state().cancelled
        controller.shutdown()
        return passed
    }
}
