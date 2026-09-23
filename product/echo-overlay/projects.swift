import AppKit
import CryptoKit
import Foundation

/// The authority is the sole source of what a person may retrieve. The UI can
/// optionally narrow an Ask to one project, but it never builds a client-side
/// collection of records to search.
enum AskScope: Equatable, Sendable {
    case global
    case project(id: String, name: String)

    var projectID: String? {
        if case .project(let id, _) = self { return id }
        return nil
    }

    var displayName: String {
        switch self {
        case .global: return "All accessible context"
        case .project(_, let name): return name
        }
    }
}

enum AskSubmission: Equatable {
    case accepted
    case rejected(String)
}

// Closed, bounded CLI replies. Authority remains responsible for permission;
// a local project selection is never a read grant.
enum ProjectWire {
    // JSONSerialization accepts duplicate object members and retains only one
    // value. Scan the bounded bytes first so closed reply validation sees no
    // ambiguous root or nested fields, including escaped-equivalent names.
    private static func hasUniqueObjectMembers(_ payload: Data) -> Bool {
        guard let text = String(data: payload, encoding: .utf8) else { return false }
        let scalars = Array(text.unicodeScalars)
        var containers: [Set<String>?] = []
        var index = 0
        while index < scalars.count {
            switch scalars[index].value {
            case 34: // `"`
                let start = index
                index += 1
                while index < scalars.count {
                    let scalar = scalars[index].value
                    if scalar < 32 { return false }
                    if scalar == 92 { // `\\`
                        index += 1
                        guard index < scalars.count else { return false }
                    } else if scalar == 34 {
                        break
                    }
                    index += 1
                }
                guard index < scalars.count else { return false }
                let end = index
                var after = end + 1
                while after < scalars.count, [9, 10, 13, 32].contains(scalars[after].value) {
                    after += 1
                }
                if after < scalars.count, scalars[after].value == 58 { // `:`
                    let literal = String(String.UnicodeScalarView(scalars[start...end]))
                    guard let key = try? JSONDecoder().decode(String.self, from: Data(literal.utf8)),
                          !containers.isEmpty,
                          var keys = containers[containers.count - 1],
                          keys.insert(key).inserted else { return false }
                    containers[containers.count - 1] = keys
                }
            case 123: // `{`
                containers.append(Set<String>())
            case 91: // `[`
                containers.append(nil)
            case 125, 93: // `}`, `]`
                guard !containers.isEmpty else { return false }
                containers.removeLast()
            default:
                break
            }
            index += 1
        }
        return containers.isEmpty
    }

    static func object(_ bytes: Data) -> [String: Any]? {
        let payload = bytes.last == 10 ? bytes.dropLast() : bytes[...]
        guard payload.count <= 32 * 1024 else { return nil }
        let data = Data(payload)
        guard hasUniqueObjectMembers(data) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    static func keys(_ value: [String: Any], _ names: [String]) -> Bool { Set(value.keys) == Set(names) }
    static func id(_ value: String, prefix: String) -> Bool {
        value.range(of: "^" + prefix + "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    static func text(_ value: String, max: Int, multiline: Bool = false) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= max &&
        value.unicodeScalars.allSatisfy { scalar in
            let n = scalar.value
            return (!(n < 32 || (127...159).contains(n) )) ||
                (multiline && [9, 10, 13].contains(n))
        }
    }
    static func name(_ value: String) -> Bool {
        text(value, max: 200) && value == value.trimmingCharacters(in: .whitespacesAndNewlines) &&
            Data(value.utf8) == Data(value.precomposedStringWithCanonicalMapping.utf8)
    }
    static func date(_ value: String) -> Bool {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date) == value
    }
    static func cursor(_ value: Any?) -> Bool {
        if value is NSNull { return true }
        guard let value = value as? String, !value.isEmpty, value.count <= 512,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return false }
        let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4)) else { return false }
        return data.base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_") == value
    }
    static func header(_ value: [String: Any], version: Int, kind: String) -> Bool {
        guard let n = value["schema_version"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
        return n.doubleValue == Double(version) && value["kind"] as? String == kind
    }
}

struct ProjectSummary: Decodable, Equatable {
    let schema_version: Int
    let kind: String
    let project_id: String
    let name: String
    let created_at: String
    let role: String
    static func valid(_ object: [String: Any]) -> Bool {
        ProjectWire.keys(object, ["schema_version", "kind", "project_id", "name", "created_at", "role"]) &&
        ProjectWire.header(object, version: 1, kind: "echo-project-summary-v1") &&
        ProjectWire.id(object["project_id"] as? String ?? "", prefix: "prj_") &&
        ProjectWire.name(object["name"] as? String ?? "") &&
        ProjectWire.date(object["created_at"] as? String ?? "") && ["lead", "member"].contains(object["role"] as? String ?? "")
    }
}
struct ProjectMember: Decodable {
    let membership_id: String
    let display_name: String
    let role: String?
}

struct ProjectFailure {
    let code: String
    let status: Int?
    let unknown: Bool
    static let invalid = ProjectFailure(code: "invalid_output", status: nil, unknown: false)
    static let uncertain = ProjectFailure(code: "outcome_unknown", status: nil, unknown: true)
    var losesAccess: Bool { ["not_found", "unauthorized", "stale_access_state", "sign_in_required"].contains(code) }
    var message: String {
        if unknown { return "The change may have completed. Retry the same change to reconcile it." }
        switch code {
        case "not_found": return "This project or original is no longer available to you."
        case "unauthorized", "stale_access_state", "sign_in_required": return "Your access changed. Refresh your account and projects."
        case "invalid_file": return "Choose a supported, readable document up to 25 MiB."
        case "snapshot_conflict": return "This request already has a different saved original. Retry its retained upload."
        case "snapshot_limit": return "Resolve or abandon a retained upload before starting another."
        case "snapshot_not_found": return "The local retry copy is unavailable. Check the saved upload status before starting another."
        case "quota_exceeded": return "Document storage is full. Contact your organization owner."
        case "conflict": return "The change conflicts with current state. A project must keep at least one lead. Refresh and review before another change."
        default: return "Could not confirm the result. Refresh and try again."
        }
    }
    static func parse(_ data: Data, action: String, requestID: String?) -> ProjectFailure? {
        guard let o = ProjectWire.object(data), let ok = o["ok"] as? NSNumber,
              CFGetTypeID(ok) == CFBooleanGetTypeID(), !ok.boolValue, o["action"] as? String == action,
              let error = o["error"] as? String, !error.isEmpty, error.utf8.count <= 2048,
              let code = o["code"] as? String else { return nil }
        var expected = ["ok", "action", "error", "code"]
        var status: Int?
        if let n = o["status"] as? NSNumber {
            guard CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.intValue), (400...599).contains(n.intValue) else { return nil }
            expected.append("status"); status = n.intValue
        }
        if o["status"] is NSNull { expected.append("status") }
        let documentCodes = action.hasPrefix("documents-") ? ["invalid_file", "snapshot_conflict", "snapshot_limit", "snapshot_not_found", "invalid_download", "quota_exceeded"] : []
        let localRejections = ["invalid_request", "sign_in_required", "stale_access_state"] + documentCodes.filter { $0 != "quota_exceeded" }
        if let requestID {
            expected += ["request_id", "mutation_outcome"]
            guard o["request_id"] as? String == requestID else { return nil }
            if code == "outcome_unknown" {
                guard o["mutation_outcome"] as? String == "unknown", ProjectWire.keys(o, expected) else { return nil }
                return ProjectFailure(code: code, status: status, unknown: true)
            }
            guard o["mutation_outcome"] as? String == "not_submitted",
                  status.map({ (400...499).contains($0) }) ?? localRejections.contains(code) else { return nil }
        }
        guard ProjectWire.keys(o, expected), (["invalid_request", "conflict", "invalid_output", "not_found", "stale_access_state", "unauthorized", "rate_limited", "unavailable", "sign_in_required"] + documentCodes).contains(code) else { return nil }
        return ProjectFailure(code: code, status: status, unknown: false)
    }
}

// Separate bounded stdout/stderr avoids interpreting a failed command as a
// successful result, and never presents raw diagnostic output to the person.
private final class ProjectOutput: @unchecked Sendable {
    private var bytes = Data()
    private(set) var overflow = false
    func read(_ handle: FileHandle, running: AccountRunning) {
        do {
            while let chunk = try handle.read(upToCount: 4096), !chunk.isEmpty {
                guard bytes.count + chunk.count <= 32 * 1024 + 1 else { overflow = true; running.cancel(); return }
                bytes.append(chunk)
            }
        } catch { overflow = true; running.cancel() }
    }
    var data: Data { bytes }
}
enum ProjectExchange { case output(Data, Bool), accountChanged, unavailable, failed }
final class ProjectCLI: @unchecked Sendable {
    static var installedExecutable: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ECHO/bin/echo-brain") }
    let account: AccountClient
    private let executable: URL
    init(executable: URL = ProjectCLI.installedExecutable) {
        self.executable = executable; account = AccountClient(executable: executable)
    }
    func execute(_ arguments: [String], identity: AccountIdentity, running: AccountRunning) -> ProjectExchange {
        guard identity.membershipID?.isEmpty == false,
              case .signedIn(let before) = account.readStatus(running), before == identity else { return .unavailable }
        let output = capture(arguments, running: running)
        let state = running.state()
        // A cancelled/overflowed/timed-out subprocess cannot perform a final
        // account probe. Treat its mutation as unknown, not an account switch.
        if state.cancelled || state.timedOut { return .failed }
        guard case .signedIn(let after) = account.readStatus(running), after == identity else { return .accountChanged }
        return output
    }
    private func capture(_ arguments: [String], running: AccountRunning) -> ProjectExchange {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else { return .failed }
        let process = Process(); let stdout = Pipe(); let stderr = Pipe()
        process.executableURL = executable; process.arguments = arguments
        process.environment = ["HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": NSTemporaryDirectory(), "LANG": "en_US.UTF-8"]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = stdout; process.standardError = stderr
        do { guard try running.launch(process) else { return .failed } } catch { return .failed }
        let out = ProjectOutput(); let err = ProjectOutput(); let readers = DispatchGroup()
        for (reader, pipe) in [(out, stdout), (err, stderr)] {
            readers.enter()
            DispatchQueue.global(qos: .userInitiated).async { reader.read(pipe.fileHandleForReading, running: running); readers.leave() }
            try? pipe.fileHandleForWriting.close()
        }
        let timeout = DispatchWorkItem { running.timeOut() }
        let documentTransfer = arguments.prefix(2) == ["person", "documents"]
            && ["upload", "upload-v2", "retry", "download", "download-v2"].contains(arguments.dropFirst(2).first ?? "")
        // The Authority transfer budget is 600 seconds. Keep 120 seconds for
        // local snapshot/session startup and final account reconciliation.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + (documentTransfer ? 720 : 45), execute: timeout)
        process.waitUntilExit(); timeout.cancel(); readers.wait(); running.detach(process)
        let state = running.state()
        guard !state.cancelled, !state.timedOut, !out.overflow, !err.overflow else { return .failed }
        let success = process.terminationReason == .exit && process.terminationStatus == 0
        guard !success || err.data.isEmpty else { return .failed }
        return .output(success ? out.data : err.data, success)
    }
}

enum ProjectCommand {
    case list(String?), create(String, String), read(String), members(String, String?)
    case directory(String, String?, String?), memberAdd(String, String, String), setMember(String, String, String, String), removeMember(String, String, String)
    case associate(String, String, String, Bool), feedV2(String, String?), searchV2(String, String, String?), readContextV2(String, String)
    var operation: String {
        switch self {
        case .list: return "list"
        case .create: return "create"
        case .read: return "read"
        case .members: return "members"
        case .directory: return "directory"
        case .memberAdd: return "member-add"
        case .setMember: return "member-set"
        case .removeMember: return "member-remove"
        case .associate(_, _, _, let add): return add ? "associate" : "dissociate"
        case .feedV2: return "feed-v2"
        case .searchV2: return "search-v2"
        case .readContextV2: return "read-context-v2"
        }
    }
    var projectID: String? {
        switch self {
        case .list, .create: return nil
        case .read(let id), .members(let id, _), .directory(let id, _, _), .memberAdd(let id, _, _), .setMember(let id, _, _, _),
             .removeMember(let id, _, _), .associate(let id, _, _, _), .feedV2(let id, _), .searchV2(let id, _, _), .readContextV2(let id, _): return id
        }
    }
    var requestID: String? {
        switch self {
        case .create(_, let id), .memberAdd(_, _, let id), .setMember(_, _, _, let id), .removeMember(_, _, let id), .associate(_, _, let id, _): return id
        default: return nil
        }
    }
    var arguments: [String] {
        var args = ["person", "projects", operation]
        if let projectID { args += ["--project-id", projectID] }
        if let requestID { args += ["--request-id", requestID] }
        func page(_ cursor: String?) { args += ["--limit", "10"]; if let cursor { args += ["--cursor", cursor] } }
        switch self {
        case .list(let cursor), .members(_, let cursor), .feedV2(_, let cursor): page(cursor)
        case .create(let name, _): args += ["--name", name]
        case .directory(_, let query, let cursor):
            if let query { args += ["--query", query] }
            page(cursor)
        case .searchV2(_, let query, let cursor): args += ["--query", query]; page(cursor)
        case .memberAdd(_, let member, _): args += ["--membership-id", member]
        case .setMember(_, let member, let role, _): args += ["--membership-id", member, "--role", role]
        case .removeMember(_, let member, _): args += ["--membership-id", member]
        case .associate(_, let context, _, _), .readContextV2(_, let context): args += ["--context-id", context]
        case .read: break
        }
        return args
    }
}

protocol ProjectMutationRecoveryStore: AnyObject {
    func data(forKey defaultName: String) -> Data?
    func object(forKey defaultName: String) -> Any?
    func set(_ value: Any?, forKey defaultName: String)
    func removeObject(forKey defaultName: String)
    @discardableResult func synchronize() -> Bool
}
extension UserDefaults: ProjectMutationRecoveryStore {}

// A single account-scoped replay locator, not a project/content cache. It
// keeps the exact bounded command needed to reconcile an unknown mutation
// after a normal quit or process restart.
struct ProjectMutationRecovery {
    enum Load { case missing, recovered(ProjectMutationRecovery), invalid }
    let authority: String
    let membershipID: String
    let operation: String
    let requestID: String
    let projectID: String?
    let membership: String?
    let contextID: String?
    let role: String?
    let name: String?

    init?(identity: AccountIdentity, command: ProjectCommand) {
        guard validateAuthorityOrigin(identity.authority) == identity.authority,
              let membershipID = identity.membershipID, ProjectWire.id(membershipID, prefix: "mem_") else { return nil }
        authority = identity.authority; self.membershipID = membershipID
        switch command {
        case .create(let name, let requestID):
            guard ProjectWire.name(name), ProjectWire.id(requestID, prefix: "") else { return nil }
            operation = "create"; self.requestID = requestID; projectID = nil; membership = nil; contextID = nil; role = nil; self.name = name
        case .setMember(let projectID, let membership, let role, let requestID):
            guard ProjectWire.id(projectID, prefix: "prj_"), ProjectWire.id(membership, prefix: "mem_"),
                  ["member", "lead"].contains(role), ProjectWire.id(requestID, prefix: "") else { return nil }
            operation = "member-set"; self.requestID = requestID; self.projectID = projectID; self.membership = membership; contextID = nil; self.role = role; name = nil
        case .memberAdd(let projectID, let membership, let requestID):
            guard ProjectWire.id(projectID, prefix: "prj_"), ProjectWire.id(membership, prefix: "mem_"),
                  ProjectWire.id(requestID, prefix: "") else { return nil }
            operation = "member-add"; self.requestID = requestID; self.projectID = projectID; self.membership = membership; contextID = nil; role = nil; name = nil
        case .removeMember(let projectID, let membership, let requestID):
            guard ProjectWire.id(projectID, prefix: "prj_"), ProjectWire.id(membership, prefix: "mem_"),
                  ProjectWire.id(requestID, prefix: "") else { return nil }
            operation = "member-remove"; self.requestID = requestID; self.projectID = projectID; self.membership = membership; contextID = nil; role = nil; name = nil
        case .associate(let projectID, let contextID, let requestID, let add):
            guard ProjectWire.id(projectID, prefix: "prj_"), contextID.range(of: "^ctx_[0-9a-f]{64}$", options: .regularExpression) != nil,
                  ProjectWire.id(requestID, prefix: "") else { return nil }
            operation = add ? "associate" : "dissociate"; self.requestID = requestID; self.projectID = projectID; membership = nil; self.contextID = contextID; role = nil; name = nil
        default:
            return nil
        }
    }

    private init?(identity: AccountIdentity, object: [String: Any]) {
        guard let authority = object["authority"] as? String, authority == identity.authority,
              validateAuthorityOrigin(authority) == authority,
              let membershipID = object["membership_id"] as? String, membershipID == identity.membershipID,
              ProjectWire.id(membershipID, prefix: "mem_"),
              let operation = object["operation"] as? String,
              let requestID = object["request_id"] as? String, ProjectWire.id(requestID, prefix: "")
        else { return nil }
        self.authority = authority; self.membershipID = membershipID; self.operation = operation; self.requestID = requestID
        switch operation {
        case "create":
            guard ProjectWire.keys(object, ["schema_version", "kind", "authority", "membership_id", "operation", "request_id", "name"]),
                  ProjectWire.header(object, version: 1, kind: "echo-project-mutation-recovery-v1"),
                  let name = object["name"] as? String, ProjectWire.name(name) else { return nil }
            projectID = nil; membership = nil; contextID = nil; role = nil; self.name = name
        case "member-set":
            guard ProjectWire.keys(object, ["schema_version", "kind", "authority", "membership_id", "operation", "request_id", "project_id", "target_membership_id", "role"]),
                  ProjectWire.header(object, version: 1, kind: "echo-project-mutation-recovery-v1"),
                  let projectID = object["project_id"] as? String, ProjectWire.id(projectID, prefix: "prj_"),
                  let membership = object["target_membership_id"] as? String, ProjectWire.id(membership, prefix: "mem_"),
                  let role = object["role"] as? String, ["member", "lead"].contains(role) else { return nil }
            self.projectID = projectID; self.membership = membership; contextID = nil; self.role = role; name = nil
        case "member-add":
            guard ProjectWire.keys(object, ["schema_version", "kind", "authority", "membership_id", "operation", "request_id", "project_id", "target_membership_id"]),
                  ProjectWire.header(object, version: 1, kind: "echo-project-mutation-recovery-v1"),
                  let projectID = object["project_id"] as? String, ProjectWire.id(projectID, prefix: "prj_"),
                  let membership = object["target_membership_id"] as? String, ProjectWire.id(membership, prefix: "mem_") else { return nil }
            self.projectID = projectID; self.membership = membership; contextID = nil; role = nil; name = nil
        case "member-remove":
            guard ProjectWire.keys(object, ["schema_version", "kind", "authority", "membership_id", "operation", "request_id", "project_id", "target_membership_id"]),
                  ProjectWire.header(object, version: 1, kind: "echo-project-mutation-recovery-v1"),
                  let projectID = object["project_id"] as? String, ProjectWire.id(projectID, prefix: "prj_"),
                  let membership = object["target_membership_id"] as? String, ProjectWire.id(membership, prefix: "mem_") else { return nil }
            self.projectID = projectID; self.membership = membership; contextID = nil; role = nil; name = nil
        case "associate", "dissociate":
            guard ProjectWire.keys(object, ["schema_version", "kind", "authority", "membership_id", "operation", "request_id", "project_id", "context_id"]),
                  ProjectWire.header(object, version: 1, kind: "echo-project-mutation-recovery-v1"),
                  let projectID = object["project_id"] as? String, ProjectWire.id(projectID, prefix: "prj_"),
                  let contextID = object["context_id"] as? String, contextID.range(of: "^ctx_[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
            self.projectID = projectID; membership = nil; self.contextID = contextID; role = nil; name = nil
        default:
            return nil
        }
    }

    var command: ProjectCommand? {
        switch operation {
        case "create": guard let name else { return nil }; return .create(name, requestID)
        case "member-set": guard let projectID, let membership, let role else { return nil }; return .setMember(projectID, membership, role, requestID)
        case "member-add": guard let projectID, let membership else { return nil }; return .memberAdd(projectID, membership, requestID)
        case "member-remove": guard let projectID, let membership else { return nil }; return .removeMember(projectID, membership, requestID)
        case "associate": guard let projectID, let contextID else { return nil }; return .associate(projectID, contextID, requestID, true)
        case "dissociate": guard let projectID, let contextID else { return nil }; return .associate(projectID, contextID, requestID, false)
        default: return nil
        }
    }

    static func recoveryKey(for identity: AccountIdentity) -> String {
        let bytes = Data("\(identity.authority)\n\(identity.membershipID ?? "")".utf8)
        return "org.echobrain.echo.project-mutation." + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private var object: [String: Any] {
        var result: [String: Any] = ["schema_version": 1, "kind": "echo-project-mutation-recovery-v1", "authority": authority,
                                     "membership_id": membershipID, "operation": operation, "request_id": requestID]
        if let projectID { result["project_id"] = projectID }
        if let membership { result["target_membership_id"] = membership }
        if let contextID { result["context_id"] = contextID }
        if let role { result["role"] = role }
        if let name { result["name"] = name }
        return result
    }

    func save(for identity: AccountIdentity, defaults: ProjectMutationRecoveryStore) -> Bool {
        guard authority == identity.authority, membershipID == identity.membershipID,
              let data = try? JSONSerialization.data(withJSONObject: object), data.count <= 4096 else { return false }
        let key = Self.recoveryKey(for: identity); let original = defaults.object(forKey: key)
        defaults.set(data, forKey: key)
        guard defaults.synchronize() && defaults.data(forKey: key) == data else {
            Self.restore(original, forKey: key, defaults: defaults); return false
        }
        return true
    }

    static func clear(for identity: AccountIdentity, defaults: ProjectMutationRecoveryStore) -> Bool {
        let key = recoveryKey(for: identity); let original = defaults.object(forKey: key)
        defaults.removeObject(forKey: key)
        guard defaults.synchronize() && defaults.object(forKey: key) == nil else {
            restore(original, forKey: key, defaults: defaults); return false
        }
        return true
    }

    static func load(for identity: AccountIdentity, defaults: ProjectMutationRecoveryStore) -> Load {
        let key = recoveryKey(for: identity)
        guard let value = defaults.object(forKey: key) else { return .missing }
        guard let data = value as? Data, data.count <= 4096,
              let object = ProjectWire.object(data), let recovery = ProjectMutationRecovery(identity: identity, object: object)
        else { return .invalid }
        return .recovered(recovery)
    }

    private static func restore(_ value: Any?, forKey key: String, defaults: ProjectMutationRecoveryStore) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
        _ = defaults.synchronize()
    }
}
enum ProjectResult {
    case projects([ProjectSummary], String?), summary(ProjectSummary), members([ProjectMember], String?)
    case items([UploadMatch], String?), content(UploadContent), applied(String), failure(ProjectFailure), accountChanged
}
final class ProjectClient: @unchecked Sendable {
    let cli: ProjectCLI
    init(cli: ProjectCLI = ProjectCLI()) { self.cli = cli }
    func perform(_ command: ProjectCommand, identity: AccountIdentity, completion: @escaping @MainActor (ProjectResult) -> Void) -> AccountRunning {
        let running = AccountRunning()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.execute(command, identity: identity, running: running)
            DispatchQueue.main.async { completion(result) }
        }
        return running
    }
    func execute(_ command: ProjectCommand, identity: AccountIdentity, running: AccountRunning) -> ProjectResult {
        switch cli.execute(command.arguments, identity: identity, running: running) {
        case .output(let bytes, let success):
            if success { return Self.parse(bytes, command: command) }
            return .failure(ProjectFailure.parse(bytes, action: "projects-" + command.operation, requestID: command.requestID) ?? (command.requestID == nil ? .invalid : .uncertain))
        case .accountChanged, .unavailable: return .accountChanged
        case .failed: return .failure(command.requestID == nil ? .invalid : .uncertain)
        }
    }
    static func parse(_ bytes: Data, command: ProjectCommand) -> ProjectResult {
        let failure = ProjectResult.failure(command.requestID == nil ? .invalid : .uncertain)
        guard let o = ProjectWire.object(bytes) else { return failure }
        let decoder = JSONDecoder()
        func decode<T: Decodable>(_ type: T.Type, _ object: Any) -> T? {
            guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
            return try? decoder.decode(type, from: data)
        }
        func header(_ kind: String, _ fields: [String]) -> Bool {
            ProjectWire.header(o, version: 1, kind: kind) && ProjectWire.keys(o, ["schema_version", "kind"] + fields)
        }
        func page(_ kind: String, scoped: Bool = true, version: Int = 1) -> [[String: Any]]? {
            guard ProjectWire.header(o, version: version, kind: kind),
                  ProjectWire.keys(o, ["schema_version", "kind"] + (scoped ? ["project_id"] : []) + ["items", "next_cursor"]),
                  !scoped || o["project_id"] as? String == command.projectID,
                  ProjectWire.cursor(o["next_cursor"]), let items = o["items"] as? [[String: Any]], items.count <= 10 else { return nil }
            return items
        }
        switch command {
        case .list:
            guard let items = page("echo-project-list-v1", scoped: false), items.allSatisfy(ProjectSummary.valid),
                  let projects = decode([ProjectSummary].self, items), Set(projects.map(\.project_id)).count == projects.count else { return failure }
            return .projects(projects, o["next_cursor"] as? String)
        case .read(let id):
            guard ProjectSummary.valid(o), let project = decode(ProjectSummary.self, o), project.project_id == id else { return failure }
            return .summary(project)
        case .create:
            guard header("echo-project-create-receipt-v1", ["request_id", "project_id", "created_at", "state"]),
                  o["request_id"] as? String == command.requestID, o["state"] as? String == "created",
                  let project = o["project_id"] as? String, ProjectWire.id(project, prefix: "prj_"),
                  ProjectWire.date(o["created_at"] as? String ?? "") else { return failure }
            return .applied(project)
        case .members, .directory:
            let directory = command.operation == "directory"
            guard let items = page(directory ? "echo-project-directory-v1" : "echo-project-members-v1"), items.allSatisfy({ item in
                ProjectWire.keys(item, ["membership_id", "display_name"] + (directory ? [] : ["role"])) &&
                ProjectWire.id(item["membership_id"] as? String ?? "", prefix: "mem_") &&
                ProjectWire.text(item["display_name"] as? String ?? "", max: 200) &&
                (directory || ["member", "lead"].contains(item["role"] as? String ?? ""))
            }), let members = decode([ProjectMember].self, items), Set(members.map(\.membership_id)).count == members.count else { return failure }
            return .members(members, o["next_cursor"] as? String)
        case .feedV2, .searchV2:
            guard let items = page(command.operation == "feed-v2" ? "echo-project-context-feed-v2" : "echo-project-context-search-result-v2", version: 2),
                  items.allSatisfy(UploadMatch.validObject), let matches = decode([UploadMatch].self, items),
                  Set(matches.map(\.context_id)).count == matches.count else { return failure }
            return .items(matches, o["next_cursor"] as? String)
        case .readContextV2(_, let context):
            guard ProjectWire.header(o, version: 2, kind: "echo-project-context-read-v2"),
                  ProjectWire.keys(o, ["schema_version", "kind", "project_id", "context_id", "received_at", "audience", "title", "text"]),
                  o["project_id"] as? String == command.projectID, o["context_id"] as? String == context,
                  UploadContent.validFields(o), let content = decode(UploadContent.self, o) else { return failure }
            return .content(content)
        case .memberAdd, .setMember, .removeMember, .associate:
            let member = command.operation.hasPrefix("member-")
            let field = member ? "membership_id" : "context_id"
            let args = command.arguments; let expected = args[args.firstIndex(of: member ? "--membership-id" : "--context-id")! + 1]
            let receiptOperation = command.operation == "member-add" ? "member_set" : command.operation.replacingOccurrences(of: "-", with: "_")
            guard header("echo-project-mutation-receipt-v1", ["request_id", "project_id", "operation", field, "received_at", "state"]),
                  o["request_id"] as? String == command.requestID, o["project_id"] as? String == command.projectID,
                  o["operation"] as? String == receiptOperation,
                  o[field] as? String == expected, o["state"] as? String == "applied",
                  ProjectWire.date(o["received_at"] as? String ?? "") else { return failure }
            return .applied(command.projectID!)
        }
    }
}

