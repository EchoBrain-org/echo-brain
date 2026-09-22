import AppKit
import CryptoKit
import Darwin
import Foundation

enum UploadVisibility: String, Codable {
    case onlyMe = "only_me", team, project
    var label: String { switch self { case .onlyMe: return "Only me"; case .team: return "Everyone in my organization"; case .project: return "Project members" } }
    var argument: String { self == .onlyMe ? "only-me" : rawValue }
}
struct UploadAudience: Codable, Equatable {
    let kind: UploadVisibility
    let project_id: String?
    init(_ kind: UploadVisibility, projectID: String? = nil) { self.kind = kind; project_id = projectID }
    var valid: Bool { kind == .project ? ProjectWire.id(project_id ?? "", prefix: "prj_") : project_id == nil }
    var label: String { kind.label }
    static func validObject(_ object: Any?) -> Bool {
        guard let o = object as? [String: Any], let kind = o["kind"] as? String,
              let visibility = UploadVisibility(rawValue: kind) else { return false }
        return ProjectWire.keys(o, visibility == .project ? ["kind", "project_id"] : ["kind"]) &&
            UploadAudience(visibility, projectID: o["project_id"] as? String).valid
    }
}
private func uploadText(_ value: String, maximum: Int, multiline: Bool = false) -> Bool {
    ProjectWire.text(value, max: maximum, multiline: multiline)
}
private func uploadID(_ value: String) -> Bool { value.range(of: "^ctx_[0-9a-f]{64}$", options: .regularExpression) != nil }

func uploadQuery(_ source: String) -> String? {
    let text = source.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
    guard !text.isEmpty, text.unicodeScalars.count <= 240,
          !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || [0x2028, 0x2029].contains($0.value) }) else { return nil }
    let expression = try! NSRegularExpression(pattern: "[\\p{L}\\p{N}]+")
    let terms = Set(expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match -> String? in
        guard let range = Range(match.range, in: text) else { return nil }
        return String(text[range]).lowercased().precomposedStringWithCanonicalMapping
    })
    guard (1...32).contains(terms.count), terms.allSatisfy({ $0.utf8.count <= 64 }) else { return nil }
    return text
}

struct UploadReceipt: Decodable {
    let schema_version: Int
    let kind: String
    let request_id: String
    let context_id: String
    let received_at: String
    let audience: UploadAudience
    let project_id: String?
    let state: String?
    let status: String?
    let metadata: String?
    var visibility: UploadVisibility { audience.kind }
    var valid: Bool {
        schema_version == 2 && uploadID(context_id) && ProjectWire.date(received_at) && audience.valid &&
        (project_id == nil || ProjectWire.id(project_id!, prefix: "prj_")) && ProjectWire.id(request_id, prefix: "")
    }
    var message: String {
        let enrichment: String
        switch metadata {
        case "ready": enrichment = "Search metadata is ready."
        case "unavailable": enrichment = "Extra search metadata is unavailable; your original is still searchable."
        default: enrichment = "Extra search metadata is being prepared."
        }
        return "Saved · \(audience.label). Available in search now. \(enrichment)"
    }
}
struct UploadMatch: Decodable {
    let context_id: String
    let received_at: String
    let audience: UploadAudience
    let title: String
    let excerpt: String
    var visibility: UploadVisibility { audience.kind }
    static func validObject(_ o: [String: Any]) -> Bool {
        guard ProjectWire.keys(o, ["context_id", "received_at", "audience", "title", "excerpt"]),
              let excerpt = o["excerpt"] as? String else { return false }
        return uploadID(o["context_id"] as? String ?? "") && ProjectWire.date(o["received_at"] as? String ?? "") &&
            UploadAudience.validObject(o["audience"]) && uploadText(o["title"] as? String ?? "", maximum: 200) &&
            excerpt.unicodeScalars.count <= 300 && uploadText(excerpt, maximum: 1200, multiline: true)
    }
}
struct UploadContent: Decodable {
    let schema_version: Int
    let kind: String
    let context_id: String
    let received_at: String
    let audience: UploadAudience
    let title: String
    let text: String
    var visibility: UploadVisibility { audience.kind }
    static func validFields(_ o: [String: Any]) -> Bool {
        uploadID(o["context_id"] as? String ?? "") && ProjectWire.date(o["received_at"] as? String ?? "") &&
        UploadAudience.validObject(o["audience"]) && uploadText(o["title"] as? String ?? "", maximum: 200) &&
        uploadText(o["text"] as? String ?? "", maximum: 8192, multiline: true)
    }
}
private struct UploadSearchResponse: Decodable {
    let schema_version: Int
    let kind: String
    let results: [UploadMatch]
}

