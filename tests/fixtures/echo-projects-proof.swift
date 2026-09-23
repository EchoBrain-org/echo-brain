import AppKit
import Foundation

final class ProofRecoveryStore: ProjectMutationRecoveryStore {
    var values: [String: Any] = [:]
    var synchronizes = true
    func data(forKey defaultName: String) -> Data? { values[defaultName] as? Data }
    func object(forKey defaultName: String) -> Any? { values[defaultName] }
    func set(_ value: Any?, forKey defaultName: String) { values[defaultName] = value }
    func removeObject(forKey defaultName: String) { values.removeValue(forKey: defaultName) }
    func synchronize() -> Bool { synchronizes }
}

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
enum ProjectProof {
    static let project = "prj_11111111-1111-4111-8111-111111111111"
    static let other = "prj_44444444-4444-4444-8444-444444444444"
    static let member = "mem_33333333-3333-4333-8333-333333333333"
    static let context = "ctx_" + String(repeating: "a", count: 64)
    static var identity = AccountIdentity(displayName: "Ari", role: "Employee", authority: "https://authority.example", version: "1", membershipID: "mem_22222222-2222-4222-8222-222222222222")
    static func require(_ value: @autoclosure () -> Bool, _ message: String = "proof failed") { if !value() { fatalError(message) } }
    static func data(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
    static func wait(_ label: String, _ ready: () -> Bool) {
        let deadline = Date().addingTimeInterval(12)
        while !ready() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        require(ready(), "Timed out: \(label)")
    }
    static func commands(_ operations: [[String: Any]]) -> [ProjectCommand] {
        func request(_ index: Int) -> String { (operations[index]["http"] as! [String: Any])["body"].map { ($0 as! [String: Any])["request_id"] as! String }! }
        return [.list("eyJsYXN0Ijoicm93In0"), .create("Apollo", request(1)), .read(project), .members(project, nil),
            .directory(project, "ari", nil), .setMember(project, member, "member", request(5)), .removeMember(project, member, request(6)),
            .associate(project, context, request(7), true), .associate(project, context, request(8), false),
            .feed(project, "eyJsYXN0Ijoicm93In0"), .search(project, "ship", nil), .readContext(project, context)]
    }
    @MainActor static func main() {
        let requestedMode = CommandLine.arguments[1]
        let mode = requestedMode.hasPrefix("cli-") ? String(requestedMode.dropFirst(4)) : requestedMode
        if requestedMode.hasPrefix("cli-") {
            let account = AccountClient(executable: URL(fileURLWithPath: CommandLine.arguments[3]))
            guard case .signedIn(let current) = account.readStatus(AccountRunning()) else { fatalError("real CLI status") }
            identity = current
        }
        let fixture = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let operations = (try! JSONSerialization.jsonObject(with: fixture) as! [String: Any])["operations"] as! [[String: Any]]
        let commands = commands(operations)
        func response(_ index: Int) -> [String: Any] { (operations[index]["http"] as! [String: Any])["response"] as! [String: Any] }
        if mode == "frozen-fixtures" {
            for (index, command) in commands.enumerated() {
                let fixtureArgs = operations[index]["argv"] as! [String]
                let args = Array(command.arguments.dropFirst())
                require(Array(args.prefix(2)) == Array(fixtureArgs.prefix(2)))
                func flags(_ values: [String]) -> [String: String] {
                    Dictionary(uniqueKeysWithValues: stride(from: 2, to: values.count, by: 2).map { (values[$0], values[$0 + 1]) })
                }
                require(flags(args) == flags(fixtureArgs), "CLI flags: \(command.operation)")
                switch ProjectClient.parse(data(response(index)), command: command) {
                case .failure, .accountChanged: fatalError("Frozen response rejected: \(command.operation)")
                default: break
                }
            }
            let draft = try! UploadDraft(title: "Apollo update", bytes: Data("We agreed to ship.\n".utf8), visibility: .project, audienceProjectID: project, projectID: project)
            var receipt = response(12); receipt["request_id"] = draft.requestID
            guard case .saved = UploadClient.parse(data(receipt), command: .submit(draft)) else { fatalError("V2 receipt") }
            let recovery = UploadRecovery(identity: identity, requestID: draft.requestID, visibility: .project, audienceProjectID: project, projectID: project)!
            var status = response(13); status["request_id"] = draft.requestID
            guard case .saved = UploadClient.parse(data(status), command: .status(recovery)),
                  case .matches = UploadClient.parse(data(response(14)), command: .search("ship")),
                  case .content = UploadClient.parse(data(response(15)), command: .read(context)) else { fatalError("V2 read fixtures") }
        } else if mode == "strict-replies" {
            for (index, command) in commands.enumerated() {
                var o = response(index); o["unknown"] = "private"
                guard case .failure = ProjectClient.parse(data(o), command: command) else { fatalError("extra fields") }
                o = response(index); o["schema_version"] = true
                guard case .failure = ProjectClient.parse(data(o), command: command) else { fatalError("boolean version") }
                if command.projectID != nil {
                    o = response(index); o["project_id"] = other
                    guard case .failure = ProjectClient.parse(data(o), command: command) else { fatalError("cross project") }
                }
            }
            var feed = response(9); var item = (feed["items"] as! [[String: Any]])[0]
            item["audience"] = ["kind": "team", "project_id": project]; feed["items"] = [item]
            guard case .failure = ProjectClient.parse(data(feed), command: commands[9]) else { fatalError("audience widening") }
            feed = response(9); feed["items"] = Array(repeating: (feed["items"] as! [[String: Any]])[0], count: 2)
            guard case .failure = ProjectClient.parse(data(feed), command: commands[9]) else { fatalError("duplicate item") }
            feed = response(9); feed["next_cursor"] = "a"
            guard case .failure = ProjectClient.parse(data(feed), command: commands[9]) else { fatalError("invalid cursor") }
            guard case .failure = ProjectClient.parse(Data(repeating: 32, count: 32770), command: commands[9]) else { fatalError("oversize") }
            let duplicateRoot = #"""
{"schema_version":1,"kind":"echo-project-list-v1","k\u0069nd":"echo-project-list-v1","items":[],"next_cursor":null}
"""#
            guard case .failure = ProjectClient.parse(Data(duplicateRoot.utf8), command: .list(nil)) else { fatalError("duplicate root key") }
            let duplicateNested = #"""
{"schema_version":1,"kind":"echo-project-context-feed-v1","project_id":"prj_11111111-1111-4111-8111-111111111111","items":[{"context_id":"ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","received_at":"2026-09-21T22:01:00.000Z","title":"Apollo","excerpt":"note","audience":{"kind":"project","k\u0069nd":"project","project_id":"prj_11111111-1111-4111-8111-111111111111"}}],"next_cursor":null}
"""#
            guard case .failure = ProjectClient.parse(Data(duplicateNested.utf8), command: commands[9]) else { fatalError("duplicate nested key") }
            let duplicateError = #"""
{"ok":false,"action":"projects-member-set","error":"Request failed","code":"conflict","c\u006fde":"conflict","status":409,"request_id":"00000000-0000-4000-8000-000000000002","mutation_outcome":"not_submitted","mutation_\u006futcome":"not_submitted"}
"""#
            guard ProjectFailure.parse(Data(duplicateError.utf8), action: "projects-member-set", requestID: "00000000-0000-4000-8000-000000000002") == nil else { fatalError("duplicate error key") }
        } else if mode == "independent-recovery" {
            let draft = try! UploadDraft(title: "Private original", bytes: Data("unchanged\n".utf8), visibility: .project, audienceProjectID: project, projectID: other)
            let args = UploadCommand.submit(draft).arguments
            require(args[args.firstIndex(of: "--audience-project-id")! + 1] == project)
            require(args[args.firstIndex(of: "--project-id")! + 1] == other)
            let recovery = UploadRecovery(identity: identity, requestID: draft.requestID, visibility: .project, audienceProjectID: project, projectID: other)!
            let suite = "org.echo.pc05." + UUID().uuidString; let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            recovery.save(for: identity, defaults: defaults)
            require(UploadRecovery.load(for: identity, defaults: UserDefaults(suiteName: suite)!) == recovery)
            var changed = response(13); changed["request_id"] = draft.requestID
            guard case .failed = UploadClient.parse(data(changed), command: .status(recovery)) else { fatalError("initial association mismatch") }
            changed["project_id"] = other
            guard case .saved = UploadClient.parse(data(changed), command: .status(recovery)) else { fatalError("frozen coordinates") }
            require((try? UploadDraft(title: "Invalid", bytes: Data("note".utf8), visibility: .team, audienceProjectID: project)) == nil)
        } else if mode.hasPrefix("ui-") {
            uiProof(mode, executable: URL(fileURLWithPath: CommandLine.arguments[3]), cli: requestedMode.hasPrefix("cli-"))
        } else {
            scenario(mode, executable: URL(fileURLWithPath: CommandLine.arguments[3]))
        }
        print("passed \(mode)")
    }
    @MainActor static func uiProof(_ mode: String, executable: URL, cli: Bool) {
        let app = NSApplication.shared; app.setActivationPolicy(.regular); app.finishLaunching()
        let client = ProjectCLI(executable: executable)
        let suite = "org.echo.pc05.ui." + UUID().uuidString; let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        if mode == "ui-recovery" { defaults.set(Data("{bad".utf8), forKey: ProjectMutationRecovery.recoveryKey(for: identity)) }
        if mode == "ui-recovery-pending" {
            require(ProjectMutationRecovery(identity: identity, command: .create("Apollo", UUID().uuidString.lowercased()))!.save(for: identity, defaults: defaults), "recovery setup")
        }
        let uploads = UploadSession(client: UploadClient(cli: client), defaults: defaults, isForeground: { true })
        let projects = ProjectSession(client: ProjectClient(cli: client), defaults: defaults, foreground: { true })
        var questions: [String] = []
        let controller = ProjectsController(uploads: uploads, projects: projects, documents: DocumentSession(cli: client, foreground: { true }), onAsk: { questions.append($0) })
        defer { controller.shutdown() }
        let window = controller.window
        // The frame view includes the titlebar accessories (sidebar toggle,
        // Back, the people stack) as well as the content view.
        let chrome = ProofUI.chrome(window)
        func sheetRoot(_ label: String) -> NSView {
            guard let root = window.attachedSheet?.contentView else { fatalError("Missing sheet: \(label)") }
            return root
        }
        // A confirm alert on the main window, or on an attached sheet.
        func alert(_ label: String, onSheet: Bool) -> NSView {
            wait(label) { (onSheet ? window.attachedSheet?.attachedSheet : window.attachedSheet)?.contentView != nil }
            return (onSheet ? window.attachedSheet?.attachedSheet : window.attachedSheet)!.contentView!
        }
        func press(_ title: String, in scope: NSView) {
            guard let button = ProofUI.views(scope).compactMap({ $0 as? NSButton }).first(where: { $0.title == title && ProofUI.visible($0) }) else {
                fatalError("Missing button: \(title)")
            }
            button.performClick(nil)
        }
        func visibleButton(_ key: String, in scope: NSView) -> NSButton? {
            ProofUI.all(NSButton.self, key, in: scope).first(where: ProofUI.visible)
        }
        func settle(_ label: String) {
            wait(label) { !projects.busy && !uploads.busy }
            let until = Date().addingTimeInterval(0.3)
            while Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.01)); if projects.busy || uploads.busy { wait(label) { !projects.busy && !uploads.busy } } }
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("echo-projects-ui-" + UUID().uuidString)
        try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        func textFile(_ name: String, _ text: String) -> URL {
            let url = folder.appendingPathComponent(name); try! Data(text.utf8).write(to: url); return url
        }
        controller.show(); wait("home") { !uploads.busy && uploads.identity != nil && !projects.busy && projects.projects.count == 2 }
        let query = ProofUI.find(NSTextField.self, "ask-field", "Ask or find context", in: chrome)
        let submit = ProofUI.find(NSButton.self, "submit-button", "Submit", in: chrome)
        let back = ProofUI.find(NSButton.self, "back-button", "Back", in: chrome)
        func openApollo() {
            let role = mode == "ui-member" ? "Member" : "Lead"
            ProofUI.find(NSButton.self, "Apollo · \(role)", in: chrome).performClick(nil)
            wait("project") { !projects.busy && projects.selected?.project_id == project && projects.items.count == 1 && !projects.members.isEmpty }
            settle("project settle")
        }

        if mode.hasPrefix("ui-recovery") {
            // The home banner is the only way out of recovery review: Retry
            // only for a pending change, Dismiss… always, behind a confirm.
            settle("recovery home")
            require(projects.needsRecoveryReview && !projects.canMutate, "recovery review expected")
            require(ProofUI.showsText("A project change may not have finished.", in: chrome), "recovery banner missing")
            require(ProofUI.all(NSButton.self, "recovery-dismiss", in: chrome).filter(ProofUI.visible).count == 1, "exactly one Dismiss…")
            require(ProofUI.all(NSButton.self, "recovery-retry", in: chrome).filter(ProofUI.visible).count == (mode == "ui-recovery-pending" ? 1 : 0),
                    "Retry must appear only for a pending change")
            require(!ProofUI.find(NSButton.self, "sidebar-new-project", in: chrome).isEnabled, "New project enabled during recovery review")
            visibleButton("recovery-dismiss", in: chrome)!.performClick(nil)
            press("Cancel", in: alert("dismiss alert", onSheet: false)); wait("alert cancelled") { window.attachedSheet == nil }
            require(projects.needsRecoveryReview, "Cancel cleared the recovery")
            visibleButton("recovery-dismiss", in: chrome)!.performClick(nil)
            press("Dismiss", in: alert("dismiss alert", onSheet: false))
            wait("dismissed") { window.attachedSheet == nil && !projects.busy && !projects.needsRecoveryReview }
            settle("after dismiss")
            require(projects.canMutate && ProofUI.find(NSButton.self, "sidebar-new-project", in: chrome).isEnabled, "New project still blocked")
            require(visibleButton("recovery-dismiss", in: chrome) == nil, "banner shown after Dismiss")
            guard case .missing = ProjectMutationRecovery.load(for: identity, defaults: defaults) else { fatalError("recovery kept after Dismiss") }
            return
        }

        if mode == "ui-documents" {
            openApollo()
            wait("document feed") { !controller.documents.busy && controller.documents.matches.count == 1 }
            ProofUI.find(NSButton.self, "document-row", in: chrome).performClick(nil)
            wait("document text") { controller.documents.page?.display == "Page 1\nFirst page" }
            require(ProofUI.showsText("Page 1\nFirst page", in: chrome), "first document page not rendered")
            let actions = ProofUI.find(IconButton.self, "reader-actions", in: chrome)
            guard let menu = actions.menuProvider?(), let next = menu.items.first(where: { $0.title == "Next text page" }),
                  next.isEnabled, let selector = next.action else { fatalError("document page action") }
            require(menu.items.contains { $0.title == "Save original…" && $0.isEnabled }, "original download action")
            _ = NSApp.sendAction(selector, to: next.target, from: next)
            wait("next document page") { controller.documents.page?.display == "Page 2\nSecond page" }
            require(ProofUI.showsText("Page 2\nSecond page", in: chrome), "document reader cache did not refresh")
            back.performClick(nil); settle("document back")
            let binary = folder.appendingPathComponent("Robot PRD.pdf")
            try! Data([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]).write(to: binary)
            ProofUI.find(FileDropView.self, "content-drop", in: chrome).onDropFile?(binary)
            wait("binary compose") { window.attachedSheet != nil }
            let compose = sheetRoot("binary compose")
            require(ProofUI.find(NSTextView.self, "compose-body", in: compose).string.isEmpty, "binary decoded into note")
            require(ProofUI.find(NSTextField.self, "compose-document", in: compose).stringValue.contains("Robot PRD.pdf"))
            ProofUI.find(NSButton.self, "compose-send", in: compose).performClick(nil)
            wait("document saved") { !uploads.busy && uploads.receipt?.document != nil }
            require(uploads.receipt?.document?.content_length == 6 && uploads.receipt?.document?.extraction_state == "extracting")
            require(ProofUI.views(compose).compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("Original saved · Extracting text.") }, "custody vs extraction state not shown")
            return
        }

        if mode == "ui-drop" {
            let file = textFile("Kickoff notes.txt", "Kickoff notes\nShip annual first.\n")
            func dropped(_ label: String, to title: String) {
                wait(label) { window.attachedSheet != nil }
                let compose = sheetRoot(label)
                require(ProofUI.find(ChipMenuButton.self, "compose-to", in: compose).title == title, "\(label): To is not \(title)")
                require(ProofUI.find(NSTextView.self, "compose-body", in: compose).string.isEmpty, "\(label): document entered note editor")
                require(ProofUI.find(NSTextField.self, "compose-document", in: compose).stringValue.contains("Kickoff notes.txt"), "\(label): attachment missing")
                let until = Date().addingTimeInterval(0.3)
                while Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
                require(uploads.draft == nil && uploads.receipt == nil && !uploads.hasOutstandingMutation, "\(label): a drop sent by itself")
                window.attachedSheet?.cancelOperation(nil); wait("\(label) closed") { window.attachedSheet == nil }
                settle("\(label) settle")
            }
            // Onto the Beacon row: To is that row's project, not the default.
            guard let onRow = ProofUI.find(ProjectRowButton.self, "Beacon · Lead", in: chrome).onDropFile else { fatalError("row takes no drop") }
            onRow(file); dropped("row drop", to: "Beacon")
            // Anywhere on the window: the last choice on home (initially Only me)…
            let area = ProofUI.find(FileDropView.self, "content-drop", in: chrome)
            guard let onArea = area.onDropFile else { fatalError("window takes no drop") }
            onArea(file); dropped("home drop", to: "Only me")
            // …and the open project inside one.
            openApollo(); onArea(file); dropped("project drop", to: "Apollo")
            // Not text: refused, with the one status line.
            onArea(textFile("image.bin", "\u{0}\u{1}")); settle("binary drop")
            require(window.attachedSheet == nil && ProofUI.showsText("Choose TXT, Markdown, PDF, or DOCX up to 25 MiB.", in: chrome), "non-text drop not refused")
            // ⌘⇧E after the app was in the background (the list was cleared):
            // To still offers every live project once the list reloads.
            back.performClick(nil); settle("home")
            controller.conceal(); require(projects.projects.isEmpty, "conceal kept the list")
            controller.capture(); wait("capture") { window.attachedSheet != nil }
            settle("capture list")
            let captureTo = ProofUI.find(ChipMenuButton.self, "compose-to", in: sheetRoot("capture"))
            require(captureTo.choices.contains("Apollo") && captureTo.choices.contains("Beacon"), "capture To lacks the live projects: \(captureTo.choices)")
            // A sheet left open across concealment: closing it reloads the
            // list instead of leaving a bare Reload.
            controller.conceal(); require(projects.projects.isEmpty && window.attachedSheet != nil, "compose closed on conceal")
            window.attachedSheet?.cancelOperation(nil); wait("capture closed") { window.attachedSheet == nil }
            wait("list reloaded") { !uploads.busy && !projects.busy && projects.projects.count == 2 }
            return
        }

        if mode.hasPrefix("ui-create") {
            // New project: name, Create, then files saved one at a time.
            ProofUI.find(NSButton.self, "sidebar-toggle", in: chrome).performClick(nil)
            ProofUI.find(NSButton.self, "sidebar-new-project", in: chrome).performClick(nil)
            wait("create sheet") { window.attachedSheet != nil }
            let sheet = sheetRoot("create")
            let name = ProofUI.find(NSTextField.self, "create-name", in: sheet)
            name.stringValue = "Apollo"; NotificationCenter.default.post(name: NSControl.textDidChangeNotification, object: name)
            let create = ProofUI.find(NSButton.self, "create-submit", in: sheet)
            require(create.title == "Create" && create.isEnabled, "Create not offered")
            create.performClick(nil)
            if mode == "ui-create-read-fail" {
                // The receipt came back; the new project's read failed once.
                wait("read failed") { !projects.busy && projects.createdProjectID == project && projects.selected == nil }
                settle("read failed settle")
                require(window.attachedSheet != nil && create.title == "Open" && create.isEnabled && !name.isEnabled, "failed reopen must offer Open, never Create")
                create.performClick(nil)
            }
            wait("created") { !projects.busy && projects.selected?.project_id == project }
            settle("created settle")
            require(ProofUI.visible(ProofUI.find(NSButton.self, "create-add-files", in: sheet)), "files step not shown")
            let done = ProofUI.find(NSButton.self, "create-done", in: sheet)
            // Keyboard focus lands in "Add someone"; the creator's Lead chip is
            // announced, not only drawn.
            let addSomeone = ProofUI.all(NSTextField.self, "people-add-field", in: sheet).first(where: ProofUI.visible)
            require(addSomeone != nil && (window.attachedSheet?.firstResponder as? NSTextView)?.delegate === addSomeone, "focus is not in Add someone")
            require(ProofUI.views(sheet).contains { $0 is LeadChip && $0.isAccessibilityElement() && $0.accessibilityLabel() == "Lead" }, "Lead chip has no accessibility label")
            if mode == "ui-create-read-fail" {
                done.performClick(nil); wait("closed") { window.attachedSheet == nil }; return
            }
            controller.createSheet.queueFiles([textFile("Alpha.txt", "Alpha notes\n"), textFile("Beta.txt", "Beta notes\n")])
            wait("first save settled") { !uploads.busy && controller.createSheet.fileStates.first?.hasSuffix(":uncertain") == true }
            settle("halted")
            // The queue stops on the unconfirmed file; nothing runs for the
            // next one, so there is no spinner and Done / Escape stay usable.
            require(controller.createSheet.fileStates == ["Alpha.txt:uncertain", "Beta.txt:notStarted"], "queue did not halt: \(controller.createSheet.fileStates)")
            require(done.isEnabled, "a stopped queue blocks Done")
            require(!ProofUI.views(sheet).contains { ($0 as? NSProgressIndicator).map(ProofUI.visible) == true }, "spinner for a file that is not saving")
            require(ProofUI.views(sheet).compactMap { $0 as? NSTextField }.contains { $0.stringValue.hasPrefix("Beta.txt ·") }, "waiting file not listed")
            if mode == "ui-create-account" {
                // Another account: the sheet closes (nothing is running), the
                // old names go, and the save's locator stays for its account.
                controller.accountWillChange()
                wait("closed on account change") { window.attachedSheet == nil }
                require(UploadRecovery.load(for: identity, defaults: defaults) != nil, "the unconfirmed save's locator was lost")
                return
            }
            if mode == "ui-create" {
                press("Check status", in: sheet)
                wait("reconciled and resumed") { !uploads.busy && controller.createSheet.fileStates == ["Alpha.txt:saved", "Beta.txt:saved"] }
                settle("saved")
                require(done.isEnabled); done.performClick(nil)
            } else {
                press("Skip…", in: sheet)
                press("Skip", in: alert("skip alert", onSheet: true))
                wait("skipped and resumed") { !uploads.busy && controller.createSheet.fileStates == ["Alpha.txt:skipped", "Beta.txt:saved"] }
                settle("saved")
                window.attachedSheet?.cancelOperation(nil)
            }
            wait("create closed") { window.attachedSheet == nil }
            settle("after create")
            require(window.title == "Apollo", "create did not land on the new project")
            if mode == "ui-create-skip" {
                require(ProofUI.showsText("Some files may not have been saved.", in: chrome), "skipped file not reported")
            }
            return
        }

        if mode == "ui-associate" {
            // Association to a project other than a note's audience happens
            // from the saved-context reader, then is undone from the project.
            ProofUI.find(NSButton.self, "sidebar-toggle", in: chrome).performClick(nil)
            ProofUI.find(NSButton.self, "sidebar-search", in: chrome).performClick(nil)
            query.stringValue = "ship"; submit.performClick(nil)
            wait("saved search") { !uploads.busy && uploads.matches.count == 1 }
            wait("result row") { visibleButton("item-row", in: chrome) != nil }
            visibleButton("item-row", in: chrome)!.performClick(nil)
            wait("saved original") { !uploads.busy && uploads.content?.context_id == context }
            guard let menu = ProofUI.all(IconButton.self, "reader-actions", in: chrome).first(where: ProofUI.visible)?.menuProvider?(),
                  let add = menu.items.first(where: { $0.title == "Add to project" })?.submenu,
                  let beacon = add.items.first(where: { $0.title == "Beacon" }), let action = beacon.action else { fatalError("Add to project → Beacon missing") }
            require(beacon.isEnabled, "Add to Beacon disabled")
            NSApp.sendAction(action, to: beacon.target, from: beacon)
            wait("associated") { !projects.busy && projects.selected?.project_id == other && projects.items.count == 1 }
            settle("beacon open")
            require(window.title == "Beacon", "association did not open Beacon")
            visibleButton("item-row", in: chrome)!.performClick(nil)
            wait("project original") { !projects.busy && projects.content?.context_id == context }
            guard let actions = ProofUI.all(IconButton.self, "reader-actions", in: chrome).first(where: ProofUI.visible)?.menuProvider?(),
                  let remove = actions.items.first(where: { $0.title == "Remove from this project" }), let removal = remove.action else {
                fatalError("Remove from this project missing")
            }
            require(remove.isEnabled, "Remove disabled")
            NSApp.sendAction(removal, to: remove.target, from: remove)
            wait("dissociated") { !projects.busy && projects.selected?.project_id == other }
            settle("after dissociate")
            return
        }

        if mode == "ui-search-controls" {
            openApollo()
            let clear = ProofUI.find(NSButton.self, "clear-search", "Clear search", in: chrome)
            // × clears the search and brings the feed back.
            query.stringValue = "ship"; submit.performClick(nil); settle("search")
            require(ProofUI.visible(clear), "× missing while a search is shown")
            clear.performClick(nil); settle("cleared")
            require(!ProofUI.visible(clear) && query.stringValue.isEmpty && projects.items.count == 1, "× did not restore the feed")
            // Escape in the bar goes back to the feed, not home.
            query.stringValue = "ship"; submit.performClick(nil); settle("search 2")
            window.makeFirstResponder(query)
            if let editor = query.currentEditor() as? NSTextView { editor.doCommand(by: #selector(NSResponder.cancelOperation(_:))) }
            else { _ = controller.control(query, textView: NSTextView(), doCommandBy: #selector(NSResponder.cancelOperation(_:))) }
            settle("escaped")
            require(window.title == "Apollo" && ProofUI.visible(back) && !ProofUI.visible(clear) && query.stringValue.isEmpty, "Escape left the project")
            // Escape on the window closes the reader.
            visibleButton("item-row", in: chrome)!.performClick(nil)
            wait("reader") { !projects.busy && projects.content != nil }
            window.cancelOperation(nil); settle("reader closed")
            require(projects.content == nil && ProofUI.visible(back) && window.title == "Apollo", "Escape did not close the reader")
            // A click during a load is replayed, not dropped.
            projects.loadMembers(); require(projects.busy, "members load did not start")
            visibleButton("item-row", in: chrome)!.performClick(nil)
            wait("replayed read") { !projects.busy && projects.content != nil }
            window.cancelOperation(nil); settle("reader closed 2")
            // So is a search.
            projects.loadMembers(); require(projects.busy, "members load did not start")
            query.stringValue = "late"; submit.performClick(nil)
            settle("replayed search")
            require(ProofUI.visible(clear), "search made during a load was dropped")
            require(questions.isEmpty)
            return
        }

        // Live list: the sidebar row reads exactly "New project" and is enabled.
        let newProject = ProofUI.find(NSButton.self, "sidebar-new-project", in: chrome)
        require(newProject.title == "New project" && newProject.isEnabled, "New project must be enabled when live")
        // Rows name the viewer's real role and nothing else.
        let otherRole = mode == "ui-member" ? "Lead" : "Member"
        require(ProofUI.all(NSButton.self, "Apollo · \(otherRole)", in: chrome).isEmpty, "row shows the wrong role")
        openApollo()
        require(window.title == "Apollo", "window title must be the open project")
        // No project-scoped Ask exists anywhere.
        require(!ProofUI.views(chrome).compactMap({ $0 as? NSButton }).contains(where: { $0.title.contains("Ask this project") }))
        // The project-page bar runs the scoped project search, never global Ask.
        // (The driver also checks the CLI log for the scoped `projects search`.)
        query.stringValue = "ship"; submit.performClick(nil)
        wait("scoped search") { !projects.busy && projects.items.count == 1 }; require(questions.isEmpty, "project bar reached onAsk")
        settle("search settle")
        // People is a sheet opened from the people stack; opening it re-reads
        // the roster (it does not show the avatar stack's earlier page).
        ProofUI.find(NSButton.self, "people-button", "Project members", in: chrome).performClick(nil)
        require(projects.busy && projects.members.isEmpty, "opening People did not re-read the roster")
        wait("people sheet") { window.attachedSheet != nil && !projects.busy && !projects.members.isEmpty }
        let people = sheetRoot("people")
        let viewer = projects.members.first(where: { $0.membership_id == identity.membershipID })
        let others = projects.members.filter { $0.membership_id != identity.membershipID }
        let rowMenus = ProofUI.views(people).compactMap({ $0 as? NSButton })
            .filter { ProofUI.visible($0) && ($0.accessibilityLabel() ?? "").hasPrefix("More for ") }
        let addFields = ProofUI.all(NSTextField.self, "people-add-field", in: people).filter(ProofUI.visible)
        if mode == "ui-member" {
            require(rowMenus.isEmpty && addFields.isEmpty, "member sees membership management")
            require(!ProofUI.views(people).compactMap({ $0 as? NSButton }).contains(where: {
                ProofUI.visible($0) && (["Make lead", "Make member", "Remove from project", "Add"].contains($0.title) || ($0.accessibilityLabel() ?? "").hasPrefix("Add "))
            }), "member sees membership actions")
            projects.directory("ari"); projects.setMember(member, role: "lead"); require(!projects.busy)
            return
        }
        // A lead manages everyone but themself: no "…" on their own row.
        require(Set(rowMenus.compactMap { $0.accessibilityLabel() }) == Set(others.map { "More for \($0.display_name)" }), "row menus must be exactly the other people's")
        if let viewer { require(!rowMenus.contains { $0.accessibilityLabel() == "More for \(viewer.display_name)" }, "viewer's own row has a … menu") }
        require(addFields.count == 1 && addFields[0].isEnabled, "lead is missing an enabled Add someone field")
        if mode == "ui-people" { peopleProof(); return }
        // The People sheet must be closed first, so the attached sheet below is compose.
        ProofUI.find(NSButton.self, "people-done", in: people).performClick(nil)
        wait("people closed") { window.attachedSheet == nil && !projects.busy && !uploads.busy }
        settle("people closed settle")
        // The search shown before People comes back with its query (the
        // roster load cleared the column).
        require(query.stringValue == "ship" && ProofUI.visible(ProofUI.find(NSButton.self, "clear-search", in: chrome)) && projects.items.count == 1,
                "People replaced the search with the feed")
        controller.startWrite(); wait("compose sheet") { window.attachedSheet != nil }
        var compose = sheetRoot("compose")
        let body = ProofUI.find(NSTextView.self, "compose-body", "Original note text", in: compose)
        let to = ProofUI.find(ChipMenuButton.self, "compose-to", "Send to", in: compose)
        let send = ProofUI.find(NSButton.self, "compose-send", "Send", in: compose)
        // Composing inside Apollo defaults To to Apollo; the choices are
        // Only me, the live projects, then Organization.
        require(to.title == "Apollo", "compose inside a project must default To to it")
        require(to.choices.first == "Only me" && to.choices.last == "Organization" && to.choices.contains("Apollo") && to.choices.contains("Beacon"), "To choices")
        require(body.string.isEmpty && !send.isEnabled, "Send enabled with an empty body")
        body.string = " \n\t"; body.didChangeText(); require(!send.isEnabled, "Send enabled with a whitespace body")
        body.string = "We agreed to ship.\n"; body.didChangeText(); require(send.isEnabled, "Send disabled with text")
        // The chip is drivable without its menu.
        guard let choose = to.onChoose else { fatalError("compose-to has no onChoose") }
        choose(0); require(to.title == "Only me", "choosing Only me did not update To")
        guard let apollo = to.choices.firstIndex(of: "Apollo") else { fatalError("Apollo is not a To choice") }
        choose(apollo); require(to.title == "Apollo", "choosing Apollo did not update To")
        require(body.string == "We agreed to ship.\n" && send.isEnabled, "changing To altered the draft")
        if mode == "ui-access-loss" {
            wait("idle before read") { !projects.busy }
            require(projects.selected?.project_id == project)
            projects.read(context); wait("lost project") { !projects.busy }
            require(projects.selected == nil && projects.items.isEmpty && projects.content == nil)
            require(body.string.isEmpty && window.attachedSheet == nil)
            require(uploads.draft == nil && questions.isEmpty)
            // The page says so (no stale project title) and offers a reload.
            require(window.title == "ECHO" && ProofUI.showsText("This project or original is no longer available to you.", in: chrome), "lost project page")
            require(visibleButton("reload-project", in: chrome) != nil, "no reload on a lost project")
            return
        }
        send.performClick(nil)
        require(uploads.hasOutstandingMutation && !body.isEditable, "body must lock while sending")
        if mode == "ui-upload-rejected" {
            wait("upload rejection") { !uploads.busy }
            require(uploads.receipt == nil && uploads.draft == nil && uploads.recovery?.projectID == project)
            require(uploads.recovery?.audience.project_id == project && projects.selected == nil)
            require(body.string.isEmpty && window.attachedSheet == nil); return
        }
        if mode == "ui-upload-unknown" {
            wait("unknown upload") { !uploads.busy }
            guard let originalDraft = uploads.draft else { fatalError("missing immutable draft") }
            let id = originalDraft.requestID
            require(uploads.receipt == nil && uploads.recovery?.requestID == id)
            require(ProofUI.showsText("This may not have been sent.", in: sheetRoot("attention")), "unknown outcome is not shown")
            require(!ProofUI.claimsSent(sheetRoot("attention")), "sent claimed without a receipt")
            let retry = ProofUI.find(NSButton.self, "compose-retry", in: sheetRoot("attention"))
            let check = ProofUI.find(NSButton.self, "compose-check", in: sheetRoot("attention"))
            require(retry.title == "Retry same save" && check.title == "Check status")
            require(ProofUI.visible(retry) && retry.isEnabled && ProofUI.visible(check) && check.isEnabled, "recovery is not actionable")
            retry.performClick(nil); wait("rejected exact replay") { !uploads.busy }
            require(uploads.receipt == nil && uploads.recovery?.requestID == id && uploads.draft?.requestID == id)
            require(uploads.draft?.audience.project_id == project && uploads.draft?.projectID == project)
            require(!ProofUI.claimsSent(sheetRoot("attention")), "sent claimed after a rejected replay")
            let recheck = ProofUI.find(NSButton.self, "compose-check", in: sheetRoot("attention"))
            require(ProofUI.visible(recheck) && recheck.isEnabled, "Check status lost after a rejected replay")
            recheck.performClick(nil)
        }
        wait("project save") { !uploads.busy && uploads.receipt != nil }
        // To = Apollo means audience = association = Apollo.
        require(uploads.receipt?.audience == UploadAudience(.project, projectID: project))
        require(uploads.receipt?.project_id == project)
        require(uploads.recovery?.audience.project_id == project && uploads.recovery?.projectID == project)
        let sent = sheetRoot("sent")
        require(!ProofUI.offersUndo(sent) && !ProofUI.offersUndo(chrome), "Undo offered after save")
        require(ProofUI.showsText("Sent to Apollo", in: sent), "sent state does not name the project")
        let done = ProofUI.find(NSButton.self, "compose-done", in: sent)
        require(done.title == "Done"); done.performClick(nil)
        wait("compose closed") { window.attachedSheet == nil }
        require(uploads.receipt == nil && uploads.recovery == nil && uploads.canCompose, "Done must start another note")
        if mode == "ui-round-trip" && !cli {
            settle("after first send")
            // The last To carries over outside the project…
            back.performClick(nil); wait("home again") { !projects.busy && projects.projects.count == 2 }; settle("home settle")
            controller.startWrite(); wait("home compose") { window.attachedSheet != nil }
            require(ProofUI.find(ChipMenuButton.self, "compose-to", in: sheetRoot("home compose")).title == "Apollo", "last project choice not remembered")
            window.attachedSheet?.cancelOperation(nil); wait("home compose closed") { window.attachedSheet == nil }
            // …but never into another account (or a signed-out window).
            controller.accountWillChange(); settle("signed out")
            controller.startWrite(); wait("signed-out compose") { window.attachedSheet != nil }
            let reset = ProofUI.find(ChipMenuButton.self, "compose-to", in: sheetRoot("signed-out compose"))
            require(reset.title == "Only me" && !reset.choices.contains("Apollo"), "last To survived an account change")
            window.attachedSheet?.cancelOperation(nil); wait("signed-out compose closed") { window.attachedSheet == nil }
            controller.refreshIdentity(); wait("signed in again") { !uploads.busy && uploads.identity != nil && !projects.busy && projects.projects.count == 2 }
            settle("signed in settle")
            openApollo()
            // Only me and Organization chosen inside a project send no project at all.
            for (choice, title, visibility) in [("Only me", "Saved for you", UploadVisibility.onlyMe), ("Organization", "Sent to your organization", .team)] {
                controller.startWrite(); wait("compose \(choice)") { window.attachedSheet != nil }
                compose = sheetRoot("compose \(choice)")
                let chip = ProofUI.find(ChipMenuButton.self, "compose-to", in: compose)
                require(chip.title == "Apollo", "compose inside Apollo must default To to Apollo")
                chip.onChoose?(chip.choices.firstIndex(of: choice)!)
                let text = ProofUI.find(NSTextView.self, "compose-body", in: compose)
                text.string = "\(choice) note\n"; text.didChangeText()
                ProofUI.find(NSButton.self, "compose-send", in: compose).performClick(nil)
                wait("\(choice) save") { !uploads.busy && uploads.receipt != nil }
                require(uploads.receipt?.visibility == visibility && uploads.receipt?.project_id == nil, "\(choice) sent with a project")
                require(ProofUI.showsText(title, in: sheetRoot("sent \(choice)")), "\(choice) sent title")
                ProofUI.find(NSButton.self, "compose-done", in: sheetRoot("sent \(choice)")).performClick(nil)
                wait("\(choice) closed") { window.attachedSheet == nil }; settle("\(choice) settle")
            }
            // Organization is never remembered as the next default.
            back.performClick(nil); wait("home after org") { !projects.busy && projects.projects.count == 2 }; settle("home after org")
            controller.startWrite(); wait("compose after org") { window.attachedSheet != nil }
            require(ProofUI.find(ChipMenuButton.self, "compose-to", in: sheetRoot("compose after org")).title == "Only me", "Organization became the default To")
            window.attachedSheet?.cancelOperation(nil); wait("compose after org closed") { window.attachedSheet == nil }
        }
        query.stringValue = "unsent question"
        controller.accountWillChange()
        require(projects.selected == nil && projects.projects.isEmpty && uploads.recovery == nil && query.stringValue.isEmpty)
        require(questions.isEmpty)

        func peopleProof() {
            func sheetMenu(_ person: String) -> NSMenu {
                guard let button = ProofUI.all(IconButton.self, "More for \(person)", in: sheetRoot("people")).first(where: ProofUI.visible),
                      let menu = button.menuProvider?() else { fatalError("no … for \(person)") }
                return menu
            }
            func choose(_ title: String, for person: String) {
                let menu = sheetMenu(person)
                guard let index = menu.items.firstIndex(where: { $0.title == title }) else { fatalError("no \(title) for \(person)") }
                require(menu.items[index].isEnabled, "\(title) disabled")
                menu.performActionForItem(at: index)
            }
            func settled(_ label: String) {
                wait(label) { !projects.busy && window.attachedSheet?.attachedSheet == nil && !projects.members.isEmpty }
                settle(label)
            }
            // Add from the directory, behind a confirm naming the person.
            let field = ProofUI.all(NSTextField.self, "people-add-field", in: sheetRoot("people")).first(where: ProofUI.visible)!
            field.stringValue = "cleo"; field.sendAction(field.action, to: field.target)
            wait("candidates") { !projects.busy && projects.candidates.count == 1 }
            wait("add pill") { ProofUI.all(NSButton.self, "Add Cleo", in: sheetRoot("people")).contains(where: ProofUI.visible) }
            ProofUI.all(NSButton.self, "Add Cleo", in: sheetRoot("people")).first(where: ProofUI.visible)!.performClick(nil)
            let add = alert("add alert", onSheet: true)
            require(ProofUI.showsText("Add Cleo?", in: add), "add alert does not name the person")
            press("Add", in: add); settled("added")
            // Remove, cancelled first: nothing runs.
            choose("Remove from project", for: "Bea")
            let cancelled = alert("remove alert", onSheet: true)
            require(ProofUI.showsText("Remove Bea?", in: cancelled), "remove alert does not name the person")
            press("Cancel", in: cancelled); settled("cancelled")
            // A confirm left open while the app is concealed ends with the
            // sheet and never lands on a later project.
            choose("Make lead", for: "Bea")
            _ = alert("role alert", onSheet: true)
            let peopleWindow = window.attachedSheet
            controller.conceal()
            wait("concealed") { window.attachedSheet == nil && !projects.busy }
            require(peopleWindow?.attachedSheet == nil, "confirm alert outlived its sheet")
            controller.refreshIdentity(); wait("home again") { !uploads.busy && !projects.busy && projects.projects.count == 2 }
            settle("home settle")
            openApollo()
            ProofUI.find(NSButton.self, "people-button", "Project members", in: chrome).performClick(nil)
            wait("people again") { window.attachedSheet != nil && !projects.busy && !projects.members.isEmpty }
            settle("people again settle")
            require(window.attachedSheet?.attachedSheet == nil, "a stale alert came back with the sheet")
            choose("Remove from project", for: "Bea")
            press("Remove", in: alert("remove alert 2", onSheet: true))
            wait("removed") { !projects.busy && window.attachedSheet?.attachedSheet == nil && projects.members.count == 1 }
            settle("removed settle")
            ProofUI.find(NSButton.self, "people-done", in: sheetRoot("people")).performClick(nil)
            wait("people closed") { window.attachedSheet == nil }
        }
    }
    @MainActor static func scenario(_ mode: String, executable: URL) {
        let cli = ProjectCLI(executable: executable)
        let client = ProjectClient(cli: cli)
        if mode == "recovery-store-failure" {
            let store = ProofRecoveryStore(); store.synchronizes = false
            let guarded = ProjectSession(client: client, defaults: store, foreground: { true })
            guarded.bind(identity); wait("store-failure list") { !guarded.busy }
            guarded.create("Apollo")
            require(!guarded.busy && guarded.pending == nil && guarded.status.contains("safely record"), "unacknowledged recovery launched a mutation")
            let recovery = ProjectMutationRecovery(identity: identity, command: .create("Apollo", UUID().uuidString.lowercased()))!
            store.synchronizes = true; require(recovery.save(for: identity, defaults: store), "recovery setup")
            let restarting = ProjectSession(client: client, defaults: store, foreground: { true })
            restarting.bind(identity); wait("clear-failure list") { !restarting.busy }
            require(restarting.pending?.arguments == recovery.command?.arguments, "recovery setup was not loaded")
            let key = ProjectMutationRecovery.recoveryKey(for: identity); let stored = store.data(forKey: key)
            store.synchronizes = false; restarting.abandonPending()
            require(restarting.needsRecoveryReview && restarting.pending?.arguments == recovery.command?.arguments && store.data(forKey: key) == stored, "unacknowledged clear unlocked mutation")
            return
        }
        let suite = "org.echobrain.test.projects." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        if mode == "malformed-recovery" {
            defaults.set(Data("{bad".utf8), forKey: ProjectMutationRecovery.recoveryKey(for: identity))
            let blocked = ProjectSession(client: client, defaults: defaults, foreground: { true })
            blocked.bind(identity); wait("blocked list") { !blocked.busy }
            require(blocked.needsRecoveryReview && !blocked.canMutate && blocked.pending == nil, "corrupt recovery must block")
            blocked.create("Apollo"); require(!blocked.busy, "corrupt recovery launched a mutation")
            blocked.abandonPending(); require(!blocked.needsRecoveryReview && blocked.canMutate, "explicit abandon must clear corrupt recovery")
            let restarted = ProjectSession(client: client, defaults: UserDefaults(suiteName: suite)!, foreground: { true })
            restarted.bind(identity); wait("cleared restart") { !restarted.busy }
            require(!restarted.needsRecoveryReview && restarted.canMutate, "cleared recovery returned after restart")
            return
        }
        let session = ProjectSession(client: client, defaults: defaults, foreground: { true })
        session.bind(identity); wait("list") { !session.busy }
        if mode == "unsupported" {
            require(session.availability == .notLive && session.projects.isEmpty); return
        }
        require(session.availability == .live && session.projects.count == 1)
        if mode == "pagination" {
            // "More projects" adds the next page below the first.
            require(session.listCursor != nil, "list cursor")
            session.nextProjects(); wait("next projects") { !session.busy }
            require(session.projects.map(\.project_id) == [project, other] && session.listCursor == nil, "list page replaced, not appended")
        }
        session.open(project)
        if mode == "switch-project" { session.open(other) }
        wait("project") { !session.busy }
        if mode == "switch-project" {
            require(session.selected?.project_id == other && session.items.count == 1)
            require(session.content == nil); return
        }
        if mode == "switch-account" {
            require(session.identity == nil && session.selected == nil && session.items.isEmpty && session.projects.isEmpty); return
        }
        if mode == "inaccessible" {
            require(session.selected == nil && session.items.isEmpty && session.availability == .live); return
        }
        require(session.selected?.project_id == project && session.items.count == 1)
        session.read(context); wait("read") { !session.busy }
        require(session.content?.text == "We agreed to ship.\n")
        if mode == "account-clear" {
            session.bind(nil); require(session.content == nil && session.selected == nil && session.projects.isEmpty); return
        }
        if mode == "pagination" {
            // Member pages append (the avatar stack keeps page one)…
            session.loadMembers(); wait("members") { !session.busy }
            require(session.members.count == 1 && session.memberCursor != nil, "first member page")
            session.nextMembers(); wait("more members") { !session.busy }
            require(session.members.map(\.membership_id) == ["mem_22222222-2222-4222-8222-222222222222", member] && session.memberCursor == nil, "member page replaced, not appended")
            session.search("ship"); wait("search") { !session.busy }
            require(session.pageCursor != nil)
            session.nextPage(); wait("next page") { !session.busy }
            require(session.pageCursor == nil && session.items.count == 1 && session.items[0].context_id != context)
            // …and Older / More results never clears them.
            require(session.members.count == 2, "paging the feed cleared the members")
            return
        }
        session.roster(); wait("roster") { !session.busy }
        require(session.members.count == 1)
        if mode == "demoted" {
            require(!session.canManage && session.selected?.role == "member")
            session.directory("ari"); session.setMember(member, role: "lead"); require(!session.busy); return
        }
        session.directory("ari"); wait("directory") { !session.busy }
        require(session.candidates.count == 1)
        session.setMember(member, role: "member"); wait("membership") { !session.busy }
        if mode == "uncertain-mutation" || mode == "restart-recovery" || mode == "uncertain-overflow" {
            guard let pending = session.pending else { fatalError("lost replay") }
            let args = pending.arguments
            session.retry(); wait("retry") { !session.busy }
            require(session.pending?.arguments == args)
            if mode == "restart-recovery" {
                var inactive = identity; inactive.membershipID = member
                guard case .missing = ProjectMutationRecovery.load(for: inactive, defaults: defaults) else { fatalError("recovery leaked to another account") }
                let restarted = ProjectSession(client: client, defaults: UserDefaults(suiteName: suite)!, foreground: { true })
                restarted.bind(identity); wait("restart") { !restarted.busy }
                require(restarted.pending?.arguments == args, "restart lost frozen mutation")
                restarted.abandonPending(); require(!restarted.needsRecoveryReview, "explicit abandon retained recovery")
                let cleared = ProjectSession(client: client, defaults: UserDefaults(suiteName: suite)!, foreground: { true })
                cleared.bind(identity); wait("cleared restart") { !cleared.busy }
                require(cleared.pending == nil && cleared.canMutate, "abandoned recovery returned after restart")
                return
            }
            session.bind(nil); require(session.pending == nil && session.selected == nil)
            session.bind(identity); wait("return to original account") { !session.busy }
            require(session.pending?.arguments == args, "account change lost frozen mutation")
        } else {
            require(session.pending == nil && session.selected != nil)
            session.removeMember(member); wait("remove member") { !session.busy }; require(session.pending == nil)
            session.associate(context, project: project, add: true); wait("associate") { !session.busy }; require(session.pending == nil)
            session.associate(context, project: project, add: false); wait("dissociate") { !session.busy }; require(session.pending == nil)
            if mode == "restart-create" {
                session.create("Apollo"); wait("unknown create") { !session.busy }
                guard let args = session.pending?.arguments else { fatalError("create lost replay") }
                let restarted = ProjectSession(client: client, defaults: UserDefaults(suiteName: suite)!, foreground: { true })
                restarted.bind(identity); wait("create restart") { !restarted.busy }
                require(restarted.pending?.arguments == args, "restart lost exact create")
                restarted.retry(); wait("create retry") { !restarted.busy && restarted.pending == nil }
                let cleared = ProjectSession(client: client, defaults: UserDefaults(suiteName: suite)!, foreground: { true })
                cleared.bind(identity); wait("create cleared restart") { !cleared.busy }
                require(cleared.pending == nil, "successful create did not clear recovery")
                return
            }
            session.create("Apollo"); wait("create") { !session.busy }; require(session.pending == nil && session.selected?.project_id == project)
        }
    }
}