@MainActor
final class ProjectSession {
    enum Availability { case checking, live, notLive, failed }
    let client: ProjectClient
    private let defaults: ProjectMutationRecoveryStore
    var onChange: (() -> Void)?
    var onAccessChanged: (() -> Void)?
    /// Only terminal authorization/account loss, never an ordinary fresh read.
    var onAccessLost: (() -> Void)?
    private let foreground: @MainActor () -> Bool
    private(set) var identity: AccountIdentity?
    private(set) var availability = Availability.checking
    private(set) var projects: [ProjectSummary] = []
    private(set) var selected: ProjectSummary?
    private(set) var members: [ProjectMember] = []
    private(set) var candidates: [ProjectMember] = []
    private(set) var items: [UploadMatch] = []
    private(set) var content: UploadContent?
    private(set) var listCursor: String?
    // True once a list page has arrived for this account; false whenever the
    // list is cleared (discover, failure, concealment, account change).
    private(set) var listFetched = false
    private(set) var pageCursor: String?
    private(set) var directoryCursor: String?
    private var directoryQuery: String?
    private(set) var memberCursor: String?
    private(set) var scopeGeneration = 0
    private(set) var status = ""
    // Attention-only text; routine progress stays in `status`.
    private(set) var notice = ""
    private(set) var busy = false
    private(set) var hasOutstandingMutation = false
    private(set) var pending: ProjectCommand?
    private(set) var authorizationGeneration = UUID()
    // The project a create receipt confirmed, kept so a failed reopen never
    // looks like "nothing was created" (a second Create would duplicate it).
    private(set) var createdProjectID: String?
    private var page: ProjectCommand?
    private var readForRoster = false
    private var pendingByAccount: [String: ProjectCommand] = [:]
    private var recoveryBlockedByAccount: Set<String> = []
    private func accountKey(_ account: AccountIdentity) -> String { account.authority + "\n" + (account.membershipID ?? "") }
    private var active: AccountRunning?
    private var generation = UUID()
    private var concealed = false
    private var recoveryBlocked: Bool { identity.map { recoveryBlockedByAccount.contains(accountKey($0)) } ?? false }
    var needsRecoveryReview: Bool { pending != nil || recoveryBlocked }
    var canManage: Bool { availability == .live && selected?.role == "lead" && !busy && pending == nil && !recoveryBlocked }
    var canMutate: Bool { availability == .live && identity != nil && !busy && pending == nil && !recoveryBlocked }
    init(client: ProjectClient = ProjectClient(), defaults: ProjectMutationRecoveryStore = UserDefaults.standard,
         foreground: @escaping @MainActor () -> Bool = { NSApp.isActive }) {
        self.client = client; self.defaults = defaults; self.foreground = foreground
    }
    func bind(_ account: AccountIdentity?) {
        guard identity != account else { return }
        if !hasOutstandingMutation { cancel() }
        clearAll(); identity = account; createdProjectID = nil
        if let account {
            let key = accountKey(account)
            switch ProjectMutationRecovery.load(for: account, defaults: defaults) {
            case .missing:
                recoveryBlockedByAccount.remove(key)
            case .recovered(let recovery):
                recoveryBlockedByAccount.remove(key)
                if let command = recovery.command { pendingByAccount[key] = command }
            case .invalid:
                pendingByAccount.removeValue(forKey: key)
                recoveryBlockedByAccount.insert(key)
            }
        }
        pending = account.flatMap { pendingByAccount[accountKey($0)] }; availability = .checking; concealed = false
        invalidateDrafts()
        if account != nil && !hasOutstandingMutation { discover() } else { onChange?() }
    }
    func discover(cursor: String? = nil) {
        guard identity != nil, !hasOutstandingMutation else { return }
        cancel(); clearScoped(); projects = []; listCursor = nil; listFetched = false; concealed = false
        invalidateDrafts(); status = "Loading your projects…"; run(.list(cursor))
    }
    func open(_ project: String) {
        guard !hasOutstandingMutation, identity != nil else { return }
        cancel(); clearScoped(); readForRoster = false; concealed = false; invalidateDrafts()
        status = "Opening project…"; run(.read(project))
    }
    func feed() {
        guard !busy, let selected else { return }
        clearContent(); status = "Loading project context…"; run(.feedV2(selected.project_id, nil))
    }
    func search(_ source: String) {
        guard !busy, let selected else { return }
        guard let query = uploadQuery(source) else { status = "Search with up to 240 characters and 32 distinct words."; notice = status; onChange?(); return }
        clearContent(); status = "Searching this project…"; run(.searchV2(selected.project_id, query, nil))
    }
    func read(_ context: String) {
        guard !busy, let selected else { return }
        clearContent(); status = "Loading original text…"; run(.readContextV2(selected.project_id, context))
    }
    func roster() {
        guard !busy, let selected else { return }
        clearContent(); members = []; memberCursor = nil; candidates = []; status = "Loading project members…"
        readForRoster = true; run(.read(selected.project_id))
    }
    func directory(_ source: String? = nil, cursor: String? = nil) {
        guard canManage, let selected else { return }
        let trimmed = (source ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty || uploadQuery(trimmed) != nil else {
            status = "Search with up to 240 characters and 32 distinct words."; notice = status; onChange?(); return
        }
        let query = trimmed.isEmpty ? nil : uploadQuery(trimmed)
        if cursor == nil { candidates = []; directoryCursor = nil; directoryQuery = query }
        run(.directory(selected.project_id, query, cursor))
    }
    func nextDirectory() {
        guard !busy, let selected, let cursor = directoryCursor else { return }
        run(.directory(selected.project_id, directoryQuery, cursor))
    }
    /// Load another feed/search page without discarding the rows already shown.
    /// A cursor is an opaque continuation, so dedupe on the stable context id.
    func nextPage() {
        guard !busy, let page, let cursor = pageCursor else { return }
        content = nil
        switch page {
        case .feedV2(let project, _): status = "Loading project context…"; run(.feedV2(project, cursor))
        case .searchV2(let project, let query, _): status = "Searching this project…"; run(.searchV2(project, query, cursor))
        default: break
        }
    }
    // The next list page, appended below the rows already shown.
    func nextProjects() {
        guard !busy, identity != nil, !hasOutstandingMutation, let cursor = listCursor else { return }
        status = "Loading your projects…"; run(.list(cursor))
    }
    func nextMembers() {
        guard !busy, let selected, let cursor = memberCursor else { return }
        run(.members(selected.project_id, cursor))
    }
    // The first member page for an open project, without clearing its feed.
    func loadMembers() {
        guard !busy, let selected else { return }
        run(.members(selected.project_id, nil))
    }
    func create(_ name: String) {
        guard canMutate, ProjectWire.name(name) else { return }
        mutate(.create(name, UUID().uuidString.lowercased()))
    }
    func setMember(_ membership: String, role: String) {
        guard canManage, let selected, ["member", "lead"].contains(role) else { return }
        mutate(.setMember(selected.project_id, membership, role, UUID().uuidString.lowercased()))
    }
    func addMember(_ membership: String) {
        guard canManage, let selected else { return }
        // This is deliberately distinct from member-set: an existing lead
        // stays a lead if a stale picker row is acted on.
        mutate(.memberAdd(selected.project_id, membership, UUID().uuidString.lowercased()))
    }
    func removeMember(_ membership: String) {
        guard canManage, let selected else { return }
        mutate(.removeMember(selected.project_id, membership, UUID().uuidString.lowercased()))
    }
    func associate(_ context: String, project: String, add: Bool) {
        guard canMutate else { return }
        mutate(.associate(project, context, UUID().uuidString.lowercased(), add))
    }
    private func mutate(_ command: ProjectCommand) {
        guard let identity else { return }
        guard let recovery = ProjectMutationRecovery(identity: identity, command: command), recovery.save(for: identity, defaults: defaults) else {
            status = "Could not safely record this project change. Try again before it is sent."
            notice = status; onChange?(); return
        }
        pending = command; pendingByAccount[accountKey(identity)] = command
        clearContent(); status = "Saving project change…"; run(command)
    }
    func retry() {
        guard !busy, let pending else { return }
        status = "Retrying the same project change…"; run(pending)
    }
    // Explicit UI acknowledgment is required before abandoning an unknown
    // mutation. Refreshing a roster/feed never silently clears its replay ID.
    func abandonPending() {
        guard !busy, let identity, needsRecoveryReview else { return }
        guard ProjectMutationRecovery.clear(for: identity, defaults: defaults) else {
            status = "Could not safely clear this project recovery. Try again."
            onChange?(); return
        }
        let key = accountKey(identity)
        pendingByAccount.removeValue(forKey: key); recoveryBlockedByAccount.remove(key); pending = nil; onChange?()
    }
    func leave() {
        guard !hasOutstandingMutation else { return }
        cancel(); clearScoped(); invalidateDrafts(); onChange?()
    }
    func conceal() {
        concealed = true
        if !hasOutstandingMutation { cancel() }
        clearAll(); invalidateDrafts(); onChange?()
    }
    func accessLost() {
        if !hasOutstandingMutation { cancel() }
        clearAll(); invalidateDrafts(); onAccessLost?(); onChange?()
    }
    // Recovery locators survive normal termination. A command is not launched
    // until its locator has been acknowledged by the recovery store.
    func shutdown() { cancel(); clearAll(); pending = nil; pendingByAccount = [:]; createdProjectID = nil }
    private func invalidateDrafts() { authorizationGeneration = UUID(); onAccessChanged?() }
    private func cancel() { active?.cancel(); active = nil; generation = UUID(); busy = false; hasOutstandingMutation = false }
    private func clearContent() { items = []; content = nil; pageCursor = nil }
    private func clearScoped() {
        selected = nil; members = []; memberCursor = nil; candidates = []; directoryCursor = nil; directoryQuery = nil; page = nil; clearContent()
        scopeGeneration += 1
    }
    private func clearAll() { projects = []; listCursor = nil; listFetched = false; clearScoped() }
    private func run(_ command: ProjectCommand) {
        guard !busy, let identity else { return }
        notice = ""
        busy = true; hasOutstandingMutation = command.requestID != nil
        let id = UUID(); generation = id
        active = client.perform(command, identity: identity) { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil; self.busy = false; self.hasOutstandingMutation = false
            guard self.identity == identity else { self.onChange?(); return }
            if self.concealed || !self.foreground() {
                // A dropped list page carried nothing scoped; only scoped reads
                // and mutations invalidate drafts (a capture may be open).
                self.clearAll()
                if case .list = command {} else { self.invalidateDrafts() }
                self.onChange?(); return
            }
            switch result {
            case .projects(let projects, let cursor):
                self.availability = .live; self.listCursor = cursor; self.listFetched = true
                // A later page adds rows; the first page replaces them.
                if case .list(let from) = command, from != nil {
                    self.projects += projects.filter { page in !self.projects.contains { $0.project_id == page.project_id } }
                } else { self.projects = projects }
                self.status = self.projects.isEmpty ? "No projects on this page. Create one to start." : "Choose a project."
            case .summary(let project):
                if let selected = self.selected, selected.role != project.role { self.invalidateDrafts() }
                self.selected = project; self.availability = .live
                if self.readForRoster { self.readForRoster = false; self.run(.members(project.project_id, nil)) }
                else { self.feed() }
                return
            case .members(let members, let cursor):
                if command.operation == "directory" {
                    if case .directory(_, _, let from) = command, from != nil {
                        self.candidates += members.filter { page in !self.candidates.contains { $0.membership_id == page.membership_id } }
                    } else { self.candidates = members }
                    self.directoryCursor = cursor
                }
                else {
                    if case .members(_, let from) = command, from != nil {
                        self.members += members.filter { page in !self.members.contains { $0.membership_id == page.membership_id } }
                    } else { self.members = members }
                    self.memberCursor = cursor
                }
                self.status = members.isEmpty ? "No members on this page." : "Current project members. Leads manage membership."
            case .items(let items, let cursor):
                if case .feedV2(_, let from) = command, from != nil {
                    self.items += items.filter { next in !self.items.contains { $0.context_id == next.context_id } }
                } else if case .searchV2(_, _, let from) = command, from != nil {
                    self.items += items.filter { next in !self.items.contains { $0.context_id == next.context_id } }
                } else { self.items = items }
                self.pageCursor = cursor; self.page = command
                self.status = self.items.isEmpty ? "No context you can read on this page." : "Select an original to read."
            case .content(let content): self.content = content; self.status = ""
            case .applied(let project):
                guard ProjectMutationRecovery.clear(for: identity, defaults: self.defaults) else {
                    self.status = "Saved, but could not safely clear project recovery. Retry the same change."
                    self.notice = self.status; self.onChange?(); return
                }
                let key = self.accountKey(identity)
                self.pending = nil; self.pendingByAccount.removeValue(forKey: key); self.recoveryBlockedByAccount.remove(key)
                if case .create = command { self.createdProjectID = project }
                // Receipts describe the committed operation, not current access
                // or association state. Always issue a fresh authorized read.
                self.open(project); return
            case .failure(let failure):
                self.clearAll(); self.invalidateDrafts()
                if failure.losesAccess { self.onAccessLost?() }
                if command.operation == "list", failure.code == "not_found", failure.status == 404 {
                    self.availability = .notLive; self.status = "Projects · Not live yet"
                } else {
                    if command.operation == "list" { self.availability = .failed }
                    self.status = failure.message
                }
                self.notice = self.status
                // Even a later canonical rejection cannot disprove an earlier
                // committed attempt. Keep the frozen pending command.
            case .accountChanged:
                self.clearAll(); self.identity = nil; self.pending = nil; self.availability = .checking; self.createdProjectID = nil
                self.invalidateDrafts(); self.onAccessLost?(); self.status = "Your account changed. Reopen ECHO after signing in."
                self.notice = self.status
            }
            self.onChange?()
        }
        onChange?()
    }
}

extension ProjectSession {
    /// The whole list is here: a first page arrived with no further cursor.
    /// A list emptied by concealment or a failure is not "loaded".
    var listLoaded: Bool {
        availability == .live && !busy && listCursor == nil && listFetched
    }
}

// MARK: - Look

/// Fixed colours and initials. Nothing here invents data: a circle only ever
/// carries letters taken from a real name the backend returned.
private enum Look {
    static let palette: [NSColor] = [0x6B5A3E, 0x4E5A6B, 0x5A6B4E, 0x6B4E5A, 0x4E6B66, 0x5E5A6B].map { (value: Int) in
        NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
    static func color(for id: String) -> NSColor {
        palette[Int(id.unicodeScalars.reduce(UInt64(0)) { $0 &+ UInt64($1.value) } % UInt64(palette.count))]
    }
    static func initials(_ name: String) -> String {
        name.split(whereSeparator: { $0.isWhitespace }).prefix(2).compactMap { $0.first }.map { String($0).uppercased() }.joined()
    }
    static func initial(_ name: String) -> String { name.first.map { String($0).uppercased() } ?? "" }
}

/// "Now", "12m", "3h", "Yesterday", "Mon", "12 Sep", "12 Sep 2025".
@MainActor
private enum RelativeTime {
    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static func formatter(_ template: String) -> DateFormatter {
        let formatter = DateFormatter(); formatter.locale = .current; formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }
    private static let weekday = formatter("EEE")
    private static let dayMonth = formatter("dMMM")
    private static let dayMonthYear = formatter("dMMMy")
    static func text(_ value: String, now: Date = Date()) -> String {
        guard let date = parser.date(from: value) else { return "" }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "Now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "\(Int(seconds / 3600))h" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 1 { return "Yesterday" }
        if (2...6).contains(days) { return weekday.string(from: date) }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) { return dayMonth.string(from: date) }
        return dayMonthYear.string(from: date)
    }
}

private func suggestedNoteTitle(_ source: String) -> String {
    var suggestion = source.split(whereSeparator: { $0.isNewline }).lazy.map {
        String($0).components(separatedBy: .controlCharacters).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }.first(where: { !$0.isEmpty }) ?? "Note"
    while suggestion.utf8.count > 200 { suggestion.removeLast() }
    return suggestion.isEmpty ? "Note" : suggestion
}

@MainActor
private func mark(_ view: NSView, _ identifier: String, label: String? = nil) {
    view.identifier = NSUserInterfaceItemIdentifier(identifier)
    view.setAccessibilityIdentifier(identifier)
    if let label { view.setAccessibilityLabel(label) }
}

@MainActor
private func tintedSymbol(_ name: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor) -> NSImage? {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: weight)) else { return nil }
    return NSImage(size: base.size, flipped: false) { rect in
        base.draw(in: rect)
        color.set()
        rect.fill(using: .sourceAtop)
        return true
    }
}

@MainActor
private func drawImage(_ image: NSImage, centeredIn rect: NSRect) {
    let size = image.size
    let frame = NSRect(x: round(rect.midX - size.width / 2), y: round(rect.midY - size.height / 2), width: size.width, height: size.height)
    image.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
}

@MainActor
private func textWidth(_ text: String, _ font: NSFont) -> CGFloat {
    ceil((text as NSString).size(withAttributes: [.font: font]).width)
}

/// One line of text, vertically centred in `rect`, truncated at the tail.
@MainActor
private func drawLine(_ text: String, font: NSFont, color: NSColor, in rect: NSRect, alignment: NSTextAlignment = .left) {
    let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail; paragraph.alignment = alignment
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
    let height = ceil(("Ag" as NSString).size(withAttributes: attributes).height)
    (text as NSString).draw(in: NSRect(x: rect.minX, y: floor(rect.midY - height / 2), width: max(0, rect.width), height: height),
                            withAttributes: attributes)
}

@MainActor
private func drawInitials(_ text: String, color: NSColor, in rect: NSRect, fontSize: CGFloat, ring: CGFloat = 0) {
    if ring > 0 { EchoTheme.ink.setFill(); NSBezierPath(ovalIn: rect).fill() }
    color.setFill(); NSBezierPath(ovalIn: rect.insetBy(dx: ring, dy: ring)).fill()
    drawLine(text, font: .systemFont(ofSize: fontSize, weight: .semibold), color: EchoTheme.text, in: rect, alignment: .center)
}

/// Supported document URLs; content validation occurs at the Authority.
@MainActor
private func droppedDocumentFile(_ info: NSDraggingInfo) -> URL? {
    guard let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
          urls.count == 1, let url = urls.first else { return nil }
    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey])
    if values?.isRegularFile == false { return nil }
    guard DocumentSnapshot.supports(url) else { return nil }
    return url
}

@MainActor
private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = EchoTheme.text) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    return field
}

@MainActor
private func pill(_ title: String, _ style: PillButton.Style, height: CGFloat, target: AnyObject?, action: Selector?) -> PillButton {
    let button = PillButton(title: title, target: target, action: action)
    button.style = style
    button.translatesAutoresizingMaskIntoConstraints = false
    button.heightAnchor.constraint(equalToConstant: height).isActive = true
    return button
}

@MainActor
private func confirm(_ title: String, detail: String, action: String, cancel: String = "Cancel", on window: NSWindow,
                     apply: @escaping () -> Void) {
    let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
    alert.addButton(withTitle: action); alert.addButton(withTitle: cancel)
    alert.beginSheetModal(for: window) { response in if response == .alertFirstButtonReturn { apply() } }
}

@MainActor
private func spinner() -> NSProgressIndicator {
    let indicator = NSProgressIndicator()
    indicator.style = .spinning; indicator.controlSize = .small; indicator.isDisplayedWhenStopped = false
    indicator.startAnimation(nil)
    return indicator
}

// MARK: - Self-drawn controls

/// Base for every self-drawn button: flipped, borderless, hover-aware.
class HoverButton: NSButton {
    private(set) var hovering = false
    private var hoverArea: NSTrackingArea?

    init() {
        super.init(frame: .zero)
        isBordered = false; title = ""
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area); hoverArea = area
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8).fill() }
}

/// A small glyph button (titlebar, "…" menus). It may pop a menu instead of
/// sending its action.
/// Back: a chevron and the page it returns to. The visible destination avoids
/// ambiguous navigation when a project reader, documents, and Ask share a window.
final class BackButton: HoverButton {
    static let maximumWidth: CGFloat = 180
    private let labelFont = NSFont.systemFont(ofSize: 13)

    override init() { super.init(); setAccessibilityLabel("Back") }
    @available(*, unavailable) required init?(coder: NSCoder) { nil }
    override var title: String {
        didSet { setAccessibilityLabel(title.isEmpty ? "Back" : "Back to \(title)"); needsDisplay = true }
    }
    var fittingWidth: CGFloat { min(Self.maximumWidth, 6 + 10 + 5 + textWidth(title, labelFont) + 8) }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
    override func draw(_ dirtyRect: NSRect) {
        let active = isEnabled && (isHighlighted || hovering)
        if active { EchoTheme.text.withAlphaComponent(isHighlighted ? 0.14 : 0.08).setFill(); NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
        let color = active ? EchoTheme.text : EchoTheme.mutedText
        let chevron = NSRect(x: 6, y: 0, width: 10, height: bounds.height)
        if let image = tintedSymbol("chevron.left", size: 12, weight: .semibold, color: color) { drawImage(image, centeredIn: chevron) }
        let x = chevron.maxX + 5
        drawLine(title, font: labelFont, color: color, in: NSRect(x: x, y: 0, width: bounds.width - x - 8, height: bounds.height))
    }
}

final class IconButton: HoverButton {
    var symbolName: String { didSet { needsDisplay = true } }
    var round = false
    var menuProvider: (() -> NSMenu?)?
    private let symbolSize: CGFloat

    init(symbol: String, label: String, size: CGFloat = 14) {
        symbolName = symbol; symbolSize = size
        super.init()
        setAccessibilityLabel(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func drawFocusRingMask() {
        let radius = round ? bounds.height / 2 : 5
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
    }

    override func draw(_ dirtyRect: NSRect) {
        if isEnabled && (isHighlighted || hovering) {
            EchoTheme.text.withAlphaComponent(isHighlighted ? 0.14 : 0.08).setFill()
            let radius = round ? bounds.height / 2 : 5
            NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        }
        if let image = tintedSymbol(symbolName, size: symbolSize, weight: .medium,
                                    color: EchoTheme.text.withAlphaComponent(isEnabled ? 0.66 : 0.25)) {
            drawImage(image, centeredIn: bounds)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled, let menu = menuProvider?() else { super.mouseDown(with: event); return }
        popMenu(menu)
    }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled, let menu = menuProvider?() else { return super.accessibilityPerformPress() }
        popMenu(menu); return true
    }

    private func popMenu(_ menu: NSMenu) {
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 4), in: self)
    }
}

/// The 34pt circles: bar write/send, compose attach/send, clear search.
final class CircleButton: HoverButton {
    enum Style { case quiet, attach, gold, clear, close }
    private let symbolName: String
    private let style: Style
    private let progress = NSProgressIndicator()
    var showsSpinner = false {
        didSet {
            progress.isHidden = !showsSpinner
            if showsSpinner { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
            needsDisplay = true
        }
    }

    init(symbol: String, label: String, style: Style) {
        symbolName = symbol; self.style = style
        super.init()
        setAccessibilityLabel(label)
        progress.style = .spinning; progress.controlSize = .small; progress.isDisplayedWhenStopped = false; progress.isHidden = true
        addSubview(progress)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        progress.frame = NSRect(x: floor(bounds.midX - 8), y: floor(bounds.midY - 8), width: 16, height: 16)
    }

    override func drawFocusRingMask() { NSBezierPath(ovalIn: bounds).fill() }

    override func draw(_ dirtyRect: NSRect) {
        let alpha: CGFloat = isEnabled || showsSpinner ? 1 : 0.38
        let fill: NSColor
        let glyph: NSColor
        switch style {
        case .gold:
            fill = isHighlighted ? EchoTheme.goldBright : EchoTheme.gold; glyph = EchoTheme.inkDeep
        case .quiet:
            fill = EchoTheme.text.withAlphaComponent(isHighlighted ? 0.18 : (hovering && isEnabled ? 0.14 : 0.10)); glyph = EchoTheme.text
        case .attach:
            fill = EchoTheme.text.withAlphaComponent(isHighlighted ? 0.16 : (hovering && isEnabled ? 0.12 : 0.08)); glyph = EchoTheme.mutedText
        case .clear:
            fill = EchoTheme.text.withAlphaComponent(isHighlighted ? 0.20 : 0.12); glyph = EchoTheme.mutedText
        case .close:
            fill = EchoTheme.text.withAlphaComponent(isHighlighted ? 0.20 : (hovering && isEnabled ? 0.14 : 0.08)); glyph = EchoTheme.mutedText
        }
        fill.withAlphaComponent(fill.alphaComponent * alpha).setFill()
        NSBezierPath(ovalIn: bounds).fill()
        guard !showsSpinner else { return }
        if let image = tintedSymbol(symbolName, size: style == .clear ? 8 : 14, weight: .semibold,
                                    color: glyph.withAlphaComponent(glyph.alphaComponent * alpha)) {
            drawImage(image, centeredIn: bounds)
        }
    }
}

/// A Messages-style project row: initial circle, name, and "Lead" only for
/// leads. It accepts one dropped text file.
final class ProjectRowButton: HoverButton {
    private let name: String
    private let projectID: String
    private let isLead: Bool
    var onDropFile: ((URL) -> Void)?
    private var dropTarget = false { didSet { needsDisplay = true } }

