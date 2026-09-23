import AppKit
import CryptoKit
import Darwin
import Foundation
import UniformTypeIdentifiers

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
    var document: DocumentMetadata? = nil
    var visibility: UploadVisibility { audience.kind }
    var valid: Bool {
        schema_version == 2 && uploadID(context_id) && ProjectWire.date(received_at) && audience.valid &&
        (project_id == nil || ProjectWire.id(project_id!, prefix: "prj_")) && ProjectWire.id(request_id, prefix: "")
    }
    var message: String {
        if let document { return document.stateMessage }
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
    var carrier: String? = nil
    var documentFilename: String? = nil
    var documentSize: Int? = nil
    var documentSha256: String? = nil
    var documentTitle: String? = nil
    var visibility: UploadVisibility { audience.kind }

    init?(identity: AccountIdentity, requestID: String, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) {
        let audience = UploadAudience(visibility, projectID: audienceProjectID)
        guard audience.valid, projectID == nil || ProjectWire.id(projectID!, prefix: "prj_") else { return nil }
        guard let member = identity.membershipID, !member.isEmpty else { return nil }
        authority = identity.authority; membershipID = member
        self.requestID = requestID; self.audience = audience; self.projectID = projectID
    }
    var validCarrier: Bool {
        if carrier == nil { return documentFilename == nil && documentSize == nil && documentSha256 == nil && documentTitle == nil }
        return carrier == "document-v1" && documentFilename.map { ProjectWire.text($0, max: 255) } == true
            && documentSize.map { (1...DocumentSnapshot.maximumBytes).contains($0) } == true
            && documentSha256.map(DocumentMetadata.hash) == true && documentTitle.map { ProjectWire.text($0, max: 200) } == true
    }
    func matches(_ metadata: DocumentMetadata) -> Bool {
        validCarrier && metadata.request_id == requestID && metadata.audience == audience && metadata.project_id == projectID
            && metadata.filename == documentFilename && metadata.content_length == documentSize
            && metadata.sha256 == documentSha256 && metadata.title == documentTitle
    }
    func belongs(to identity: AccountIdentity) -> Bool {
        authority == identity.authority && membershipID == identity.membershipID
    }
    private static func key(_ identity: AccountIdentity) -> String {
        let bytes = Data("\(identity.authority)\n\(identity.membershipID ?? "")".utf8)
        return "org.echobrain.echo.upload-receipt." + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    @discardableResult func save(for identity: AccountIdentity, defaults: UserDefaults = .standard) -> Bool {
        guard belongs(to: identity), validCarrier, let data = try? JSONEncoder().encode(self) else { return false }
        defaults.set(data, forKey: Self.key(identity))
        return defaults.synchronize() && defaults.data(forKey: Self.key(identity)) == data
    }
    static func clear(for identity: AccountIdentity, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key(identity))
    }
    static func load(for identity: AccountIdentity, defaults: UserDefaults = .standard) -> UploadRecovery? {
        guard let data = defaults.data(forKey: key(identity)), data.count <= 4096,
              let result = try? JSONDecoder().decode(Self.self, from: data), result.belongs(to: identity), result.audience.valid, result.validCarrier,
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
    private let directory: URL?
    let document: DocumentSnapshot?

    init(title: String, bytes: Data, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) throws {
        let audience = UploadAudience(visibility, projectID: audienceProjectID)
        guard audience.valid, projectID == nil || ProjectWire.id(projectID!, prefix: "prj_") else { throw CocoaError(.validationMissingMandatoryProperty) }
        guard uploadText(title, maximum: 200), bytes.count <= 8192,
              let text = String(data: bytes, encoding: .utf8), uploadText(text, maximum: 8192, multiline: true)
        else { throw CocoaError(.fileReadCorruptFile) }
        document = nil
        self.title = title; self.audience = audience; self.projectID = projectID; requestID = UUID().uuidString.lowercased()
        var template = Array(FileManager.default.temporaryDirectory.appendingPathComponent("echo-upload-XXXXXXXX").path.utf8CString)
        guard let path = mkdtemp(&template) else { throw CocoaError(.fileWriteUnknown) }
        directory = URL(fileURLWithPath: String(cString: path), isDirectory: true)
        file = directory!.appendingPathComponent("original.txt")
        do {
            try bytes.write(to: file, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { try? FileManager.default.removeItem(at: directory!); throw error }
    }
    init(title: String, document: DocumentSnapshot, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) throws {
        let audience = UploadAudience(visibility, projectID: audienceProjectID)
        guard uploadText(title, maximum: 200), audience.valid, projectID == nil || ProjectWire.id(projectID!, prefix: "prj_") else { throw CocoaError(.validationMissingMandatoryProperty) }
        self.title = title; self.document = document; self.audience = audience; self.projectID = projectID
        requestID = UUID().uuidString.lowercased(); file = document.file; directory = nil
    }
    deinit { if let directory { try? FileManager.default.removeItem(at: directory) } }

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
        case .submit(let draft):
            if draft.document != nil { return ["person", "documents", "upload", "--request-id", draft.requestID, "--title", draft.title,
                "--file", draft.file.path, "--audience", draft.visibility.argument]
                + (draft.audience.project_id.map { ["--audience-project-id", $0] } ?? [])
                + (draft.projectID.map { ["--project-id", $0] } ?? []) }
            return base + ["submit", "--request-id", draft.requestID, "--title", draft.title,
                                              "--file", draft.file.path, "--visibility", draft.visibility.argument]
                + (draft.audience.project_id.map { ["--audience-project-id", $0] } ?? [])
                + (draft.projectID.map { ["--project-id", $0] } ?? [])
        case .status(let receipt): return (receipt.carrier == "document-v1" ? ["person", "documents"] : base) + ["status", "--request-id", receipt.requestID]
        case .search(let query): return base + ["search", "--query", query, "--limit", "10"]
        case .read(let context): return base + ["read", "--context-id", context]
        }
    }
    var action: String {
        switch self { case .submit(let draft): return draft.document == nil ? "updates-submit" : "documents-upload"; case .status(let recovery): return recovery.carrier == nil ? "updates-status" : "documents-status"; case .search: return "updates-search"; case .read: return "updates-read" }
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
        var arguments = command.arguments
        if case .submit(let draft) = command, draft.document != nil, let membership = identity.membershipID {
            arguments += ["--expected-membership-id", membership, "--expected-authority", identity.authority]
        }
        switch cli.execute(arguments, identity: identity, running: running) {
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
        if case .submit(let draft) = command, let snapshot = draft.document {
            guard let metadata = DocumentMetadata.parseEnvelope(bytes, receipt: true), metadata.request_id == draft.requestID,
                  metadata.audience == draft.audience, metadata.project_id == draft.projectID,
                  metadata.filename == snapshot.filename, metadata.title == draft.title, metadata.content_length == snapshot.size, metadata.sha256 == snapshot.sha256 else { return .failed }
            return .saved(metadata.uploadReceipt)
        }
        if case .status(let recovery) = command, recovery.carrier == "document-v1" {
            guard let metadata = DocumentMetadata.parseEnvelope(bytes), recovery.matches(metadata) else { return .failed }
            return .saved(metadata.uploadReceipt)
        }
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
    func submitDocument(title: String, snapshot: DocumentSnapshot, visibility: UploadVisibility, audienceProjectID: String? = nil, projectID: String? = nil) {
        guard canCompose, let identity else { return }
        do { draft = try UploadDraft(title: title, document: snapshot, visibility: visibility, audienceProjectID: audienceProjectID, projectID: projectID) }
        catch { status = "Choose a supported document up to 25 MiB and a title up to 200 UTF-8 bytes."; onChange?(); return }
        guard let draft, var recovery = UploadRecovery(identity: identity, requestID: draft.requestID, visibility: visibility, audienceProjectID: audienceProjectID, projectID: projectID) else { return }
        recovery.carrier = "document-v1"; recovery.documentFilename = snapshot.filename; recovery.documentSize = snapshot.size
        recovery.documentSha256 = snapshot.sha256; recovery.documentTitle = title
        guard recovery.save(for: identity, defaults: defaults) else { self.draft = nil; status = "Could not record this save safely. Try again."; onChange?(); return }
        self.recovery = recovery
        status = "Saving your original document…"; run(.submit(draft))
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

// Documents keep their original bytes out of the note editor and off the heap.
// A private disk snapshot owns a single bounded copy through an uncertain retry.
final class DocumentSnapshot {
    static let maximumBytes = 25 * 1024 * 1024
    static let extensions = ["txt", "md", "pdf", "docx"]
    static var contentTypes: [UTType] { extensions.compactMap { UTType(filenameExtension: $0) } }
    let filename: String
    let size: Int
    let sha256: String
    let file: URL
    private let directory: URL
    var display: String { filename + " · " + ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file) }
    static func supports(_ url: URL) -> Bool { url.isFileURL && extensions.contains(url.pathExtension.lowercased()) }
    init(_ source: URL) throws {
        guard Self.supports(source), !source.lastPathComponent.contains("\\"), ProjectWire.text(source.lastPathComponent, max: 255) else { throw CocoaError(.fileReadUnsupportedScheme) }
        let fd = open(source.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        guard fd >= 0 else { throw CocoaError(.fileReadNoPermission) }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= Self.maximumBytes else { throw CocoaError(.fileReadTooLarge) }
        var template = Array(FileManager.default.temporaryDirectory.appendingPathComponent("echo-document-XXXXXXXX").path.utf8CString)
        guard let path = mkdtemp(&template) else { throw CocoaError(.fileWriteUnknown) }
        directory = URL(fileURLWithPath: String(cString: path), isDirectory: true)
        filename = source.lastPathComponent.precomposedStringWithCanonicalMapping; file = directory.appendingPathComponent(filename)
        let output = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard output >= 0 else { try? FileManager.default.removeItem(at: directory); throw CocoaError(.fileWriteUnknown) }
        defer { close(output) }
        do {
            var buffer = [UInt8](repeating: 0, count: 64 * 1024), total = 0, hash = SHA256()
            while true {
                let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
                guard count >= 0 else { throw CocoaError(.fileReadUnknown) }
                if count == 0 { break }
                total += count
                guard total <= Self.maximumBytes else { throw CocoaError(.fileReadTooLarge) }
                let bytes = Data(buffer.prefix(count)); hash.update(data: bytes)
                try bytes.withUnsafeBytes { raw in
                    var written = 0
                    while written < count {
                        let n = write(output, raw.baseAddress!.advanced(by: written), count - written)
                        guard n > 0 else { throw CocoaError(.fileWriteUnknown) }; written += n
                    }
                }
            }
            guard total > 0, fsync(output) == 0 else { throw CocoaError(.fileWriteUnknown) }
            size = total; sha256 = "sha256:" + hash.finalize().map { String(format: "%02x", $0) }.joined()
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    deinit { try? FileManager.default.removeItem(at: directory) }
}

struct DocumentMetadata: Decodable {
    let schema_version: Int
    let kind: String
    let request_id: String
    let document_id: String
    let filename: String
    let title: String
    let content_length: Int
    let sha256: String
    let audience: UploadAudience
    let project_id: String?
    let detected_media_type: String
    let received_at: String
    let state: String
    let extraction_state: String
    let extraction_detail: String?
    let extractor: String?
    let extracted_text_bytes: Int?
    let excerpt: String?
    static let states = ["extracting", "ready", "partial", "no_text", "encrypted", "malformed", "limit_exceeded", "timed_out", "unsupported", "unavailable"]
    static func id(_ value: String) -> Bool { value.range(of: "^doc_[0-9a-f]{64}$", options: .regularExpression) != nil }
    static func hash(_ value: String) -> Bool { value.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil }
    static func envelope(_ bytes: Data) -> [String: Any]? {
        guard let root = ProjectWire.object(bytes), ProjectWire.keys(root, ["ok", "result"]),
              let ok = root["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
              let result = root["result"] as? [String: Any] else { return nil }
        return result
    }
    static func parseEnvelope(_ bytes: Data, receipt: Bool = false) -> DocumentMetadata? {
        guard let object = envelope(bytes) else { return nil }; return parse(object, receipt: receipt)
    }
    static func parse(_ object: [String: Any], receipt: Bool = false, match: Bool = false) -> DocumentMetadata? {
        let fields = ["schema_version", "kind", "request_id", "document_id", "filename", "title", "content_length", "sha256", "audience", "project_id", "detected_media_type", "received_at", "state", "extraction_state"]
            + (receipt ? [] : ["extraction_detail", "extractor", "extracted_text_bytes"]) + (match ? ["excerpt", "anchor"] : [])
        guard ProjectWire.keys(object, fields), ProjectWire.header(object, version: 1, kind: receipt ? "echo-person-document-receipt-v1" : "echo-person-document-metadata-v1"),
              UploadAudience.validObject(object["audience"]), object["project_id"] is NSNull || object["project_id"] is String,
              let bytes = try? JSONSerialization.data(withJSONObject: object), let value = try? JSONDecoder().decode(Self.self, from: bytes),
              id(value.document_id), ProjectWire.id(value.request_id, prefix: ""), hash(value.sha256),
              ProjectWire.text(value.filename, max: 255), !value.filename.contains("/"), !value.filename.contains("\\"), ProjectWire.text(value.title, max: 200),
              (1...DocumentSnapshot.maximumBytes).contains(value.content_length), value.audience.valid,
              value.project_id == nil || ProjectWire.id(value.project_id!, prefix: "prj_"),
              ["text/plain", "text/markdown", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].contains(value.detected_media_type),
              ProjectWire.date(value.received_at), value.state == "saved", states.contains(value.extraction_state),
              value.extracted_text_bytes == nil || (0...2 * 1024 * 1024).contains(value.extracted_text_bytes!),
              (value.excerpt?.utf8.count ?? 0) <= 1200, (value.extraction_detail?.utf8.count ?? 0) <= 4096,
              (value.extractor?.utf8.count ?? 0) <= 512 else { return nil }
        if match, !(object["anchor"] is NSNull) {
            guard let anchor = object["anchor"] as? [String: Any], ProjectWire.keys(anchor, ["kind", "start"]),
                  ["page", "paragraph"].contains(anchor["kind"] as? String ?? ""),
                  let start = anchor["start"] as? NSNumber, CFGetTypeID(start) != CFBooleanGetTypeID(),
                  start.doubleValue == Double(start.intValue), start.intValue >= 1 else { return nil }
        }
        return value
    }
    var stateLabel: String {
        switch extraction_state {
        case "extracting": return "Extracting text"
        case "ready": return "Text ready"
        case "partial": return "Partial text"
        case "no_text": return "No searchable text"
        case "encrypted": return "Encrypted · text unavailable"
        case "malformed": return "Unreadable document · text unavailable"
        case "limit_exceeded": return "Extraction limit reached"
        case "timed_out": return "Text extraction timed out"
        default: return "Text unavailable"
        }
    }
    var stateMessage: String { "Original saved · " + stateLabel + "." }
    var display: String { filename + " · " + ByteCountFormatter.string(fromByteCount: Int64(content_length), countStyle: .file) + " · " + stateLabel }
    var renderKey: String { document_id + "|" + extraction_state + "|" + String(extracted_text_bytes ?? 0) }
    var uploadReceipt: UploadReceipt {
        UploadReceipt(schema_version: 1, kind: kind, request_id: request_id, context_id: document_id, received_at: received_at,
                      audience: audience, project_id: project_id, state: state, status: nil, metadata: nil, document: self)
    }
}
struct DocumentTextPage: Decodable {
    struct Chunk: Decodable { let ordinal: Int; let anchor_kind: String; let anchor_start: Int; let text: String }
    let schema_version: Int
    let kind: String
    let document_id: String
    let original_sha256: String
    let extractor: String?
    let extraction_state: String
    let chunks: [Chunk]
    let next_cursor: String?
    var display: String { chunks.map { "\($0.anchor_kind == "page" ? "Page" : "Paragraph") \($0.anchor_start)\n\($0.text)" }.joined(separator: "\n\n") }
    static func parse(_ object: [String: Any], metadata: DocumentMetadata) -> DocumentTextPage? {
        guard ProjectWire.keys(object, ["schema_version", "kind", "document_id", "original_sha256", "extractor", "extraction_state", "chunks", "next_cursor"]),
              ProjectWire.header(object, version: 1, kind: "echo-person-document-text-v1"), ProjectWire.cursor(object["next_cursor"]),
              let raw = object["chunks"] as? [[String: Any]], raw.count <= 8,
              raw.allSatisfy({ ProjectWire.keys($0, ["ordinal", "anchor_kind", "anchor_start", "text"]) }),
              let data = try? JSONSerialization.data(withJSONObject: object), let page = try? JSONDecoder().decode(Self.self, from: data),
              page.document_id == metadata.document_id, page.original_sha256 == metadata.sha256,
              page.extractor == metadata.extractor, page.extraction_state == metadata.extraction_state,
              page.chunks.allSatisfy({ $0.ordinal >= 0 && ["page", "paragraph"].contains($0.anchor_kind) && $0.anchor_start >= 1 && (1...8192).contains($0.text.utf8.count) }),
              zip(page.chunks, page.chunks.dropFirst()).allSatisfy({ $0.ordinal < $1.ordinal }),
              page.chunks.reduce(0, { $0 + $1.text.utf8.count }) <= 24 * 1024 else { return nil }
        return page
    }
}

@MainActor
final class DocumentSession {
    let cli: ProjectCLI
    var onChange: (() -> Void)?
    private(set) var identity: AccountIdentity?
    private(set) var matches: [DocumentMetadata] = []
    private(set) var metadata: DocumentMetadata?
    private(set) var page: DocumentTextPage?
    private(set) var nextCursor: String?
    private(set) var busy = false
    private(set) var status = ""
    private var active: AccountRunning?
    private var generation = UUID()
    private var query = ""
    private var projectID: String?
    private let foreground: @MainActor () -> Bool
    init(cli: ProjectCLI = ProjectCLI(), foreground: @escaping @MainActor () -> Bool = { NSApp.isActive }) { self.cli = cli; self.foreground = foreground }
    func bind(_ identity: AccountIdentity?) { if self.identity != identity { clear(); self.identity = identity } }
    func clear() { active?.cancel(); active = nil; generation = UUID(); busy = false; matches = []; metadata = nil; page = nil; nextCursor = nil; status = ""; query = ""; projectID = nil }
    func closeReader() { active?.cancel(); active = nil; generation = UUID(); busy = false; metadata = nil; page = nil }
    func search(_ query: String = "", projectID: String? = nil, cursor: String? = nil) {
        guard identity != nil else { return }
        guard query.utf8.count <= 200 else { clear(); status = "Search documents with up to 200 UTF-8 bytes."; onChange?(); return }
        if cursor == nil { clear(); self.query = query; self.projectID = projectID }
        guard !busy else { return }
        var args = ["person", "documents", "search", "--query", query, "--limit", "10"]
        if let projectID { args += ["--project-id", projectID] }; if let cursor { args += ["--cursor", cursor] }
        run(args) { [weak self] result in
            guard let self, ProjectWire.header(result, version: 1, kind: "echo-person-document-search-result-v1"),
                  ProjectWire.keys(result, ["schema_version", "kind", "documents", "next_cursor"]),
                  ProjectWire.cursor(result["next_cursor"]), let raw = result["documents"] as? [[String: Any]], raw.count <= 10 else { return false }
            let matches = raw.compactMap { DocumentMetadata.parse($0, match: true) }
            guard matches.count == raw.count, Set(matches.map(\.document_id)).count == matches.count else { return false }
            self.matches = matches; self.nextCursor = result["next_cursor"] as? String; return true
        }
    }
    func more() { if let nextCursor { search(query, projectID: projectID, cursor: nextCursor) } }
    func read(_ id: String, cursor: String? = nil) {
        guard !busy, DocumentMetadata.id(id) else { return }
        metadata = nil; page = nil
        var args = ["person", "documents", "read", "--document-id", id]
        if let projectID { args += ["--project-id", projectID] }
        if let cursor { args += ["--cursor", cursor] }
        run(args) { [weak self] result in
            guard let self, ProjectWire.keys(result, ["metadata", "text"]), let raw = result["metadata"] as? [String: Any],
                  let metadata = DocumentMetadata.parse(raw), metadata.document_id == id,
                  let rawText = result["text"] as? [String: Any], let page = DocumentTextPage.parse(rawText, metadata: metadata) else { return false }
            self.metadata = metadata; self.page = page; return true
        }
    }
    func nextTextPage() { if let metadata, let cursor = page?.next_cursor { read(metadata.document_id, cursor: cursor) } }
    func download(_ metadata: DocumentMetadata, to file: URL) {
        guard !busy else { return }
        run(["person", "documents", "download", "--document-id", metadata.document_id, "--out", file.path]
            + (projectID.map { ["--project-id", $0] } ?? [])) { [weak self] result in
            // CLI atomically writes only after checking the original size/hash.
            guard result["document_id"] as? String == metadata.document_id,
                  result["sha256"] as? String == metadata.sha256,
                  result["content_length"] as? Int == metadata.content_length,
                  result["output_path"] as? String == file.path,
                  ProjectWire.keys(result, ["document_id", "output_path", "content_length", "sha256"]) else { return false }
            self?.status = "Original saved to your selected file."; return true
        }
    }
    private func run(_ arguments: [String], accept: @escaping @MainActor ([String: Any]) -> Bool) {
        guard !busy, let identity else { return }
        let token = UUID(); generation = token; let running = AccountRunning(); active = running; busy = true; status = ""
        let cli = self.cli
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let output = cli.execute(arguments, identity: identity, running: running)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == token, self.identity == identity else { return }
                self.active = nil; self.busy = false
                guard self.foreground() else { self.clear(); self.onChange?(); return }
                if case .output(let bytes, true) = output, let object = DocumentMetadata.envelope(bytes), accept(object) { self.onChange?(); return }
                self.metadata = nil; self.page = nil; self.matches = []; self.nextCursor = nil
                self.status = arguments.dropFirst(2).first == "download"
                    ? "Could not confirm the download. Check the selected file before trying again."
                    : "Could not load the document. Refresh to check your connection and access."
                self.onChange?()
            }
        }
        onChange?()
    }
}
