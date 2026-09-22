import AppKit
import Foundation

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
{"schema_version":1,"kind":"echo-project-context-feed-v1","project_id":"prj_11111111-1111-4111-8111-111111111111","items":[{"context_id":"ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","received_at":"2026-09-21T22:01:00.000Z","title":"Apollo","excerpt":"note","audience":{"kind":"project","k\u0069nd":"team","project_id":"prj_11111111-1111-4111-8111-111111111111"}}],"next_cursor":null}
"""#
            guard case .failure = ProjectClient.parse(Data(duplicateNested.utf8), command: commands[9]) else { fatalError("duplicate nested key") }
            let duplicateError = #"""
{"ok":false,"action":"projects-member-set","error":"Request failed","code":"conflict","c\u006fde":"invalid_request","status":409,"request_id":"00000000-0000-4000-8000-000000000002","mutation_outcome":"not_submitted"}
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
            uiProof(mode, executable: URL(fileURLWithPath: CommandLine.arguments[3]))
        } else {
            scenario(mode, executable: URL(fileURLWithPath: CommandLine.arguments[3]))
        }
        print("passed \(mode)")
    }
    @MainActor static func uiProof(_ mode: String, executable: URL) {
        let app = NSApplication.shared; app.setActivationPolicy(.regular); app.finishLaunching()
        let cli = ProjectCLI(executable: executable)
        let suite = "org.echo.pc05.ui." + UUID().uuidString; let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let uploads = UploadSession(client: UploadClient(cli: cli), defaults: defaults, isForeground: { true })
        let projects = ProjectSession(client: ProjectClient(cli: cli), foreground: { true })
        var questions: [String] = []
        let controller = ProjectsController(uploads: uploads, projects: projects, onAsk: { questions.append($0) })
        defer { controller.shutdown() }
        func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
        let root = controller.window.contentView!
        func button(_ title: String, in view: NSView? = nil) -> NSButton {
            guard let result = views(view ?? root).compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else { fatalError("Missing button: \(title)") }
            return result
        }
        controller.show(); wait("home") { !uploads.busy && uploads.identity != nil && !projects.busy && projects.projects.count == 2 }
        require(button("New project").isEnabled)
        button(mode == "ui-member" ? "Apollo · Member" : "Apollo · Lead").performClick(nil)
        wait("project") { !projects.busy && projects.items.count == 1 }
        let projectAsk = button("Ask this project · Not live yet"); require(!projectAsk.isEnabled)
        projectAsk.performClick(nil); require(questions.isEmpty)
        let query = views(root).compactMap({ $0 as? NSTextField }).first(where: { $0.accessibilityLabel() == "Ask or find context" })!
        let submit = views(root).compactMap({ $0 as? NSButton }).first(where: { $0.accessibilityLabel() == "Submit" })!
        query.stringValue = "ship"; submit.performClick(nil)
        wait("scoped search") { !projects.busy && projects.items.count == 1 }; require(questions.isEmpty)
        button("Project members").performClick(nil); wait("roster") { !projects.busy && projects.members.count == 1 }
        if mode == "ui-member" {
            require(!views(root).compactMap({ $0 as? NSButton }).contains(where: { $0.title == "Find member" || $0.title == "Make lead" || $0.title == "Remove from project" }))
            projects.directory("ari"); projects.setMember(member, role: "lead"); require(!projects.busy)
            return
        }
        require(button("Find member").isEnabled)
        controller.startWrite(); wait("sheet") { controller.window.attachedSheet != nil }
        let sheet = controller.window.attachedSheet!.contentView!
        let body = views(sheet).compactMap({ $0 as? NSTextView }).first(where: { $0.accessibilityLabel() == "Original note text" })!
        body.string = "We agreed to ship.\n"
        let destination = views(sheet).compactMap({ $0 as? NSPopUpButton }).first(where: { $0.accessibilityLabel() == "Note destination project" })!
        let audience = views(sheet).compactMap({ $0 as? NSPopUpButton }).first(where: { $0.accessibilityLabel() == "Note audience project" })!
        destination.selectItem(at: 2)
        button("Continue", in: sheet).performClick(nil)
        button("Project members", in: sheet).performClick(nil)
        require(!button("Save", in: sheet).isEnabled)
        audience.selectItem(at: 1); _ = audience.target?.perform(audience.action, with: audience)
        require(button("Save", in: sheet).isEnabled)
        if mode == "ui-access-loss" {
            projects.read(context); wait("lost project") { !projects.busy }
            require(projects.selected == nil && projects.items.isEmpty && projects.content == nil)
            require(body.string.isEmpty && controller.window.attachedSheet == nil)
            require(uploads.draft == nil && questions.isEmpty); return
        }
        button("Save", in: sheet).performClick(nil)
        if mode == "ui-upload-rejected" {
            wait("upload rejection") { !uploads.busy }
            require(uploads.receipt == nil && uploads.draft == nil && uploads.recovery?.projectID == other)
            require(uploads.recovery?.audience.project_id == project && projects.selected == nil)
            require(body.string.isEmpty && controller.window.attachedSheet == nil); return
        }
        if mode == "ui-upload-unknown" {
            wait("unknown upload") { !uploads.busy }
            guard let originalDraft = uploads.draft else { fatalError("missing immutable draft") }
            let id = originalDraft.requestID
            require(uploads.receipt == nil && uploads.recovery?.requestID == id)
            button("Retry same save", in: sheet).performClick(nil); wait("rejected exact replay") { !uploads.busy }
            require(uploads.receipt == nil && uploads.recovery?.requestID == id && uploads.draft?.requestID == id)
            require(uploads.draft?.audience.project_id == project && uploads.draft?.projectID == other)
            button("Check status", in: sheet).performClick(nil)
        }
        wait("project save") { !uploads.busy && uploads.receipt != nil }
        require(uploads.receipt?.audience == UploadAudience(.project, projectID: project))
        require(uploads.receipt?.project_id == other)
        require(uploads.recovery?.audience.project_id == project && uploads.recovery?.projectID == other)
        button("Done", in: sheet).performClick(nil)
        controller.accountWillChange()
        require(projects.selected == nil && projects.projects.isEmpty && uploads.recovery == nil && query.stringValue.isEmpty)
    }
    @MainActor static func scenario(_ mode: String, executable: URL) {
        let cli = ProjectCLI(executable: executable)
        let client = ProjectClient(cli: cli)
        let session = ProjectSession(client: client, foreground: { true })
        session.bind(identity); wait("list") { !session.busy }
        if mode == "unsupported" {
            require(session.availability == .notLive && session.projects.isEmpty); return
        }
        require(session.availability == .live && session.projects.count == 1)
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
            session.search("ship"); wait("search") { !session.busy }
            require(session.pageCursor != nil)
            session.nextPage(); wait("next page") { !session.busy }
            require(session.pageCursor == nil && session.items.count == 1 && session.items[0].context_id != context)
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
        if mode == "uncertain-mutation" || mode == "uncertain-overflow" {
            guard let pending = session.pending else { fatalError("lost replay") }
            let args = pending.arguments
            session.retry(); wait("retry") { !session.busy }
            require(session.pending?.arguments == args)
            session.bind(nil); require(session.pending == nil && session.selected == nil)
            session.bind(identity); wait("return to original account") { !session.busy }
            require(session.pending?.arguments == args, "account change lost frozen mutation")
        } else {
            require(session.pending == nil && session.selected != nil)
            session.removeMember(member); wait("remove member") { !session.busy }; require(session.pending == nil)
            session.associate(context, project: project, add: true); wait("associate") { !session.busy }; require(session.pending == nil)
            session.associate(context, project: project, add: false); wait("dissociate") { !session.busy }; require(session.pending == nil)
            session.create("Apollo"); wait("create") { !session.busy }; require(session.pending == nil && session.selected?.project_id == project)
        }
    }
}