// A receipt locator, not a local content store or an upload queue. On restart,
// Check upload status can reconcile the last attempt without submitting again.
struct UploadRecovery: Codable, Equatable {
    let authority: String
    let membershipID: String
    let requestID: String
    let audience: UploadAudience
    let projectID: String?
    var visibility: UploadVisibility { audience.kind }

    init?(identity: AccountIdentity, requestID: String, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) {
        let audience = UploadAudience(visibility, projectID: audienceProjectID)
        guard audience.valid, projectID == nil || ProjectWire.id(projectID!, prefix: "prj_") else { return nil }
        guard let member = identity.membershipID, !member.isEmpty else { return nil }
        authority = identity.authority; membershipID = member
        self.requestID = requestID; self.audience = audience; self.projectID = projectID
    }
    func belongs(to identity: AccountIdentity) -> Bool {
        authority == identity.authority && membershipID == identity.membershipID
    }
    private static func key(_ identity: AccountIdentity) -> String {
        let bytes = Data("\(identity.authority)\n\(identity.membershipID ?? "")".utf8)
        return "org.echobrain.echo.upload-receipt." + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    func save(for identity: AccountIdentity, defaults: UserDefaults = .standard) {
        guard belongs(to: identity), let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(identity))
    }
    static func clear(for identity: AccountIdentity, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key(identity))
    }
    static func load(for identity: AccountIdentity, defaults: UserDefaults = .standard) -> UploadRecovery? {
        guard let data = defaults.data(forKey: key(identity)), data.count <= 4096,
              let result = try? JSONDecoder().decode(Self.self, from: data), result.belongs(to: identity), result.audience.valid,
              result.projectID == nil || ProjectWire.id(result.projectID!, prefix: "prj_"),
              result.requestID.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
        else { return nil }
        return result
    }
}

final class UploadDraft {
    let requestID: String
    let title: String
    let audience: UploadAudience
    let projectID: String?
    var visibility: UploadVisibility { audience.kind }
    let file: URL
    private let directory: URL