    init(project: ProjectSummary) {
        name = project.name; projectID = project.project_id; isLead = project.role == "lead"
        super.init()
        mark(self, "project-row", label: "\(project.name) · \(isLead ? "Lead" : "Member")")
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 74) }

    override func draw(_ dirtyRect: NSRect) {
        if dropTarget {
            let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
            EchoTheme.gold.withAlphaComponent(0.14).setFill(); shape.fill()
            EchoTheme.gold.setStroke(); shape.lineWidth = 1; shape.stroke()
        } else {
            if isHighlighted || hovering {
                EchoTheme.text.withAlphaComponent(0.06).setFill()
                NSBezierPath(roundedRect: bounds.insetBy(dx: 0, dy: 1), xRadius: 10, yRadius: 10).fill()
            }
            EchoTheme.quietBorder.setFill()
            NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        }
        let circle = NSRect(x: 6, y: floor((bounds.height - 46) / 2), width: 46, height: 46)
        drawInitials(Look.initial(name), color: Look.color(for: projectID), in: circle, fontSize: 16)
        var trailing = bounds.width - 12
        if isLead {
            let font = NSFont.systemFont(ofSize: 12)
            let width = textWidth("Lead", font)
            drawLine("Lead", font: font, color: dropTarget ? EchoTheme.mutedText : EchoTheme.faintText,
                     in: NSRect(x: trailing - width, y: 0, width: width, height: bounds.height))
            trailing -= width + 12
        }
        let x = circle.maxX + 14
        drawLine(name, font: .systemFont(ofSize: 15, weight: .medium), color: EchoTheme.text,
                 in: NSRect(x: x, y: 0, width: trailing - x, height: bounds.height))
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard isEnabled, onDropFile != nil, droppedDocumentFile(sender) != nil else { return [] }
        dropTarget = true
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { dropTarget ? .copy : [] }
    override func draggingExited(_ sender: NSDraggingInfo?) { dropTarget = false }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { dropTarget }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dropTarget = false
        guard let url = droppedDocumentFile(sender), let onDropFile else { return false }
        onDropFile(url)
        return true
    }
    override func concludeDragOperation(_ sender: NSDraggingInfo?) { dropTarget = false }
}

/// A non-interactive SF Symbol with its own accessibility label.
final class GlyphView: NSView {
    private let symbolName: String

    init(symbol: String, label: String) {
        symbolName = symbol
        super.init(frame: .zero)
        setAccessibilityElement(true); setAccessibilityRole(.image); setAccessibilityLabel(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        if let image = tintedSymbol(symbolName, size: 11, weight: .medium, color: EchoTheme.faintText) { drawImage(image, centeredIn: bounds) }
    }
}

/// One original: note tile, title, an audience glyph only for exceptions, and
/// a relative time. No author: the backend has none.
final class ItemRowButton: HoverButton {
    private let itemTitle: String
    private let detail: String?
    private let time: String
    private let glyph: GlyphView?
    private let timeFont = NSFont.systemFont(ofSize: 12.5)

    init(title: String, visibility: UploadVisibility, receivedAt: String, detail: String? = nil) {
        self.detail = detail; itemTitle = title; time = RelativeTime.text(receivedAt)
        switch visibility {
        case .onlyMe: glyph = GlyphView(symbol: "lock.fill", label: "Only you")
        case .team: glyph = GlyphView(symbol: "globe", label: "Everyone in your organization")
        case .project, .projects: glyph = nil
        }
        super.init()
        mark(self, "item-row", label: title)
        if let glyph { addSubview(glyph); setAccessibilityHelp(glyph.accessibilityLabel()) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 56) }

    private var timeWidth: CGFloat { time.isEmpty ? 0 : textWidth(time, timeFont) }

    override func layout() {
        super.layout()
        let trailing = bounds.width - 8 - timeWidth - (time.isEmpty ? 0 : 8)
        glyph?.frame = NSRect(x: trailing - 14, y: floor((bounds.height - 14) / 2), width: 14, height: 14)
    }

    override func draw(_ dirtyRect: NSRect) {
        if isHighlighted || hovering {
            EchoTheme.text.withAlphaComponent(0.06).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 0, dy: 1), xRadius: 10, yRadius: 10).fill()
        }
        EchoTheme.quietBorder.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        let tile = NSRect(x: 8, y: floor((bounds.height - 32) / 2), width: 32, height: 32)
        EchoTheme.text.withAlphaComponent(0.12).setFill()
        NSBezierPath(roundedRect: tile, xRadius: 9, yRadius: 9).fill()
        let lines = NSBezierPath()
        let origin = NSPoint(x: tile.minX + 9, y: tile.minY + 9)
        for (y, length) in [(3.5, 10.0), (7.0, 10.0), (10.5, 6.0)] as [(CGFloat, CGFloat)] {
            lines.move(to: NSPoint(x: origin.x + 2, y: origin.y + y))
            lines.line(to: NSPoint(x: origin.x + 2 + length, y: origin.y + y))
        }
        lines.lineWidth = 1.5; lines.lineCapStyle = .round
        EchoTheme.text.withAlphaComponent(0.8).setStroke(); lines.stroke()
        var trailing = bounds.width - 8
        if !time.isEmpty {
            drawLine(time, font: timeFont, color: EchoTheme.faintText, in: NSRect(x: trailing - timeWidth, y: 0, width: timeWidth, height: bounds.height))
            trailing -= timeWidth + 8
        }
        if glyph != nil { trailing -= 14 + 8 }
        let x = tile.maxX + 14
        drawLine(itemTitle, font: .systemFont(ofSize: 15, weight: .medium), color: EchoTheme.text,
                 in: NSRect(x: x, y: detail == nil ? 0 : 22, width: trailing - x, height: detail == nil ? bounds.height : 24))
        if let detail { drawLine(detail, font: .systemFont(ofSize: 11.5), color: EchoTheme.faintText,
                                in: NSRect(x: x, y: 6, width: trailing - x, height: 18)) }
    }
}

/// The dashed-circle call to action used by empty states.
final class EmptyCircleButton: HoverButton {
    private let titleFont = NSFont.systemFont(ofSize: 15, weight: .medium)

    init(title: String) {
        super.init()
        self.title = title
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var title: String {
        didSet { setAccessibilityLabel(title); invalidateIntrinsicContentSize(); needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 8 + 46 + 14 + textWidth(title, titleFont) + 16, height: 74) }

    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 37, yRadius: 37).fill() }

    override func draw(_ dirtyRect: NSRect) {
        let alpha: CGFloat = isEnabled ? 1 : 0.38
        if isEnabled && (isHighlighted || hovering) {
            EchoTheme.text.withAlphaComponent(isHighlighted ? 0.10 : 0.06).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 37, yRadius: 37).fill()
        }
        let circle = NSRect(x: 8, y: floor((bounds.height - 46) / 2), width: 46, height: 46).insetBy(dx: 0.75, dy: 0.75)
        let ring = NSBezierPath(ovalIn: circle)
        ring.lineWidth = 1.5; ring.setLineDash([4, 3], count: 2, phase: 0)
        EchoTheme.text.withAlphaComponent(0.45 * alpha).setStroke(); ring.stroke()
        let plus = NSBezierPath()
        plus.move(to: NSPoint(x: circle.midX - 7, y: circle.midY)); plus.line(to: NSPoint(x: circle.midX + 7, y: circle.midY))
        plus.move(to: NSPoint(x: circle.midX, y: circle.midY - 7)); plus.line(to: NSPoint(x: circle.midX, y: circle.midY + 7))
        plus.lineWidth = 1.6; plus.lineCapStyle = .round
        EchoTheme.text.withAlphaComponent(0.8 * alpha).setStroke(); plus.stroke()
        let x = circle.maxX + 14
        // A disabled state ("Not live yet") is information: keep it readable.
        drawLine(title, font: titleFont, color: isEnabled ? EchoTheme.text : EchoTheme.faintText,
                 in: NSRect(x: x, y: 0, width: bounds.width - x - 12, height: bounds.height))
    }
}

/// Up to three overlapping member circles from the fetched first page, never
/// a total, one initial each so the overlap never cuts a letter. Before
/// members load it shows a plain people glyph.
final class PeopleStackButton: HoverButton {
    var people: [(initials: String, id: String)] = [] { didSet { needsDisplay = true } }

    override init() {
        super.init()
        mark(self, "people-button", label: "Project members")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let shown = Array(people.prefix(3))
        guard !shown.isEmpty else {
            let box = NSRect(x: bounds.maxX - 34, y: floor((bounds.height - 24) / 2), width: 28, height: 24)
            if isHighlighted || hovering {
                EchoTheme.text.withAlphaComponent(isHighlighted ? 0.14 : 0.08).setFill()
                NSBezierPath(roundedRect: box, xRadius: 5, yRadius: 5).fill()
            }
            if let image = tintedSymbol("person.2", size: 13, weight: .medium, color: EchoTheme.mutedText) { drawImage(image, centeredIn: box) }
            return
        }
        let width = 24 + CGFloat(shown.count - 1) * 17
        var x = bounds.maxX - 14 - width
        let y = floor((bounds.height - 24) / 2)
        for person in shown {
            drawInitials(person.initials, color: Look.color(for: person.id), in: NSRect(x: x, y: y, width: 24, height: 24), fontSize: 10, ring: 2)
            x += 17
        }
        if isHighlighted {
            EchoTheme.text.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: NSRect(x: bounds.maxX - 16 - width, y: y - 2, width: width + 4, height: 28), xRadius: 14, yRadius: 14).fill()
        }
    }
}

/// The sidebar's bottom row: who is signed in, and the account menu.
final class AccountRowButton: HoverButton {
    var name: String? { didSet { needsDisplay = true } }
    var role = "" { didSet { needsDisplay = true } }
    var colorKey = "" { didSet { needsDisplay = true } }

    override init() {
        super.init()
        setAccessibilityLabel("Account")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.quietBorder.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
        if isHighlighted || hovering {
            EchoTheme.text.withAlphaComponent(isHighlighted ? 0.08 : 0.04).setFill()
            NSRect(x: 0, y: 1, width: bounds.width, height: bounds.height - 1).fill()
        }
        let circle = NSRect(x: 20, y: floor((bounds.height - 28) / 2) - 2, width: 28, height: 28)
        let x = circle.maxX + 10
        let width = bounds.width - x - 14
        guard let name else {
            EchoTheme.text.withAlphaComponent(0.12).setFill(); NSBezierPath(ovalIn: circle).fill()
            if let image = tintedSymbol("person.fill", size: 12, color: EchoTheme.mutedText) { drawImage(image, centeredIn: circle) }
            drawLine("Account · Sign in", font: .systemFont(ofSize: 13), color: EchoTheme.text, in: NSRect(x: x, y: circle.minY, width: width, height: 28))
            return
        }
        drawInitials(Look.initials(name), color: Look.color(for: colorKey), in: circle, fontSize: 11)
        drawLine(name, font: .systemFont(ofSize: 13), color: EchoTheme.text, in: NSRect(x: x, y: circle.minY - 1, width: width, height: 16))
        drawLine(role, font: .systemFont(ofSize: 11.5), color: EchoTheme.faintText, in: NSRect(x: x, y: circle.minY + 14, width: width, height: 15))
    }
}

/// A sidebar entry: icon, label, and an optional faint trailing hint.
final class SidebarRowButton: HoverButton {
    private let symbolName: String
    var trailing: String? { didSet { needsDisplay = true } }
    private var labelFont: NSFont { .systemFont(ofSize: 13.5) }

    init(title: String, symbol: String, target: AnyObject?, action: Selector?) {
        symbolName = symbol
        super.init()
        self.title = title; self.target = target; self.action = action
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var title: String {
        didSet { setAccessibilityLabel(title); needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 34) }

    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }

    override func draw(_ dirtyRect: NSRect) {
        let alpha: CGFloat = isEnabled ? 1 : 0.38
        if isEnabled && (isHighlighted || hovering) {
            EchoTheme.text.withAlphaComponent(isHighlighted ? 0.10 : 0.06).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        }
        let box = NSRect(x: 10, y: floor((bounds.height - 16) / 2), width: 16, height: 16)
        if let image = tintedSymbol(symbolName, size: 13, color: EchoTheme.text.withAlphaComponent(0.66 * alpha)) { drawImage(image, centeredIn: box) }
        var right = bounds.width - 10
        if let trailing {
            let font = NSFont.systemFont(ofSize: 12)
            let width = textWidth(trailing, font)
            drawLine(trailing, font: font, color: EchoTheme.text.withAlphaComponent(0.55 * alpha), in: NSRect(x: right - width, y: 0, width: width, height: bounds.height))
            right -= width + 8
        }
        let text = NSRect(x: box.maxX + 10, y: 0, width: right - box.maxX - 10, height: bounds.height)
        // "New project · Check availability" does not fit 220pt: the state
        // goes under the name, faint, instead of being cut off.
        if textWidth(title, labelFont) > text.width, let split = title.range(of: " · ") {
            drawLine(String(title[..<split.lowerBound]), font: labelFont, color: EchoTheme.text.withAlphaComponent(alpha),
                     in: NSRect(x: text.minX, y: text.midY - 16, width: text.width, height: 17))
            drawLine(String(title[split.upperBound...]), font: .systemFont(ofSize: 11.5), color: EchoTheme.faintText,
                     in: NSRect(x: text.minX, y: text.midY + 1, width: text.width, height: 15))
            return
        }
        drawLine(title, font: labelFont, color: EchoTheme.text.withAlphaComponent(alpha), in: text)
    }
}

/// The "To <destination> ⌄" chip. A plain pill that pops a menu, so the
/// destination reads as a fact rather than a form control. `onChoose` is the
/// whole contract: choosing works without the menu.
final class ChipMenuButton: NSButton {
    var choices: [String] = []
    var selectedIndex = 0 { didSet { needsDisplay = true } }
    var onChoose: ((Int) -> Void)?
    private var chipFont: NSFont { .systemFont(ofSize: 13.5) }

    override var isFlipped: Bool { true }

    override var intrinsicContentSize: NSSize {
        NSSize(width: min(320, textWidth(title, chipFont) + 41), height: 30)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize(); needsDisplay = true }
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { path().fill() }

    override func draw(_ dirtyRect: NSRect) {
        let alpha: CGFloat = isEnabled ? 1 : 0.38
        EchoTheme.text.withAlphaComponent((isHighlighted ? 0.18 : 0.12) * alpha).setFill()
        path().fill()
        drawLine(title, font: chipFont, color: EchoTheme.text.withAlphaComponent(alpha),
                 in: NSRect(x: 12, y: 0, width: bounds.width - 41, height: bounds.height))
        let chevron = NSBezierPath()
        let centre = NSPoint(x: bounds.maxX - 17, y: bounds.midY)
        chevron.move(to: NSPoint(x: centre.x - 4, y: centre.y - 2))
        chevron.line(to: NSPoint(x: centre.x, y: centre.y + 2))
        chevron.line(to: NSPoint(x: centre.x + 4, y: centre.y - 2))
        chevron.lineWidth = 1.5; chevron.lineCapStyle = .round; chevron.lineJoinStyle = .round
        EchoTheme.text.withAlphaComponent(0.66 * alpha).setStroke()
        chevron.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        showMenu()
    }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        showMenu(); return true
    }

    private func showMenu() {
        let menu = NSMenu()
        for (index, choice) in choices.enumerated() {
            let item = NSMenuItem(title: choice, action: #selector(choose(_:)), keyEquivalent: "")
            item.target = self; item.tag = index; item.state = index == selectedIndex ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 4), in: self)
    }

    @objc private func choose(_ sender: NSMenuItem) {
        onChoose?(sender.tag)
    }

    private func path() -> NSBezierPath {
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    }
}

/// The rounded field at the bottom of the window.
final class BarBackgroundView: NSView {
    var highlighted = false { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.surface.setFill()
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: inset, xRadius: inset.height / 2, yRadius: inset.height / 2)
        shape.fill()
        (highlighted ? EchoTheme.gold : EchoTheme.border).setStroke()
        shape.lineWidth = 1
        shape.stroke()
    }
}

/// The main content area. It takes one dropped text file anywhere (a project
/// row takes its own drop first) and shows a 1pt gold inset border while the
/// drop would be accepted. Dropping never sends anything.
final class FileDropView: NSView {
    var onDropFile: ((URL) -> Void)?
    var acceptsDrop: (() -> Bool)?
    private let outline = DropOutlineView()
    private(set) var dropTarget = false { didSet { outline.isHidden = !dropTarget } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        outline.isHidden = true; outline.autoresizingMask = [.width, .height]; outline.frame = bounds
        addSubview(outline)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // The border always draws over the column's own views.
    override func didAddSubview(_ subview: NSView) {
        super.didAddSubview(subview)
        if subview !== outline, outline.superview === self { addSubview(outline, positioned: .above, relativeTo: nil) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard onDropFile != nil, acceptsDrop?() != false, droppedDocumentFile(sender) != nil else { return [] }
        dropTarget = true
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { dropTarget ? .copy : [] }
    override func draggingExited(_ sender: NSDraggingInfo?) { dropTarget = false }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { dropTarget }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dropTarget = false
        guard let url = droppedDocumentFile(sender), let onDropFile else { return false }
        onDropFile(url)
        return true
    }
    override func concludeDragOperation(_ sender: NSDraggingInfo?) { dropTarget = false }
}

/// The drop border: drawn only, never hit.
final class DropOutlineView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(rect: bounds.insetBy(dx: 0.5, dy: 0.5))
        shape.lineWidth = 1; EchoTheme.gold.setStroke(); shape.stroke()
    }
}

/// A rounded well behind a borderless text field.
final class FieldBox: NSView {
    private let stroke: NSColor
    private let radius: CGFloat

    init(stroke: NSColor, radius: CGFloat) {
        self.stroke = stroke; self.radius = radius
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        EchoTheme.surface.setFill(); shape.fill()
        stroke.setStroke(); shape.lineWidth = 1; shape.stroke()
    }
}

/// The dashed well that holds a new project's files.
final class DashedBox: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        shape.lineWidth = 1; shape.setLineDash([4, 3], count: 2, phase: 0)
        EchoTheme.text.withAlphaComponent(0.24).setStroke(); shape.stroke()
    }
}

/// The sidebar surface with its quiet right edge.
final class SidebarView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.surface.setFill(); bounds.fill()
        EchoTheme.quietBorder.setFill()
        NSRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height).fill()
    }
}

/// A label that never takes clicks (placeholders drawn over a text view).
final class PassthroughLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Fixed-height rows stacked top-down by frame. Owners replace the rows; the
/// view sizes itself so a scroll view can hold it.
final class ColumnStackView: NSView {
    struct Row {
        let view: NSView
        let height: CGFloat
        var centered = false
        var gap: CGFloat = 0
    }
    private var rows: [Row] = []
    private lazy var height: NSLayoutConstraint = {
        let constraint = heightAnchor.constraint(equalToConstant: 0); constraint.isActive = true
        return constraint
    }()

    override var isFlipped: Bool { true }

    func set(_ rows: [Row]) {
        for row in self.rows { row.view.removeFromSuperview() }
        self.rows = rows
        for row in rows { row.view.translatesAutoresizingMaskIntoConstraints = true; addSubview(row.view) }
        height.constant = rows.reduce(0) { $0 + $1.gap + $1.height }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        var y: CGFloat = 0
        for row in rows {
            y += row.gap
            if row.centered {
                let width = min(bounds.width, max(0, row.view.intrinsicContentSize.width))
                row.view.frame = NSRect(x: floor((bounds.width - width) / 2), y: y, width: width, height: row.height)
            } else {
                row.view.frame = NSRect(x: 0, y: y, width: bounds.width, height: row.height)
            }
            y += row.height
        }
    }
}

@MainActor
private func listScroll(_ list: ColumnStackView) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    list.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = list
    NSLayoutConstraint.activate([
        list.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
        list.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
        list.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
    ])
    return scroll
}

/// The gold "Lead" chip on the new-project people list.
final class LeadChip: NSView {
    private let font = NSFont.systemFont(ofSize: 12)
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true); setAccessibilityRole(.staticText); setAccessibilityLabel("Lead")
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override var intrinsicContentSize: NSSize { NSSize(width: textWidth("Lead", font) + 20, height: 24) }
    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.gold.withAlphaComponent(0.18).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
        drawLine("Lead", font: font, color: EchoTheme.goldBright, in: bounds, alignment: .center)
    }
}

/// A person: initials circle, name, "Lead" for leads, then one optional
/// control. Only fields the backend returned are drawn.
final class PersonRowView: NSView {
    private let initials: String
    private let colorKey: String

    init(name: String, id: String, isLead: Bool, leadChip: Bool, fontSize: CGFloat, trailing: NSView?) {
        initials = Look.initials(name); colorKey = id
        super.init(frame: .zero)
        let nameLabel = label(name, size: fontSize)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        addSubview(nameLabel)
        var edge = trailingAnchor
        var gap: CGFloat = 0
        if let trailing {
            trailing.translatesAutoresizingMaskIntoConstraints = false
            addSubview(trailing)
            trailing.trailingAnchor.constraint(equalTo: trailingAnchor).isActive = true
            trailing.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -0.5).isActive = true
            edge = trailing.leadingAnchor; gap = 10
        }
        if isLead {
            let lead: NSView
            if leadChip {
                lead = LeadChip()
            } else {
                lead = label("Lead", size: 12, color: EchoTheme.goldBright)
            }
            lead.translatesAutoresizingMaskIntoConstraints = false
            lead.setContentCompressionResistancePriority(.required, for: .horizontal)
            addSubview(lead)
            lead.trailingAnchor.constraint(equalTo: edge, constant: -gap).isActive = true
            lead.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -0.5).isActive = true
            edge = lead.leadingAnchor; gap = 10
        }
        NSLayoutConstraint.activate([
            nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40),
            nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -0.5),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: edge, constant: -max(gap, 10)),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        drawInitials(initials, color: Look.color(for: colorKey), in: NSRect(x: 0, y: floor((bounds.height - 28) / 2), width: 28, height: 28), fontSize: 11)
        EchoTheme.quietBorder.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }
}

/// The compose body: plain text, Escape handled by the sheet, and a dropped
/// text file handed to the sheet instead of inserting its path.
final class ComposeTextView: NSTextView {
    var onDropFile: ((URL) -> Void)?
    var onCancel: (() -> Void)?

    override var acceptableDragTypes: [NSPasteboard.PasteboardType] {
        let types = super.acceptableDragTypes
        return types.contains(.fileURL) ? types : types + [.fileURL]
    }

    private func file(_ sender: NSDraggingInfo) -> URL? { onDropFile == nil ? nil : droppedDocumentFile(sender) }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if file(sender) != nil { return isEditable ? .copy : [] }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if file(sender) != nil { return isEditable ? .copy : [] }
        return super.draggingUpdated(sender)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if file(sender) != nil { return isEditable }
        return super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let url = file(sender) {
            guard isEditable, let onDropFile else { return false }
            onDropFile(url); return true
        }
        return super.performDragOperation(sender)
    }
    override func cancelOperation(_ sender: Any?) {
        if let onCancel { onCancel() } else { super.cancelOperation(sender) }
    }
}

private final class ProjectsWindow: NSWindow {
    var onCancel: (() -> Void)?
    /// Main-window-only navigation; sheets leave this unset.
    var onBack: (() -> Void)?

    // Accessory apps have no Edit menu to route field-editor shortcuts.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers == .command, let editor = firstResponder as? NSTextView {
            switch event.charactersIgnoringModifiers {
            case "a": editor.selectAll(nil)
            case "c": editor.copy(nil)
            case "x": editor.cut(nil)
            case "v": editor.paste(nil)
            case "z": editor.undoManager?.undo()
            default: return super.performKeyEquivalent(with: event)
            }
            return true
        }
        if modifiers == [.command, .shift], event.charactersIgnoringModifiers?.lowercased() == "z",
           let editor = firstResponder as? NSTextView {
            editor.undoManager?.redo(); return true
        }
        if modifiers == .command, event.charactersIgnoringModifiers == "[", let onBack {
            onBack(); return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        if let onCancel { onCancel() } else { super.cancelOperation(sender) }
    }
    override func otherMouseDown(with event: NSEvent) {
        if event.buttonNumber == 3, let onBack { onBack(); return }
        super.otherMouseDown(with: event)
    }
}

@MainActor
private func sheetWindow(width: CGFloat, height: CGFloat) -> ProjectsWindow {
    let sheet = ProjectsWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                               styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
    sheet.appearance = NSAppearance(named: .darkAqua); sheet.backgroundColor = EchoTheme.ink
    sheet.titlebarAppearsTransparent = true; sheet.titleVisibility = .hidden
    sheet.isReleasedWhenClosed = false
    return sheet
}

/// A single-line borderless field inside a drawn well.
@MainActor
private func boxedField(_ field: NSTextField, in box: FieldBox, placeholder: String, size: CGFloat, weight: NSFont.Weight = .regular) {
    field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
    field.font = .systemFont(ofSize: size, weight: weight); field.textColor = EchoTheme.text
    field.cell?.isScrollable = true; field.cell?.wraps = false; field.maximumNumberOfLines = 1
    field.cell?.sendsActionOnEndEditing = false
    field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: EchoTheme.text.withAlphaComponent(0.5)])
    field.setAccessibilityLabel(placeholder)
    field.translatesAutoresizingMaskIntoConstraints = false
    box.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(field)
    NSLayoutConstraint.activate([
        field.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: size > 16 ? 14 : 12),
        field.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: size > 16 ? -14 : -12),
        field.centerYAnchor.constraint(equalTo: box.centerYAnchor),
    ])
}

// MARK: - Compose sheet

/// A compose entrypoint can seed a project association, but it never seeds an
/// audience. Sharing stays an explicit second-step decision.
enum ComposeTarget: Equatable {
    case onlyMe, team, project(String, String)
    var title: String {
        switch self {
        case .onlyMe: return "Only me"
        case .team: return "Organization"
        case .project(_, let name): return name
        }
    }
    var projectID: String? { if case .project(let id, _) = self { return id }; return nil }
}

private enum ComposeSharing: Equatable {
    case onlyMe, projectMembers, organization
}

