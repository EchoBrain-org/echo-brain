import AppKit
import Foundation

/// Finds controls the way the render harness does: by accessibility
/// identifier or label, across the window frame view (titlebar accessories
/// included) or an attached sheet's content view. Hidden views are included;
/// a visible match is preferred over a hidden one.
@MainActor
enum ProofUI {
    static func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    static func chrome(_ window: NSWindow) -> NSView {
        guard let content = window.contentView else { fatalError("window has no content view") }
        return content.superview ?? content
    }
    static func visible(_ view: NSView) -> Bool { !view.isHiddenOrHasHiddenAncestor }
    static func matches(_ view: NSView, _ keys: [String]) -> Bool {
        keys.contains { $0 == view.accessibilityIdentifier() || $0 == view.accessibilityLabel() }
    }
    static func all<T: NSView>(_ type: T.Type, _ keys: String..., in scope: NSView) -> [T] {
        views(scope).compactMap { $0 as? T }.filter { matches($0, keys) }
    }
    static func find<T: NSView>(_ type: T.Type, _ keys: String..., in scope: NSView) -> T {
        let found = views(scope).compactMap { $0 as? T }.filter { matches($0, keys) }
        guard let result = found.first(where: visible) ?? found.first else { fatalError("Missing \(T.self): \(keys.joined(separator: " / "))") }
        return result
    }
    static func showsText(_ text: String, in scope: NSView) -> Bool {
        views(scope).contains { view in
            guard visible(view) else { return false }
            if let field = view as? NSTextField { return field.stringValue == text }
            if let textView = view as? NSTextView { return textView.string == text }
            return false
        }
    }
    static func claimsSent(_ scope: NSView) -> Bool {
        views(scope).contains { view in
            guard visible(view), let field = view as? NSTextField else { return false }
            return field.stringValue.hasPrefix("Sent to") || field.stringValue.hasPrefix("Saved for")
        }
    }
    static func offersUndo(_ scope: NSView) -> Bool {
        views(scope).compactMap { $0 as? NSButton }.contains {
            $0.title.localizedCaseInsensitiveContains("Undo") || ($0.accessibilityLabel() ?? "").localizedCaseInsensitiveContains("Undo")
        }
    }
}

