import AppKit
import Foundation

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
        case "window", "window-account-change", "window-recovery", "window-uncertain": windowProof(client, folder: folder, mode: mode)
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
        var questions: [String] = []
        let controller = ProjectsController(uploads: session, projects: ProjectSession(client: ProjectClient(cli: client.cli), defaults: defaults, foreground: { true }), onAsk: { questions.append($0) })
        let window = controller.window
        guard let root = window.contentView else { fatalError("home window") }
        func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
        func button(_ title: String, in view: NSView) -> NSButton {
            guard let found = views(view).compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else { fatalError("button: \(title)") }
            return found
        }
        func wait(_ label: String, _ ready: () -> Bool) {
            let deadline = Date().addingTimeInterval(8)
            while !ready() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
            require(ready(), "UI operation timed out: \(label)")
        }
        session.refreshIdentity(); wait("identity") { !session.busy && session.identity != nil && !controller.projects.busy }
        require(!button("New project · Not live yet", in: root).isEnabled)
        require(!views(root).compactMap({ $0 as? NSTextField }).contains(where: { $0.stringValue.contains("Lumen") || $0.stringValue.contains("Harbor") }))
        if mode == "window-recovery" {
            require(!session.canCompose && session.recovery != nil)
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
        button("Find saved context", in: root).performClick(nil)
        let query = views(root).compactMap({ $0 as? NSTextField }).first(where: { $0.accessibilityLabel() == "Ask or find context" })!
        let submit = views(root).compactMap({ $0 as? NSButton }).first(where: { $0.accessibilityLabel() == "Submit" })!
        query.stringValue = "café"; submit.performClick(nil)
        wait("search") { !session.busy && session.matches.count == 1 }
        button("Read original", in: root).performClick(nil)
        wait("original") { !session.busy && session.content?.text == original }
        require(views(root).compactMap({ $0 as? NSTextView }).contains(where: { $0.string == original }))
        button("Ask ECHO", in: root).performClick(nil)
        query.stringValue = "Why did we delay launch?"; submit.performClick(nil)
        require(questions == ["Why did we delay launch?"] && !controller.answerContainer.isHidden)
        // Real compose sheet must retain the full original, including its first
        // line and trailing newline, when it creates a CLI draft.
        window.makeKeyAndOrderFront(nil)
        wait("account after focus") { !session.busy }
        controller.startWrite()
        wait("write sheet attached") { window.attachedSheet != nil }
        guard let sheet = window.attachedSheet, let sheetRoot = sheet.contentView else { fatalError("write sheet") }
        let body = views(sheetRoot).compactMap({ $0 as? NSTextView }).first(where: { $0.accessibilityLabel() == "Original note text" })!
        body.string = "\t\n\t" + original
        button("Continue", in: sheetRoot).performClick(nil)
        button("Save", in: sheetRoot).performClick(nil)
        wait("save") { !session.busy && session.receipt != nil }
        require(session.receipt?.visibility == .onlyMe)
        require(!views(sheetRoot).compactMap({ $0 as? NSButton }).contains(where: { $0.title == "Undo" }))
        button("Done", in: sheetRoot).performClick(nil)
        controller.conceal(); require(session.matches.isEmpty && session.content == nil)
        controller.accountWillChange(); require(query.stringValue.isEmpty)
        controller.shutdown()
    }
}