/// Write an original, optionally associate it with one or more projects, then
/// explicitly choose its audience. The sent state appears only with a receipt;
/// an unknown outcome stays visible and actionable.
@MainActor
final class ProjectComposeSheet: NSObject, NSTextViewDelegate {
    private enum Page { case content, sharing }

    private let sheet = sheetWindow(width: 560, height: 510)
    private let contentPage = NSView()
    private let sharingPage = NSView()
    private let projectButton = pill("None", .quiet, height: 30, target: nil, action: nil)
    private let projectHint = label("Projects are optional", size: 13, color: EchoTheme.mutedText)
    private let next = pill("Next: Sharing", .primary, height: 34, target: nil, action: nil)
    private let sharingHeading = label("Who can read this?", size: 18, weight: .semibold)
    private let sharingDetail = NSTextField(wrappingLabelWithString: "Choose who can read this upload.")
    private let onlyMe = NSButton(radioButtonWithTitle: "Only me", target: nil, action: nil)
    private let projectMembers = NSButton(radioButtonWithTitle: "Members of selected projects", target: nil, action: nil)
    private let organization = NSButton(radioButtonWithTitle: "Everyone in organization", target: nil, action: nil)
    private let sharingBack = pill("Back", .quiet, height: 34, target: nil, action: nil)
    private let upload = pill("Upload", .primary, height: 34, target: nil, action: nil)
    private let body = ComposeTextView(frame: NSRect(x: 0, y: 0, width: 524, height: 240))
    private let bodyScroll = NSScrollView()
    private let placeholder = PassthroughLabel(labelWithString: "What happened?")
    private let attach = CircleButton(symbol: "paperclip", label: "Attach a document", style: .attach)
    private let problem = label("", size: 12.5, color: EchoTheme.ember)
    private let composeGroup = NSView()
    private let outcome = NSStackView()
    private let outcomeMark = NSImageView()
    private let outcomeTitle = label("", size: 16, weight: .semibold)
    private let outcomeDetail = NSTextField(wrappingLabelWithString: "")
    private let done = pill("Done", .quiet, height: 30, target: nil, action: nil)
    private let check = pill("Check status", .quiet, height: 30, target: nil, action: nil)
    private let retry = pill("Retry same save", .quiet, height: 30, target: nil, action: nil)
    private let another = pill("Write new…", .quiet, height: 30, target: nil, action: nil)
    private let closeButton = pill("Close", .quiet, height: 30, target: nil, action: nil)
    private let sheetClose = CircleButton(symbol: "xmark", label: "Close", style: .close)
    private(set) var target = ComposeTarget.onlyMe
    private var page: Page = .content
    private var sharing = ComposeSharing.onlyMe
    /// Sorted stable identifiers make the request, its receipt matching, and a
    /// later exact retry independent from popover/page arrival order.
    private var selectedProjectIDs: [String] = []
    private var selectedProjectNames: [String: String] = [:]
    // The picker is a separate read session. Pagination must not replace the
    // Home list or the project reader behind this sheet.
    private var pickerProjects: ProjectSession?
    private let pickerPopover = NSPopover()
    private let pickerRows = NSStackView()
    private let pickerMore = pill("More projects", .quiet, height: 28, target: nil, action: nil)
    private let pickerStatus = label("", size: 12.5, color: EchoTheme.mutedText)
    private var loadedFile: DocumentSnapshot?
    private var preparingFile = false
    private var snapshotGeneration = UUID()
    private let attachmentLabel = NSTextField(wrappingLabelWithString: "")
    private let removeFile = pill("Remove file", .quiet, height: 28, target: nil, action: nil)
    private var owns = false
    private var sentBody = false
    private(set) var didSave = false
    private var shownMark = ""
    private var session: UploadSession?
    private var projects: ProjectSession?
    private var admittedIdentity: AccountIdentity?
    // The account changed under this sheet's own save: the outcome text stays
    // on screen (the save may exist) until the person closes the sheet.
    private var strandedStatus: String?
    var onSent: ((ComposeTarget) -> Void)?
    var onWillClose: (() -> Void)?
    var onClose: (() -> Void)?
    var isPresented: Bool { sheet.sheetParent != nil }

    override init() { super.init(); build() }

    func present(over parent: NSWindow, session: UploadSession, projects: ProjectSession, target: ComposeTarget,
                 placeholder text: String, file: URL? = nil) {
        guard !isPresented else { return }
        snapshotGeneration = UUID(); preparingFile = false
        self.session = session; self.projects = projects; admittedIdentity = session.identity
        self.target = target; loadedFile = nil; setBody("")
        page = .content; sharing = .onlyMe; selectedProjectIDs = []; selectedProjectNames = [:]
        if case .project(let id, let name) = target {
            selectedProjectIDs = [id]; selectedProjectNames[id] = name
        }
        placeholder.stringValue = text; problem.stringValue = ""; sentBody = false; didSave = false; strandedStatus = nil
        if session.receipt != nil { session.startAnother() }
        owns = session.recovery != nil && session.receipt == nil
        // Use the same authenticated CLI adapter as the visible controller;
        // a default ProjectSession would point at a different local client.
        let picker = ProjectSession(client: projects.client, foreground: {
            NSApp.isActive || NSApp.windows.contains { $0.attachedSheet != nil }
        })
        picker.onChange = { [weak self] in self?.refresh() }
        pickerProjects = picker
        picker.bind(session.identity)
        refresh()
        parent.beginSheet(sheet)
        sheet.makeFirstResponder(body)
        if let file { load(file) }
    }

    func focusBody() { if isPresented { sheet.makeFirstResponder(body) } }

    func refresh() {
        guard let session else { return }
        // This sheet's own save ended after its account went away (a switch
        // mid-save, or an account check that failed after the save ran).
        if (owns || sentBody), session.identity == nil, session.receipt == nil, !session.hasOutstandingMutation,
           session.status.hasPrefix("The save may have completed") {
            strandedStatus = session.status
        }
        if let admitted = admittedIdentity, admitted != session.identity {
            setBody(""); loadedFile = nil
            if strandedStatus == nil, !session.hasOutstandingMutation, isPresented { closeNow(); return }
        }
        admittedIdentity = session.identity
        // A confirmed receipt this sheet did not produce (an earlier note
        // closed without Done) must not hold the next note: clear it once the
        // session is idle (it can be busy with an identity probe at present).
        if isPresented, !owns, strandedStatus == nil, session.receipt != nil, !session.busy { session.startAnother(); return }
        if let picker = pickerProjects {
            for project in picker.projects { selectedProjectNames[project.project_id] = project.name }
        }
        selectedProjectIDs.sort()
        projectButton.title = projectSelectionTitle
        projectButton.setAccessibilityLabel("Selected projects: \(projectSelectionAccessibility)")
        projectMembers.title = selectedProjectIDs.count == 1
            ? "Members of \(selectedProjectNames[selectedProjectIDs[0]] ?? "selected project")"
            : "Members of \(selectedProjectIDs.count) selected projects"
        sharingDetail.stringValue = sharingScopeSummary
        projectMembers.isHidden = selectedProjectIDs.isEmpty
        if selectedProjectIDs.isEmpty && sharing == .projectMembers { sharing = .onlyMe }
        onlyMe.state = sharing == .onlyMe ? .on : .off
        projectMembers.state = sharing == .projectMembers ? .on : .off
        organization.state = sharing == .organization ? .on : .off
        rebuildProjectPicker()

        let sending = session.hasOutstandingMutation
        sheetClose.isEnabled = !sending
        closeButton.isHidden = true
        let stranded = strandedStatus != nil && !sending
        let sent = !stranded && owns && session.receipt != nil
        let attention = stranded || (!sent && session.recovery != nil && session.receipt == nil && !sending)
        if attention { owns = true }
        composeGroup.isHidden = sent || attention
        outcome.isHidden = !(sent || attention)
        let preparing = preparingFile
        body.isEditable = !preparing && !sending && !sent && !attention
        let hasText = !body.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        attach.isEnabled = !preparing && !sending && body.isEditable
        projectButton.isEnabled = !sending && !preparing && session.canCompose
        next.isEnabled = !preparing && !sending && (hasText || loadedFile != nil) && session.canCompose
        sharingBack.isEnabled = !sending
        upload.isEnabled = !sending && session.canCompose && (sharing != .projectMembers || !selectedProjectIDs.isEmpty)
        onlyMe.isEnabled = !sending; projectMembers.isEnabled = !sending && !selectedProjectIDs.isEmpty; organization.isEnabled = !sending
        contentPage.isHidden = page != .content
        sharingPage.isHidden = page != .sharing
        placeholder.isHidden = !body.string.isEmpty || loadedFile != nil
        bodyScroll.isHidden = loadedFile != nil
        attachmentLabel.isHidden = loadedFile == nil && !preparing; removeFile.isHidden = loadedFile == nil && !preparing
        removeFile.isEnabled = !preparing && !sending
        attachmentLabel.stringValue = loadedFile.map { $0.display + "\nOriginal file will be saved unchanged." }
            ?? (preparing ? "Preparing private copy…" : "")

        if sent, let receipt = session.receipt {
            showMark("checkmark.circle.fill", gold: true)
            outcomeTitle.stringValue = sentTitle(receipt)
            outcomeDetail.stringValue = receipt.contentUnavailable == true ? receipt.message : (receipt.document.map { $0.display + "\n" + $0.stateMessage } ?? "")
            outcomeDetail.isHidden = receipt.document == nil && receipt.contentUnavailable != true
            done.isHidden = false
            for button in [check, retry, another, closeButton] { button.isHidden = true }
            didSave = true
        } else if attention {
            showMark("exclamationmark.circle", gold: false)
            // Say "saved" for a note kept for yourself, "sent" when others get it.
            let kind = session.recovery?.audience.kind ?? (sharing == .onlyMe ? .onlyMe : .projects)
            outcomeTitle.stringValue = kind == .onlyMe ? "This may not have been saved." : "This may not have been sent."
            var detail = strandedStatus ?? session.status
            if let name = session.recovery?.documentFilename, let size = session.recovery?.documentSize {
                detail = name + " · " + ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file) + "\n" + detail
            }
            outcomeDetail.stringValue = detail; outcomeDetail.isHidden = detail.isEmpty
            done.isHidden = true
            // Only offer what can run for this account right now.
            check.isHidden = stranded || session.recovery == nil; check.isEnabled = !session.busy
            retry.isHidden = stranded || !session.canRetry; retry.isEnabled = !session.busy
            another.isHidden = stranded || session.identity == nil; another.isEnabled = !session.busy
            closeButton.isHidden = true; closeButton.isEnabled = false
        }
    }

    private func showMark(_ symbol: String, gold: Bool) {
        guard shownMark != symbol else { return }
        shownMark = symbol
        guard gold else { outcomeMark.image = tintedSymbol(symbol, size: 36, color: EchoTheme.mutedText); return }
        let check = tintedSymbol("checkmark", size: 18, weight: .bold, color: EchoTheme.inkDeep)
        outcomeMark.image = NSImage(size: NSSize(width: 44, height: 44), flipped: false) { rect in
            EchoTheme.gold.setFill(); NSBezierPath(ovalIn: rect).fill()
            if let check {
                let size = check.size
                check.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height))
            }
            return true
        }
    }

    private func sentTitle(_ receipt: UploadReceipt) -> String {
        switch receipt.audience.kind {
        case .onlyMe: return "Saved for you"
        case .team: return "Sent to your organization"
        case .project:
            let id = receipt.audience.project_id
            let name = target.projectID == id ? target.title
                : (projects?.projects.first(where: { $0.project_id == id })?.name
                    ?? (projects?.selected?.project_id == id ? projects?.selected?.name : nil))
            return name.map { "Sent to \($0)" } ?? "Sent to project members"
        case .projects:
            return "Shared with selected project members"
        }
    }

    func projectAccessChanged() {
        guard !selectedProjectIDs.isEmpty else { return }
        snapshotGeneration = UUID(); preparingFile = false; setBody(""); loadedFile = nil
        if session?.hasOutstandingMutation != true {
            if isPresented { closeNow() }
        }
    }

    func accountWillChange() {
        snapshotGeneration = UUID(); preparingFile = false; setBody(""); loadedFile = nil
        pickerProjects?.bind(nil)
        if session?.hasOutstandingMutation != true, isPresented { closeNow() }
        refresh()
    }

    private func setBody(_ text: String) {
        body.string = text
        body.textStorage?.setAttributes(bodyAttributes, range: NSRange(location: 0, length: (text as NSString).length))
        placeholder.isHidden = !text.isEmpty
    }

    private var bodyAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 5
        return [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: EchoTheme.text, .paragraphStyle: paragraph]
    }

    func textDidChange(_ notification: Notification) {
        problem.stringValue = ""
        refresh()
    }

    private func load(_ file: URL) {
        guard body.isEditable, !preparingFile else { return }
        // Attaching never converts or appends bytes to the note editor.
        guard body.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            problem.stringValue = "Send this note before attaching a document."; return
        }
        let generation = UUID(); snapshotGeneration = generation; preparingFile = true
        let identity = admittedIdentity
        problem.stringValue = "Preparing private copy…"; refresh()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let snapshot = try? DocumentSnapshot(file)
            DispatchQueue.main.async {
                guard let self, self.snapshotGeneration == generation, self.isPresented,
                      self.admittedIdentity == identity, self.session?.identity == identity else { return }
                self.preparingFile = false
                self.loadedFile = snapshot
                self.problem.stringValue = snapshot == nil ? "Choose TXT, Markdown, PDF, or DOCX up to 25 MiB." : ""
                self.refresh()
            }
        }
    }
    @objc private func removeAttachment() {
        guard session?.busy != true else { return }
        snapshotGeneration = UUID(); preparingFile = false; loadedFile = nil; refresh()
    }

    private var projectSelectionTitle: String {
        switch selectedProjectIDs.count {
        case 0: return "None"
        case 1: return selectedProjectNames[selectedProjectIDs[0]] ?? "1 project"
        default:
            let first = selectedProjectNames[selectedProjectIDs[0]] ?? "1 project"
            return "\(first) + \(selectedProjectIDs.count - 1)"
        }
    }
    private var projectSelectionAccessibility: String {
        selectedProjectIDs.isEmpty ? "None" : selectedProjectIDs.map { selectedProjectNames[$0] ?? "Selected project" }.joined(separator: ", ")
    }
    private var sharingScopeSummary: String {
        switch selectedProjectIDs.count {
        case 0:
            return "No projects selected. Choose who can read this upload."
        case 1:
            return "Selected project: \(selectedProjectNames[selectedProjectIDs[0]] ?? "Selected project")."
        default:
            let first = selectedProjectNames[selectedProjectIDs[0]] ?? "Selected project"
            return "Selected projects: \(first) + \(selectedProjectIDs.count - 1) more."
        }
    }

    @objc private func showProjectPicker() {
        guard !pickerPopover.isShown, session?.hasOutstandingMutation != true else { return }
        pickerPopover.show(relativeTo: projectButton.bounds, of: projectButton, preferredEdge: .maxY)
    }
    @objc private func chooseNoProjects() {
        guard session?.hasOutstandingMutation != true else { return }
        selectedProjectIDs = []; refresh()
    }
    @objc private func toggleProject(_ sender: NSButton) {
        guard let picker = pickerProjects, picker.projects.indices.contains(sender.tag), session?.hasOutstandingMutation != true else { return }
        let project = picker.projects[sender.tag]
        selectedProjectNames[project.project_id] = project.name
        if let index = selectedProjectIDs.firstIndex(of: project.project_id) { selectedProjectIDs.remove(at: index) }
        else {
            guard selectedProjectIDs.count < 20 else {
                problem.stringValue = "Choose up to 20 projects."; return
            }
            selectedProjectIDs.append(project.project_id); selectedProjectIDs.sort()
        }
        refresh()
    }
    @objc private func morePickerProjects() { pickerProjects?.nextProjects() }
    @objc private func nextSharing() {
        guard next.isEnabled else { return }
        if loadedFile == nil, !ProjectWire.text(body.string, max: 8192, multiline: true) {
            // This is the visible content page. Do not leave an invalid note
            // behind a sharing page where its validation message is hidden.
            problem.stringValue = "Up to 8 KiB of text."
            page = .content; refresh(); return
        }
        pickerPopover.close(); page = .sharing; refresh()
    }
    @objc private func returnToContent() {
        guard session?.hasOutstandingMutation != true else { return }
        page = .content; refresh(); sheet.makeFirstResponder(body)
    }
    @objc private func chooseSharing(_ sender: NSButton) {
        guard session?.hasOutstandingMutation != true else { return }
        switch sender.tag {
        case 0: sharing = .onlyMe
        case 1 where !selectedProjectIDs.isEmpty: sharing = .projectMembers
        case 2: sharing = .organization
        default: return
        }
        refresh()
    }

    @objc private func sendNote() {
        guard page == .sharing, upload.isEnabled, let session, session.canCompose,
              admittedIdentity == session.identity else { return }
        let projectIDs = selectedProjectIDs
        let audienceProjectIDs = sharing == .projectMembers ? projectIDs : []
        let visibility: UploadVisibility
        switch sharing {
        case .onlyMe: visibility = .onlyMe
        case .projectMembers:
            guard !audienceProjectIDs.isEmpty else { page = .content; refresh(); return }
            visibility = .projects
        case .organization: visibility = .team
        }
        if let snapshot = loadedFile {
            let title = suggestedNoteTitle(snapshot.file.deletingPathExtension().lastPathComponent)
            session.submitDocument(title: title, snapshot: snapshot, visibility: visibility,
                                   audienceProjectIDs: audienceProjectIDs, projectIDs: projectIDs)
        } else {
            let text = body.string
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            guard ProjectWire.text(text, max: 8192, multiline: true) else {
                problem.stringValue = "Up to 8 KiB of text."; page = .content; refresh(); return
            }
            let title = suggestedNoteTitle(text)
            session.submit(title: title, text: text, visibility: visibility,
                           audienceProjectIDs: audienceProjectIDs, projectIDs: projectIDs)
        }
        guard session.busy else { problem.stringValue = session.status; page = .content; refresh(); return }
        owns = true; sentBody = true
        onSent?(target)
        refresh()
    }

    @objc private func chooseFile() {
        guard body.isEditable else { return }
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false; picker.allowsMultipleSelection = false; picker.allowedContentTypes = DocumentSnapshot.contentTypes
        picker.beginSheetModal(for: sheet) { [weak self] response in
            guard let self, response == .OK, let file = picker.url else { return }
            self.load(file)
        }
    }

    @objc private func finish() {
        // Start the next note before the parent regains key and refreshes.
        session?.startAnother()
        closeNow()
    }
    @objc private func checkSave() { session?.checkStatus() }
    @objc private func retrySave() { session?.retry() }
    @objc private func writeNew() {
        guard let session, !session.busy else { return }
        let identity = session.identity
        confirm("Start another note?", detail: "The previous save may have completed. Check its status or search first to avoid a duplicate. Continuing removes the local retry copy; it does not delete any saved original in ECHO.",
                action: "Start another note", cancel: "Keep previous save", on: sheet) { [weak self] in
            // Only the recovery this alert was shown for, on the same account.
            guard let self, self.isPresented, let session = self.session, !session.busy, session.identity == identity else { return }
            session.startAnother()
            if self.sentBody { self.setBody(""); self.loadedFile = nil; self.sentBody = false }
            self.page = .content; self.sharing = .onlyMe; self.owns = false; self.refresh()
            self.sheet.makeFirstResponder(self.body)
        }
    }

    @objc private func requestClose() {
        guard session?.hasOutstandingMutation != true else { return }
        let hasUnsentDraft = !body.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || loadedFile != nil
        let needsDiscardConfirmation = hasUnsentDraft && session?.receipt == nil && session?.recovery == nil
        guard needsDiscardConfirmation else { closeNow(); return }
        confirm("Discard this note?", detail: "", action: "Discard", cancel: "Keep writing", on: sheet) { [weak self] in
            self?.closeNow()
        }
    }

    private func closeNow() {
        guard session?.hasOutstandingMutation != true, let parent = sheet.sheetParent else { return }
        // A confirm alert or file panel never outlives the sheet it belongs to.
        if let child = sheet.attachedSheet { sheet.endSheet(child, returnCode: .cancel) }
        pickerPopover.close()
        pickerProjects?.conceal()
        // Leaving a confirmed "Sent" any way (Escape, app switch) is Done:
        // the receipt is settled, so the next note starts clean.
        if owns, let session, session.receipt != nil, !session.busy { session.startAnother() }
        snapshotGeneration = UUID(); preparingFile = false; strandedStatus = nil; loadedFile = nil
        onWillClose?()
        parent.endSheet(sheet)
        onClose?()
    }

    private func build() {
        guard let root = sheet.contentView else { return }
        sheet.onCancel = { [weak self] in self?.requestClose() }
        let projectsLabel = label("Projects", size: 13, color: EchoTheme.faintText)
        mark(projectButton, "compose-projects", label: "Selected projects")
        projectButton.target = self; projectButton.action = #selector(showProjectPicker)
        mark(next, "compose-next-sharing", label: "Next: Sharing"); next.target = self; next.action = #selector(nextSharing)
        mark(sharingBack, "compose-sharing-back", label: "Back to content"); sharingBack.target = self; sharingBack.action = #selector(returnToContent)
        mark(upload, "compose-upload", label: "Upload"); upload.target = self; upload.action = #selector(sendNote)
        for (index, control) in [onlyMe, projectMembers, organization].enumerated() {
            control.tag = index; control.target = self; control.action = #selector(chooseSharing(_:))
        }
        mark(onlyMe, "compose-sharing-only-me", label: "Only me")
        mark(projectMembers, "compose-sharing-projects", label: "Members of selected projects")
        mark(organization, "compose-sharing-organization", label: "Everyone in organization")
        sharingDetail.font = .systemFont(ofSize: 13); sharingDetail.textColor = EchoTheme.mutedText; sharingDetail.maximumNumberOfLines = 2

        body.isRichText = false; body.importsGraphics = false; body.allowsUndo = true
        body.isAutomaticQuoteSubstitutionEnabled = false; body.isAutomaticDashSubstitutionEnabled = false
        body.isAutomaticTextReplacementEnabled = false; body.isAutomaticSpellingCorrectionEnabled = false
        body.drawsBackground = false; body.insertionPointColor = EchoTheme.gold
        body.textContainerInset = .zero; body.textContainer?.lineFragmentPadding = 0
        body.minSize = .zero; body.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        body.isVerticallyResizable = true; body.isHorizontallyResizable = false; body.autoresizingMask = [.width]
        body.textContainer?.widthTracksTextView = true
        body.textContainer?.containerSize = NSSize(width: 524, height: CGFloat.greatestFiniteMagnitude)
        body.typingAttributes = bodyAttributes
        body.defaultParagraphStyle = bodyAttributes[.paragraphStyle] as? NSParagraphStyle
        body.font = .systemFont(ofSize: 16); body.textColor = EchoTheme.text
        body.delegate = self
        mark(body, "compose-body", label: "Original note text")
        body.onDropFile = { [weak self] url in self?.load(url) }
        body.onCancel = { [weak self] in self?.requestClose() }
        body.registerForDraggedTypes([.fileURL])
        bodyScroll.documentView = body; bodyScroll.drawsBackground = false
        bodyScroll.hasVerticalScroller = true; bodyScroll.autohidesScrollers = true; bodyScroll.borderType = .noBorder
        placeholder.font = .systemFont(ofSize: 16); placeholder.textColor = EchoTheme.faintText

        mark(attach, "compose-attach", label: "Attach a document")
        attach.target = self; attach.action = #selector(chooseFile)
        problem.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        mark(attachmentLabel, "compose-document", label: "Attached original document")
        attachmentLabel.font = .systemFont(ofSize: 15); attachmentLabel.textColor = EchoTheme.text
        removeFile.target = self; removeFile.action = #selector(removeAttachment); mark(removeFile, "compose-remove-file")
        for view in [projectsLabel, projectButton, projectHint, bodyScroll, placeholder, attach, problem, attachmentLabel, removeFile, next] {
            view.translatesAutoresizingMaskIntoConstraints = false; contentPage.addSubview(view)
        }
        for view in [sharingHeading, sharingDetail, onlyMe, projectMembers, organization, sharingBack, upload] {
            view.translatesAutoresizingMaskIntoConstraints = false; sharingPage.addSubview(view)
        }

        mark(done, "compose-done"); done.target = self; done.action = #selector(finish)
        mark(check, "compose-check"); check.target = self; check.action = #selector(checkSave)
        mark(retry, "compose-retry"); retry.target = self; retry.action = #selector(retrySave)
        mark(another, "compose-new"); another.target = self; another.action = #selector(writeNew)
        mark(closeButton, "compose-close"); closeButton.target = self; closeButton.action = #selector(requestClose)
        mark(sheetClose, "sheet-close", label: "Close"); sheetClose.target = self; sheetClose.action = #selector(requestClose)
        outcomeMark.imageScaling = .scaleNone
        outcomeMark.translatesAutoresizingMaskIntoConstraints = false
        outcomeMark.widthAnchor.constraint(equalToConstant: 44).isActive = true
        outcomeMark.heightAnchor.constraint(equalToConstant: 44).isActive = true
        outcomeDetail.font = .systemFont(ofSize: 12.5); outcomeDetail.textColor = EchoTheme.faintText; outcomeDetail.alignment = .center
        outcomeDetail.preferredMaxLayoutWidth = 420
        let recovery = NSStackView(views: [check, retry, another, closeButton])
        recovery.orientation = .horizontal; recovery.spacing = 8
        outcome.orientation = .vertical; outcome.alignment = .centerX; outcome.spacing = 12
        for view in [outcomeMark, outcomeTitle, outcomeDetail, done, recovery] { outcome.addArrangedSubview(view) }
        outcome.setCustomSpacing(18, after: outcomeDetail)

        composeGroup.translatesAutoresizingMaskIntoConstraints = false
        outcome.translatesAutoresizingMaskIntoConstraints = false
        composeGroup.addSubview(contentPage); composeGroup.addSubview(sharingPage)
        root.addSubview(composeGroup); root.addSubview(outcome); root.addSubview(sheetClose)
        sheetClose.translatesAutoresizingMaskIntoConstraints = false
        contentPage.translatesAutoresizingMaskIntoConstraints = false; sharingPage.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            composeGroup.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            composeGroup.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            composeGroup.topAnchor.constraint(equalTo: root.topAnchor, constant: 54),
            composeGroup.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
            outcome.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            outcome.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            outcome.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            sheetClose.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            sheetClose.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            sheetClose.widthAnchor.constraint(equalToConstant: 28), sheetClose.heightAnchor.constraint(equalToConstant: 28),

            contentPage.leadingAnchor.constraint(equalTo: composeGroup.leadingAnchor), contentPage.trailingAnchor.constraint(equalTo: composeGroup.trailingAnchor),
            contentPage.topAnchor.constraint(equalTo: composeGroup.topAnchor), contentPage.bottomAnchor.constraint(equalTo: composeGroup.bottomAnchor),
            sharingPage.leadingAnchor.constraint(equalTo: composeGroup.leadingAnchor), sharingPage.trailingAnchor.constraint(equalTo: composeGroup.trailingAnchor),
            sharingPage.topAnchor.constraint(equalTo: composeGroup.topAnchor), sharingPage.bottomAnchor.constraint(equalTo: composeGroup.bottomAnchor),

            projectsLabel.leadingAnchor.constraint(equalTo: contentPage.leadingAnchor),
            projectsLabel.centerYAnchor.constraint(equalTo: projectButton.centerYAnchor),
            projectButton.leadingAnchor.constraint(equalTo: projectsLabel.trailingAnchor, constant: 10),
            projectButton.topAnchor.constraint(equalTo: contentPage.topAnchor),
            projectHint.leadingAnchor.constraint(equalTo: projectButton.trailingAnchor, constant: 10),
            projectHint.centerYAnchor.constraint(equalTo: projectButton.centerYAnchor),
            projectHint.trailingAnchor.constraint(lessThanOrEqualTo: contentPage.trailingAnchor),
            attachmentLabel.leadingAnchor.constraint(equalTo: contentPage.leadingAnchor),
            attachmentLabel.trailingAnchor.constraint(equalTo: contentPage.trailingAnchor),
            attachmentLabel.topAnchor.constraint(equalTo: projectButton.bottomAnchor, constant: 24),
            removeFile.leadingAnchor.constraint(equalTo: attachmentLabel.leadingAnchor),
            removeFile.topAnchor.constraint(equalTo: attachmentLabel.bottomAnchor, constant: 16),
            bodyScroll.leadingAnchor.constraint(equalTo: contentPage.leadingAnchor),
            bodyScroll.trailingAnchor.constraint(equalTo: contentPage.trailingAnchor),
            bodyScroll.topAnchor.constraint(equalTo: projectButton.bottomAnchor, constant: 14),
            bodyScroll.bottomAnchor.constraint(equalTo: next.topAnchor, constant: -14),
            placeholder.leadingAnchor.constraint(equalTo: bodyScroll.leadingAnchor),
            placeholder.topAnchor.constraint(equalTo: bodyScroll.topAnchor),

            attach.leadingAnchor.constraint(equalTo: contentPage.leadingAnchor),
            attach.bottomAnchor.constraint(equalTo: contentPage.bottomAnchor),
            attach.widthAnchor.constraint(equalToConstant: 34), attach.heightAnchor.constraint(equalToConstant: 34),
            problem.leadingAnchor.constraint(equalTo: attach.trailingAnchor, constant: 10),
            problem.centerYAnchor.constraint(equalTo: attach.centerYAnchor),
            problem.trailingAnchor.constraint(lessThanOrEqualTo: next.leadingAnchor, constant: -10),
            next.trailingAnchor.constraint(equalTo: contentPage.trailingAnchor), next.bottomAnchor.constraint(equalTo: contentPage.bottomAnchor),
            next.widthAnchor.constraint(equalToConstant: 124),

            sharingHeading.leadingAnchor.constraint(equalTo: sharingPage.leadingAnchor),
            sharingHeading.topAnchor.constraint(equalTo: sharingPage.topAnchor, constant: 8),
            sharingDetail.leadingAnchor.constraint(equalTo: sharingPage.leadingAnchor), sharingDetail.trailingAnchor.constraint(equalTo: sharingPage.trailingAnchor),
            sharingDetail.topAnchor.constraint(equalTo: sharingHeading.bottomAnchor, constant: 8),
            onlyMe.leadingAnchor.constraint(equalTo: sharingPage.leadingAnchor), onlyMe.topAnchor.constraint(equalTo: sharingDetail.bottomAnchor, constant: 26),
            projectMembers.leadingAnchor.constraint(equalTo: sharingPage.leadingAnchor), projectMembers.topAnchor.constraint(equalTo: onlyMe.bottomAnchor, constant: 14),
            organization.leadingAnchor.constraint(equalTo: sharingPage.leadingAnchor), organization.topAnchor.constraint(equalTo: projectMembers.bottomAnchor, constant: 14),
            sharingBack.leadingAnchor.constraint(equalTo: sharingPage.leadingAnchor), sharingBack.bottomAnchor.constraint(equalTo: sharingPage.bottomAnchor),
            upload.trailingAnchor.constraint(equalTo: sharingPage.trailingAnchor), upload.bottomAnchor.constraint(equalTo: sharingPage.bottomAnchor), upload.widthAnchor.constraint(equalToConstant: 96),
        ])
        buildProjectPicker()
    }

    private func buildProjectPicker() {
        pickerPopover.behavior = .transient
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 340))
        let heading = label("Add to projects", size: 15, weight: .semibold)
        let none = pill("None", .quiet, height: 28, target: self, action: #selector(chooseNoProjects))
        mark(none, "compose-project-none", label: "No projects")
        pickerRows.orientation = .vertical; pickerRows.alignment = .leading; pickerRows.spacing = 3
        let scroll = NSScrollView(); scroll.documentView = pickerRows; scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        for view in [heading, none, scroll, pickerStatus, pickerMore] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        mark(pickerMore, "compose-more-projects", label: "More projects"); pickerMore.target = self; pickerMore.action = #selector(morePickerProjects)
        NSLayoutConstraint.activate([
            heading.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14), heading.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            none.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14), none.centerYAnchor.constraint(equalTo: heading.centerYAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10), scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            scroll.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 12), scroll.bottomAnchor.constraint(equalTo: pickerStatus.topAnchor, constant: -8),
            pickerStatus.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14), pickerStatus.trailingAnchor.constraint(equalTo: pickerMore.leadingAnchor, constant: -8), pickerStatus.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
            pickerMore.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14), pickerMore.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -10),
        ])
        pickerPopover.contentViewController = NSViewController(); pickerPopover.contentViewController?.view = root
    }

    private func rebuildProjectPicker() {
        guard pickerPopover.contentViewController != nil else { return }
        for row in pickerRows.arrangedSubviews { pickerRows.removeArrangedSubview(row); row.removeFromSuperview() }
        guard let picker = pickerProjects else { return }
        for (index, project) in picker.projects.enumerated() {
            let row = NSButton(checkboxWithTitle: project.name, target: self, action: #selector(toggleProject(_:)))
            row.tag = index; row.state = selectedProjectIDs.contains(project.project_id) ? .on : .off
            row.translatesAutoresizingMaskIntoConstraints = false; row.heightAnchor.constraint(equalToConstant: 28).isActive = true
            mark(row, "compose-project-\(project.project_id)", label: "Project \(project.name)")
            pickerRows.addArrangedSubview(row)
        }
        pickerRows.frame = NSRect(x: 0, y: 0, width: 330, height: max(28, pickerRows.fittingSize.height))
        pickerMore.isHidden = picker.listCursor == nil
        pickerMore.isEnabled = !picker.busy
        pickerStatus.stringValue = picker.busy ? "Loading projects…"
            : (picker.projects.isEmpty ? (picker.status.isEmpty ? "No available projects." : picker.status) : "")
    }
}