@main
enum UploadProof {
    static let contextID = "ctx_" + String(repeating: "b", count: 64)
    static let original = "Original café note.\nSecond line preserved.\n"
    static let identity = AccountIdentity(displayName: "Casey", role: "Employee", authority: "https://authority.example", version: "1", membershipID: "mem_original")
    static func require(_ condition: @autoclosure () -> Bool, _ message: String = "proof failed") {
        if !condition() { fatalError(message) }
    }
    static func data(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    static func draft(_ visibility: UploadVisibility = .onlyMe) -> UploadDraft {
        try! UploadDraft(title: "Client memo", bytes: Data(original.utf8), visibility: visibility)
    }
    static func content() -> [String: Any] {
        ["schema_version": 2, "kind": "echo-person-upload-content-v2", "context_id": contextID,
         "received_at": "2026-09-21T00:00:00.000Z", "audience": ["kind": "only_me"], "title": "Client memo", "text": original]
    }
    @MainActor static func main() {
        let mode = CommandLine.arguments[1]
        let folder = URL(fileURLWithPath: CommandLine.arguments[3])
        let client = UploadClient(cli: ProjectCLI(executable: URL(fileURLWithPath: CommandLine.arguments[2])))
        func execute(_ command: UploadCommand) -> UploadResult { client.execute(command, identity: identity, running: AccountRunning()) }
        switch mode {
        case "round-trip":
            let attempt = draft()
            guard case .saved(let receipt) = execute(.submit(attempt)) else { fatalError("submit") }
            require(receipt.request_id == attempt.requestID && receipt.visibility == .onlyMe)
            let recovery = UploadRecovery(identity: identity, requestID: attempt.requestID, visibility: .onlyMe)!
            guard case .saved(let status) = execute(.status(recovery)), case .matches(let hits) = execute(.search("café")),
                  case .content(let read) = execute(.read(contextID)) else { fatalError("reads") }
            require(status.metadata == "ready" && hits.count == 1 && read.text == original)
            guard case .saved(let team) = execute(.submit(draft(.team))) else { fatalError("team submit") }
            require(team.visibility == .team)
        case "snapshot-replay":
            let source = folder.appendingPathComponent("input.txt")
            try! Data(original.utf8).write(to: source)
            let attempt = try! UploadDraft(title: "Client memo", bytes: UploadDraft.readFile(source), visibility: .onlyMe)
            try! Data("Changed original file".utf8).write(to: source)
            require((try! Data(contentsOf: attempt.file)) == Data(original.utf8))
            let attributes = try! FileManager.default.attributesOfItem(atPath: attempt.file.path)
            require((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
            let directory = try! FileManager.default.attributesOfItem(atPath: attempt.file.deletingLastPathComponent().path)
            require((directory[.posixPermissions] as? NSNumber)?.intValue == 0o700)
            guard case .saved(let first) = execute(.submit(attempt)), case .saved(let second) = execute(.submit(attempt)) else { fatalError("retry") }
            require(first.context_id == second.context_id && first.request_id == second.request_id)
        case "file-bounds":
            let file = folder.appendingPathComponent("input.txt")
            for value in [Data(), Data([0xff]), Data([0]), Data(repeating: 97, count: 8193)] {
                try! value.write(to: file); require((try? UploadDraft.readFile(file)) == nil)
            }
            let limit = Data(repeating: 97, count: 8192); try! limit.write(to: file)
            require((try? UploadDraft.readFile(file)) == limit)
            let link = folder.appendingPathComponent("link.txt")
            try! FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
            require((try? UploadDraft.readFile(link)) == nil && (try? UploadDraft.readFile(folder)) == nil)
            require((try? UploadDraft(title: String(repeating: "é", count: 101), bytes: limit, visibility: .team)) == nil)
            require((try? UploadDraft(title: "Title\nline", bytes: limit, visibility: .team)) == nil)
        case "parser-bounds":
            require(uploadQuery("  cafe\u{301}  ") == "café")
            for query in ["!!!", "one\nline", "one\u{2028}line", String(repeating: "é", count: 33),
                          (0...32).map { "word\($0)" }.joined(separator: " "), String(repeating: "a ", count: 121)] {
                require(uploadQuery(query) == nil, "query limit")
            }
            guard case .content(let read) = UploadClient.parse(data(content()), command: .read(contextID)) else { fatalError("valid original") }
            require(read.text == original)
            for (key, value) in [("context_id", "ctx_" + String(repeating: "c", count: 64)), ("audience", "public"),
                                 ("kind", "other"), ("received_at", "invalid"), ("text", String(repeating: "x", count: 8193)), ("title", "bad\nname")] {
                var changed = content(); changed[key] = value
                guard case .failed = UploadClient.parse(data(changed), command: .read(contextID)) else { fatalError(key) }
            }
            var extra = content(); extra["decision"] = true
            guard case .failed = UploadClient.parse(data(extra), command: .read(contextID)) else { fatalError("extra field") }
            var hit = content(); hit.removeValue(forKey: "schema_version"); hit.removeValue(forKey: "kind"); hit.removeValue(forKey: "text"); hit["excerpt"] = "Memo"
            for hits in [[hit, hit], Array(repeating: hit, count: 11)] {
                guard case .failed = UploadClient.parse(data(["schema_version": 2, "kind": "echo-person-upload-search-v2", "results": hits]), command: .search("Memo")) else { fatalError("duplicate or overflow") }
            }
            let attempt = draft()
            var receipt: [String: Any] = ["schema_version": 2, "kind": "echo-person-update-receipt-v2", "context_id": contextID,
                                         "received_at": "2026-09-21T00:00:00.000Z", "request_id": attempt.requestID, "audience": ["kind": "team"], "project_id": NSNull(), "state": "received"]
            guard case .failed = UploadClient.parse(data(receipt), command: .submit(attempt)) else { fatalError("visibility mismatch") }
            receipt["audience"] = ["kind": "only_me"]; receipt["request_id"] = UUID().uuidString.lowercased()
            guard case .failed = UploadClient.parse(data(receipt), command: .submit(attempt)) else { fatalError("request mismatch") }
        case "recovery":
            let suite = "org.echobrain.test.uploads." + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let receipt = UploadRecovery(identity: identity, requestID: UUID().uuidString.lowercased(), visibility: .team)!
            receipt.save(for: identity, defaults: defaults)
            require(UploadRecovery.load(for: identity, defaults: UserDefaults(suiteName: suite)!) == receipt)
            var other = identity; other.membershipID = "mem_other"
            require(UploadRecovery.load(for: other, defaults: defaults) == nil)
            let keys = Set((try! JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)) as! [String: Any]).keys)
            require(keys == Set(["authority", "membershipID", "requestID", "audience"]))
            let otherReceipt = UploadRecovery(identity: other, requestID: UUID().uuidString.lowercased(), visibility: .onlyMe)!
            otherReceipt.save(for: other, defaults: defaults)
            UploadRecovery.clear(for: identity, defaults: defaults)
            require(UploadRecovery.load(for: identity, defaults: defaults) == nil)
            require(UploadRecovery.load(for: other, defaults: defaults) == otherReceipt)
        case "switch-before", "switch-after":
            guard case .unavailable = execute(.read(contextID)) else { fatalError("account switch disclosed content") }
        case "submit-switch-after":
            guard case .unconfirmedAccount = execute(.submit(draft())) else { fatalError("lost submitted-write state") }
        case "unknown-submit":
            guard case .unconfirmed = execute(.submit(draft())) else { fatalError("write failure must be unknown") }
        case "oversized-read":
            switch execute(.read(contextID)) {
            case .failed, .unavailable: break
            default: fatalError("oversized result disclosed")
            }
        case "cancel-before":
            let running = AccountRunning(); running.cancel()
            guard case .unavailable = client.execute(.submit(draft()), identity: identity, running: running) else { fatalError("cancelled request") }
            // The fake CLI was never invoked; keep a bounded empty invocation log.
            try! Data().write(to: folder.appendingPathComponent("calls.jsonl"))
        case "window", "window-account-change", "window-recovery", "window-uncertain", "window-stranded": windowProof(client, folder: folder, mode: mode)
        default: fatalError("unknown mode")
        }
        print("passed \(mode)")
    }

    @MainActor static func windowProof(_ client: UploadClient, folder: URL, mode: String) {
        let app = NSApplication.shared; app.setActivationPolicy(.regular); app.finishLaunching()
        let suite = "org.echobrain.test.home." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        if mode == "window-recovery" {
            UploadRecovery(identity: identity, requestID: UUID().uuidString.lowercased(), visibility: .onlyMe)!.save(for: identity, defaults: defaults)
        }
        let session = UploadSession(client: client, defaults: defaults, isForeground: { true })
        var questions: [(String, AskScope)] = []
        let controller = ProjectsController(uploads: session, projects: ProjectSession(client: ProjectClient(cli: client.cli), defaults: defaults, foreground: { true }), onAsk: { question, scope in
            questions.append((question, scope)); return .accepted
        })
        let window = controller.window
        // The frame view includes the titlebar accessories and the content view.
        let chrome = ProofUI.chrome(window)
        func wait(_ label: String, _ ready: () -> Bool) {
            let deadline = Date().addingTimeInterval(8)
            while !ready() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
            require(ready(), "UI operation timed out: \(label)")
        }
        session.refreshIdentity(); wait("identity") { !session.busy && session.identity != nil && !controller.projects.busy }
        // `projects list` 404 is the only Not live yet signal: every New project control says so and is disabled.
        let newProject = ProofUI.find(NSButton.self, "sidebar-new-project", in: chrome)
        require(newProject.title == "New project · Not live yet" && !newProject.isEnabled, "sidebar New project must be disabled and not live")
        let emptyNew = ProofUI.find(NSButton.self, "new-project-empty", in: chrome)
        require(emptyNew.title == "New project · Not live yet" && !emptyNew.isEnabled, "empty New project must be disabled and not live")
        require(!ProofUI.views(chrome).compactMap({ $0 as? NSButton }).contains(where: {
            ["sidebar-new-project", "new-project-empty"].contains($0.accessibilityIdentifier()) && $0.isEnabled
        }), "an enabled New project control exists while not live")
        require(!ProofUI.views(chrome).compactMap({ $0 as? NSTextField }).contains(where: { $0.stringValue.contains("Lumen") || $0.stringValue.contains("Harbor") }))
        if mode == "window-recovery" {
            require(!session.canCompose && session.recovery != nil)
            // ⌘⇧E with an unreconciled save opens straight into it: the
            // outcome, Check status, and no editable body.
            controller.capture(); wait("capture attention") { window.attachedSheet != nil && !session.busy }
            let first = window.attachedSheet
            guard let attention = first?.contentView else { fatalError("capture sheet") }
            require(ProofUI.showsText("This may not have been saved.", in: attention), "capture did not open in the attention state")
            let check = ProofUI.find(NSButton.self, "compose-check", in: attention)
            require(ProofUI.visible(check) && check.isEnabled, "Check status not offered")
            require(!ProofUI.find(NSTextView.self, "compose-body", in: attention).isEditable, "body editable over an unreconciled save")
            controller.capture(); require(window.attachedSheet === first && window.sheets.count == 1, "a second capture stacked another sheet")
            first?.cancelOperation(nil); wait("attention closed") { window.attachedSheet == nil }
            require(session.recovery != nil, "closing the attention state dropped the recovery")
            wait("idle") { !session.busy }
            session.checkStatus(); wait("recovered") { !session.busy && session.receipt != nil }
            require(!session.canCompose)
            session.startAnother(); require(session.canCompose && session.recovery == nil)
            require(UploadRecovery.load(for: identity, defaults: UserDefaults(suiteName: suite)!) == nil)
            controller.shutdown(); return
        }
        if mode == "window-account-change" {
            session.submit(title: "Client memo", text: original, visibility: .onlyMe)
            require(controller.hasOutstandingMutation)
            controller.accountWillChange()
            wait("inflight save") { !controller.hasOutstandingMutation }
            require(session.identity == nil && session.content == nil && session.matches.isEmpty && session.receipt == nil)
            require(!session.status.hasPrefix("Saved ·"))
            require(UploadRecovery.load(for: identity, defaults: defaults) != nil)
            controller.shutdown(); return
        }
        if mode == "window-stranded" {
            // The save's account check comes back as another account: the
            // sheet stays with the honest outcome, and so does the home.
            controller.startWrite(); wait("compose") { window.attachedSheet != nil && !session.busy }
            guard let sheet = window.attachedSheet, let root = sheet.contentView else { fatalError("compose") }
            let body = ProofUI.find(NSTextView.self, "compose-body", in: root)
            body.string = original; body.didChangeText()
            ProofUI.find(NSButton.self, "compose-send", in: root).performClick(nil)
            wait("stranded save") { !session.busy && !session.hasOutstandingMutation }
            let status = "The save may have completed. Check its status from the original account."
            require(session.identity == nil && session.status == status, "expected an unconfirmed-account save")
            require(window.attachedSheet === sheet, "the sheet closed and hid the unknown outcome")
            require(ProofUI.showsText("This may not have been saved.", in: root) && ProofUI.showsText(status, in: root), "outcome not shown")
            require(!ProofUI.claimsSent(root), "claimed saved without a receipt")
            require(!ProofUI.visible(ProofUI.find(NSButton.self, "compose-check", in: root)), "Check status offered without the original account")
            let close = ProofUI.find(NSButton.self, "sheet-close", in: root)
            require(ProofUI.visible(close) && close.isEnabled); close.performClick(nil)
            wait("closed") { window.attachedSheet == nil }
            require(ProofUI.showsText(status, in: chrome), "home does not say the save may exist")
            require(UploadRecovery.load(for: identity, defaults: defaults) != nil, "the original account's locator was lost")
            controller.shutdown(); return
        }
        if mode == "window-uncertain" {
            session.submit(title: "Client memo", text: original, visibility: .onlyMe)
            wait("uncertain save") { !session.busy }
            require(session.receipt == nil && session.draft != nil && session.recovery != nil && !session.canCompose)
            let id = session.draft!.requestID
            session.submit(title: "Replacement", text: "Must not submit", visibility: .team)
            require(session.draft?.requestID == id)
            session.retry(); wait("exact retry") { !session.busy }
            require(session.draft?.requestID == id)
            session.checkStatus(); wait("reconcile") { !session.busy && session.receipt != nil }
            require(session.draft == nil && session.receipt?.request_id == id)
            controller.shutdown(); return
        }
        // Ask is the only home context entrypoint. It submits authorized global
        // retrieval, clears the composer only after acceptance, and does not
        // expose a saved-context browser in the sidebar.
        ProofUI.find(NSButton.self, "sidebar-toggle", in: chrome).performClick(nil)
        require(!ProofUI.views(chrome).compactMap({ $0 as? NSButton }).contains(where: {
            ($0.accessibilityIdentifier() == "sidebar-search" || $0.title == "Find saved context") && ProofUI.visible($0)
        }), "saved-context browser remains in the sidebar")
        let query = ProofUI.find(NSTextField.self, "ask-field", "Ask ECHO", in: chrome)
        let submit = ProofUI.find(NSButton.self, "submit-button", "Submit", in: chrome)
        query.stringValue = "Why did we delay launch?"; submit.performClick(nil)
        require(questions.count == 1 && questions[0].0 == "Why did we delay launch?" && questions[0].1 == .global,
                "home Ask did not use authorized global scope")
        require(query.stringValue.isEmpty && !controller.answerContainer.isHidden,
                "accepted home Ask did not clear its composer and show the answer")
        // Real compose sheet must retain the full original, including its first
        // line and trailing newline, when it creates a CLI draft.
        window.makeKeyAndOrderFront(nil)
        wait("account after focus") { !session.busy && !controller.projects.busy }
        controller.startWrite()
        wait("write sheet attached") { window.attachedSheet != nil }
        guard let sheet = window.attachedSheet, let sheetRoot = sheet.contentView else { fatalError("write sheet") }
        let body = ProofUI.find(NSTextView.self, "compose-body", "Original note text", in: sheetRoot)
        let to = ProofUI.find(ChipMenuButton.self, "compose-to", "Send to", in: sheetRoot)
        let send = ProofUI.find(NSButton.self, "compose-send", "Send", in: sheetRoot)
        require(to.title == "Only me" && to.choices.first == "Only me", "compose outside a project must default To to Only me")
        require(body.string.isEmpty && !send.isEnabled, "Send enabled with an empty body")
        body.string = "\t\n\t" + original; body.didChangeText()
        require(send.isEnabled, "Send disabled with text")
        send.performClick(nil)
        wait("save") { !session.busy && session.receipt != nil }
        require(session.receipt?.visibility == .onlyMe)
        guard let sent = window.attachedSheet?.contentView else { fatalError("sent sheet") }
        require(!ProofUI.offersUndo(sent) && !ProofUI.offersUndo(chrome), "Undo offered after save")
        require(ProofUI.showsText("Saved for you", in: sent), "sent state does not say Saved for you")
        let done = ProofUI.find(NSButton.self, "compose-done", in: sent)
        require(done.title == "Done"); done.performClick(nil)
        wait("compose closed") { window.attachedSheet == nil }
        // Leaving "Saved" with Escape instead of Done, then ⌘⇧E: the next
        // note can be sent (the settled receipt does not hold it).
        wait("idle after done") { !session.busy }
        controller.startWrite(); wait("second compose") { window.attachedSheet != nil }
        guard let second = window.attachedSheet?.contentView else { fatalError("second compose") }
        let secondBody = ProofUI.find(NSTextView.self, "compose-body", in: second)
        secondBody.string = "Second note\n"; secondBody.didChangeText()
        ProofUI.find(NSButton.self, "compose-send", in: second).performClick(nil)
        wait("second save") { !session.busy && session.receipt != nil }
        window.attachedSheet?.cancelOperation(nil); wait("escaped sent") { window.attachedSheet == nil }
        controller.capture(); wait("capture") { window.attachedSheet != nil && !session.busy }
        guard let capture = window.attachedSheet?.contentView else { fatalError("capture sheet") }
        let captureBody = ProofUI.find(NSTextView.self, "compose-body", in: capture)
        require(captureBody.isEditable && ProofUI.visible(captureBody), "capture did not open a fresh note")
        captureBody.string = "Pasted text"; captureBody.didChangeText()
        require(ProofUI.find(NSButton.self, "compose-send", in: capture).isEnabled && session.canCompose, "capture after Escape cannot send")
        window.attachedSheet?.cancelOperation(nil)
        wait("capture discard confirmation") { window.attachedSheet?.attachedSheet != nil }
        guard let discardPrompt = window.attachedSheet?.attachedSheet?.contentView,
              let discard = ProofUI.views(discardPrompt).compactMap({ $0 as? NSButton }).first(where: { $0.title == "Discard" })
        else { fatalError("capture discard control") }
        require(ProofUI.showsText("Discard this note?", in: discardPrompt), "Escape discarded a typed capture without confirmation")
        require(captureBody.string == "Pasted text" && session.receipt == nil, "capture changed before the discard choice")
        discard.performClick(nil); wait("capture closed") { window.attachedSheet == nil }
        controller.conceal(); require(session.matches.isEmpty && session.content == nil)
        query.stringValue = "unsent question"
        controller.accountWillChange(); require(query.stringValue.isEmpty)
        controller.shutdown()
    }
}