    init(title: String, bytes: Data, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) throws {
        let audience = UploadAudience(visibility, projectID: audienceProjectID)
        guard audience.valid, projectID == nil || ProjectWire.id(projectID!, prefix: "prj_") else { throw CocoaError(.validationMissingMandatoryProperty) }
        guard uploadText(title, maximum: 200), bytes.count <= 8192,
              let text = String(data: bytes, encoding: .utf8), uploadText(text, maximum: 8192, multiline: true)
        else { throw CocoaError(.fileReadCorruptFile) }
        self.title = title; self.audience = audience; self.projectID = projectID; requestID = UUID().uuidString.lowercased()
        var template = Array(FileManager.default.temporaryDirectory.appendingPathComponent("echo-upload-XXXXXXXX").path.utf8CString)
        guard let path = mkdtemp(&template) else { throw CocoaError(.fileWriteUnknown) }
        directory = URL(fileURLWithPath: String(cString: path), isDirectory: true)
        file = directory.appendingPathComponent("original.txt")
        do {
            try bytes.write(to: file, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    deinit { try? FileManager.default.removeItem(at: directory) }

    static func readFile(_ file: URL) throws -> Data {
        guard file.isFileURL else { throw CocoaError(.fileReadInvalidFileName) }
        let fd = open(file.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        guard fd >= 0 else { throw CocoaError(.fileReadNoPermission) }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 8192 else {
            throw CocoaError(.fileReadTooLarge)
        }
        var buffer = [UInt8](repeating: 0, count: 8193)
        var count = 0
        while count < buffer.count {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!.advanced(by: count), $0.count - count) }
            guard n >= 0 else { throw CocoaError(.fileReadUnknown) }
            if n == 0 { break }
            count += n
        }
        let bytes = Data(buffer.prefix(count))
        guard count <= 8192, let text = String(data: bytes, encoding: .utf8), uploadText(text, maximum: 8192, multiline: true) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return bytes
    }
}

enum UploadCommand {
    case submit(UploadDraft), status(UploadRecovery), search(String), read(String)
    var arguments: [String] {
        let base = ["person", "updates"]
        switch self {
        case .submit(let draft): return base + ["submit", "--request-id", draft.requestID, "--title", draft.title,
                                              "--file", draft.file.path, "--visibility", draft.visibility.argument]
                + (draft.audience.project_id.map { ["--audience-project-id", $0] } ?? [])
                + (draft.projectID.map { ["--project-id", $0] } ?? [])
        case .status(let receipt): return base + ["status", "--request-id", receipt.requestID]
        case .search(let query): return base + ["search", "--query", query, "--limit", "10"]
        case .read(let context): return base + ["read", "--context-id", context]
        }
    }
    var action: String {
        switch self { case .submit: return "updates-submit"; case .status: return "updates-status"; case .search: return "updates-search"; case .read: return "updates-read" }
    }
    var mutates: Bool { if case .submit = self { return true }; return false }
}

enum UploadResult {
    case saved(UploadReceipt), matches([UploadMatch]), content(UploadContent)
    case unavailable, failed, unconfirmed, unconfirmedAccount, rejected(ProjectFailure)
}

final class UploadClient: @unchecked Sendable {
    let cli: ProjectCLI
    var account: AccountClient { cli.account }
    init(cli: ProjectCLI = ProjectCLI()) { self.cli = cli }

    func perform(_ command: UploadCommand, identity: AccountIdentity,
                 completion: @escaping @MainActor (UploadResult) -> Void) -> AccountRunning {
        let running = AccountRunning()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.execute(command, identity: identity, running: running)
            DispatchQueue.main.async { completion(result) }
        }
        return running
    }

    func execute(_ command: UploadCommand, identity: AccountIdentity, running: AccountRunning) -> UploadResult {
        if case .status(let recovery) = command, !recovery.belongs(to: identity) { return .unavailable }
        switch cli.execute(command.arguments, identity: identity, running: running) {
        case .output(let bytes, let success):
            if !success {
                let requestID: String? = { if case .submit(let draft) = command { return draft.requestID }; return nil }()
                guard let failure = ProjectFailure.parse(bytes, action: command.action, requestID: requestID) else {
                    return command.mutates ? .unconfirmed : .failed
                }
                return failure.unknown ? .unconfirmed : .rejected(failure)
            }
            let result = Self.parse(bytes, command: command)
            if command.mutates, case .failed = result { return .unconfirmed }
            return result
        case .unavailable: return .unavailable
        case .accountChanged: return command.mutates ? .unconfirmedAccount : .unavailable
        case .failed: return command.mutates ? .unconfirmed : .failed
        }
    }

    static func parse(_ bytes: Data, command: UploadCommand) -> UploadResult {
        let decoder = JSONDecoder()
        guard let object = ProjectWire.object(bytes) else { return .failed }
        func keys(_ expected: [String]) -> Bool { ProjectWire.keys(object, expected) }
        func receipt(_ request: String, _ audience: UploadAudience, _ projectID: String?, status: Bool) -> UploadResult {
            guard keys(["schema_version", "kind", "request_id", "context_id", "received_at", "audience", "project_id"] + (status ? ["status", "metadata"] : ["state"])),
                  ProjectWire.header(object, version: 2, kind: status ? "echo-person-update-status-v2" : "echo-person-update-receipt-v2"),
                  UploadAudience.validObject(object["audience"]), object["project_id"] is NSNull || object["project_id"] is String,
                  let r = try? decoder.decode(UploadReceipt.self, from: bytes), r.valid,
                  r.request_id == request, r.audience == audience, r.project_id == projectID else { return .failed }
            guard status ? (r.status == "stored" && ["pending", "processing", "ready", "unavailable"].contains(r.metadata ?? "")) : r.state == "received" else { return .failed }
            return .saved(r)
        }
        switch command {
        case .submit(let draft): return receipt(draft.requestID, draft.audience, draft.projectID, status: false)
        case .status(let expected): return receipt(expected.requestID, expected.audience, expected.projectID, status: true)
        case .search:
            guard keys(["schema_version", "kind", "results"]),
                  ProjectWire.header(object, version: 2, kind: "echo-person-upload-search-v2"),
                  let entries = object["results"] as? [[String: Any]], entries.count <= 10, entries.allSatisfy(UploadMatch.validObject),
                  let r = try? decoder.decode(UploadSearchResponse.self, from: bytes),
                  Set(r.results.map(\.context_id)).count == r.results.count else { return .failed }
            return .matches(r.results)
        case .read(let id):
            guard keys(["schema_version", "kind", "context_id", "received_at", "audience", "title", "text"]),
                  ProjectWire.header(object, version: 2, kind: "echo-person-upload-content-v2"), UploadContent.validFields(object),
                  let r = try? decoder.decode(UploadContent.self, from: bytes), r.context_id == id else { return .failed }
            return .content(r)
        }
    }
}

// Shared UI state for the supported upload commands. Content stays in memory;
// only the account-scoped receipt locator survives a restart.
@MainActor
final class UploadSession {
    let client: UploadClient
    private let defaults: UserDefaults
    private let isForeground: @MainActor () -> Bool
    var onChange: (() -> Void)?
    var onProjectAccessChanged: (() -> Void)?
    private(set) var identity: AccountIdentity?
    private(set) var matches: [UploadMatch] = []
    private(set) var content: UploadContent?
    private(set) var receipt: UploadReceipt?
    private(set) var recovery: UploadRecovery?
    private(set) var draft: UploadDraft?
    private(set) var status = ""
    private(set) var busy = false
    private(set) var hasOutstandingMutation = false
    private var active: AccountRunning?
    private var generation = UUID()
    private var concealed = false
    private var activeContentRead = false