// MARK: - People sheet

/// The project's people. Leads manage membership; members only see it.
@MainActor
final class ProjectPeopleSheet: NSObject {
    private let sheet = sheetWindow(width: 380, height: 480)
    private let list = ColumnStackView()
    private lazy var scroll = listScroll(list)
    private let addBox = FieldBox(stroke: EchoTheme.border, radius: 8)
    private let addField = NSTextField()
    private let sheetClose = CircleButton(symbol: "xmark", label: "Close", style: .close)
    private let notice = NSTextField(wrappingLabelWithString: "")
    private var toBottom: NSLayoutConstraint?
    private var toField: NSLayoutConstraint?
    private var projects: ProjectSession?
    private var rosterGeneration: Int?
    private var shownCandidate: String?
    private var didLoadDirectory = false
    private var signature = ""
    private(set) var isPresented = false
    var onWillClose: (() -> Void)?
    var onClose: (() -> Void)?

    override init() { super.init(); build() }

    func present(over parent: NSWindow, projects: ProjectSession) {
        guard !isPresented, projects.selected != nil else { return }
        self.projects = projects; isPresented = true; signature = ""; shownCandidate = nil; didLoadDirectory = false
        addField.stringValue = ""
        rosterGeneration = projects.scopeGeneration
        projects.roster()
        refresh()
        parent.beginSheet(sheet)
    }

    func clearQuery() { addField.stringValue = "" }

