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
        ["schema_version": 1, "kind": "echo-person-upload-content-v1", "context_id": contextID,
         "received_at": "2026-09-21T00:00:00.000Z", "visibility": "only_me", "title": "Client memo", "text": original]
    }
    @MainActor static func main() {
        let mode = CommandLine.arguments[1]
        let folder = URL(fileURLWithPath: CommandLine.arguments[3])
        let client = UploadClient(account: AccountClient(executable: URL(fileURLWithPath: CommandLine.arguments[2])))
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
            for (key, value) in [("context_id", "ctx_" + String(repeating: "c", count: 64)), ("visibility", "public"),
                                 ("kind", "other"), ("received_at", "invalid"), ("text", String(repeating: "x", count: 8193)), ("title", "bad\nname")] {
                var changed = content(); changed[key] = value
                guard case .failed = UploadClient.parse(data(changed), command: .read(contextID)) else { fatalError(key) }
            }
            var extra = content(); extra["decision"] = true
            guard case .failed = UploadClient.parse(data(extra), command: .read(contextID)) else { fatalError("extra field") }
            var hit = content(); hit.removeValue(forKey: "schema_version"); hit.removeValue(forKey: "kind"); hit.removeValue(forKey: "text"); hit["excerpt"] = "Memo"
            for hits in [[hit, hit], Array(repeating: hit, count: 11)] {
                guard case .failed = UploadClient.parse(data(["schema_version": 1, "kind": "echo-person-upload-search-v1", "results": hits]), command: .search("Memo")) else { fatalError("duplicate or overflow") }
            }
            let attempt = draft()
            var receipt: [String: Any] = ["schema_version": 1, "kind": "echo-person-update-receipt-v1", "context_id": contextID,
                                         "received_at": "2026-09-21T00:00:00.000Z", "request_id": attempt.requestID, "visibility": "team", "state": "received"]
            guard case .failed = UploadClient.parse(data(receipt), command: .submit(attempt)) else { fatalError("visibility mismatch") }
            receipt["visibility"] = "only_me"; receipt["request_id"] = UUID().uuidString.lowercased()
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
            require(keys == Set(["authority", "membershipID", "requestID", "visibility"]))
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
        case "window", "window-account-change", "window-recovery": windowProof(client, folder: folder, mode: mode)
        default: fatalError("unknown mode")
        }
        print("passed \(mode)")
    }

    @MainActor static func windowProof(_ client: UploadClient, folder: URL, mode: String) {
        let app = NSApplication.shared; app.setActivationPolicy(.regular); app.finishLaunching()
        let suite = "org.echobrain.test.uploads.window." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        if mode == "window-recovery" {
            UploadRecovery(identity: identity, requestID: UUID().uuidString.lowercased(), visibility: .onlyMe)!.save(for: identity, defaults: defaults)
        }
        let controller = UploadsController(client: client, defaults: defaults, isForeground: { true })
        controller.show()
        guard let window = app.windows.first(where: { $0.title == "Uploads" }), let root = window.contentView else { fatalError("window") }
        func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
        let all = views(root)
        guard let search = all.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Search" }),
              let query = all.compactMap({ $0 as? NSSearchField }).first,
              let table = all.compactMap({ $0 as? NSTableView }).first,
              let originalView = all.compactMap({ $0 as? NSTextView }).first else { fatalError("controls") }
        func wait(_ label: String, _ ready: () -> Bool) {
            let deadline = Date().addingTimeInterval(8)
            while !ready() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
            require(ready(), "UI operation timed out: \(label); active=\(app.isActive)")
        }
        wait("identity") { if !search.isEnabled { controller.refreshIdentity() }; return search.isEnabled }
        if mode == "window-recovery" {
            let buttons = all.compactMap { $0 as? NSButton }
            let choose = buttons.first(where: { $0.title == "Choose file…" })!
            let check = buttons.first(where: { $0.title == "Check upload status" })!
            let open = buttons.first(where: { $0.title == "Open saved upload" })!
            let new = buttons.first(where: { $0.title == "New upload" })!
            require(!choose.isEnabled && check.isEnabled && new.isEnabled)
            check.performClick(nil)
            wait("recover receipt") { open.isEnabled }
            require(!choose.isEnabled)
            new.performClick(nil)
            require(choose.isEnabled && !check.isEnabled && !open.isEnabled)
            require(UploadRecovery.load(for: identity, defaults: UserDefaults(suiteName: suite)!) == nil, "abandoned recovery returned after restart")
            controller.shutdown(); window.orderOut(nil); return
        }
        if mode == "window-account-change" {
            let source = folder.appendingPathComponent("memo.txt")
            try! Data(original.utf8).write(to: source)
            controller.selectFile(source)
            let submit = all.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Upload" })!
            require(submit.isEnabled)
            submit.performClick(nil); require(controller.hasOutstandingMutation)
            controller.accountWillChange()
            require(originalView.string.isEmpty && table.numberOfRows == 0)
            wait("pending upload released after account change") { !controller.hasOutstandingMutation }
            require(originalView.string.isEmpty && !search.isEnabled)
            require(!all.compactMap({ $0 as? NSTextField }).contains(where: { $0.stringValue.hasPrefix("Saved ·") }))
            require(UploadRecovery.load(for: identity, defaults: defaults) != nil)
            controller.shutdown(); window.orderOut(nil); return
        }
        query.stringValue = "café"; search.performClick(nil)
        wait("search") { table.numberOfRows == 1 && search.isEnabled }
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        wait("read") { originalView.string == original }
        window.setContentSize(window.contentMinSize); root.layoutSubtreeIfNeeded()
        require(originalView.enclosingScrollView!.bounds.height >= 150)
        for button in all.compactMap({ $0 as? NSButton }) {
            let frame = button.convert(button.bounds, to: root)
            require(root.bounds.contains(frame), "button outside the window: \(button.title)")
        }
        if let bitmap = root.bitmapImageRepForCachingDisplay(in: root.bounds) {
            window.effectiveAppearance.performAsCurrentDrawingAppearance { root.cacheDisplay(in: root.bounds, to: bitmap) }
            try! bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent("uploads.png"))
        }
        controller.conceal(); require(table.numberOfRows == 0 && originalView.string.isEmpty)
        controller.accountWillChange(); require(query.stringValue.isEmpty)
        controller.shutdown(); window.orderOut(nil)
    }
}