    init(client: UploadClient = UploadClient(), defaults: UserDefaults = .standard,
         isForeground: @escaping @MainActor () -> Bool = { NSApp.isActive }) {
        self.client = client; self.defaults = defaults; self.isForeground = isForeground
    }
    var canCompose: Bool { identity != nil && !busy && recovery == nil && draft == nil }
    func refreshIdentity() {
        concealed = false
        guard !busy else { return }
        matches = []; content = nil
        let id = UUID(); generation = id; busy = true
        active = client.account.status { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil; self.busy = false
            guard case .signedIn(let account) = result, account.membershipID?.isEmpty == false else {
                self.reset(); self.status = "Sign in from Account to save and find context."
                self.onChange?(); return
            }
            if self.identity != account {
                self.reset(); self.identity = account
                self.recovery = UploadRecovery.load(for: account, defaults: self.defaults)
                self.status = self.recovery == nil ? "" : "Check the previous save before starting another."
            }
            self.onChange?()
        }
        onChange?()
    }
    func submit(title: String, text: String, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) {
        guard canCompose, let identity else { return }
        do { draft = try UploadDraft(title: title, bytes: Data(text.utf8), visibility: visibility, audienceProjectID: audienceProjectID, projectID: projectID) }
        catch { status = "Use a title up to 200 UTF-8 bytes and nonempty text up to 8 KiB."; onChange?(); return }
        guard let draft, let recovery = UploadRecovery(identity: identity, requestID: draft.requestID, visibility: visibility, audienceProjectID: audienceProjectID, projectID: projectID) else { return }
        self.recovery = recovery; recovery.save(for: identity, defaults: defaults)
        status = "Saving your original text…"; run(.submit(draft))
    }
    // Losing project authorization clears the draft bytes, never its receipt
    // locator or immutable audience/association coordinates.
    func projectAccessChanged() {
        matches = []; content = nil
        if draft?.projectID != nil || draft?.audience.kind == .project { draft = nil }
        if activeContentRead { active?.cancel(); active = nil; generation = UUID(); busy = false; activeContentRead = false }
        onChange?()
    }
    func retry() {
        guard !busy, receipt == nil, let draft else { return }
        status = "Retrying the same save…"; run(.submit(draft))
    }
    func checkStatus() {
        guard !busy, let recovery else { return }
        status = "Checking the saved context…"; run(.status(recovery))
    }
    // Caller explicitly confirms abandoning an uncertain receipt. This does not
    // delete a saved upload, withdraw its audience, or generate a fresh retry.
    func startAnother() {
        guard !busy, let identity else { return }
        UploadRecovery.clear(for: identity, defaults: defaults)
        draft = nil; receipt = nil; recovery = nil; status = ""; onChange?()
    }
    func search(_ source: String) {
        guard !busy, identity != nil else { return }
        guard let query = uploadQuery(source) else {
            status = "Search with up to 240 characters and 32 distinct words."; onChange?(); return
        }
        matches = []; content = nil; status = "Searching saved context…"; run(.search(query))
    }
    func read(_ id: String) {
        guard !busy, identity != nil else { return }
        content = nil; status = "Loading original text…"; run(.read(id))
    }
    func conceal() {
        concealed = true; matches = []; content = nil
        if !hasOutstandingMutation { active?.cancel(); active = nil; generation = UUID(); busy = false }
        onChange?()
    }
    func accountWillChange() {
        if !hasOutstandingMutation { active?.cancel(); active = nil; generation = UUID(); busy = false }
        reset(); onChange?()
    }
    func shutdown() { active?.cancel(); generation = UUID(); draft = nil }
    private func reset() {
        identity = nil; matches = []; content = nil; receipt = nil; recovery = nil; draft = nil; status = ""
    }
    private func run(_ command: UploadCommand) {
        guard !busy, let identity else { return }
        let id = UUID(); generation = id; busy = true; hasOutstandingMutation = command.mutates
        switch command { case .read, .search: activeContentRead = true; default: activeContentRead = false }
        active = client.perform(command, identity: identity) { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil; self.busy = false; self.hasOutstandingMutation = false; self.activeContentRead = false
            guard self.identity == identity else {
                self.reset(); self.status = command.mutates
                    ? "The save may have completed. Check its status from the original account."
                    : "Your account changed. Reopen ECHO after signing in."
                self.onChange?(); return
            }
            switch result {
            case .saved(let receipt):
                self.receipt = receipt; self.draft = nil; self.status = receipt.message
            case .matches(let matches):
                if !self.concealed && self.isForeground() { self.matches = matches }
                self.status = matches.isEmpty ? "No matching context you can read." : "Select a result to read the original."
            case .content(let content):
                if !self.concealed && self.isForeground() { self.content = content }
                self.status = ""
            case .unconfirmed:
                self.matches = []; self.content = nil
                self.status = "The save may have completed. Check its status before retrying."
            case .unconfirmedAccount:
                self.reset(); self.status = "The save may have completed. Check its status from the original account."
            case .unavailable:
                self.reset(); self.status = "Sign in from Account to continue."
            case .rejected(let failure):
                self.matches = []; self.content = nil
                if failure.losesAccess { self.draft = nil; self.onProjectAccessChanged?() }
                self.status = self.recovery == nil ? failure.message : "The current attempt was rejected. An earlier save may exist; keep checking its original status."
            case .failed:
                self.matches = []; self.content = nil
                self.status = "Could not confirm the result. Check your connection and sign-in, then try again."
            }
            self.onChange?()
        }
        onChange?()
    }
}