    func refresh() {
        guard isPresented, let projects else { return }
        // Re-opening after a change passes through "idle, nothing selected"
        // synchronously; only close if that is still true a turn later.
        guard projects.busy || projects.selected != nil else {
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(closeIfLost), object: nil)
            perform(#selector(closeIfLost), with: nil, afterDelay: 0)
            return
        }
        // A membership change re-opens the project, which clears members.
        if !projects.busy, projects.selected != nil, projects.members.isEmpty, projects.scopeGeneration != rosterGeneration {
            rosterGeneration = projects.scopeGeneration
            projects.roster()
            return
        }
        let lead = projects.selected?.role == "lead"
        let manage = projects.canManage
        if lead, !projects.busy, !didLoadDirectory {
            didLoadDirectory = true
            projects.directory()
            return
        }
        addBox.isHidden = !lead
        addField.isEnabled = manage
        toField?.isActive = lead; toBottom?.isActive = !lead
        notice.stringValue = projects.notice; notice.isHidden = projects.notice.isEmpty
        sheetClose.isEnabled = !projects.hasOutstandingMutation

        let viewer = projects.identity?.membershipID
        let key = [String(lead), String(manage), String(projects.memberCursor != nil), String(projects.directoryCursor != nil), viewer ?? ""]
            + projects.members.map { "\($0.membership_id)|\($0.display_name)|\($0.role ?? "")" }
            + ["--"] + candidates(projects).map { "\($0.membership_id)|\($0.display_name)" }
        let joined = key.joined(separator: "\n")
        guard joined != signature else { return }
        signature = joined
        var rows: [ColumnStackView.Row] = []
        for member in projects.members {
            var menuButton: IconButton?
            // Your own row has no "…": leads manage other people.
            if lead, member.membership_id != viewer {
                let button = IconButton(symbol: "ellipsis", label: "More for \(member.display_name)", size: 13)
                button.round = true; button.isEnabled = manage
                button.widthAnchor.constraint(equalToConstant: 28).isActive = true
                button.heightAnchor.constraint(equalToConstant: 28).isActive = true
                button.menuProvider = { [weak self] in self?.menu(for: member) }
                menuButton = button
            }
            rows.append(.init(view: PersonRowView(name: member.display_name, id: member.membership_id, isLead: member.role == "lead",
                                                  leadChip: false, fontSize: 14, trailing: menuButton), height: 44))
        }
        if projects.memberCursor != nil {
            let more = PillButton(title: "More", target: self, action: #selector(moreMembers))
            more.style = .quiet
            rows.append(.init(view: more, height: 30, centered: true, gap: 10))
        }
        if lead {
            for (index, person) in candidates(projects).enumerated() {
                let add = pill("Add", .quiet, height: 30, target: self, action: #selector(addCandidate(_:)))
                add.tag = index; add.isEnabled = manage
                add.setAccessibilityLabel("Add \(person.display_name)")
                rows.append(.init(view: PersonRowView(name: person.display_name, id: person.membership_id, isLead: false,
                                                      leadChip: false, fontSize: 14, trailing: add), height: 44, gap: index == 0 ? 10 : 0))
            }
            if projects.directoryCursor != nil {
                let more = PillButton(title: "More people", target: self, action: #selector(morePeople))
                more.style = .quiet; more.isEnabled = manage
                rows.append(.init(view: more, height: 30, centered: true, gap: 10))
            }
        }
        list.set(rows)
        // Directory results land under the roster; bring them into view.
        let candidateRows = candidates(projects)
        if lead, let first = candidateRows.first, first.membership_id != shownCandidate {
            let top = rows.dropLast(candidateRows.count).reduce(CGFloat(0)) { $0 + $1.gap + $1.height }
            scroll.layoutSubtreeIfNeeded()
            list.scrollToVisible(NSRect(x: 0, y: top, width: 1, height: min(scroll.contentSize.height, list.frame.height - top)))
        }
        shownCandidate = lead ? candidateRows.first?.membership_id : nil
    }

    private func menu(for member: ProjectMember) -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        let promote = member.role != "lead"
        let role = NSMenuItem(title: promote ? "Make lead" : "Make member", action: #selector(changeRole(_:)), keyEquivalent: "")
        role.target = self; role.representedObject = member.membership_id; role.isEnabled = projects?.canManage == true
        // Plain title: a custom colour stays put on the selection highlight.
        // The confirm alert names the removal.
        let remove = NSMenuItem(title: "Remove from project", action: #selector(removeMember(_:)), keyEquivalent: "")
        remove.target = self; remove.representedObject = member.membership_id; remove.isEnabled = projects?.canManage == true
        menu.addItem(role); menu.addItem(.separator()); menu.addItem(remove)
        return menu
    }

    private func member(_ sender: NSMenuItem) -> ProjectMember? {
        guard let id = sender.representedObject as? String else { return nil }
        return projects?.members.first(where: { $0.membership_id == id })
    }

    /// A confirmed change applies only to the project (and open) it was
    /// shown for; a late confirm never lands on another project.
    private func confirmed(_ apply: @escaping (ProjectSession) -> Void) -> () -> Void {
        let project = projects?.selected?.project_id, generation = projects?.authorizationGeneration
        return { [weak self] in
            guard let self, self.isPresented, let projects = self.projects, project != nil,
                  projects.selected?.project_id == project, projects.authorizationGeneration == generation else { return }
            apply(projects)
        }
    }

    @objc private func changeRole(_ sender: NSMenuItem) {
        guard let person = member(sender) else { return }
        let role = person.role == "lead" ? "member" : "lead"
        confirm("Make \(person.display_name) a \(role)?", detail: "Leads manage who is in the project.",
                action: role == "lead" ? "Make lead" : "Make member", on: sheet,
                apply: confirmed { $0.setMember(person.membership_id, role: role) })
    }

    @objc private func removeMember(_ sender: NSMenuItem) {
        guard let person = member(sender) else { return }
        confirm("Remove \(person.display_name)?", detail: "They lose access through this project.", action: "Remove", on: sheet,
                apply: confirmed { $0.removeMember(person.membership_id) })
    }

    @objc private func addCandidate(_ sender: NSButton) {
        guard let projects, candidates(projects).indices.contains(sender.tag) else { return }
        let person = candidates(projects)[sender.tag]
        confirm("Add \(person.display_name)?", detail: "They'll see what's shared with this project.", action: "Add", on: sheet,
                apply: confirmed { $0.addMember(person.membership_id) })
    }

    @objc private func findPeople() {
        let query = addField.stringValue
        projects?.directory(query)
    }

    @objc private func moreMembers() { projects?.nextMembers() }

    @objc private func morePeople() { projects?.nextDirectory() }

    private func candidates(_ projects: ProjectSession) -> [ProjectMember] {
        let memberIDs = Set(projects.members.map(\.membership_id))
        // A directory read and a member change can cross. Excluding a row
        // already on the roster prevents a stale add from changing its role.
        return projects.candidates.filter { !memberIDs.contains($0.membership_id) }
    }

    @objc private func closeIfLost() {
        guard isPresented, let projects, !projects.busy, projects.selected == nil else { return }
        close()
    }

    @objc func close() {
        guard isPresented, projects?.hasOutstandingMutation != true else { return }
        // A confirm alert never outlives the sheet it belongs to.
        if let child = sheet.attachedSheet { sheet.endSheet(child, returnCode: .cancel) }
        isPresented = false; signature = ""
        onWillClose?()
        if let parent = sheet.sheetParent { parent.endSheet(sheet) }
        onClose?()
    }

    private func build() {
        guard let root = sheet.contentView else { return }
        sheet.onCancel = { [weak self] in self?.close() }
        let heading = label("People", size: 17, weight: .semibold)
        mark(sheetClose, "sheet-close", label: "Close"); sheetClose.target = self; sheetClose.action = #selector(close)
        boxedField(addField, in: addBox, placeholder: "Find people by name", size: 14)
        mark(addField, "people-add-field", label: "Find people by name")
        addField.target = self; addField.action = #selector(findPeople)
        notice.font = .systemFont(ofSize: 12.5); notice.textColor = EchoTheme.faintText
        for view in [heading, sheetClose, scroll, notice, addBox] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        toField = notice.bottomAnchor.constraint(equalTo: addBox.topAnchor, constant: -10)
        toBottom = notice.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20)
        NSLayoutConstraint.activate([
            sheetClose.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            sheetClose.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            sheetClose.widthAnchor.constraint(equalToConstant: 28), sheetClose.heightAnchor.constraint(equalToConstant: 28),
            heading.leadingAnchor.constraint(equalTo: sheetClose.trailingAnchor, constant: 10),
            heading.centerYAnchor.constraint(equalTo: sheetClose.centerYAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            scroll.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 14),
            scroll.bottomAnchor.constraint(equalTo: notice.topAnchor, constant: -8),
            notice.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            notice.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            addBox.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            addBox.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            addBox.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
            addBox.heightAnchor.constraint(equalToConstant: 36),
        ])
        toField?.isActive = true
    }
}

// MARK: - New project sheet

/// Name first; people and files only once the project exists, because the
/// directory is project-scoped. Files save one at a time, each with a receipt.
@MainActor
final class ProjectCreateSheet: NSObject, NSTextFieldDelegate {
    private enum FileState: String { case preparing, queued, saving, saved, uncertain, failed, notStarted, skipped }
    private struct QueuedFile { let name: String; let title: String; var snapshot: DocumentSnapshot?; var state: FileState; var detail: String }

    private let sheet = sheetWindow(width: 560, height: 540)
    private let nameBox = FieldBox(stroke: EchoTheme.gold, radius: 10)
    private let nameField = NSTextField()
    private let nameLabel = label("", size: 20, weight: .semibold)
    private let people = ColumnStackView()
    private lazy var peopleScroll = listScroll(people)
    private let addBox = FieldBox(stroke: EchoTheme.border, radius: 8)
    private let addField = NSTextField()
    private let fileList = ColumnStackView()
    private lazy var fileScroll = listScroll(fileList)
    private let filesBox = DashedBox()
    private var peopleHeight: NSLayoutConstraint?
    private var fileHeight: NSLayoutConstraint?
    private var fileGap: NSLayoutConstraint?
    private var groupBottoms: [NSLayoutConstraint] = []
    private let addFiles = pill("Add files…", .quiet, height: 30, target: nil, action: nil)
    private let finishFirst = label("Finish the last save first.", size: 12.5, color: EchoTheme.faintText)
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let sheetClose = CircleButton(symbol: "xmark", label: "Close", style: .close)
    private let cancel = pill("Cancel", .quiet, height: 34, target: nil, action: nil)
    private let submit = pill("Create", .primary, height: 34, target: nil, action: nil)
    private let done = pill("Done", .primary, height: 34, target: nil, action: nil)
    private let first = NSView()
    private let second = NSView()
    private var projects: ProjectSession?
    private var uploads: UploadSession?
    private var project: ProjectSummary?
    private var admittedIdentity: AccountIdentity?
    private var awaitingCreate = false
    private var createdFrom: String?
    // The session's confirmed-create id before this sheet's Create, so only a
    // receipt for *this* create counts as "created".
    private var createdBefore: String?
    private var createdNotOpened: String?
    /// A Create pressed during a read reload is retained and starts only after
    /// that read ends. Mutations, recovery, and lost access never queue it.
    private var queuedCreate: String?
    private var closeRequested = false
    private var focusAdd = false
    private var files: [QueuedFile] = []
    private var pumping = false
    private let snapshotQueue = DispatchQueue(label: "org.echobrain.echo.project-document-snapshots", qos: .userInitiated)
    private var snapshotGeneration = UUID()
    private var peopleSignature = ""
    private var didLoadRoster = false
    private var didLoadDirectory = false
    private var fileSignature = ""
    private var fileProblem = ""
    private(set) var isPresented = false
    var onCreated: ((ProjectSummary) -> Void)?
    var onWillClose: (() -> Void)?
    var onClose: (() -> Void)?

    override init() { super.init(); build() }

    /// Only a running change or save keeps the sheet open. A queue that
    /// stopped behind an unconfirmed file is not in flight.
    private var inFlight: Bool {
        projects?.hasOutstandingMutation == true || uploads?.hasOutstandingMutation == true
            || (uploads?.busy == true && files.contains { $0.state == .saving })
    }
    /// Files that were not, or may not have been, saved.
    var unsavedFiles: Int { files.filter { $0.state != .saved }.count }
    /// "name:state" per queued file, in order (proofs and the render harness).
    var fileStates: [String] { files.map { "\($0.name):\($0.state.rawValue)" } }

    func present(over parent: NSWindow, projects: ProjectSession, uploads: UploadSession) {
        guard !isPresented else { return }
        self.projects = projects; self.uploads = uploads; admittedIdentity = uploads.identity
        project = nil; files = []; awaitingCreate = false; createdFrom = nil; createdBefore = nil; createdNotOpened = nil; queuedCreate = nil
        closeRequested = false; focusAdd = false
        didLoadRoster = false; didLoadDirectory = false
        peopleSignature = ""; fileSignature = ""; fileProblem = ""; addField.stringValue = ""
        if case .create(let name, _) = projects.pending { nameField.stringValue = name } else { nameField.stringValue = "" }
        isPresented = true
        refresh()
        parent.beginSheet(sheet)
        sheet.makeFirstResponder(nameField)
    }

    /// Closes now, or as soon as nothing is running. No new save starts
    /// meanwhile (concealment and account changes).
    func closeWhenIdle() {
        guard isPresented else { return }
        closeRequested = true; snapshotGeneration = UUID()
        if inFlight { refresh() } else { close() }
    }
    func clearQuery() { addField.stringValue = "" }

    /// Queues background private disk snapshots for sequential saves. Each
    /// completion is fenced to this sheet, account, project and selection.
    func queueFiles(_ urls: [URL]) {
        guard isPresented, project != nil, !closeRequested else { return }
        guard urls.count <= 20 - files.count else { fileProblem = "Add up to 20 documents in this project setup."; refresh(); return }
        fileProblem = ""
        let generation = snapshotGeneration, identity = admittedIdentity, projectID = project?.project_id
        for url in urls {
            let index = files.count
            files.append(QueuedFile(name: url.lastPathComponent, title: suggestedNoteTitle(url.deletingPathExtension().lastPathComponent),
                                    snapshot: nil, state: .preparing, detail: "Preparing private copy…"))
            snapshotQueue.async { [weak self] in
                let snapshot = try? DocumentSnapshot(url)
                DispatchQueue.main.async {
                    guard let self, self.snapshotGeneration == generation, self.isPresented, !self.closeRequested,
                          self.admittedIdentity == identity, self.project?.project_id == projectID,
                          self.files.indices.contains(index), self.files[index].state == .preparing else { return }
                    self.files[index].snapshot = snapshot
                    self.files[index].state = snapshot == nil ? .failed : .queued
                    self.files[index].detail = snapshot?.display ?? "Unsupported file or over 25 MiB"
                    self.refresh()
                }
            }
        }
        refresh()
    }

    func refresh() {
        guard isPresented, let projects, let uploads else { return }
        // Another account, or none: the old account's names go, nothing more
        // starts, and the sheet closes once nothing is running.
        if let admitted = admittedIdentity, admitted != uploads.identity {
            admittedIdentity = nil; closeRequested = true; snapshotGeneration = UUID(); nameLabel.stringValue = ""
        }
        if awaitingCreate, let selected = projects.selected, selected.project_id != createdFrom {
            awaitingCreate = false; createdNotOpened = nil; project = selected
            onCreated?(selected)
            focusAdd = true
        }
        if let selected = projects.selected, selected.project_id == project?.project_id { project = selected }
        if let queued = queuedCreate, project == nil {
            if projects.canMutate { queuedCreate = nil; startCreate(queued, projects); return }
            if !canQueueCreate(projects) { queuedCreate = nil }
        }
        pump()
        if closeRequested && !inFlight { close(); return }
        sheetClose.isEnabled = !inFlight
        first.isHidden = project != nil
        second.isHidden = project == nil
        notice.stringValue = fileProblem.isEmpty ? projects.notice : fileProblem; notice.isHidden = notice.stringValue.isEmpty
        guard let project else {
            // A receipt confirmed the create but the new project did not open:
            // never offer a second Create (it would make a duplicate project).
            if awaitingCreate, !projects.busy, projects.selected == nil,
               let created = projects.createdProjectID, created != createdBefore {
                createdNotOpened = created
            }
            if createdNotOpened != nil {
                submit.title = "Open"; submit.isEnabled = !projects.busy && !projects.hasOutstandingMutation && projects.identity != nil
                nameField.isEnabled = false; cancel.title = "Close"; cancel.isEnabled = !projects.hasOutstandingMutation
                notice.stringValue = "Created, but it did not open."; notice.isHidden = false
            } else {
                let pendingCreate: Bool = { if case .create = projects.pending { return true }; return false }()
                submit.title = pendingCreate ? "Retry" : (queuedCreate == nil ? "Create" : "Creating when ready…")
                submit.isEnabled = pendingCreate ? !projects.busy : (queuedCreate == nil && ProjectWire.text(normalizedName, max: 200) && (projects.canMutate || canQueueCreate(projects)))
                nameField.isEnabled = !projects.hasOutstandingMutation && !pendingCreate && queuedCreate == nil
                cancel.title = "Cancel"; cancel.isEnabled = !projects.hasOutstandingMutation
            }
            fitHeight()
            return
        }
        if admittedIdentity != nil { nameLabel.stringValue = project.name }
        let lead = admittedIdentity != nil && projects.selected?.role == "lead"
        let saving = inFlight
        if lead, !projects.busy, !didLoadRoster {
            didLoadRoster = true
            projects.roster()
            return
        }
        if lead, !projects.busy, didLoadRoster, !didLoadDirectory {
            didLoadDirectory = true
            projects.directory()
            return
        }
        addBox.isHidden = !lead
        // Directory reads guard themselves; keep the field (and its focus)
        // steady through the post-create loads.
        addField.isEnabled = lead && !saving
        let unreconciled = uploads.recovery != nil && uploads.receipt == nil
        let blocked = unreconciled && files.isEmpty
        addFiles.isHidden = blocked; finishFirst.isHidden = !blocked
        addFiles.isEnabled = !files.contains { [.preparing, .queued, .saving, .uncertain].contains($0.state) } && uploads.identity != nil
            && !projects.busy && !closeRequested
        done.isEnabled = !inFlight
        renderPeople(lead: lead, manage: projects.canManage && !saving)
        renderFiles(uploads)
        fitHeight()
        if focusAdd, !addBox.isHidden, addField.isEnabled {
            focusAdd = false; sheet.makeFirstResponder(addField)
        }
    }

    /// The name step is one field; the next step sizes to what it holds (the
    /// files well hugs its rows). The top edge stays put while attached.
    private func fitHeight() {
        let named = project == nil
        let group = named ? first : second
        let height: CGFloat = named ? 164 : ceil(28 + group.fittingSize.height + 22)
        let frame = sheet.frame
        guard abs(frame.height - height) > 0.5 || groupBottoms[named ? 0 : 1].isActive == false else { return }
        NSLayoutConstraint.deactivate(groupBottoms)
        sheet.setFrame(NSRect(x: frame.minX, y: frame.maxY - height, width: frame.width, height: height), display: true)
        groupBottoms[named ? 0 : 1].isActive = true
    }

    private var normalizedName: String {
        nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
    }

    private func renderPeople(lead: Bool, manage: Bool) {
        guard let projects else { return }
        let members = admittedIdentity == nil ? [] : projects.members
        let memberIDs = Set(members.map(\.membership_id))
        let candidates = lead ? projects.candidates.filter { !memberIDs.contains($0.membership_id) } : []
        let key = ([String(lead), String(manage)] + members.map { "\($0.membership_id)|\($0.display_name)|\($0.role ?? "")" }
            + ["--"] + candidates.map { "\($0.membership_id)|\($0.display_name)" }).joined(separator: "\n")
        guard key != peopleSignature else { return }
        peopleSignature = key
        var rows: [ColumnStackView.Row] = members.map {
            .init(view: PersonRowView(name: $0.display_name, id: $0.membership_id, isLead: $0.role == "lead", leadChip: true,
                                      fontSize: 14.5, trailing: nil), height: 42)
        }
        for (index, person) in candidates.enumerated() {
            let add = pill("Add", .quiet, height: 30, target: self, action: #selector(addCandidate(_:)))
            add.tag = index; add.isEnabled = manage
            add.setAccessibilityLabel("Add \(person.display_name)")
            rows.append(.init(view: PersonRowView(name: person.display_name, id: person.membership_id, isLead: false,
                                                  leadChip: true, fontSize: 14.5, trailing: add), height: 42))
        }
        if lead, projects.directoryCursor != nil {
            let more = pill("More people", .quiet, height: 30, target: self, action: #selector(morePeople))
            more.isEnabled = manage
            rows.append(.init(view: more, height: 30, centered: true, gap: 10))
        }
        people.set(rows)
        peopleHeight?.constant = min(max(CGFloat(rows.count) * 42, 42), 42 * 4)
    }

    private func renderFiles(_ uploads: UploadSession) {
        let key = files.map { "\($0.name)|\($0.state)" }.joined(separator: "\n")
            + "|\(uploads.busy)|\(uploads.draft != nil)|\(uploads.recovery != nil)"
        guard key != fileSignature else { return }
        fileSignature = key
        fileList.set(files.enumerated().map { index, file in
            .init(view: fileRow(file, index: index, uploads: uploads), height: 32, gap: index == 0 ? 0 : 6)
        })
        // Up to four rows show at once; more scroll inside the well.
        let shown = CGFloat(min(files.count, 4))
        fileHeight?.constant = files.isEmpty ? 0 : shown * 38 - 6
        fileGap?.constant = files.isEmpty ? 0 : 6
    }

    private func fileRow(_ file: QueuedFile, index: Int, uploads: UploadSession) -> NSView {
        let row = NSView()
        row.wantsLayer = true
        row.layer?.backgroundColor = EchoTheme.text.withAlphaComponent(0.06).cgColor
        row.layer?.cornerRadius = 6
        let state: NSView
        switch file.state {
        case .preparing, .saving: state = spinner()
        case .queued, .notStarted:
            // Waiting its turn, or stopped behind an unconfirmed file: nothing
            // is running for it, so no spinner.
            let image = NSImageView(image: tintedSymbol("circle.dotted", size: 12, color: EchoTheme.faintText) ?? NSImage())
            image.setAccessibilityLabel(file.state == .queued ? "Waiting" : "Not started"); state = image
        case .saved:
            let image = NSImageView(image: tintedSymbol("checkmark.circle.fill", size: 13, color: EchoTheme.gold) ?? NSImage())
            image.setAccessibilityLabel("Saved"); state = image
        case .uncertain, .failed, .skipped:
            let image = NSImageView(image: tintedSymbol("exclamationmark.triangle.fill", size: 12, color: EchoTheme.ember) ?? NSImage())
            image.setAccessibilityLabel(file.state == .failed ? "Not saved" : "May not have been saved"); state = image
        }
        let name = label(file.detail, size: 13.5, color: file.state == .notStarted ? EchoTheme.mutedText : EchoTheme.text)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)
        var controls: [NSView] = []
        // Only offer what can run: Check needs the locator, Retry the draft.
        if file.state == .uncertain, uploads.recovery != nil {
            let check = pill("Check status", .quiet, height: 24, target: self, action: #selector(checkFile(_:)))
            check.tag = index; check.isEnabled = !uploads.busy; controls.append(check)
            if uploads.canRetry {
                let retry = pill("Retry same save", .quiet, height: 24, target: self, action: #selector(retryFile(_:)))
                retry.tag = index; retry.isEnabled = !uploads.busy; controls.append(retry)
            }
            let skip = pill("Skip…", .quiet, height: 24, target: self, action: #selector(skipFile(_:)))
            skip.tag = index; skip.isEnabled = !uploads.busy; controls.append(skip)
        }
        let stack = NSStackView(views: [state, name] + controls)
        stack.orientation = .horizontal; stack.spacing = 10; stack.alignment = .centerY
        stack.setHuggingPriority(.defaultLow, for: .horizontal)
        stack.translatesAutoresizingMaskIntoConstraints = false
        state.translatesAutoresizingMaskIntoConstraints = false
        state.widthAnchor.constraint(equalToConstant: 16).isActive = true
        state.heightAnchor.constraint(equalToConstant: 16).isActive = true
        row.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -6),
            stack.centerYAnchor.constraint(equalTo: row.centerYAnchor),
        ])
        return row
    }

    // One save at a time. The next file starts only after a confirmed
    // receipt; an unknown outcome stops the queue on that file, and the files
    // behind it wait as "Not started" (nothing runs for them).
    private func pump() {
        guard !pumping, let uploads, let project else { return }
        pumping = true; defer { pumping = false }
        while let index = files.firstIndex(where: { $0.state == .queued || $0.state == .saving }) {
            if files[index].state == .saving {
                if uploads.busy { return }
                if let receipt = uploads.receipt {
                    files[index].state = .saved; files[index].detail = files[index].name + " · " + (receipt.document?.stateLabel ?? "Saved")
                    files[index].snapshot = nil; uploads.startAnother(); resume(); continue
                }
                if uploads.documentMutationState == .rejectedBeforeAnyUnknownOutcome,
                   uploads.settleRejectedFirstDocumentAttempt() { return }
                if uploads.recovery != nil { files[index].state = .uncertain; halt(); return }
                // No receipt and no locator: the session was reset. Only a
                // save that provably never ran is "not saved".
                if uploads.status.hasPrefix("The save may have completed") { files[index].state = .uncertain; halt(); return }
                files[index].state = .failed; continue
            }
            if uploads.busy { return }
            if closeRequested || admittedIdentity == nil { halt(); return }
            if uploads.receipt != nil { uploads.startAnother() }
            guard uploads.canCompose else { halt(); return }
            guard let snapshot = files[index].snapshot else { files[index].state = .failed; continue }
            files[index].state = .saving
            uploads.submitDocument(title: files[index].title, snapshot: snapshot, visibility: .projects,
                           audienceProjectIDs: [project.project_id], projectIDs: [project.project_id])
        }
    }
    private func halt() { for index in files.indices where files[index].state == .queued { files[index].state = .notStarted } }
    private func resume() {
        guard !closeRequested, admittedIdentity != nil else { return }
        for index in files.indices where files[index].state == .notStarted { files[index].state = .queued }
    }

    func controlTextDidChange(_ obj: Notification) {
        if (obj.object as? NSTextField) === nameField { refresh() }
    }

    @objc private func createProject() {
        guard let projects, project == nil else { return }
        if let created = createdNotOpened {
            // Retry only the read; the project already exists.
            guard !projects.busy, !projects.hasOutstandingMutation else { return }
            awaitingCreate = true; createdFrom = nil
            projects.open(created); return
        }
        if case .create = projects.pending {
            guard !projects.busy else { return }
            awaitingCreate = true; createdFrom = projects.selected?.project_id; createdBefore = projects.createdProjectID
            projects.retry(); return
        }
        let name = normalizedName
        guard ProjectWire.text(name, max: 200), queuedCreate == nil else { return }
        guard projects.canMutate else {
            if canQueueCreate(projects) { queuedCreate = name; refresh() }
            return
        }
        startCreate(name, projects)
    }

    private func startCreate(_ name: String, _ projects: ProjectSession) {
        createdFrom = projects.selected?.project_id; createdBefore = projects.createdProjectID
        projects.create(name)
        // Only a create the session actually recorded is awaited.
        if case .create = projects.pending { awaitingCreate = true }
        refresh()
    }

    private func canQueueCreate(_ projects: ProjectSession) -> Bool {
        projects.busy && !projects.hasOutstandingMutation && projects.pending == nil && !projects.needsRecoveryReview
            && projects.availability == .live && projects.identity != nil && admittedIdentity != nil && !closeRequested
    }

    @objc private func findPeople() {
        let query = addField.stringValue
        projects?.directory(query)
    }

    @objc private func addCandidate(_ sender: NSButton) {
        guard let projects, uploads?.busy != true, !inFlight else { return }
        let memberIDs = Set(projects.members.map(\.membership_id))
        let candidates = projects.candidates.filter { !memberIDs.contains($0.membership_id) }
        guard candidates.indices.contains(sender.tag) else { return }
        projects.addMember(candidates[sender.tag].membership_id)
    }

    @objc private func morePeople() { projects?.nextDirectory() }

    @objc private func chooseFiles() {
        guard project != nil, projects?.busy != true else { return }
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false; picker.allowsMultipleSelection = true; picker.allowedContentTypes = DocumentSnapshot.contentTypes
        picker.beginSheetModal(for: sheet) { [weak self] response in
            guard let self, response == .OK else { return }
            self.queueFiles(picker.urls)
        }
    }

    @objc private func checkFile(_ sender: NSButton) {
        guard let uploads, files.indices.contains(sender.tag), files[sender.tag].state == .uncertain,
              !uploads.busy, uploads.recovery != nil else { return }
        files[sender.tag].state = .saving; uploads.checkStatus(); refresh()
    }

    @objc private func retryFile(_ sender: NSButton) {
        guard let uploads, files.indices.contains(sender.tag), files[sender.tag].state == .uncertain,
              !uploads.busy, uploads.draft != nil else { return }
        files[sender.tag].state = .saving; uploads.retry(); refresh()
    }

    /// Explicitly give up on an unconfirmed file (it may have been saved),
    /// then carry on with the files behind it.
    @objc private func skipFile(_ sender: NSButton) {
        guard let uploads, files.indices.contains(sender.tag), files[sender.tag].state == .uncertain, !uploads.busy else { return }
        let index = sender.tag, identity = uploads.identity
        confirm("Skip this file?", detail: "It may have been saved. Check its status first to avoid a duplicate.",
                action: "Skip", cancel: "Keep", on: sheet) { [weak self] in
            guard let self, self.isPresented, let uploads = self.uploads, !uploads.busy, uploads.identity == identity,
                  self.files.indices.contains(index), self.files[index].state == .uncertain else { return }
            uploads.startAnother()
            self.files[index].state = .skipped; self.files[index].snapshot = nil; self.resume(); self.refresh()
        }
    }

    @objc private func cancelOrDone() {
        guard !inFlight else { return }
        close()
    }

    private func close() {
        guard isPresented else { return }
        // A confirm alert or file panel never outlives the sheet it belongs to.
        if let child = sheet.attachedSheet { sheet.endSheet(child, returnCode: .cancel) }
        snapshotGeneration = UUID(); isPresented = false; awaitingCreate = false; queuedCreate = nil; closeRequested = false
        for index in files.indices { files[index].snapshot = nil }
        onWillClose?()
        if let parent = sheet.sheetParent { parent.endSheet(sheet) }
        onClose?()
    }

    private func build() {
        guard let root = sheet.contentView else { return }
        sheet.onCancel = { [weak self] in self?.cancelOrDone() }
        mark(sheetClose, "sheet-close", label: "Close"); sheetClose.target = self; sheetClose.action = #selector(cancelOrDone)
        boxedField(nameField, in: nameBox, placeholder: "Name", size: 20, weight: .semibold)
        mark(nameField, "create-name", label: "Project name")
        nameField.delegate = self; nameField.target = self; nameField.action = #selector(createProject)
        mark(submit, "create-submit"); submit.target = self; submit.action = #selector(createProject)
        cancel.isHidden = true; cancel.target = self; cancel.action = #selector(cancelOrDone); cancel.keyEquivalent = "\u{1b}"
        mark(done, "create-done"); done.target = self; done.action = #selector(cancelOrDone)
        mark(addFiles, "create-add-files"); addFiles.target = self; addFiles.action = #selector(chooseFiles)
        mark(filesBox, "create-files")
        boxedField(addField, in: addBox, placeholder: "Add someone", size: 14)
        mark(addField, "people-add-field", label: "Add someone")
        addField.target = self; addField.action = #selector(findPeople)
        notice.font = .systemFont(ofSize: 12.5); notice.textColor = EchoTheme.faintText
        notice.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for view in [nameBox, cancel, submit] { view.translatesAutoresizingMaskIntoConstraints = false; first.addSubview(view) }
        for view in [nameLabel, peopleScroll, addBox, filesBox, done] {
            view.translatesAutoresizingMaskIntoConstraints = false; second.addSubview(view)
        }
        for view in [fileScroll, addFiles, finishFirst] {
            view.translatesAutoresizingMaskIntoConstraints = false; filesBox.addSubview(view)
        }
        for view in [first, second, notice, sheetClose] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        let footerGuide = NSLayoutGuide(); root.addLayoutGuide(footerGuide)
        NSLayoutConstraint.activate([
            sheetClose.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            sheetClose.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            sheetClose.widthAnchor.constraint(equalToConstant: 28), sheetClose.heightAnchor.constraint(equalToConstant: 28),
            footerGuide.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
            footerGuide.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
            footerGuide.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22),
            footerGuide.heightAnchor.constraint(equalToConstant: 34),
            notice.leadingAnchor.constraint(equalTo: footerGuide.leadingAnchor),
            notice.centerYAnchor.constraint(equalTo: footerGuide.centerYAnchor),
            notice.trailingAnchor.constraint(lessThanOrEqualTo: footerGuide.trailingAnchor, constant: -200),
        ])
        for group in [first, second] {
            NSLayoutConstraint.activate([
                group.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
                group.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
                group.topAnchor.constraint(equalTo: root.topAnchor, constant: 54),
            ])
        }
        // Only the visible step is pinned to the bottom (see fitHeight), so
        // the hidden one never holds the sheet at its own height.
        groupBottoms = [first, second].map { $0.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22) }
        let peopleHeight = peopleScroll.heightAnchor.constraint(equalToConstant: 42)
        self.peopleHeight = peopleHeight
        // The well hugs its rows and "Add files…"; the list scrolls past four.
        let fileHeight = fileScroll.heightAnchor.constraint(equalToConstant: 0)
        let fileGap = addFiles.topAnchor.constraint(equalTo: fileScroll.bottomAnchor, constant: 0)
        self.fileHeight = fileHeight; self.fileGap = fileGap
        NSLayoutConstraint.activate([
            nameBox.leadingAnchor.constraint(equalTo: first.leadingAnchor),
            nameBox.trailingAnchor.constraint(equalTo: first.trailingAnchor),
            nameBox.topAnchor.constraint(equalTo: first.topAnchor),
            nameBox.heightAnchor.constraint(equalToConstant: 46),
            submit.trailingAnchor.constraint(equalTo: first.trailingAnchor),
            submit.bottomAnchor.constraint(equalTo: first.bottomAnchor),
            submit.widthAnchor.constraint(greaterThanOrEqualToConstant: 84),
            cancel.trailingAnchor.constraint(equalTo: submit.leadingAnchor, constant: -10),
            cancel.centerYAnchor.constraint(equalTo: submit.centerYAnchor),

            nameLabel.leadingAnchor.constraint(equalTo: second.leadingAnchor),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: second.trailingAnchor),
            nameLabel.topAnchor.constraint(equalTo: second.topAnchor),
            peopleScroll.leadingAnchor.constraint(equalTo: second.leadingAnchor),
            peopleScroll.trailingAnchor.constraint(equalTo: second.trailingAnchor),
            peopleScroll.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 14),
            peopleHeight,
            addBox.leadingAnchor.constraint(equalTo: second.leadingAnchor),
            addBox.trailingAnchor.constraint(equalTo: second.trailingAnchor),
            addBox.topAnchor.constraint(equalTo: peopleScroll.bottomAnchor, constant: 8),
            addBox.heightAnchor.constraint(equalToConstant: 36),
            filesBox.leadingAnchor.constraint(equalTo: second.leadingAnchor),
            filesBox.trailingAnchor.constraint(equalTo: second.trailingAnchor),
            filesBox.topAnchor.constraint(equalTo: addBox.bottomAnchor, constant: 20),
            done.topAnchor.constraint(greaterThanOrEqualTo: filesBox.bottomAnchor, constant: 20),
            fileScroll.leadingAnchor.constraint(equalTo: filesBox.leadingAnchor, constant: 13),
            fileScroll.trailingAnchor.constraint(equalTo: filesBox.trailingAnchor, constant: -13),
            fileScroll.topAnchor.constraint(equalTo: filesBox.topAnchor, constant: 13),
            fileHeight, fileGap,
            addFiles.leadingAnchor.constraint(equalTo: filesBox.leadingAnchor, constant: 13),
            filesBox.bottomAnchor.constraint(equalTo: addFiles.bottomAnchor, constant: 13),
            finishFirst.leadingAnchor.constraint(equalTo: filesBox.leadingAnchor, constant: 16),
            finishFirst.centerYAnchor.constraint(equalTo: addFiles.centerYAnchor),
            done.trailingAnchor.constraint(equalTo: second.trailingAnchor),
            done.bottomAnchor.constraint(equalTo: second.bottomAnchor),
            done.widthAnchor.constraint(greaterThanOrEqualToConstant: 84),
        ])
    }
}

// MARK: - The window

/// The original in full, read-only, with one actions menu.
final class ReaderView: NSView {
    let actions = IconButton(symbol: "ellipsis", label: "More actions", size: 13)
    private let titleLabel = label("", size: 17, weight: .semibold)
    private let meta = label("", size: 12.5, color: EchoTheme.faintText)
    private let scroll = NSTextView.scrollableTextView()
    private var shownID: String?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        guard let text = scroll.documentView as? NSTextView else { return }
        text.isEditable = false; text.isSelectable = true; text.isRichText = false
        text.drawsBackground = false; text.textContainerInset = NSSize(width: 0, height: 4)
        text.textContainer?.lineFragmentPadding = 0
        mark(text, "reader-text", label: "Original text")
        scroll.drawsBackground = false; scroll.autohidesScrollers = true; scroll.borderType = .noBorder
        mark(actions, "reader-actions", label: "More actions")
        actions.round = true
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        meta.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [titleLabel, meta, scroll, actions] { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: actions.leadingAnchor, constant: -10),
            actions.trailingAnchor.constraint(equalTo: trailingAnchor),
            actions.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            actions.widthAnchor.constraint(equalToConstant: 28), actions.heightAnchor.constraint(equalToConstant: 28),
            meta.leadingAnchor.constraint(equalTo: leadingAnchor),
            meta.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            meta.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: meta.bottomAnchor, constant: 16),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func show(id: String, title: String, meta detail: String, text original: String, extracted: Bool = false) {
        titleLabel.stringValue = title; meta.stringValue = detail
        guard let text = scroll.documentView as? NSTextView else { return }
        text.setAccessibilityLabel(extracted ? "Extracted document text" : "Original text")
        let signature = id + "|" + detail + "|" + original
        guard shownID != signature else { return }; shownID = signature
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 5
        text.textStorage?.setAttributedString(NSAttributedString(string: original, attributes: [
            .font: NSFont.systemFont(ofSize: 15), .foregroundColor: EchoTheme.text, .paragraphStyle: paragraph]))
        text.scrollToBeginningOfDocument(nil)
    }

    func forget() { shownID = nil }
}

