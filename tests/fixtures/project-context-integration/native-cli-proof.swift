import AppKit
import Foundation

// Compiled from this worktree's real native clients. The executable argument
// invokes the real built Person CLI; it never returns canned JSON.
@main
enum NativeIntegrationProof {
    static func require(_ value: @autoclosure () -> Bool, _ message: String) {
        if !value() { fatalError(message) }
    }
    static func wait(_ label: String, _ ready: () -> Bool) {
        let deadline = Date().addingTimeInterval(20)
        while !ready() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        require(ready(), "Timed out: \(label)")
    }
    @MainActor static func main() {
        let args = CommandLine.arguments
        let cli = ProjectCLI(executable: URL(fileURLWithPath: args[1]))
        guard case .signedIn(let identity) = cli.account.readStatus(AccountRunning()) else { fatalError("real CLI status unavailable") }
        let suite = "org.echobrain.test.native-projects." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let session = ProjectSession(client: ProjectClient(cli: cli), defaults: defaults, foreground: { true })
        session.bind(identity); wait("discovery") { !session.busy }
        if args[2] == "unsupported" {
            require(session.availability == .notLive && session.projects.isEmpty, "unsupported list must stay not live")
            print("passed unsupported"); return
        }
        let alpha = args[3], beta = args[4], cross = args[5]
        require(session.availability == .live, "real capability probe")
        if args[2] == "alice" {
            require(session.projects.count == 2, "overlapping project memberships")
            session.open(alpha); wait("alpha") { !session.busy }
            require(session.items.count == 3, "all permitted Alpha originals")
            session.search("meridian"); wait("search") { !session.busy }
            require(session.items.count == 3, "scoped original search")
            session.roster(); wait("roster") { !session.busy }
            require(session.members.count == 2, "real project roster")
            session.open(beta); wait("beta") { !session.busy }
            require(session.items.count == 1, "cross-associated source")
            session.read(cross); wait("original") { !session.busy }
            require(session.content?.text == "PC06 original cross meridian.", "real original bytes")
            let draft = try! UploadDraft(title: "Synthetic native note", bytes: Data("native original meridian\n".utf8),
                visibility: .project, audienceProjectID: alpha, projectID: beta)
            guard case .saved(let receipt) = UploadClient(cli: cli).execute(.submit(draft), identity: identity, running: AccountRunning()) else { fatalError("real native upload") }
            require(receipt.audience == UploadAudience(.project, projectID: alpha) && receipt.project_id == beta, "independent audience and association")
        } else {
            require(session.projects.count == 1 && session.projects[0].project_id == beta, "disjoint membership")
            session.open(beta); wait("beta") { !session.busy }
            require(session.items.isEmpty, "association cannot widen audience")
            session.read(cross); wait("inaccessible read") { !session.busy }
            require(session.selected == nil && session.items.isEmpty && session.content == nil, "access loss clears project content")
            require(session.availability == .live, "individual 404 is not capability absence")
        }
        session.bind(nil)
        require(session.projects.isEmpty && session.selected == nil && session.content == nil, "account change clears scope")
        print("passed \(args[2])")
    }
}
