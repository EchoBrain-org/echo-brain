import AppKit
import CryptoKit
import Darwin
import Foundation

enum UploadVisibility: String, Codable {
    case onlyMe = "only_me", team
    var label: String { self == .onlyMe ? "Only me" : "Team" }
    var argument: String { self == .onlyMe ? "only-me" : "team" }
}

private func uploadText(_ value: String, maximum: Int, multiline: Bool = false) -> Bool {
    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= maximum &&
    value.unicodeScalars.allSatisfy {
        let n = $0.value
        return !(n < 32 || (127...159).contains(n)) || (multiline && [9, 10, 13].contains(n))
    }
}

private func uploadID(_ value: String) -> Bool {
    value.range(of: "^ctx_[0-9a-f]{64}$", options: .regularExpression) != nil
}

private func uploadDate(_ value: String) -> Date? {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: value)
}

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
    let visibility: UploadVisibility
    let state: String?
    let status: String?
    let metadata: String?

    var valid: Bool {
        schema_version == 1 && uploadID(context_id) && uploadDate(received_at) != nil &&
        request_id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    var message: String {
        let enrichment: String
        switch metadata {
        case "ready": enrichment = "Search metadata is ready."
        case "unavailable": enrichment = "Extra search metadata is unavailable; your original is still searchable."
        default: enrichment = "Extra search metadata is being prepared."
        }
        return "Saved · \(visibility.label). Available in search now. \(enrichment)"
    }
}

struct UploadMatch: Decodable {
    let context_id: String
    let received_at: String
    let visibility: UploadVisibility
    let title: String
    let excerpt: String
    var valid: Bool {
        uploadID(context_id) && uploadDate(received_at) != nil && uploadText(title, maximum: 200) &&
        excerpt.unicodeScalars.count <= 300 && uploadText(excerpt, maximum: 1200, multiline: true)
    }
}

struct UploadContent: Decodable {
    let schema_version: Int
    let kind: String
    let context_id: String
    let received_at: String
    let visibility: UploadVisibility
    let title: String
    let text: String
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
    let visibility: UploadVisibility

    init?(identity: AccountIdentity, requestID: String, visibility: UploadVisibility) {
        guard let member = identity.membershipID, !member.isEmpty else { return nil }
        authority = identity.authority; membershipID = member
        self.requestID = requestID; self.visibility = visibility
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
              let result = try? JSONDecoder().decode(Self.self, from: data), result.belongs(to: identity),
              result.requestID.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
        else { return nil }
        return result
    }
}

final class UploadDraft {
    let requestID: String
    let title: String
    let visibility: UploadVisibility
    let file: URL
    private let directory: URL

    init(title: String, bytes: Data, visibility: UploadVisibility) throws {
        guard uploadText(title, maximum: 200), bytes.count <= 8192,
              let text = String(data: bytes, encoding: .utf8), uploadText(text, maximum: 8192, multiline: true)
        else { throw CocoaError(.fileReadCorruptFile) }
        self.title = title; self.visibility = visibility; requestID = UUID().uuidString.lowercased()
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
        case .status(let receipt): return base + ["status", "--request-id", receipt.requestID]
        case .search(let query): return base + ["search", "--query", query, "--limit", "10"]
        case .read(let context): return base + ["read", "--context-id", context]
        }
    }
    var mutates: Bool { if case .submit = self { return true }; return false }
}

enum UploadResult {
    case saved(UploadReceipt), matches([UploadMatch]), content(UploadContent)
    case unavailable, failed, unconfirmed, unconfirmedAccount
}

final class UploadClient: @unchecked Sendable {
    let account: AccountClient
    init(account: AccountClient = AccountClient()) { self.account = account }

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
        guard identity.membershipID?.isEmpty == false,
              case .signedIn(let before) = account.readStatus(running), before == identity else { return .unavailable }
        let bytes = account.runCaptured(command.arguments, timeout: 45, running: running)
        // Never display a previous membership's private text after account change.
        guard case .signedIn(let after) = account.readStatus(running), after == identity else {
            return command.mutates ? .unconfirmedAccount : .unavailable
        }
        guard let bytes else { return command.mutates ? .unconfirmed : .failed }
        let result = Self.parse(bytes, command: command)
        if command.mutates, case .failed = result { return .unconfirmed }
        return result
    }

    static func parse(_ bytes: Data, command: UploadCommand) -> UploadResult {
        let decoder = JSONDecoder()
        guard let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return .failed }
        func keys(_ expected: [String]) -> Bool { Set(object.keys) == Set(expected) }
        switch command {
        case .submit(let draft):
            guard keys(["schema_version", "kind", "request_id", "context_id", "received_at", "visibility", "state"]),
                  let r = try? decoder.decode(UploadReceipt.self, from: bytes), r.valid,
                  r.kind == "echo-person-update-receipt-v1", r.state == "received",
                  r.request_id == draft.requestID, r.visibility == draft.visibility else { return .failed }
            return .saved(r)
        case .status(let expected):
            guard keys(["schema_version", "kind", "request_id", "context_id", "received_at", "visibility", "status", "metadata"]),
                  let r = try? decoder.decode(UploadReceipt.self, from: bytes), r.valid,
                  r.kind == "echo-person-update-status-v1", r.status == "stored",
                  ["pending", "processing", "ready", "unavailable"].contains(r.metadata ?? ""),
                  r.request_id == expected.requestID, r.visibility == expected.visibility else { return .failed }
            return .saved(r)
        case .search:
            guard keys(["schema_version", "kind", "results"]),
                  let r = try? decoder.decode(UploadSearchResponse.self, from: bytes), r.schema_version == 1,
                  r.kind == "echo-person-upload-search-v1", r.results.count <= 10,
                  r.results.allSatisfy({ $0.valid }), Set(r.results.map(\.context_id)).count == r.results.count,
                  let entries = object["results"] as? [[String: Any]],
                  entries.allSatisfy({ Set($0.keys) == Set(["context_id", "received_at", "visibility", "title", "excerpt"]) }) else { return .failed }
            return .matches(r.results)
        case .read(let id):
            guard keys(["schema_version", "kind", "context_id", "received_at", "visibility", "title", "text"]),
                  let r = try? decoder.decode(UploadContent.self, from: bytes), r.schema_version == 1,
                  r.kind == "echo-person-upload-content-v1", uploadID(r.context_id), r.context_id == id,
                  uploadDate(r.received_at) != nil, uploadText(r.title, maximum: 200),
                  uploadText(r.text, maximum: 8192, multiline: true) else { return .failed }
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
    func submit(title: String, text: String, visibility: UploadVisibility) {
        guard canCompose, let identity else { return }
        do { draft = try UploadDraft(title: title, bytes: Data(text.utf8), visibility: visibility) }
        catch { status = "Use a title up to 200 UTF-8 bytes and nonempty text up to 8 KiB."; onChange?(); return }
        guard let draft, let recovery = UploadRecovery(identity: identity, requestID: draft.requestID, visibility: visibility) else { return }
        self.recovery = recovery; recovery.save(for: identity, defaults: defaults)
        status = "Saving your original text…"; run(.submit(draft))
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
        active = client.perform(command, identity: identity) { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil; self.busy = false; self.hasOutstandingMutation = false
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
            case .failed:
                self.matches = []; self.content = nil
                self.status = "Could not confirm the result. Check your connection and sign-in, then try again."
            }
            self.onChange?()
        }
        onChange?()
    }
}