@MainActor
final class ProjectsController: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    let window: NSWindow = ProjectsWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 680),
        styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    let answerContainer = NSView()
    let uploads: UploadSession
    let documents: DocumentSession
    private var documentScope: String?
    let projects: ProjectSession
    private let composeSheet = ProjectComposeSheet()
    private let peopleSheet = ProjectPeopleSheet()
    let createSheet = ProjectCreateSheet()
    private let onAsk: (String, AskScope) -> AskSubmission
    var onConceal: (() -> Void)?
    var onIdentityChanged: (() -> Void)?
    private var observedIdentity: AccountIdentity?
    var onActivateAnswer: (() -> Void)?
    var onResizeAnswer: (() -> Void)?
    /// main.swift cancels/removes an answer whose authorization scope was lost.
    var onInvalidateAnswer: (() -> Void)?
    var onPeople: (() -> Void)?
    /// main.swift supplies an Ask subpage (currently Sources) without coupling
    /// this navigation adapter to answer/source transport details.
    var askSubPage: (() -> String?)?
    var closeAskSubPage: (() -> Void)?
    func askPageChanged() { refresh() }
    var accountMenu: NSMenu?

    private let sidebar = SidebarView()
    private let content = FileDropView()
    // The page title, drawn over the content column (the system title would
    // centre on the whole window, sidebar included). window.title still
    // carries the same text for the Window menu and accessibility.
    private let titleLabel = label("ECHO", size: 13, weight: .semibold, color: EchoTheme.mutedText)
    private var renderedTitle: String?
    private var titleRoom: NSLayoutConstraint?
    private var sidebarWidth: NSLayoutConstraint?
    private let sidebarToggle = IconButton(symbol: "sidebar.left", label: "Show sidebar", size: 14)
    private let back = BackButton()
    private let peopleButton = PeopleStackButton()
    private lazy var captureRow = SidebarRowButton(title: "Capture", symbol: "plus.app", target: self, action: #selector(captureAction))
    private lazy var newProjectRow = SidebarRowButton(title: "New project", symbol: "folder.badge.plus", target: self, action: #selector(newProject))
    private let accountRow = AccountRowButton()
    private let askField = NSTextField()
    private let writeButton = CircleButton(symbol: "plus", label: "Write", style: .quiet)
    private let sendButton = CircleButton(symbol: "arrow.up", label: "Submit", style: .gold)
    private let clearButton = CircleButton(symbol: "xmark", label: "Clear search", style: .clear)
    private var fieldToSend: NSLayoutConstraint?
    private var fieldToClear: NSLayoutConstraint?
    private let statusLine = label("", size: 12.5, color: EchoTheme.faintText)
    private let list = ColumnStackView()
    private lazy var scroll = listScroll(list)
    private let reader = ReaderView()
    private let emptyHost = NSView()
    private var listSignature = ""
    private var emptySignature = ""

    private enum Mode { case home, ask, search, project }
    private var mode = Mode.home
    private var sidebarOpen = false
    private var refreshingProjects = false
    private var projectSearchShown = false
    private var showSearchReader = false
    private var openProjectName: String?
    private var lastOpenedProjectID: String?
    private var membersGeneration: Int?
    // What the project page shows again once a sheet closes or a load ends.
    private enum Restore: Equatable { case feed, search(String), read(String) }
    private var restorePending: Restore?
    private var peopleRestore: Restore?
    // A click or search that arrived while the session was busy (for
    // example with the avatar-stack members load): replayed once idle.
    private var pendingRead: String?
    private var pendingSearch: String?
    private var shownProjectQuery: String?
    /// A paged list and its vertical position are restored after a sheet,
    /// reader, or child project returns. The source remains authorized through
    /// the normal fresh read; this only restores presentation state.
    private struct ListPlace { let rows: Int; let offset: CGFloat; let query: String? }
    private var listPlace: ListPlace?
    private var homePlace: ListPlace?
    private var scrollTarget: CGFloat?
    private struct ProjectOrigin { let id: String; let name: String; let query: String?; let reading: String?; let documentID: String?; let list: ListPlace? }
    private var createOrigin: ProjectOrigin?
    /// Project presentation behind a scoped Ask. The answer is a different
    /// page, so Back returns through a fresh authorized reader/list restore.
    private var askOrigin: ProjectOrigin?
    private var restoreDocumentID: String?
    private var createdInSheet = false
    private var localNotice = ""
    private var quietStatus = false
    // Closing our own sheet returns key to the window inside endSheet; that
    // is not a reason to re-probe the account.
    private var closingSheet = false
    // An account or list refresh skipped while a sheet was attached; it runs
    // when the sheet closes.
    private var pendingRefresh = false
    private var shownPlaceholder = ""
    // A scoped Ask is still an Ask. Back returns to the project the person
    // deliberately narrowed to, rather than unexpectedly dropping them home.
    private var askReturnProject = false
    private var askScope = AskScope.global
    var hasOutstandingMutation: Bool { uploads.hasOutstandingMutation || projects.hasOutstandingMutation }

    init(uploads: UploadSession? = nil, projects: ProjectSession? = nil, documents: DocumentSession? = nil, onAsk: @escaping (String, AskScope) -> AskSubmission) {
        self.uploads = uploads ?? UploadSession(); self.projects = projects ?? ProjectSession(); self.onAsk = onAsk
        self.documents = documents ?? DocumentSession(cli: self.uploads.client.cli)
        super.init(); configure()
        self.uploads.onChange = { [weak self] in self?.refresh() }
        self.documents.onChange = { [weak self] in self?.refresh() }
        self.projects.onChange = { [weak self] in self?.refresh() }
        self.uploads.onProjectAccessChanged = { [weak self] in self?.projects.accessLost() }
        self.projects.onAccessChanged = { [weak self] in
            guard let self else { return }
            self.documents.clear(); self.documentScope = nil
            self.uploads.projectAccessChanged(); self.composeSheet.projectAccessChanged()
            self.askField.stringValue = ""; self.peopleSheet.clearQuery(); self.createSheet.clearQuery()
        }
        self.projects.onAccessLost = { [weak self] in
            guard let self else { return }
            // Never turn a revoked project question into a global one.
            if self.askScope != .global, self.mode == .ask { self.mode = .home; self.onConceal?() }
            self.askScope = .global; self.askReturnProject = false; self.askField.stringValue = ""
            self.onInvalidateAnswer?(); self.clearPresentationRestore()
        }
        composeSheet.onWillClose = { [weak self] in self?.closingSheet = true }
        peopleSheet.onWillClose = { [weak self] in self?.closingSheet = true }
        createSheet.onWillClose = { [weak self] in self?.closingSheet = true }
        composeSheet.onClose = { [weak self] in
            guard let self else { return }
            if self.composeSheet.didSave, self.mode == .project, self.projects.selected != nil {
                self.listPlace = self.shownList(); self.restorePending = .feed; self.documentScope = nil
            }
            self.sheetClosed()
        }
        peopleSheet.onClose = { [weak self] in
            guard let self else { return }
            if self.mode == .project { self.restorePending = self.peopleRestore ?? .feed }
            self.peopleRestore = nil
            self.sheetClosed()
        }
        createSheet.onCreated = { [weak self] project in
            guard let self else { return }
            self.createdInSheet = true
            self.mode = .project; self.openProjectName = project.name; self.lastOpenedProjectID = project.project_id
            self.projectSearchShown = false; self.showSearchReader = false; self.listPlace = nil
            self.askField.stringValue = ""; self.localNotice = ""
        }
        createSheet.onClose = { [weak self] in
            guard let self else { return }
            if self.createdInSheet, self.mode == .project, self.projects.selected != nil {
                self.restorePending = .feed; self.documentScope = nil
            } else if let origin = self.createOrigin, self.projects.selected?.project_id != origin.id {
                // A cancelled sheet can sit over a reader that was cleared by a
                // concurrent reload. Return through the normal authorized read.
                self.returnToCreateOrigin()
            }
            self.createdInSheet = false
            if self.createSheet.unsavedFiles > 0 { self.localNotice = "Some files may not have been saved." }
            self.sheetClosed()
        }
        content.onDropFile = { [weak self] url in self?.dropOnWindow(url) }
        content.acceptsDrop = { [weak self] in
            guard let self else { return false }
            return self.window.attachedSheet == nil && self.uploads.identity != nil
        }
        refresh()
    }

    private func sheetClosed() {
        closingSheet = false
        // A list the sheet sat over may have been cleared (concealment, a
        // failed reopen): reload it rather than leave a bare "Reload".
        if mode == .home, projects.projects.isEmpty, !projects.busy, projects.identity != nil,
           projects.availability != .notLive, !projects.hasOutstandingMutation { pendingRefresh = true }
        if pendingRefresh { pendingRefresh = false; refreshIdentity() }
        refresh()
    }

    func show() {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(); refreshIdentity()
        if window.attachedSheet == nil { window.makeFirstResponder(askField) }
    }
    func summon() {
        if window.isKeyWindow, window.attachedSheet == nil { conceal(); window.orderOut(nil) }
        else { show() }
    }
    /// ⌘⇧E: open compose, ready for a paste. Never reads the pasteboard.
    func capture() {
        show()
        if composeSheet.isPresented { composeSheet.focusBody(); return }
        guard window.attachedSheet == nil else { return }
        presentCompose(target: defaultTarget(), placeholder: "Paste or type")
    }
    /// Whether ⌘⇧E belongs to ECHO on this Mac (another app may hold it).
    func setCaptureShortcutAvailable(_ available: Bool) { captureRow.trailing = available ? "⌘⇧E" : nil }
    func refreshIdentity() {
        guard window.isVisible, !hasOutstandingMutation, !uploads.busy else { return }
        guard window.attachedSheet == nil else { pendingRefresh = true; return }
        refreshingProjects = true; uploads.refreshIdentity()
    }
    func conceal() {
        if mode == .project || mode == .search {
            mode = .home; projectSearchShown = false; showSearchReader = false; restorePending = nil
        }
        clearPresentationRestore(); askScope = .global; askReturnProject = false
        clearPendingIntents()
        if window.attachedSheet != nil { pendingRefresh = true }
        documents.clear(); documentScope = nil
        uploads.conceal(); projects.conceal(); composeSheet.projectAccessChanged()
        peopleSheet.close(); createSheet.closeWhenIdle()
        onConceal?()
    }
    func accountWillChange() {
        documents.bind(nil); documentScope = nil
        uploads.accountWillChange(); projects.bind(nil); composeSheet.accountWillChange()
        peopleSheet.close(); createSheet.closeWhenIdle()
        askField.stringValue = ""; mode = .home; projectSearchShown = false; showSearchReader = false
        clearPresentationRestore(); askScope = .global; askReturnProject = false
        clearPendingIntents(); localNotice = ""; refresh()
    }
    func shutdown() { documents.clear(); uploads.shutdown(); projects.shutdown(); window.orderOut(nil) }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !hasOutstandingMutation else { return false }
        conceal(); window.orderOut(nil); return false
    }
    func windowDidBecomeKey(_ notification: Notification) {
        if !closingSheet { refreshIdentity() }
        if mode == .ask { onActivateAnswer?() }
    }
    func windowDidResignKey(_ notification: Notification) { onConceal?() }
    func windowDidResize(_ notification: Notification) { onResizeAnswer?(); fitTitle() }

    // Escape in the bar goes Back.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control === askField, commandSelector == #selector(NSResponder.cancelOperation(_:)), mode != .home else { return false }
        goBack(); return true
    }

    private func defaultTarget() -> ComposeTarget {
        if mode == .project, let selected = projects.selected { return .project(selected.project_id, selected.name) }
        return .onlyMe
    }

    /// Compose from outside the window's own buttons (⌘⇧E, a drop). A list
    /// cleared by concealment is reloaded for the optional project picker.
    private func presentCompose(target: ComposeTarget, placeholder: String, file: URL? = nil) {
        guard window.attachedSheet == nil else { return }
        if mode == .home, projects.projects.isEmpty, projects.identity != nil, projects.availability != .notLive,
           !projects.busy, !projects.hasOutstandingMutation {
            refreshingProjects = false; projects.discover()
        }
        composeSheet.present(over: window, session: uploads, projects: projects, target: target, placeholder: placeholder, file: file)
    }

    private func clearPendingIntents() { pendingRead = nil; pendingSearch = nil }
    private func clearPresentationRestore() {
        restorePending = nil; restoreDocumentID = nil; createOrigin = nil; askOrigin = nil
        listPlace = nil; homePlace = nil; scrollTarget = nil; peopleRestore = nil
    }
    private var scrollOffset: CGFloat { scroll.isHidden ? 0 : scroll.contentView.bounds.origin.y }
    private func shownList() -> ListPlace? {
        guard mode == .project, projects.content == nil, documents.metadata == nil, !projects.items.isEmpty else { return nil }
        return ListPlace(rows: projects.items.count, offset: scrollOffset, query: projectSearchShown ? shownProjectQuery : nil)
    }
    private func shownHome() -> ListPlace? {
        guard mode == .home, !projects.projects.isEmpty else { return nil }
        return ListPlace(rows: projects.projects.count, offset: scrollOffset, query: nil)
    }
    private func currentProjectOrigin() -> ProjectOrigin? {
        guard mode == .project, let selected = projects.selected else { return nil }
        return ProjectOrigin(id: selected.project_id, name: selected.name,
                             query: projectSearchShown ? shownProjectQuery : nil,
                             reading: projects.content?.context_id,
                             documentID: documents.metadata?.document_id,
                             list: projects.content == nil && documents.metadata == nil ? shownList() : listPlace)
    }
    private func returnToProjectOrigin(_ origin: ProjectOrigin) {
        guard !projects.hasOutstandingMutation else { return }
        mode = .project; openProjectName = origin.name; lastOpenedProjectID = origin.id
        projectSearchShown = origin.query != nil; shownProjectQuery = origin.query
        askField.stringValue = origin.query ?? ""; listPlace = origin.list
        restoreDocumentID = origin.documentID
        restorePending = origin.reading.map { .read($0) } ?? origin.query.map { .search($0) }
        projects.open(origin.id); refresh()
    }
    private func returnToCreateOrigin() {
        guard let origin = createOrigin else { return }
        createOrigin = nil; returnToProjectOrigin(origin)
    }

    // MARK: State

    private func refresh() {
        if observedIdentity != uploads.identity {
            observedIdentity = uploads.identity
            documents.bind(uploads.identity); documentScope = nil
            askField.stringValue = ""; mode = .home; projectSearchShown = false; showSearchReader = false
            clearPresentationRestore(); askScope = .global; askReturnProject = false
            onInvalidateAnswer?(); clearPendingIntents(); onIdentityChanged?()
            // A save that may exist under the account that just went away
            // stays said on the page until the person moves on.
            if uploads.identity == nil, uploads.status.hasPrefix("The save may have completed") { localNotice = uploads.status }
            projects.bind(uploads.identity)
        }
        if refreshingProjects && !uploads.busy && window.attachedSheet == nil {
            refreshingProjects = false
            if projects.identity != uploads.identity { projects.bind(uploads.identity) }
            else if mode == .home && !projects.busy { projects.discover() }
        }
        composeSheet.refresh(); peopleSheet.refresh(); createSheet.refresh()
        if mode == .project, let selected = projects.selected, uploads.identity != nil, !uploads.hasOutstandingMutation {
            let restoringDocument: Bool
            if let documentID = restoreDocumentID, !documents.busy {
                restoreDocumentID = nil; showSearchReader = true; documents.read(documentID, projectID: selected.project_id); restoringDocument = true
            } else { restoringDocument = false }
            let query = projectSearchShown ? askField.stringValue : ""
            let key = "\(selected.project_id)|\(projects.scopeGeneration)|\(query)"
            // A reader restoration is the authoritative next operation. Do not
            // replace it with the routine list refresh in this or its completion turn.
            if restoringDocument { documentScope = key }
            if !restoringDocument, !documents.busy, documentScope != key, query.isEmpty || uploadQuery(query) != nil {
                documentScope = key; documents.search(query, projectID: selected.project_id)
            }
        }
        if mode == .home, let place = homePlace, window.attachedSheet == nil, !projects.busy, projects.listFetched {
            if projects.projects.count < place.rows, projects.listCursor != nil { projects.nextProjects() }
            else { homePlace = nil; scrollTarget = place.offset }
        }
        if mode == .project, !projects.busy, let selected = projects.selected {
            openProjectName = selected.name
            if let restore = restorePending, window.attachedSheet == nil {
                restorePending = nil; clearPendingIntents()
                switch restore {
                case .feed: projectSearchShown = false; askField.stringValue = ""; projects.feed()
                case .search(let query): projectSearchShown = true; askField.stringValue = query; projects.search(query)
                case .read(let context): projects.read(context)
                }
            } else if let context = pendingRead, window.attachedSheet == nil {
                pendingRead = nil; projects.read(context)
            } else if let query = pendingSearch, window.attachedSheet == nil {
                pendingSearch = nil; projectSearchShown = true; shownProjectQuery = query; projects.search(query)
            } else if let place = listPlace, window.attachedSheet == nil, projects.content == nil, documents.metadata == nil {
                let query = projectSearchShown ? shownProjectQuery : nil
                if place.query != query { listPlace = nil }
                else if projects.items.count < place.rows, projects.pageCursor != nil { projects.nextPage() }
                else { listPlace = nil; scrollTarget = place.offset }
            } else if !peopleSheet.isPresented, projects.members.isEmpty, membersGeneration != projects.scopeGeneration {
                // After the feed has loaded, the first member page, once per open.
                membersGeneration = projects.scopeGeneration; projects.loadMembers()
            }
        }
        render()
    }

    private func render() {
        // The open project's name only while it is (being) opened; a project
        // that stopped opening is not titled as if it were shown.
        let openName = projects.selected?.name ?? (projects.busy ? openProjectName : nil)
        let pageTitle: String
        switch mode {
        case .project: pageTitle = (projects.content != nil || documents.metadata != nil) ? "" : (openName ?? "ECHO")
        case .search: pageTitle = "ECHO"
        case .home, .ask: pageTitle = "ECHO"
        }
        // Keep the Window menu and accessibility title meaningful even when
        // the centred reader label is deliberately empty under Back.
        let windowTitle = mode == .project ? (openName ?? "ECHO") : "ECHO"
        if window.title != windowTitle { window.title = windowTitle }
        // renderedTitle starts nil, so the first render applies the tracked
        // "ECHO" style too (the label is created without it).
        if renderedTitle != pageTitle {
            renderedTitle = pageTitle
            titleLabel.attributedStringValue = NSAttributedString(string: pageTitle, attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: EchoTheme.mutedText,
                .kern: pageTitle == "ECHO" ? 1.8 : 0])
        }
        let backDestination: String?
        switch mode {
        case .home: backDestination = nil
        case .ask: backDestination = askSubPage?() ?? (askReturnProject ? (projects.selected?.name ?? "Projects") : "Projects")
        case .project:
            if documents.metadata != nil || projects.content != nil || projectSearchShown { backDestination = openName ?? "Projects" }
            else if let origin = createOrigin { backDestination = origin.name }
            else { backDestination = "Projects" }
        case .search: backDestination = "Projects"
        }
        back.isHidden = backDestination == nil
        if let backDestination, back.title != backDestination {
            back.title = backDestination
            back.frame.size.width = back.fittingWidth
        }
        peopleButton.isHidden = mode != .project || projects.selected == nil
        peopleButton.people = projects.members.prefix(3).map { (initials: Look.initial($0.display_name), id: $0.membership_id) }
        peopleButton.isEnabled = !projects.busy

        switch projects.availability {
        case .live: newProjectRow.title = "New project"
        case .notLive: newProjectRow.title = "New project · Not live yet"
        case .checking: newProjectRow.title = "New project · Check availability"
        case .failed: newProjectRow.title = "New project · Refresh projects"
        }
        newProjectRow.isEnabled = projects.canMutate
        accountRow.name = uploads.identity?.displayName
        accountRow.role = uploads.identity?.role ?? ""
        accountRow.colorKey = uploads.identity?.membershipID ?? uploads.identity?.displayName ?? ""

        let placeholder: String
        switch mode {
        case .home, .ask: placeholder = "Ask ECHO"
        case .search: placeholder = "Ask ECHO"
        case .project: placeholder = "Ask \(openName ?? "this project")"
        }
        if placeholder != shownPlaceholder {
            shownPlaceholder = placeholder
            askField.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
                .font: NSFont.systemFont(ofSize: 15), .foregroundColor: EchoTheme.text.withAlphaComponent(0.5)])
        }
        let clearing = mode == .project && projectSearchShown && projects.content == nil
        clearButton.isHidden = !clearing
        fieldToClear?.isActive = clearing; fieldToSend?.isActive = !clearing
        switch mode {
        case .home, .ask: sendButton.isEnabled = true
        case .search: sendButton.isEnabled = !uploads.busy && uploads.identity != nil
        case .project: sendButton.isEnabled = projects.selected != nil
        }
        writeButton.isEnabled = true
        answerContainer.isHidden = mode != .ask

        quietStatus = false
        renderColumn()
        var status = ""
        switch mode {
        case .home, .project:
            status = localNotice.isEmpty ? projects.notice : localNotice
            // The recovery banner already says an unknown change may not have finished.
            if projects.needsRecoveryReview, status == ProjectFailure.uncertain.message { status = "" }
            if status.isEmpty, uploads.identity == nil, uploads.status.hasPrefix("The save may have completed") { status = uploads.status }
        case .search: status = localNotice.isEmpty ? attention(uploads.status) : localNotice
        case .ask: status = ""
        }
        if status.isEmpty, mode == .project || mode == .search { status = documents.status }
        statusLine.stringValue = quietStatus ? "" : status
        fitTitle()
    }

    /// The centred title never runs under the visible Back destination or members.
    private func fitTitle() {
        guard let host = back.superview, let root = window.contentView else { return }
        let centre = ((sidebarWidth?.constant ?? 0) + root.bounds.width) / 2
        var left = host.convert(back.isHidden ? sidebarToggle.frame : back.frame, to: nil).maxX
        if host.window == nil || left < 60 { left = 78 + (back.isHidden ? 34 : back.frame.maxX) }
        var right = root.bounds.width
        if !peopleButton.isHidden, let people = peopleButton.superview, people.window != nil {
            right = min(right, people.convert(people.bounds, to: nil).minX)
        }
        titleRoom?.constant = max(60, floor(2 * (min(centre - left, right - centre) - 16)))
    }

    /// Upload status minus routine progress, which the column already shows.
    private func attention(_ status: String) -> String {
        let routine: Set<String> = ["Searching saved context…", "Loading original text…", "Select a result to read the original.",
            "No matching context you can read.", "Saving your original text…", "Retrying the same save…", "Checking the saved context…"]
        return routine.contains(status) || status.hasPrefix("Saved ·") ? "" : status
    }

    private enum Column { case none, list([ColumnStackView.Row], String), reader, empty([NSView], String) }

    private func renderColumn() {
        var column = Column.none
        switch mode {
        case .ask: column = .none
        case .home: column = homeColumn()
        case .search: column = searchColumn()
        case .project: column = projectColumn()
        }
        scroll.isHidden = true; reader.isHidden = true; emptyHost.isHidden = true
        switch column {
        case .none:
            listSignature = ""; emptySignature = ""
        case .reader:
            reader.isHidden = false
            listSignature = ""; emptySignature = ""
        case .list(let rows, let signature):
            scroll.isHidden = false; emptySignature = ""
            if signature != listSignature {
                let reset = listSignature.isEmpty
                listSignature = signature; list.set(rows)
                if reset { list.scroll(.zero) }
            }
            if let offset = scrollTarget {
                scroll.layoutSubtreeIfNeeded()
                let maximum = max(0, list.bounds.height - scroll.contentView.bounds.height)
                scroll.contentView.scroll(to: NSPoint(x: 0, y: min(max(0, offset), maximum)))
                scroll.reflectScrolledClipView(scroll.contentView)
                scrollTarget = nil
            }
        case .empty(let views, let signature):
            emptyHost.isHidden = false; listSignature = ""
            if signature != emptySignature {
                emptySignature = signature
                emptyHost.subviews.forEach { $0.removeFromSuperview() }
                let stack = NSStackView(views: views)
                stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 14
                stack.translatesAutoresizingMaskIntoConstraints = false
                emptyHost.addSubview(stack)
                NSLayoutConstraint.activate([
                    stack.centerXAnchor.constraint(equalTo: emptyHost.centerXAnchor),
                    stack.centerYAnchor.constraint(equalTo: emptyHost.centerYAnchor),
                    stack.widthAnchor.constraint(lessThanOrEqualTo: emptyHost.widthAnchor),
                ])
            }
        }
        if case .reader = column {} else { reader.forget() }
    }

    private func recoveryBanner(centered: Bool = false) -> NSView {
        let text = label("A project change may not have finished.", size: 13, color: EchoTheme.mutedText)
        var views: [NSView] = [text]
        if projects.pending != nil {
            let retry = pill("Retry", .quiet, height: 30, target: self, action: #selector(retryProject))
            mark(retry, "recovery-retry"); retry.isEnabled = !projects.busy; views.append(retry)
        }
        let dismiss = pill("Dismiss…", .quiet, height: 30, target: self, action: #selector(dismissRecovery))
        mark(dismiss, "recovery-dismiss"); dismiss.isEnabled = !projects.busy; views.append(dismiss)
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal; stack.spacing = 10; stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        let host = NSView()
        host.addSubview(stack)
        NSLayoutConstraint.activate([
            centered ? stack.centerXAnchor.constraint(equalTo: host.centerXAnchor)
                : stack.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 6),
            stack.centerYAnchor.constraint(equalTo: host.centerYAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: host.trailingAnchor),
        ])
        return host
    }

    private func sized(_ view: NSView, width: CGFloat, height: CGFloat) -> NSView {
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: width).isActive = true
        view.heightAnchor.constraint(equalToConstant: height).isActive = true
        return view
    }

    private func documentRecoveryColumn() -> Column? {
        guard documents.identity != nil, documents.associationRecoveryNeeded else { return nil }
        let text = NSTextField(wrappingLabelWithString: documents.status.isEmpty ? "A document project-link change needs reconciliation." : documents.status)
        text.font = .systemFont(ofSize: 13); text.textColor = EchoTheme.mutedText; text.alignment = .center; text.preferredMaxLayoutWidth = 440
        var views: [NSView] = [text]
        if documents.pendingAssociation != nil {
            let retry = pill("Retry same project-link change", .quiet, height: 30, target: self, action: #selector(retryDocumentAssociation))
            retry.isEnabled = !documents.busy; mark(retry, "document-association-retry"); views.append(retry)
        }
        let dismiss = pill("Dismiss reminder…", .quiet, height: 30, target: self, action: #selector(dismissDocumentAssociation))
        dismiss.isEnabled = !documents.busy; mark(dismiss, "document-association-dismiss"); views.append(dismiss)
        return .empty(views, "document-recovery|\(documents.pendingAssociation?.requestID ?? "invalid")|\(documents.busy)|\(documents.status)")
    }
    @objc private func dismissDocumentAssociation() {
        guard !documents.busy else { return }
        let identity = documents.identity, pending = documents.pendingAssociation
        confirm("Dismiss this project-link reminder?", detail: "The change may already have completed. Dismissing only clears this local reminder; it does not undo a saved project link. Refresh the document before making another change.",
                action: "Dismiss reminder", cancel: "Keep reminder", on: window) { [weak self] in
            guard let self, self.documents.identity == identity, self.documents.pendingAssociation == pending, !self.documents.busy else { return }
            self.documents.dismissAssociationRecovery()
        }
    }

    private func homeColumn() -> Column {
        if let recovery = documentRecoveryColumn() { return recovery }
        let recovery = projects.needsRecoveryReview
        let recoveryKey = recovery ? "recovery|\(projects.pending != nil)|\(projects.busy)" : ""
        if uploads.identity == nil {
            if uploads.busy { return .empty([spinner()], "loading") }
            let signIn = pill("Sign in…", .primary, height: 34, target: self, action: #selector(signIn(_:)))
            mark(signIn, "sign-in", label: "Sign in…")
            return .empty([label("Sign in to use ECHO", size: 15, color: EchoTheme.mutedText), signIn], "signed-out")
        }
        if projects.projects.isEmpty {
            var views: [NSView] = recovery ? [sized(recoveryBanner(centered: true), width: 520, height: 44)] : []
            if projects.busy || uploads.busy || projects.availability == .checking {
                return .empty(views + [spinner()], "loading|" + recoveryKey)
            }
            // Zero projects only when a list page really came back empty; a
            // list cleared by an access change or failure is not "no projects".
            let fetchedEmpty = projects.availability == .live && projects.notice.isEmpty && projects.listFetched
            if projects.availability != .notLive && !fetchedEmpty {
                quietStatus = localNotice.isEmpty
                // Say it once: the banner is the unknown change's message and
                // its only retry. Any other failure keeps its own words.
                let text = recovery && projects.notice == ProjectFailure.uncertain.message ? "" : projects.notice
                if !text.isEmpty {
                    let message = NSTextField(wrappingLabelWithString: text)
                    message.font = .systemFont(ofSize: 13); message.textColor = EchoTheme.faintText; message.alignment = .center
                    message.preferredMaxLayoutWidth = 420
                    views.append(message)
                }
                let reload = pill("Reload projects", .quiet, height: 30, target: self, action: #selector(refreshProjects))
                mark(reload, "retry-projects", label: "Reload projects")
                views.append(reload)
                return .empty(views, "failed|\(text)|" + recoveryKey)
            }
            let notLive = projects.availability == .notLive
            if notLive { quietStatus = localNotice.isEmpty }
            let button = EmptyCircleButton(title: notLive ? "New project · Not live yet" : "New project")
            mark(button, "new-project-empty")
            button.target = self; button.action = #selector(newProject)
            button.isEnabled = !notLive && projects.canMutate
            views.append(button)
            return .empty(views, "new|\(notLive)|\(projects.canMutate)|" + recoveryKey)
        }
        var rows: [ColumnStackView.Row] = []
        if recovery { rows.append(.init(view: recoveryBanner(), height: 44, gap: 0)) }
        for (index, project) in projects.projects.enumerated() {
            let row = ProjectRowButton(project: project)
            row.tag = index; row.target = self; row.action = #selector(openProject(_:))
            row.onDropFile = { [weak self] url in self?.drop(url, on: project) }
            rows.append(.init(view: row, height: 74))
        }
        if projects.listCursor != nil {
            let more = PillButton(title: "More projects", target: self, action: #selector(nextProjects))
            more.style = .quiet; mark(more, "more-projects", label: "More projects"); more.isEnabled = !projects.busy
            rows.append(.init(view: more, height: 30, centered: true, gap: 14))
        }
        let signature = (["home", recoveryKey, projects.listCursor.map { "\($0)|\(projects.busy)" } ?? ""]
            + projects.projects.map { "\($0.project_id)|\($0.name)|\($0.role)" }).joined(separator: "\n")
        return .list(rows, signature)
    }

    private func searchColumn() -> Column {
        if let recovery = documentRecoveryColumn() { return recovery }
        if showSearchReader, documents.metadata != nil { return documentReader() }
        if showSearchReader, let content = uploads.content {
            reader.show(id: "saved|" + content.context_id, title: content.title,
                        meta: audienceText(content.audience) + " · " + RelativeTime.text(content.received_at), text: content.text)
            reader.actions.menuProvider = { [weak self] in self?.savedActions() }
            return .reader
        }
        if !uploads.matches.isEmpty || !documents.matches.isEmpty {
            var rows = uploads.matches.enumerated().map { index, match -> ColumnStackView.Row in
                let row = ItemRowButton(title: match.title, visibility: match.visibility, receivedAt: match.received_at)
                row.tag = index; row.target = self; row.action = #selector(openResult(_:))
                return .init(view: row, height: 56)
            }
            rows += documentRows()
            return .list(rows, (["search", documents.nextCursor ?? "", String(documents.busy)] + uploads.matches.map(\.context_id) + documents.matches.map(\.renderKey)).joined(separator: "\n"))
        }
        if uploads.busy || documents.busy { return .empty([spinner()], "search-loading") }
        if uploads.status == "No matching context you can read." {
            return .empty([label("No matches", size: 14, color: EchoTheme.faintText)], "no-matches")
        }
        return .none
    }

    private func projectColumn() -> Column {
        if let recovery = documentRecoveryColumn() { return recovery }
        guard let selected = projects.selected else {
            if projects.busy { return .empty([spinner()], "project-loading") }
            // The project did not open, or stopped being readable: say so
            // here, with its recovery (if any) and a reload; Back goes home.
            let recovery = projects.needsRecoveryReview
            var views: [NSView] = recovery ? [sized(recoveryBanner(centered: true), width: 520, height: 44)] : []
            var text = projects.notice
            if recovery, text == ProjectFailure.uncertain.message { text = "" }
            if text.isEmpty, !recovery { text = "This project is no longer available to you." }
            if !text.isEmpty {
                let message = NSTextField(wrappingLabelWithString: text)
                message.font = .systemFont(ofSize: 13); message.textColor = EchoTheme.faintText; message.alignment = .center
                message.preferredMaxLayoutWidth = 420
                views.append(message)
            }
            if lastOpenedProjectID != nil, projects.identity != nil {
                let reload = pill("Reload project", .quiet, height: 30, target: self, action: #selector(reloadProject))
                mark(reload, "reload-project", label: "Reload project"); reload.isEnabled = !projects.hasOutstandingMutation
                views.append(reload)
            }
            quietStatus = localNotice.isEmpty
            return .empty(views, "project-lost|\(text)|\(recovery)|\(projects.pending != nil)|\(projects.identity != nil)")
        }
        if documents.metadata != nil { return documentReader() }
        if let content = projects.content {
            // The audience is only worth a word when it is not this project.
            let own = content.audience.kind == .project && content.audience.project_id == selected.project_id
            reader.show(id: "project|" + content.context_id, title: content.title,
                        meta: own ? RelativeTime.text(content.received_at)
                            : audienceText(content.audience) + " · " + RelativeTime.text(content.received_at), text: content.text)
            reader.actions.menuProvider = { [weak self] in self?.projectActions() }
            return .reader
        }
        if !projects.items.isEmpty || !documents.matches.isEmpty {
            var rows = projects.items.enumerated().map { index, item -> ColumnStackView.Row in
                let row = ItemRowButton(title: item.title, visibility: item.visibility, receivedAt: item.received_at)
                row.tag = index; row.target = self; row.action = #selector(readProjectOriginal(_:))
                return .init(view: row, height: 56)
            }
            if projects.pageCursor != nil {
                let next = PillButton(title: projectSearchShown ? "More results" : "Older", target: self, action: #selector(nextProjectPage))
                next.style = .quiet; mark(next, "next-page"); next.isEnabled = !projects.busy
                rows.append(.init(view: next, height: 30, centered: true, gap: 14))
            }
            rows += documentRows()
            let signature = (["project", selected.project_id, String(projectSearchShown), documents.nextCursor ?? "", String(documents.busy), projects.pageCursor.map { "\($0)|\(projects.busy)" } ?? ""]
                + projects.items.map(\.context_id) + documents.matches.map(\.renderKey)).joined(separator: "\n")
            return .list(rows, signature)
        }
        if projects.busy || documents.busy { return .empty([spinner()], "project-loading") }
        if projectSearchShown { return .empty([label("No matches", size: 14, color: EchoTheme.faintText)], "project-no-matches") }
        if peopleSheet.isPresented || restorePending != nil || projects.availability != .live { return .none }
        let write = EmptyCircleButton(title: "Write")
        mark(write, "write-empty")
        write.target = self; write.action = #selector(writeHere)
        write.isEnabled = uploads.identity != nil
        return .empty([write], "project-empty|\(selected.project_id)|\(uploads.identity != nil)")
    }

    private func documentRows() -> [ColumnStackView.Row] {
        var rows = documents.matches.enumerated().map { index, document -> ColumnStackView.Row in
            let row = ItemRowButton(title: document.title, visibility: document.audience.kind, receivedAt: document.received_at, detail: document.display)
            row.tag = index; row.target = self; row.action = #selector(openDocument(_:)); mark(row, "document-row", label: document.title)
            return .init(view: row, height: 56)
        }
        if documents.nextCursor != nil {
            let more = pill("More documents", .quiet, height: 30, target: self, action: #selector(moreDocuments))
            more.isEnabled = !documents.busy; rows.append(.init(view: more, height: 30, centered: true, gap: 14))
        }
        return rows
    }
    private func documentReader() -> Column {
        guard let document = documents.metadata else { return .none }
        let text = documents.page?.display ?? ""
        reader.show(id: "document|" + document.renderKey, title: document.title, meta: document.display,
                    text: text.isEmpty ? document.stateMessage : text, extracted: true)
        reader.actions.menuProvider = { [weak self] in self?.documentActions() }
        return .reader
    }
    private func documentActions() -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        for (title, action, enabled) in [("Save original…", #selector(saveDocument), !documents.busy),
                                        ("Next text page", #selector(nextDocumentPage), !documents.busy && documents.page?.next_cursor != nil),
                                        ("Refresh document", #selector(refreshDocument), !documents.busy)] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: ""); item.target = self; item.isEnabled = enabled; menu.addItem(item)
        }
        if documents.pendingAssociation != nil {
            let retry = NSMenuItem(title: "Retry project-link change", action: #selector(retryDocumentAssociation), keyEquivalent: "")
            retry.target = self; retry.isEnabled = !documents.busy; menu.addItem(retry)
        } else if let document = documents.metadata {
            // V2 keeps every project association, independently of the
            // plural audience. A V1 original has at most one legacy link.
            let linked = document.association_project_ids ?? document.project_id.map { [$0] } ?? []
            let available = projects.availability == .live ? projects.projects : []
            let currentProject = mode == .project ? projects.selected?.project_id : nil
            if let currentProject, linked.contains(currentProject) {
                // Inside a project reader, only remove the current project's
                // link. Other associations are never silently changed.
                let remove = NSMenuItem(title: "Remove this project link (keep audience)", action: #selector(dissociateDocument(_:)), keyEquivalent: "")
                remove.target = self; remove.representedObject = currentProject; remove.isEnabled = !documents.busy; menu.addItem(remove)
            } else if mode != .project, !linked.isEmpty {
                // Outside a project, expose only links whose projects are in
                // the caller's current authorized project list.
                let remove = NSMenuItem(title: "Remove project link (keep audience)", action: nil, keyEquivalent: "")
                let choices = NSMenu(); choices.autoenablesItems = false
                for project in available where linked.contains(project.project_id) {
                    let item = NSMenuItem(title: project.name, action: #selector(dissociateDocument(_:)), keyEquivalent: "")
                    item.target = self; item.representedObject = project.project_id; item.isEnabled = !documents.busy; choices.addItem(item)
                }
                remove.submenu = choices; remove.isEnabled = !documents.busy && !choices.items.isEmpty; menu.addItem(remove)
            }
            let add = NSMenuItem(title: "Link to project (keep audience)", action: nil, keyEquivalent: "")
            let choices = NSMenu(); choices.autoenablesItems = false
            for project in available where !linked.contains(project.project_id) {
                let item = NSMenuItem(title: project.name, action: #selector(associateDocument(_:)), keyEquivalent: "")
                item.target = self; item.representedObject = project.project_id; item.isEnabled = !documents.busy; choices.addItem(item)
            }
            add.submenu = choices; add.isEnabled = !documents.busy && !choices.items.isEmpty; menu.addItem(add)
        }
        return menu
    }
    @objc private func associateDocument(_ sender: NSMenuItem) {
        guard let document = documents.metadata, let projectID = sender.representedObject as? String else { return }
        documents.associate(document.document_id, projectID: projectID, add: true)
    }
    @objc private func dissociateDocument(_ sender: NSMenuItem) {
        guard let document = documents.metadata, let projectID = sender.representedObject as? String else { return }
        documents.associate(document.document_id, projectID: projectID, add: false)
    }
    @objc private func retryDocumentAssociation() { documents.retryAssociation() }
    @objc private func openDocument(_ sender: NSButton) {
        guard documents.matches.indices.contains(sender.tag), !documents.busy else { return }
        showSearchReader = true; documents.read(documents.matches[sender.tag].document_id)
    }
    @objc private func moreDocuments() { documents.more() }
    @objc private func nextDocumentPage() { documents.nextTextPage() }
    @objc private func refreshDocument() { if let document = documents.metadata { documents.read(document.document_id) } }
    @objc private func saveDocument() {
        guard let document = documents.metadata, !documents.busy else { return }
        let identity = documents.identity
        let panel = NSSavePanel(); panel.nameFieldStringValue = document.filename
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let url = panel.url, self.documents.identity == identity,
                  self.documents.metadata?.document_id == document.document_id else { return }
            self.documents.download(document, to: url)
        }
    }

    private func audienceText(_ audience: UploadAudience) -> String {
        switch audience.kind {
        case .onlyMe: return "Only you"
        case .team: return "Everyone in your organization"
        case .project:
            let id = audience.project_id
            let name = projects.projects.first(where: { $0.project_id == id })?.name
                ?? (projects.selected?.project_id == id ? projects.selected?.name : nil)
            return name.map { "Members of \($0)" } ?? "Project members"
        case .projects: return "Members of selected projects"
        }
    }

    private func projectActions() -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        let remove = NSMenuItem(title: "Remove from this project", action: #selector(dissociateOriginal), keyEquivalent: "")
        remove.target = self; remove.isEnabled = projects.canMutate
        menu.addItem(remove)
        return menu
    }

    private func savedActions() -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        let add = NSMenuItem(title: "Add to project", action: nil, keyEquivalent: "")
        let choices = NSMenu(); choices.autoenablesItems = false
        let live = projects.availability == .live ? projects.projects : []
        for project in live {
            let item = NSMenuItem(title: project.name, action: #selector(associateOriginal(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = project.project_id; item.isEnabled = projects.canMutate
            choices.addItem(item)
        }
        add.submenu = choices; add.isEnabled = !live.isEmpty && projects.canMutate
        menu.addItem(add)
        return menu
    }

    // MARK: Actions

    @objc private func toggleSidebar() {
        sidebarOpen.toggle(); sidebarWidth?.constant = sidebarOpen ? 220 : 0
        sidebar.isHidden = !sidebarOpen
        sidebarToggle.setAccessibilityLabel(sidebarOpen ? "Hide sidebar" : "Show sidebar")
    }

    @objc private func goBack() {
        // A sheet owns Escape and all its draft/discard policy. Main-window
        // navigation must not leak through to the page beneath it.
        guard window.attachedSheet == nil else { return }
        localNotice = ""
        switch mode {
        case .home: return
        case .ask:
            if askSubPage?() != nil { closeAskSubPage?(); return }
            if askReturnProject {
                askReturnProject = false; askScope = .global
                if let origin = askOrigin { askOrigin = nil; returnToProjectOrigin(origin) }
                else if projects.selected != nil { mode = .project; requestFeed() }
                else { mode = .home; refresh() }
            } else {
                askScope = .global
                mode = .home
                if projects.projects.isEmpty, !projects.busy, uploads.identity != nil { projects.discover() }
                refresh()
            }
        case .search:
            if showSearchReader { showSearchReader = false; refresh() } else { goHome() }
        case .project:
            if documents.metadata != nil {
                documents.closeReader(); showSearchReader = false; refresh()
            } else if projects.selected != nil, projects.content != nil || projectSearchShown {
                askField.stringValue = ""; requestFeed()
            } else if createOrigin != nil {
                returnToCreateOrigin()
            } else { goHome(preservingHomePlace: true) }
        }
    }

    /// Return from a project to the paged Home list it was opened from. Account,
    /// access, concealment, and unrelated routes still clear all restore state.
    private func goHome(preservingHomePlace: Bool = false) {
        let place = preservingHomePlace ? homePlace : nil
        documents.clear(); documentScope = nil
        mode = .home; askField.stringValue = ""; projectSearchShown = false; showSearchReader = false
        clearPresentationRestore(); homePlace = place; askScope = .global; askReturnProject = false
        clearPendingIntents()
        projects.discover(); onConceal?(); refresh()
        window.makeFirstResponder(askField)
    }

    private func requestFeed() {
        documents.clear(); documentScope = nil
        projectSearchShown = false; clearPendingIntents()
        if projects.busy { restorePending = .feed; refresh() } else { projects.feed() }
    }

    @objc private func askSubmitted() {
        let question = askField.stringValue
        guard !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        localNotice = ""
        switch mode {
        case .home:
            // Clear only after the controller accepts a valid, non-duplicate
            // request. Invalid input and a question entered while pending stay
            // available for the person to revise or send later.
            guard acceptAsk(question, scope: .global) else { return }
            askField.stringValue = ""
            homePlace = shownHome(); askOrigin = nil
            askScope = .global
            askReturnProject = false
            mode = .ask; refresh()
        case .ask:
            guard acceptAsk(question, scope: askScope) else { return }
            askField.stringValue = ""
            mode = .ask; refresh()
        case .search:
            showSearchReader = false; uploads.search(question); documents.search(question)
        case .project:
            guard let project = projects.selected else { return }
            let scope = AskScope.project(id: project.project_id, name: project.name)
            guard acceptAsk(question, scope: scope) else { return }
            askField.stringValue = ""
            askOrigin = currentProjectOrigin()
            askReturnProject = true
            askScope = scope
            mode = .ask; refresh()
        }
    }

    private func acceptAsk(_ question: String, scope: AskScope) -> Bool {
        switch onAsk(question, scope) {
        case .accepted: return true
        case .rejected(let message):
            localNotice = message
            refresh()
            return false
        }
    }

    @objc private func clearSearch() {
        askField.stringValue = ""; requestFeed()
        window.makeFirstResponder(askField)
    }

    @objc private func openProject(_ sender: NSButton) {
        guard projects.projects.indices.contains(sender.tag), !projects.hasOutstandingMutation, uploads.identity != nil else { return }
        let project = projects.projects[sender.tag]
        // Preserve the visible Home page count and position before opening a
        // project; Back reloads pages through the normal authorized list port.
        homePlace = shownHome()
        createOrigin = nil; restoreDocumentID = nil; listPlace = nil
        mode = .project; openProjectName = project.name; lastOpenedProjectID = project.project_id
        projectSearchShown = false; restorePending = nil; clearPendingIntents()
        askField.stringValue = ""; localNotice = ""; onConceal?()
        projects.open(project.project_id)
        refresh()
    }

    @objc private func readProjectOriginal(_ sender: NSButton) {
        guard projects.items.indices.contains(sender.tag) else { return }
        documents.closeReader()
        listPlace = shownList()
        let context = projects.items[sender.tag].context_id
        // A click during a load is kept and replayed once it ends.
        if projects.busy { pendingRead = context; pendingSearch = nil; return }
        projects.read(context)
    }

    @objc private func reloadProject() {
        guard mode == .project, let id = lastOpenedProjectID, !projects.hasOutstandingMutation, projects.identity != nil else { return }
        localNotice = ""; restorePending = nil; clearPendingIntents()
        projects.open(id); refresh()
    }

    @objc private func openResult(_ sender: NSButton) {
        guard uploads.matches.indices.contains(sender.tag) else { return }
        showSearchReader = true; documents.closeReader()
        uploads.read(uploads.matches[sender.tag].context_id)
    }

    @objc private func nextProjects() { projects.nextProjects() }
    @objc private func nextProjectPage() { projects.nextPage() }
    @objc private func retryProject() { projects.retry() }

    @objc private func dismissRecovery() {
        let identity = projects.identity
        confirm("Dismiss the earlier change?", detail: "It may have completed. Refresh before changing it again.",
                action: "Dismiss", on: window) { [weak self] in
            // Only the account whose change this alert was shown for.
            guard let self, identity != nil, self.projects.identity == identity else { return }
            self.projects.abandonPending(); self.projects.discover()
        }
    }

    @objc private func refreshProjects() {
        guard !hasOutstandingMutation, !uploads.busy else { return }
        refreshingProjects = true; uploads.refreshIdentity()
    }

    @objc private func dissociateOriginal() {
        guard let original = projects.content, let selected = projects.selected else { return }
        projects.associate(original.context_id, project: selected.project_id, add: false)
    }

    @objc private func associateOriginal(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let original = uploads.content,
              let project = projects.projects.first(where: { $0.project_id == id }), projects.canMutate else { return }
        mode = .project; openProjectName = project.name; lastOpenedProjectID = project.project_id
        showSearchReader = false; projectSearchShown = false; restorePending = nil; clearPendingIntents()
        askField.stringValue = ""; localNotice = ""
        projects.associate(original.context_id, project: project.project_id, add: true)
        refresh()
    }

    @objc func startWrite() {
        guard window.attachedSheet == nil else { return }
        composeSheet.present(over: window, session: uploads, projects: projects, target: defaultTarget(), placeholder: "What happened?")
    }

    @objc private func writeHere() {
        guard window.attachedSheet == nil, let selected = projects.selected else { return }
        composeSheet.present(over: window, session: uploads, projects: projects,
                             target: .project(selected.project_id, selected.name), placeholder: "What happened?")
    }

    private func drop(_ file: URL, on project: ProjectSummary) {
        openDropped(file, target: .project(project.project_id, project.name))
    }

    /// A file dropped on a project preselects that association. Else there is
    /// no association. Either path still starts with private sharing.
    private func dropOnWindow(_ file: URL) {
        openDropped(file, target: defaultTarget())
    }

    private func openDropped(_ file: URL, target: ComposeTarget) {
        guard window.attachedSheet == nil else { return }
        guard DocumentSnapshot.supports(file) else {
            localNotice = "Choose TXT, Markdown, PDF, or DOCX up to 25 MiB."; refresh(); return
        }
        localNotice = ""
        if !NSApp.isActive { NSApp.activate(); window.makeKeyAndOrderFront(nil) }
        presentCompose(target: target, placeholder: "What happened?", file: file)
        refresh()
    }

    @objc private func captureAction() { capture() }

    @objc private func newProject() {
        guard window.attachedSheet == nil, projects.canMutate else { return }
        if mode == .home { homePlace = shownHome() }
        createdInSheet = false
        createOrigin = currentProjectOrigin()
        createSheet.present(over: window, projects: projects, uploads: uploads)
    }

    @objc private func showProjectPeople() {
        guard mode == .project, projects.selected != nil, window.attachedSheet == nil, !projects.busy else { return }
        // Opening People reloads the roster, which clears the column: bring
        // back what was shown (the original, the search, or the feed).
        if let content = projects.content { peopleRestore = .read(content.context_id) }
        else if projectSearchShown, let query = shownProjectQuery { listPlace = shownList(); peopleRestore = .search(query) }
        else { listPlace = shownList(); peopleRestore = .feed }
        peopleSheet.present(over: window, projects: projects)
    }

    @objc private func showAccount() {
        accountMenu?.popUp(positioning: nil, at: NSPoint(x: 20, y: 8), in: accountRow)
    }

    @objc private func signIn(_ sender: NSButton) {
        accountMenu?.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    // MARK: Layout

    private func configure() {
        window.title = "ECHO"; window.delegate = self; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 800, height: 580)
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = EchoTheme.ink
        // Full-size content: the sidebar runs under the traffic lights, and
        // the page title is centred on the content column, not the window.
        window.titlebarAppearsTransparent = true; window.titleVisibility = .hidden
        (window as? ProjectsWindow)?.onCancel = { [weak self] in self?.goBack() }
        (window as? ProjectsWindow)?.onBack = { [weak self] in
            guard self?.window.attachedSheet == nil else { return }
            self?.goBack()
        }

        mark(sidebarToggle, "sidebar-toggle", label: "Show sidebar")
        sidebarToggle.target = self; sidebarToggle.action = #selector(toggleSidebar)
        mark(back, "back-button", label: "Back")
        back.target = self; back.action = #selector(goBack)
        let leftHost = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 28))
        sidebarToggle.frame = NSRect(x: 8, y: 2, width: 26, height: 24)
        back.frame = NSRect(x: 38, y: 2, width: BackButton.maximumWidth, height: 24)
        // AppKit grows the accessory to the titlebar height: stay centred.
        sidebarToggle.autoresizingMask = [.minYMargin, .maxYMargin]; back.autoresizingMask = [.minYMargin, .maxYMargin]
        leftHost.addSubview(sidebarToggle); leftHost.addSubview(back)
        let left = NSTitlebarAccessoryViewController(); left.view = leftHost; left.layoutAttribute = .left
        window.addTitlebarAccessoryViewController(left)
        peopleButton.target = self; peopleButton.action = #selector(showProjectPeople)
        let rightHost = NSView(frame: NSRect(x: 0, y: 0, width: 84, height: 28))
        peopleButton.frame = NSRect(x: 0, y: 0, width: 84, height: 28)
        peopleButton.autoresizingMask = [.minYMargin, .maxYMargin]
        rightHost.addSubview(peopleButton)
        let right = NSTitlebarAccessoryViewController(); right.view = rightHost; right.layoutAttribute = .right
        window.addTitlebarAccessoryViewController(right)

        mark(captureRow, "sidebar-capture", label: "Capture"); captureRow.trailing = "⌘⇧E"
        mark(newProjectRow, "sidebar-new-project")
        accountRow.target = self; accountRow.action = #selector(showAccount)
        let rows = NSStackView(views: [captureRow, newProjectRow])
        rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 2
        rows.setHuggingPriority(.required, for: .vertical)
        sidebar.isHidden = true

        mark(askField, "ask-field", label: "Ask ECHO")
        askField.font = .systemFont(ofSize: 15); askField.textColor = EchoTheme.text
        askField.isBordered = false; askField.drawsBackground = false; askField.focusRingType = .none
        askField.cell?.isScrollable = true; askField.cell?.wraps = false; askField.maximumNumberOfLines = 1
        askField.cell?.sendsActionOnEndEditing = false
        askField.target = self; askField.action = #selector(askSubmitted); askField.delegate = self
        askField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        askField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        mark(writeButton, "write-button", label: "Write"); writeButton.target = self; writeButton.action = #selector(startWrite)
        mark(sendButton, "submit-button", label: "Submit"); sendButton.target = self; sendButton.action = #selector(askSubmitted)
        mark(clearButton, "clear-search", label: "Clear search"); clearButton.target = self; clearButton.action = #selector(clearSearch)
        clearButton.isHidden = true
        statusLine.alignment = .center
        statusLine.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // Up to two lines, so a longer notice is read, not cut off.
        statusLine.cell?.wraps = true; statusLine.lineBreakMode = .byWordWrapping
        statusLine.maximumNumberOfLines = 2; statusLine.preferredMaxLayoutWidth = 496
        statusLine.cell?.truncatesLastVisibleLine = true

        let bar = BarBackgroundView()
        for view in [writeButton, askField, clearButton, sendButton] { view.translatesAutoresizingMaskIntoConstraints = false; bar.addSubview(view) }
        mark(content, "content-drop")
        titleLabel.alignment = .center
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [scroll, reader, emptyHost, answerContainer, statusLine, bar] {
            view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view)
        }
        for view in [rows, accountRow] { view.translatesAutoresizingMaskIntoConstraints = false; sidebar.addSubview(view) }
        guard let root = window.contentView, let below = window.contentLayoutGuide as? NSLayoutGuide else { return }
        for view in [sidebar, content, titleLabel] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        let titlebar = NSLayoutGuide(); root.addLayoutGuide(titlebar)
        let region = NSLayoutGuide(); content.addLayoutGuide(region)
        let width = sidebar.widthAnchor.constraint(equalToConstant: 0); sidebarWidth = width
        fieldToSend = askField.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -10)
        fieldToClear = askField.trailingAnchor.constraint(equalTo: clearButton.leadingAnchor, constant: -6)
        let listHeight = scroll.heightAnchor.constraint(equalTo: region.heightAnchor, constant: -140)
        listHeight.priority = .defaultHigh
        let titleRoom = titleLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 520); self.titleRoom = titleRoom
        let listCentre = scroll.centerYAnchor.constraint(equalTo: region.centerYAnchor)
        listCentre.priority = NSLayoutConstraint.Priority(740)
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor), sidebar.topAnchor.constraint(equalTo: root.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor), width,
            rows.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 10),
            rows.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -10),
            rows.topAnchor.constraint(equalTo: below.topAnchor, constant: 8),
            accountRow.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            accountRow.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -1),
            accountRow.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            accountRow.heightAnchor.constraint(equalToConstant: 58),

            content.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor), content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            content.topAnchor.constraint(equalTo: below.topAnchor), content.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            titlebar.topAnchor.constraint(equalTo: root.topAnchor), titlebar.bottomAnchor.constraint(equalTo: below.topAnchor),
            titleLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: titlebar.centerYAnchor),
            titleLabel.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -64),
            titleRoom,

            bar.centerXAnchor.constraint(equalTo: content.centerXAnchor), bar.widthAnchor.constraint(equalToConstant: 520),
            bar.heightAnchor.constraint(equalToConstant: 46), bar.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -28),
            statusLine.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12),
            statusLine.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -12),
            statusLine.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -10),

            region.topAnchor.constraint(equalTo: content.topAnchor),
            region.bottomAnchor.constraint(equalTo: statusLine.topAnchor, constant: -10),
            region.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            region.widthAnchor.constraint(equalToConstant: 520),

            scroll.leadingAnchor.constraint(equalTo: region.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: region.trailingAnchor),
            scroll.topAnchor.constraint(greaterThanOrEqualTo: region.topAnchor, constant: 8),
            scroll.bottomAnchor.constraint(lessThanOrEqualTo: region.bottomAnchor),
            listHeight, listCentre,
            emptyHost.leadingAnchor.constraint(equalTo: region.leadingAnchor), emptyHost.trailingAnchor.constraint(equalTo: region.trailingAnchor),
            emptyHost.topAnchor.constraint(equalTo: scroll.topAnchor), emptyHost.bottomAnchor.constraint(equalTo: scroll.bottomAnchor),
            reader.leadingAnchor.constraint(equalTo: region.leadingAnchor), reader.trailingAnchor.constraint(equalTo: region.trailingAnchor),
            reader.topAnchor.constraint(equalTo: region.topAnchor, constant: 8), reader.bottomAnchor.constraint(equalTo: region.bottomAnchor),

            answerContainer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            answerContainer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            answerContainer.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            answerContainer.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -12),

            writeButton.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 6), writeButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            writeButton.widthAnchor.constraint(equalToConstant: 34), writeButton.heightAnchor.constraint(equalToConstant: 34),
            sendButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -6), sendButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            sendButton.widthAnchor.constraint(equalToConstant: 34), sendButton.heightAnchor.constraint(equalToConstant: 34),
            clearButton.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -6),
            clearButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            clearButton.widthAnchor.constraint(equalToConstant: 20), clearButton.heightAnchor.constraint(equalToConstant: 20),
            askField.leadingAnchor.constraint(equalTo: writeButton.trailingAnchor, constant: 10),
            askField.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
        ])
        fieldToSend?.isActive = true
        for item in rows.arrangedSubviews { item.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true }
    }
}
