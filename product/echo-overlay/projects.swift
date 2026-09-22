import AppKit
import CryptoKit
import Foundation

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
        if let requestID {
            expected += ["request_id", "mutation_outcome"]
            guard o["request_id"] as? String == requestID else { return nil }
            if code == "outcome_unknown" {
                guard o["mutation_outcome"] as? String == "unknown", ProjectWire.keys(o, expected) else { return nil }
                return ProjectFailure(code: code, status: status, unknown: true)
            }
            guard o["mutation_outcome"] as? String == "not_submitted",
                  status.map({ (400...499).contains($0) }) ?? ["invalid_request", "sign_in_required"].contains(code) else { return nil }
        }
        guard ProjectWire.keys(o, expected), ["invalid_request", "conflict", "invalid_output", "not_found", "stale_access_state", "unauthorized", "rate_limited", "unavailable", "sign_in_required"].contains(code) else { return nil }
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
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 45, execute: timeout)
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
    case directory(String, String, String?), setMember(String, String, String, String), removeMember(String, String, String)
    case associate(String, String, String, Bool), feed(String, String?), search(String, String, String?), readContext(String, String)
    var operation: String {
        switch self {
        case .list: return "list"
        case .create: return "create"
        case .read: return "read"
        case .members: return "members"
        case .directory: return "directory"
        case .setMember: return "member-set"
        case .removeMember: return "member-remove"
        case .associate(_, _, _, let add): return add ? "associate" : "dissociate"
        case .feed: return "feed"
        case .search: return "search"
        case .readContext: return "read-context"
        }
    }
    var projectID: String? {
        switch self {
        case .list, .create: return nil
        case .read(let id), .members(let id, _), .directory(let id, _, _), .setMember(let id, _, _, _),
             .removeMember(let id, _, _), .associate(let id, _, _, _), .feed(let id, _), .search(let id, _, _), .readContext(let id, _): return id
        }
    }
    var requestID: String? {
        switch self {
        case .create(_, let id), .setMember(_, _, _, let id), .removeMember(_, _, let id), .associate(_, _, let id, _): return id
        default: return nil
        }
    }
    var arguments: [String] {
        var args = ["person", "projects", operation]
        if let projectID { args += ["--project-id", projectID] }
        if let requestID { args += ["--request-id", requestID] }
        func page(_ cursor: String?) { args += ["--limit", "10"]; if let cursor { args += ["--cursor", cursor] } }
        switch self {
        case .list(let cursor), .members(_, let cursor), .feed(_, let cursor): page(cursor)
        case .create(let name, _): args += ["--name", name]
        case .directory(_, let query, let cursor), .search(_, let query, let cursor): args += ["--query", query]; page(cursor)
        case .setMember(_, let member, let role, _): args += ["--membership-id", member, "--role", role]
        case .removeMember(_, let member, _): args += ["--membership-id", member]
        case .associate(_, let context, _, _), .readContext(_, let context): args += ["--context-id", context]
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
        func page(_ kind: String, scoped: Bool = true) -> [[String: Any]]? {
            guard header(kind, (scoped ? ["project_id"] : []) + ["items", "next_cursor"]),
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
        case .feed, .search:
            guard let items = page(command.operation == "feed" ? "echo-project-context-feed-v1" : "echo-project-context-search-result-v1"),
                  items.allSatisfy(UploadMatch.validObject), let matches = decode([UploadMatch].self, items),
                  Set(matches.map(\.context_id)).count == matches.count else { return failure }
            return .items(matches, o["next_cursor"] as? String)
        case .readContext(_, let context):
            guard header("echo-project-context-read-v1", ["project_id", "context_id", "received_at", "audience", "title", "text"]),
                  o["project_id"] as? String == command.projectID, o["context_id"] as? String == context,
                  UploadContent.validFields(o), let content = decode(UploadContent.self, o) else { return failure }
            return .content(content)
        case .setMember, .removeMember, .associate:
            let member = command.operation.hasPrefix("member-")
            let field = member ? "membership_id" : "context_id"
            let args = command.arguments; let expected = args[args.firstIndex(of: member ? "--membership-id" : "--context-id")! + 1]
            guard header("echo-project-mutation-receipt-v1", ["request_id", "project_id", "operation", field, "received_at", "state"]),
                  o["request_id"] as? String == command.requestID, o["project_id"] as? String == command.projectID,
                  o["operation"] as? String == command.operation.replacingOccurrences(of: "-", with: "_"),
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
    private(set) var pageCursor: String?
    private(set) var directoryCursor: String?
    private(set) var status = ""
    private(set) var busy = false
    private(set) var hasOutstandingMutation = false
    private(set) var pending: ProjectCommand?
    private(set) var authorizationGeneration = UUID()
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
        clearAll(); identity = account
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
        cancel(); clearScoped(); projects = []; listCursor = nil; concealed = false
        invalidateDrafts(); status = "Loading your projects…"; run(.list(cursor))
    }
    func open(_ project: String) {
        guard !hasOutstandingMutation, identity != nil else { return }
        cancel(); clearScoped(); readForRoster = false; concealed = false; invalidateDrafts()
        status = "Opening project…"; run(.read(project))
    }
    func feed() {
        guard !busy, let selected else { return }
        clearContent(); status = "Loading project context…"; run(.feed(selected.project_id, nil))
    }
    func search(_ source: String) {
        guard !busy, let selected else { return }
        guard let query = uploadQuery(source) else { status = "Search with up to 240 characters and 32 distinct words."; onChange?(); return }
        clearContent(); status = "Searching this project…"; run(.search(selected.project_id, query, nil))
    }
    func read(_ context: String) {
        guard !busy, let selected else { return }
        clearContent(); status = "Loading original text…"; run(.readContext(selected.project_id, context))
    }
    func roster() {
        guard !busy, let selected else { return }
        clearContent(); members = []; candidates = []; status = "Loading project members…"
        readForRoster = true; run(.read(selected.project_id))
    }
    func directory(_ source: String, cursor: String? = nil) {
        guard canManage, let selected, let query = uploadQuery(source) else { return }
        candidates = []; directoryCursor = nil; run(.directory(selected.project_id, query, cursor))
    }
    func nextPage() {
        guard !busy, let page, let cursor = pageCursor else { return }
        clearContent(); members = []
        switch page {
        case .feed(let project, _): run(.feed(project, cursor))
        case .search(let project, let query, _): run(.search(project, query, cursor))
        case .members(let project, _): run(.members(project, cursor))
        default: break
        }
    }
    func create(_ name: String) {
        guard canMutate, ProjectWire.name(name) else { return }
        mutate(.create(name, UUID().uuidString.lowercased()))
    }
    func setMember(_ membership: String, role: String) {
        guard canManage, let selected, ["member", "lead"].contains(role) else { return }
        mutate(.setMember(selected.project_id, membership, role, UUID().uuidString.lowercased()))
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
            onChange?(); return
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
        clearAll(); invalidateDrafts(); onChange?()
    }
    // Recovery locators survive normal termination. A command is not launched
    // until its locator has been acknowledged by the recovery store.
    func shutdown() { cancel(); clearAll(); pending = nil; pendingByAccount = [:] }
    private func invalidateDrafts() { authorizationGeneration = UUID(); onAccessChanged?() }
    private func cancel() { active?.cancel(); active = nil; generation = UUID(); busy = false; hasOutstandingMutation = false }
    private func clearContent() { items = []; content = nil; pageCursor = nil }
    private func clearScoped() { selected = nil; members = []; candidates = []; directoryCursor = nil; page = nil; clearContent() }
    private func clearAll() { projects = []; listCursor = nil; clearScoped() }
    private func run(_ command: ProjectCommand) {
        guard !busy, let identity else { return }
        busy = true; hasOutstandingMutation = command.requestID != nil
        let id = UUID(); generation = id
        active = client.perform(command, identity: identity) { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil; self.busy = false; self.hasOutstandingMutation = false
            guard self.identity == identity else { self.onChange?(); return }
            if self.concealed || !self.foreground() {
                self.clearAll(); self.invalidateDrafts(); self.onChange?(); return
            }
            switch result {
            case .projects(let projects, let cursor):
                self.availability = .live; self.projects = projects; self.listCursor = cursor
                self.status = projects.isEmpty ? "No projects on this page. Create one to start." : "Choose a project."
            case .summary(let project):
                if let selected = self.selected, selected.role != project.role { self.invalidateDrafts() }
                self.selected = project; self.availability = .live
                if self.readForRoster { self.readForRoster = false; self.run(.members(project.project_id, nil)) }
                else { self.feed() }
                return
            case .members(let members, let cursor):
                if command.operation == "directory" { self.candidates = members; self.directoryCursor = cursor }
                else { self.members = members; self.pageCursor = cursor; self.page = command }
                self.status = members.isEmpty ? "No members on this page." : "Current project members. Leads manage membership."
            case .items(let items, let cursor):
                self.items = items; self.pageCursor = cursor; self.page = command
                self.status = items.isEmpty ? "No context you can read on this page." : "Select an original to read."
            case .content(let content): self.content = content; self.status = ""
            case .applied(let project):
                guard ProjectMutationRecovery.clear(for: identity, defaults: self.defaults) else {
                    self.status = "Saved, but could not safely clear project recovery. Retry the same change."
                    self.onChange?(); return
                }
                let key = self.accountKey(identity)
                self.pending = nil; self.pendingByAccount.removeValue(forKey: key); self.recoveryBlockedByAccount.remove(key)
                // Receipts describe the committed operation, not current access
                // or association state. Always issue a fresh authorized read.
                self.open(project); return
            case .failure(let failure):
                self.clearAll(); self.invalidateDrafts()
                if command.operation == "list", failure.code == "not_found", failure.status == 404 {
                    self.availability = .notLive; self.status = "Projects · Not live yet"
                } else {
                    if command.operation == "list" { self.availability = .failed }
                    self.status = failure.message
                }
                // Even a later canonical rejection cannot disprove an earlier
                // committed attempt. Keep the frozen pending command.
            case .accountChanged:
                self.clearAll(); self.identity = nil; self.pending = nil; self.availability = .checking
                self.invalidateDrafts(); self.status = "Your account changed. Reopen ECHO after signing in."
            }
            self.onChange?()
        }
        onChange?()
    }
}

struct ProjectEntry {
    let kind: String
    let title: String
    let body: String
    let when: String
    let isDecision: Bool
}

/// One thing that arrived in a project, drawn like a notification.
final class ProjectEntryView: NSView {
    private let tile = NSView()
    private let kindField = NSTextField(labelWithString: "")
    private let timeField = NSTextField(labelWithString: "")
    private let titleField = NSTextField(labelWithString: "")
    private let bodyField = NSTextField(wrappingLabelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.text.withAlphaComponent(0.08).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 16, yRadius: 16).fill()
    }

    private func build() {
        wantsLayer = true
        tile.wantsLayer = true
        tile.layer?.cornerRadius = 8
        tile.translatesAutoresizingMaskIntoConstraints = false
        addSubview(tile)

        kindField.font = .systemFont(ofSize: 11, weight: .semibold)
        timeField.font = .systemFont(ofSize: 12)
        timeField.textColor = EchoTheme.faintText
        titleField.font = .systemFont(ofSize: 14.5, weight: .semibold)
        titleField.textColor = EchoTheme.text
        titleField.lineBreakMode = .byTruncatingTail
        bodyField.font = .systemFont(ofSize: 13.5)
        bodyField.textColor = EchoTheme.text.withAlphaComponent(0.8)
        bodyField.maximumNumberOfLines = 2
        bodyField.lineBreakMode = .byTruncatingTail

        for field in [kindField, timeField, titleField, bodyField] {
            field.translatesAutoresizingMaskIntoConstraints = false
            addSubview(field)
        }
        timeField.setContentHuggingPriority(.required, for: .horizontal)
        timeField.setContentCompressionResistancePriority(.required, for: .horizontal)

        NSLayoutConstraint.activate([
            tile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            tile.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            tile.widthAnchor.constraint(equalToConstant: 30),
            tile.heightAnchor.constraint(equalToConstant: 30),

            kindField.leadingAnchor.constraint(equalTo: tile.trailingAnchor, constant: 12),
            kindField.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            timeField.leadingAnchor.constraint(greaterThanOrEqualTo: kindField.trailingAnchor, constant: 8),
            timeField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            timeField.firstBaselineAnchor.constraint(equalTo: kindField.firstBaselineAnchor),

            titleField.leadingAnchor.constraint(equalTo: kindField.leadingAnchor),
            titleField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            titleField.topAnchor.constraint(equalTo: kindField.bottomAnchor, constant: 3),

            bodyField.leadingAnchor.constraint(equalTo: kindField.leadingAnchor),
            bodyField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            bodyField.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 2),
            bodyField.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
        ])
    }

    func configure(with entry: ProjectEntry) {
        kindField.stringValue = entry.kind
        kindField.textColor = entry.isDecision ? EchoTheme.goldBright : EchoTheme.faintText
        timeField.stringValue = entry.when
        titleField.stringValue = entry.title
        bodyField.stringValue = entry.body
        tile.layer?.backgroundColor = entry.isDecision
            ? EchoTheme.gold.cgColor
            : EchoTheme.text.withAlphaComponent(0.12).cgColor
    }
}

/// A selectable pill. Used for the audience choice, where the selected one has
/// to be unmistakable before anything is sent.
final class ChipButton: NSButton {
    var selected = false { didSet { needsDisplay = true } }
    var chipHeight: CGFloat = 30 { didSet { invalidateIntrinsicContentSize() } }

    private var chipFont: NSFont { .systemFont(ofSize: 13) }

    override var intrinsicContentSize: NSSize {
        let width = ceil((title as NSString).size(withAttributes: [.font: chipFont]).width)
        return NSSize(width: width + 28, height: chipHeight)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { path().fill() }

    override func draw(_ dirtyRect: NSRect) {
        let shape = path()
        if selected {
            EchoTheme.gold.withAlphaComponent(0.18).setFill()
            shape.fill()
            EchoTheme.gold.setStroke()
        } else {
            if isHighlighted {
                EchoTheme.text.withAlphaComponent(0.10).setFill()
                shape.fill()
            }
            EchoTheme.border.setStroke()
        }
        shape.lineWidth = 1
        shape.stroke()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: chipFont,
            .foregroundColor: selected ? EchoTheme.goldBright : EchoTheme.text,
            .paragraphStyle: paragraph,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            in: NSRect(x: 0, y: floor((bounds.height - size.height) / 2), width: bounds.width, height: ceil(size.height)),
            withAttributes: attributes
        )
    }

    private func path() -> NSBezierPath {
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        return NSBezierPath(roundedRect: inset, xRadius: inset.height / 2, yRadius: inset.height / 2)
    }
}

/// The "To Harbor relaunch ⌄" chip. A plain pill that pops a menu, so the
/// destination reads as a fact rather than a form control.
final class ChipMenuButton: NSButton {
    var choices: [String] = []
    var onChoose: ((Int) -> Void)?
    private var chipFont: NSFont { .systemFont(ofSize: 13.5) }

    override var intrinsicContentSize: NSSize {
        let width = ceil((title as NSString).size(withAttributes: [.font: chipFont]).width)
        return NSSize(width: width + 38, height: 28)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { path().fill() }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.text.withAlphaComponent(isHighlighted ? 0.18 : 0.12).setFill()
        path().fill()

        let attributes: [NSAttributedString.Key: Any] = [
            .font: chipFont,
            .foregroundColor: EchoTheme.text,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            at: NSPoint(x: 12, y: floor((bounds.height - size.height) / 2)),
            withAttributes: attributes
        )

        let chevron = NSBezierPath()
        let centre = NSPoint(x: bounds.maxX - 16, y: bounds.midY + 1)
        chevron.move(to: NSPoint(x: centre.x - 4, y: centre.y + 2))
        chevron.line(to: NSPoint(x: centre.x, y: centre.y - 2))
        chevron.line(to: NSPoint(x: centre.x + 4, y: centre.y + 2))
        chevron.lineWidth = 1.5
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        EchoTheme.mutedText.setStroke()
        chevron.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        let menu = NSMenu()
        for (index, choice) in choices.enumerated() {
            let item = NSMenuItem(title: choice, action: #selector(choose(_:)), keyEquivalent: "")
            item.target = self
            item.tag = index
            item.state = choice == title ? .on : .off
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

/// The dashed box files are dropped into.
final class DropWellView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: inset, xRadius: 10, yRadius: 10)
        shape.lineWidth = 1
        shape.setLineDash([4, 4], count: 2, phase: 0)
        EchoTheme.text.withAlphaComponent(0.24).setStroke()
        shape.stroke()
    }
}

/// A sidebar entry: icon, label, and nothing else.
final class SidebarRowButton: NSButton {
    private var labelFont: NSFont { .systemFont(ofSize: 13.5) }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 32)
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }

    override func draw(_ dirtyRect: NSRect) {
        if isHighlighted {
            EchoTheme.text.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        }
        var textLeading: CGFloat = 10
        if let image {
            let box = NSRect(x: 10, y: floor((bounds.height - 16) / 2), width: 16, height: 16)
            image.isTemplate = true
            EchoTheme.mutedText.set()
            image.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            textLeading = box.maxX + 10
        }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: EchoTheme.text,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            at: NSPoint(x: textLeading, y: floor((bounds.height - size.height) / 2)),
            withAttributes: attributes
        )
    }
}

private final class ProjectsWindow: NSWindow {
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
        return super.performKeyEquivalent(with: event)
    }
}

@MainActor
private func circleButton(symbol: String, label: String, filled: Bool,
                          target: AnyObject, action: Selector) -> NSButton {
    let button = NSButton()
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 17
    button.layer?.backgroundColor = filled
        ? EchoTheme.gold.cgColor
        : EchoTheme.text.withAlphaComponent(0.10).cgColor
    button.contentTintColor = filled ? EchoTheme.inkDeep : EchoTheme.text
    button.target = target
    button.action = action
    button.setAccessibilityLabel(label)
    button.translatesAutoresizingMaskIntoConstraints = false
    return button
}

// MARK: - Write sheet

/// Two steps and no more: what it is, then who can see it. The audience is
/// never guessed, and the text stays on screen while it is chosen.
@MainActor
final class ProjectWriteSheet: NSObject {
    private let sheet = ProjectsWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 620),
        styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
    private let title = NSTextField()
    private let body = NSTextView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let audienceRow = NSStackView()
    private let consequence = NSTextField(wrappingLabelWithString: "")
    private let availability = NSTextField(wrappingLabelWithString: "Not live yet: attachments and Undo after saving.")
    private let next = PillButton(title: "Continue", target: nil, action: nil)
    private let save = PillButton(title: "Save", target: nil, action: nil)
    private let check = PillButton(title: "Check status", target: nil, action: nil)
    private let retry = PillButton(title: "Retry same save", target: nil, action: nil)
    private let another = PillButton(title: "New note", target: nil, action: nil)
    private let back = NSButton(title: "Back", target: nil, action: nil)
    private let closeButton = NSButton(title: "Cancel", target: nil, action: nil)
    private let attach = NSButton(title: "Choose text file…", target: nil, action: nil)
    private var chips: [ChipButton] = []
    private let destination = NSPopUpButton()
    private let audienceProject = NSPopUpButton()
    private var projectChoices: [ProjectSummary] = []
    private var projects: ProjectSession?
    private var admittedAuthorization: UUID?
    private var visibility = UploadVisibility.onlyMe
    private var confirming = false
    private var session: UploadSession?
    private var admittedIdentity: AccountIdentity?
    var isPresented: Bool { sheet.sheetParent != nil }

    override init() { super.init(); build() }
    func present(over parent: NSWindow, session: UploadSession, projects: ProjectSession? = nil) {
        guard !isPresented else { return }
        self.session = session; admittedIdentity = session.identity; self.projects = projects
        admittedAuthorization = projects?.authorizationGeneration
        projectChoices = projects?.availability == .live ? (projects?.projects ?? []) : []
        if let selected = projects?.selected, !projectChoices.contains(where: { $0.project_id == selected.project_id }) { projectChoices.append(selected) }
        destination.removeAllItems(); destination.addItem(withTitle: "No project")
        audienceProject.removeAllItems(); audienceProject.addItem(withTitle: "Choose audience project")
        for project in projectChoices {
            destination.menu?.addItem(NSMenuItem(title: project.name, action: nil, keyEquivalent: ""))
            audienceProject.menu?.addItem(NSMenuItem(title: project.name, action: nil, keyEquivalent: ""))
        }
        if let selected = projects?.selected, let index = projectChoices.firstIndex(where: { $0.project_id == selected.project_id }) { destination.selectItem(at: index + 1) }
        title.stringValue = ""; body.string = ""; visibility = .onlyMe; confirming = false
        refresh()
        parent.beginSheet(sheet)
        sheet.makeFirstResponder(body)
    }
    func refresh() {
        guard let session else { return }
        if admittedIdentity != session.identity {
            title.stringValue = ""; body.string = ""; confirming = false; visibility = .onlyMe
            admittedIdentity = session.identity
        }
        if admittedAuthorization != projects?.authorizationGeneration { projectAccessChanged() }
        let compose = session.canCompose
        title.isEnabled = compose; body.isEditable = compose; attach.isEnabled = compose
        status.stringValue = session.status
        next.isHidden = confirming || !compose
        next.isEnabled = compose
        audienceRow.isHidden = !confirming || !compose
        consequence.isHidden = !confirming || !compose
        save.isHidden = !confirming || !compose
        destination.isEnabled = compose && projects?.availability == .live
        audienceProject.isHidden = !confirming || !compose || visibility != .project
        audienceProject.isEnabled = compose && !projectChoices.isEmpty
        save.isEnabled = compose && (visibility != .project || selectedProject(audienceProject) != nil)
        back.isHidden = !confirming || !compose
        check.isHidden = session.recovery == nil || session.receipt != nil
        check.isEnabled = !session.busy
        retry.isHidden = session.draft == nil || session.receipt != nil
        retry.isEnabled = !session.busy
        another.isHidden = session.recovery == nil
        another.isEnabled = !session.busy
        closeButton.isEnabled = !session.hasOutstandingMutation
        closeButton.title = session.receipt == nil ? "Cancel" : "Done"
        for (index, chip) in chips.enumerated() {
            chip.selected = index == (visibility == .onlyMe ? 0 : visibility == .team ? 1 : 2)
            chip.isEnabled = compose && (index != 2 || (!projectChoices.isEmpty && projects?.availability == .live))
        }
        switch visibility {
        case .onlyMe: consequence.stringValue = "Only you can read this note, even when associated with a project."
        case .team: consequence.stringValue = "Everyone currently in your organization can read this note."
        case .project:
            let name = selectedProject(audienceProject)?.name ?? "the selected audience project"
            consequence.stringValue = "Current members of \(name) can read this note. New members may read it too."
        }
        if let project = selectedProject(destination) { consequence.stringValue += " Destination: \(project.name). This does not widen its audience." }
    }
    private func selectedProject(_ picker: NSPopUpButton) -> ProjectSummary? {
        let index = picker.indexOfSelectedItem - 1
        return projectChoices.indices.contains(index) ? projectChoices[index] : nil
    }
    func projectAccessChanged() {
        let affected = visibility == .project || selectedProject(destination) != nil
        admittedAuthorization = projects?.authorizationGeneration
        projectChoices = []; destination.removeAllItems(); destination.addItem(withTitle: "No project")
        audienceProject.removeAllItems(); audienceProject.addItem(withTitle: "Choose audience project")
        if affected {
            title.stringValue = ""; body.string = ""; confirming = false; visibility = .onlyMe
            if session?.hasOutstandingMutation != true { sheet.sheetParent?.endSheet(sheet) }
        }
    }
    func accountWillChange() {
        title.stringValue = ""; body.string = ""
        if session?.hasOutstandingMutation != true { sheet.sheetParent?.endSheet(sheet) }
        refresh()
    }
    @objc private func continueToAudience() {
        guard session?.canCompose == true else { return }
        if title.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Suggest a bounded title without modifying the original text.
            title.stringValue = suggestedTitle(body.string)
        }
        guard !body.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              body.string.utf8.count <= 8192, title.stringValue.utf8.count <= 200 else {
            status.stringValue = "Use nonempty text up to 8 KiB."; return
        }
        confirming = true; refresh()
    }
    private func suggestedTitle(_ source: String) -> String {
        var suggestion = source.split(whereSeparator: { $0.isNewline }).lazy.map {
            String($0).components(separatedBy: .controlCharacters).joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }.first(where: { !$0.isEmpty }) ?? "Note"
        while suggestion.utf8.count > 200 { suggestion.removeLast() }
        return suggestion.isEmpty ? "Note" : suggestion
    }
    @objc private func pickAudience(_ sender: ChipButton) {
        guard session?.canCompose == true else { return }
        visibility = sender.tag == 0 ? .onlyMe : sender.tag == 1 ? .team : .project; refresh()
    }
    @objc private func saveNote() {
        guard session?.canCompose == true, admittedIdentity == session?.identity,
              admittedAuthorization == projects?.authorizationGeneration,
              visibility != .project || selectedProject(audienceProject) != nil else { return }
        session?.submit(title: title.stringValue, text: body.string, visibility: visibility,
            audienceProjectID: visibility == .project ? selectedProject(audienceProject)?.project_id : nil,
            projectID: selectedProject(destination)?.project_id)
    }
    @objc private func checkSave() { session?.checkStatus() }
    @objc private func retrySave() { session?.retry() }
    @objc private func newNote() {
        guard let session, !session.busy else { return }
        if session.receipt == nil && session.recovery != nil {
            let alert = NSAlert(); alert.messageText = "Start another note?"
            alert.informativeText = "The previous save may have completed. Check its status or search first to avoid a duplicate."
            alert.addButton(withTitle: "Start another note"); alert.addButton(withTitle: "Keep previous save")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        session.startAnother(); title.stringValue = ""; body.string = ""; confirming = false; visibility = .onlyMe; refresh()
    }
    @objc private func projectChoiceChanged() { refresh() }
    @objc private func goBack() { confirming = false; refresh() }
    @objc private func close() {
        guard session?.hasOutstandingMutation != true else { return }
        sheet.sheetParent?.endSheet(sheet)
    }
    @objc private func chooseFile() {
        guard session?.canCompose == true else { return }
        let picker = NSOpenPanel(); picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        picker.message = "Choose a UTF-8 text file up to 8 KiB."
        picker.beginSheetModal(for: sheet) { [weak self] response in
            guard let self, response == .OK, let file = picker.url, self.session?.canCompose == true else { return }
            do {
                let bytes = try UploadDraft.readFile(file)
                self.body.string = String(decoding: bytes, as: UTF8.self)
                self.title.stringValue = self.suggestedTitle(file.deletingPathExtension().lastPathComponent)
            } catch { self.status.stringValue = "Choose a nonempty UTF-8 text file up to 8 KiB." }
        }
    }
    private func build() {
        sheet.title = "Save context"; sheet.appearance = NSAppearance(named: .darkAqua)
        sheet.backgroundColor = EchoTheme.ink
        title.placeholderString = "Title"; title.setAccessibilityLabel("Note title")
        body.isRichText = false; body.isAutomaticQuoteSubstitutionEnabled = false
        body.isAutomaticDashSubstitutionEnabled = false; body.isAutomaticTextReplacementEnabled = false
        body.font = .systemFont(ofSize: 16); body.textColor = EchoTheme.text
        body.backgroundColor = EchoTheme.ink; body.insertionPointColor = EchoTheme.goldBright
        body.isVerticallyResizable = true; body.autoresizingMask = [.width]
        body.textContainer?.widthTracksTextView = true; body.setAccessibilityLabel("Original note text")
        let scroll = NSScrollView(); scroll.documentView = body; scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        for (label, option) in [("Only me", 0), ("Organization", 1), ("Project members", 2)] {
            let chip = ChipButton(title: label, target: self, action: #selector(pickAudience(_:)))
            chip.tag = option; chips.append(chip); audienceRow.addArrangedSubview(chip)
        }
        audienceRow.spacing = 8
        destination.setAccessibilityLabel("Note destination project")
        audienceProject.setAccessibilityLabel("Note audience project")
        for picker in [destination, audienceProject] { picker.target = self; picker.action = #selector(projectChoiceChanged) }
        for (button, action) in [(next, #selector(continueToAudience)), (save, #selector(saveNote)),
            (check, #selector(checkSave)), (retry, #selector(retrySave)), (another, #selector(newNote))] {
            button.target = self; button.action = action
        }
        attach.target = self; attach.action = #selector(chooseFile)
        back.target = self; back.action = #selector(goBack)
        closeButton.target = self; closeButton.action = #selector(close)
        closeButton.keyEquivalent = "\u{1b}"
        let actions = NSStackView(views: [back, next, save, closeButton]); actions.spacing = 12
        let recovery = NSStackView(views: [check, retry, another]); recovery.spacing = 8
        let stack = NSStackView(views: [scroll, attach, NSTextField(labelWithString: "Destination"), destination, audienceRow, audienceProject, consequence, availability, status, recovery, actions])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        for label in [consequence, availability, status] { label.textColor = EchoTheme.mutedText; label.font = .systemFont(ofSize: 12.5) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let root = sheet.contentView else { return }; root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 130),
        ])
        for view in [scroll, consequence, availability, status] { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
    }
}


// MARK: - The window

@MainActor
final class ProjectsController: NSObject, NSWindowDelegate {
    let window: NSWindow = ProjectsWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 680),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    let answerContainer = NSView()
    let uploads: UploadSession
    let projects: ProjectSession
    private let writeSheet = ProjectWriteSheet()
    private let onAsk: (String) -> Void
    var onConceal: (() -> Void)?
    var onIdentityChanged: (() -> Void)?
    private var observedIdentity: AccountIdentity?
    var onActivateAnswer: (() -> Void)?
    var onResizeAnswer: (() -> Void)?
    var onPeople: (() -> Void)?
    var accountMenu: NSMenu?
    private let sidebar = NSView()
    private var sidebarWidth: NSLayoutConstraint?
    private let sidebarToggle = NSButton()
    private let accountButton = NSButton(title: "Account", target: nil, action: nil)
    private let peopleButton = SidebarRowButton(title: "Organization people…", target: nil, action: nil)
    private let askField = NSTextField()
    private let send = NSButton()
    private let newProject = SidebarRowButton(title: "New project · Not live yet", target: nil, action: nil)
    private let projectName = NSTextField()
    private let memberQuery = NSTextField()
    private let associationPicker = NSPopUpButton()
    private var associationChoices: [ProjectSummary] = []
    private var refreshingProjects = false
    private let back = NSButton()
    private let results = NSStackView()
    private let scroll = NSScrollView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let empty = NSTextField(wrappingLabelWithString: "Projects · Not live yet\n\nProject spaces, project people, project sharing, and unread updates are not available yet.\n\nYou can save a note, find saved context, or ask about approved decisions.")
    private var mode = Mode.home
    private enum Mode { case home, ask, search, project, roster, create }
    private var sidebarOpen = false
    var hasOutstandingMutation: Bool { uploads.hasOutstandingMutation || projects.hasOutstandingMutation }

    init(uploads: UploadSession? = nil, projects: ProjectSession? = nil, onAsk: @escaping (String) -> Void) {
        self.uploads = uploads ?? UploadSession(); self.projects = projects ?? ProjectSession(); self.onAsk = onAsk
        super.init(); configure()
        self.uploads.onChange = { [weak self] in self?.refresh() }
        self.projects.onChange = { [weak self] in self?.refresh() }
        self.uploads.onProjectAccessChanged = { [weak self] in self?.projects.accessLost() }
        self.projects.onAccessChanged = { [weak self] in
            self?.uploads.projectAccessChanged(); self?.writeSheet.projectAccessChanged()
            self?.askField.stringValue = ""; self?.memberQuery.stringValue = ""
        }
        refresh()
    }
    func show() {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(); refreshIdentity()
        window.makeFirstResponder(askField)
    }
    func summon() {
        if window.isKeyWindow, window.attachedSheet == nil { conceal(); window.orderOut(nil) }
        else { show() }
    }
    func refreshIdentity() {
        guard window.isVisible, !writeSheet.isPresented, !hasOutstandingMutation, !uploads.busy else { return }
        refreshingProjects = true; uploads.refreshIdentity()
    }
    func conceal() { uploads.conceal(); projects.conceal(); writeSheet.projectAccessChanged(); onConceal?() }
    func accountWillChange() {
        uploads.accountWillChange(); projects.bind(nil); writeSheet.accountWillChange()
        askField.stringValue = ""; mode = .home; refresh()
    }
    func shutdown() { uploads.shutdown(); projects.shutdown(); window.orderOut(nil) }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !hasOutstandingMutation else { return false }
        conceal(); window.orderOut(nil); return false
    }
    func windowDidBecomeKey(_ notification: Notification) {
        refreshIdentity(); if mode == .ask { onActivateAnswer?() }
    }
    func windowDidResignKey(_ notification: Notification) { onConceal?() }
    func windowDidResize(_ notification: Notification) { onResizeAnswer?() }

    private func refresh() {
        if observedIdentity != uploads.identity {
            observedIdentity = uploads.identity
            askField.stringValue = ""; projectName.stringValue = ""; memberQuery.stringValue = ""; mode = .home; onIdentityChanged?()
            projects.bind(uploads.identity)
        }
        if refreshingProjects && !uploads.busy {
            refreshingProjects = false
            if projects.identity != uploads.identity { projects.bind(uploads.identity) }
            else if !projects.busy { projects.discover() }
        }
        writeSheet.refresh()
        switch projects.availability {
        case .live: newProject.title = "New project"
        case .notLive: newProject.title = "New project · Not live yet"
        case .checking: newProject.title = "New project · Check availability"
        case .failed: newProject.title = "New project · Refresh projects"
        }
        newProject.isEnabled = projects.canMutate
        accountButton.title = uploads.identity?.displayName ?? "Account · Sign in"
        peopleButton.isHidden = uploads.identity?.role.lowercased() != "owner"
        status.stringValue = mode == .ask ? "" : (mode == .search ? uploads.status : projects.status)
        answerContainer.isHidden = mode != .ask
        scroll.isHidden = mode == .ask
        empty.isHidden = true
        back.isHidden = mode == .home
        askField.placeholderString = mode == .project || mode == .roster ? "Search this project's context" : (mode == .search ? "Find saved context" : "Ask about approved decisions")
        send.isEnabled = (mode == .project || mode == .roster) ? (projects.selected != nil && !projects.busy) : (mode != .search || !uploads.busy)
        for view in results.arrangedSubviews { results.removeArrangedSubview(view); view.removeFromSuperview() }
        if mode != .search && mode != .ask { renderProjects() }
        if mode == .search {
            if let content = uploads.content {
                let heading = NSTextField(wrappingLabelWithString: "\(content.title) · \(content.visibility.label)")
                heading.font = .systemFont(ofSize: 15, weight: .semibold); heading.textColor = EchoTheme.text
                addResult(heading)
                let original = NSTextView(); original.string = content.text
                original.isEditable = false; original.isSelectable = true; original.isRichText = false
                original.font = .systemFont(ofSize: 14); original.textColor = EchoTheme.text
                original.drawsBackground = false; original.textContainerInset = NSSize(width: 8, height: 8)
                original.isVerticallyResizable = true; original.isHorizontallyResizable = false
                original.autoresizingMask = [.width]; original.textContainer?.widthTracksTextView = true
                original.setAccessibilityLabel("Original saved text")
                let reader = NSScrollView(); reader.documentView = original; reader.hasVerticalScroller = true
                reader.drawsBackground = false; addResult(reader)
                reader.heightAnchor.constraint(equalToConstant: 320).isActive = true
                associationControls(context: content.context_id, scoped: false)
            } else {
                for (index, match) in uploads.matches.enumerated() {
                    let card = ProjectEntryView()
                    card.configure(with: ProjectEntry(kind: "ORIGINAL · \(match.visibility.label.uppercased())",
                        title: match.title, body: match.excerpt, when: "", isDecision: false))
                    addResult(card)
                    let open = NSButton(title: "Read original", target: self, action: #selector(openResult(_:)))
                    open.tag = index; open.isEnabled = !uploads.busy; addResult(open)
                }
            }
        }
    }
    private func label(_ text: String) { addResult(NSTextField(wrappingLabelWithString: text)) }
    @discardableResult
    private func action(_ title: String, _ selector: Selector, enabled: Bool = true, tag: Int = 0) -> NSButton {
        let button = NSButton(title: title, target: self, action: selector)
        button.isEnabled = enabled; button.tag = tag; addResult(button); return button
    }
    private func renderProjects() {
        if projects.needsRecoveryReview {
            if let pending = projects.pending {
                label("An earlier \(pending.operation) change needs reconciliation.")
                action("Retry same project change", #selector(retryProject), enabled: !projects.busy)
            } else {
                label("A saved project recovery record needs review before another change.")
            }
            action("Review a different change…", #selector(abandonProject), enabled: !projects.busy)
        }
        switch mode {
        case .home:
            label("Projects")
            if projects.availability != .live {
                label(projects.availability == .notLive ? "Projects · Not live yet" : "Refresh projects to check availability.")
            }
            for (index, project) in projects.projects.enumerated() {
                action("\(project.name) · \(project.role == "lead" ? "Lead" : "Member")", #selector(openProject(_:)), enabled: !projects.busy, tag: index)
            }
            action("Refresh projects", #selector(refreshProjects), enabled: !projects.busy && uploads.identity != nil)
            if projects.listCursor != nil { action("Next projects", #selector(nextProjects), enabled: !projects.busy) }
        case .create:
            label("Create a project")
            label("You become its first lead. Add current organization members from Project members after creation.")
            projectName.placeholderString = "Project name"; projectName.setAccessibilityLabel("Project name")
            addResult(projectName); projectName.isEnabled = projects.canMutate
            action("Create project", #selector(createProject), enabled: projects.canMutate)
        case .project, .roster:
            guard let selected = projects.selected else {
                label("Choose an accessible project from Home."); return
            }
            label(selected.name)
            action("Project feed", #selector(projectFeed), enabled: !projects.busy)
            action("Project members", #selector(projectMembers), enabled: !projects.busy)
            action("Ask this project · Not live yet", #selector(projectAskUnavailable), enabled: false)
            if mode == .roster {
                label("Project roster · \(selected.role == "lead" ? "You are a lead" : "You are a member")")
                for (index, member) in projects.members.enumerated() {
                    label("\(member.display_name) · \(member.role == "lead" ? "Lead" : "Member")")
                    if selected.role == "lead" {
                        action(member.role == "lead" ? "Make member" : "Make lead", #selector(changeRole(_:)), enabled: projects.canManage, tag: index)
                        action("Remove from project", #selector(removeMember(_:)), enabled: projects.canManage, tag: index)
                    }
                }
                if selected.role == "lead" {
                    memberQuery.placeholderString = "Find an organization member by name"
                    memberQuery.setAccessibilityLabel("Project member search"); addResult(memberQuery)
                    memberQuery.isEnabled = projects.canManage
                    action("Find member", #selector(findMember), enabled: projects.canManage)
                    for (index, member) in projects.candidates.enumerated() {
                        action("Add \(member.display_name)", #selector(addMember(_:)), enabled: projects.canManage, tag: index)
                    }
                    if projects.directoryCursor != nil { action("Next candidates", #selector(nextCandidates), enabled: projects.canManage) }
                }
            } else if let original = projects.content {
                label("\(original.title) · \(audienceLabel(original.audience))")
                let text = NSTextView(); text.string = original.text; text.isEditable = false; text.isSelectable = true
                text.isRichText = false; text.drawsBackground = false; text.font = .systemFont(ofSize: 14); text.textColor = EchoTheme.text
                text.isVerticallyResizable = true; text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView = true
                text.setAccessibilityLabel("Project original text")
                let reader = NSScrollView(); reader.documentView = text; reader.hasVerticalScroller = true
                addResult(reader); reader.heightAnchor.constraint(equalToConstant: 260).isActive = true
                associationControls(context: original.context_id, scoped: true)
            } else {
                for (index, item) in projects.items.enumerated() {
                    let card = ProjectEntryView(); card.configure(with: ProjectEntry(kind: "ORIGINAL · \(audienceLabel(item.audience))",
                        title: item.title, body: item.excerpt, when: item.received_at, isDecision: false)); addResult(card)
                    action("Read project original", #selector(readProjectOriginal(_:)), enabled: !projects.busy, tag: index)
                }
            }
            if projects.pageCursor != nil { action("Next page", #selector(nextProjectPage), enabled: !projects.busy) }
        default: break
        }
        label("Not live yet: unread counts, attachments, Undo, automatic routing, and project policies for approved records.")
    }
    private func audienceLabel(_ audience: UploadAudience) -> String {
        guard let id = audience.project_id else { return audience.label }
        let name = projects.projects.first(where: { $0.project_id == id })?.name ?? (projects.selected?.project_id == id ? projects.selected?.name : nil)
        return name.map { "Members of \($0)" } ?? "Members of the audience project"
    }
    private func associationControls(context: String, scoped: Bool) {
        label("Destination changes where the original appears. Its audience stays the same.")
        if scoped {
            action("Remove from this project", #selector(dissociateOriginal), enabled: projects.canMutate)
        } else {
            associationChoices = projects.projects
            associationPicker.removeAllItems(); associationPicker.addItem(withTitle: "Choose a destination project")
            associationChoices.forEach { associationPicker.menu?.addItem(NSMenuItem(title: $0.name, action: nil, keyEquivalent: "")) }
            associationPicker.setAccessibilityLabel("Original destination project"); addResult(associationPicker)
            action("Associate original", #selector(associateOriginal), enabled: projects.canMutate && !associationChoices.isEmpty)
        }
    }
    @objc private func refreshProjects() {
        guard !hasOutstandingMutation, !uploads.busy else { return }
        refreshingProjects = true; uploads.refreshIdentity()
    }
    @objc private func nextProjects() { projects.discover(cursor: projects.listCursor) }
    @objc private func openProject(_ sender: NSButton) {
        guard projects.projects.indices.contains(sender.tag) else { return }
        mode = .project; askField.stringValue = ""; onConceal?(); projects.open(projects.projects[sender.tag].project_id)
    }
    @objc private func createMode() { mode = .create; projectName.stringValue = ""; onConceal?(); refresh() }
    @objc private func createProject() {
        let name = projectName.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        guard ProjectWire.text(name, max: 200) else { status.stringValue = "Use a nonempty project name up to 200 UTF-8 bytes."; return }
        mode = .project; projects.create(name)
    }
    @objc private func projectFeed() { mode = .project; askField.stringValue = ""; projects.feed() }
    @objc private func projectMembers() { mode = .roster; projects.roster() }
    @objc private func findMember() { projects.directory(memberQuery.stringValue) }
    @objc private func nextCandidates() { projects.directory(memberQuery.stringValue, cursor: projects.directoryCursor) }
    @objc private func addMember(_ sender: NSButton) {
        guard projects.candidates.indices.contains(sender.tag) else { return }
        let person = projects.candidates[sender.tag]
        confirmChange("Add \(person.display_name) to this project?", detail: "They can read project-audience context, including existing originals. Private originals stay private.") {
            self.mode = .project; self.projects.setMember(person.membership_id, role: "member")
        }
    }
    @objc private func changeRole(_ sender: NSButton) {
        guard projects.members.indices.contains(sender.tag) else { return }
        let person = projects.members[sender.tag]; let role = person.role == "lead" ? "member" : "lead"
        confirmChange("Make \(person.display_name) a \(role)?", detail: "Leads manage project membership. A project must retain at least one lead.") {
            self.mode = .project; self.projects.setMember(person.membership_id, role: role)
        }
    }
    @objc private func removeMember(_ sender: NSButton) {
        guard projects.members.indices.contains(sender.tag) else { return }
        let person = projects.members[sender.tag]
        confirmChange("Remove \(person.display_name) from this project?", detail: "Their access through this project's audience ends. Organization membership is unchanged.") {
            self.mode = .project; self.projects.removeMember(person.membership_id)
        }
    }
    private func confirmChange(_ title: String, detail: String, apply: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "Confirm"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in if response == .alertFirstButtonReturn { apply() } }
    }
    @objc private func readProjectOriginal(_ sender: NSButton) {
        guard projects.items.indices.contains(sender.tag) else { return }; projects.read(projects.items[sender.tag].context_id)
    }
    @objc private func nextProjectPage() { projects.nextPage() }
    @objc private func projectAskUnavailable() { /* Deliberately has no global Ask path. */ }
    @objc private func retryProject() { projects.retry() }
    @objc private func abandonProject() {
        confirmChange("Review a different change?", detail: "The earlier change may have completed. Refresh its project before making another change to avoid duplication.") { self.projects.abandonPending(); self.projects.discover() }
    }
    @objc private func associateOriginal() {
        let index = associationPicker.indexOfSelectedItem - 1
        guard associationChoices.indices.contains(index), let original = uploads.content else { return }
        let project = associationChoices[index]; mode = .project
        projects.associate(original.context_id, project: project.project_id, add: true)
    }
    @objc private func dissociateOriginal() {
        guard let original = projects.content, let selected = projects.selected else { return }
        projects.associate(original.context_id, project: selected.project_id, add: false)
    }
    private func addResult(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false; results.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: results.widthAnchor).isActive = true
    }
    @objc private func openResult(_ sender: NSButton) {
        guard uploads.matches.indices.contains(sender.tag) else { return }
        uploads.read(uploads.matches[sender.tag].context_id)
    }
    @objc func startWrite() {
        guard !uploads.busy, !projects.busy else { return }
        writeSheet.present(over: window, session: uploads, projects: projects)
    }
    @objc private func home() { mode = .home; askField.stringValue = ""; projects.discover(); onConceal?(); refresh() }
    @objc private func findSaved() { guard !hasOutstandingMutation else { return }; projects.leave(); mode = .search; onConceal?(); refresh(); window.makeFirstResponder(askField) }
    @objc private func askMode() { guard !hasOutstandingMutation else { return }; projects.leave(); mode = .ask; refresh(); window.makeFirstResponder(askField) }
    @objc private func askSubmitted() {
        let question = askField.stringValue
        guard !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if mode == .project || mode == .roster { mode = .project; projects.search(question) }
        else if mode == .search { uploads.search(question) }
        else { mode = .ask; refresh(); onAsk(question) }
    }
    @objc private func showPeople() { onPeople?() }
    @objc private func showAccount() {
        accountMenu?.popUp(positioning: nil, at: NSPoint(x: 0, y: accountButton.bounds.height), in: accountButton)
    }
    @objc private func toggleSidebar() {
        sidebarOpen.toggle(); sidebarWidth?.constant = sidebarOpen ? 220 : 0
        sidebar.isHidden = !sidebarOpen
        sidebarToggle.setAccessibilityLabel(sidebarOpen ? "Hide sidebar" : "Show sidebar")
    }
    private func row(_ title: String, symbol: String, action: Selector?) -> SidebarRowButton {
        let button = SidebarRowButton(title: title, target: self, action: action)
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        button.isBordered = false; button.setAccessibilityLabel(title)
        return button
    }
    private func configure() {
        window.title = "ECHO"; window.delegate = self; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 800, height: 580)
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = EchoTheme.ink
        sidebarToggle.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Show sidebar")
        sidebarToggle.target = self; sidebarToggle.action = #selector(toggleSidebar); sidebarToggle.isBordered = false
        sidebarToggle.setAccessibilityLabel("Show sidebar")
        let toggleHost = NSView(frame: NSRect(x: 0, y: 0, width: 42, height: 28))
        sidebarToggle.frame = NSRect(x: 8, y: 2, width: 26, height: 24); toggleHost.addSubview(sidebarToggle)
        let accessory = NSTitlebarAccessoryViewController(); accessory.view = toggleHost; accessory.layoutAttribute = .left
        window.addTitlebarAccessoryViewController(accessory)
        sidebar.wantsLayer = true; sidebar.layer?.backgroundColor = EchoTheme.surface.cgColor; sidebar.isHidden = true
        newProject.target = self; newProject.action = #selector(createMode); newProject.isBordered = false
        newProject.image = NSImage(systemSymbolName: "folder.badge.plus", accessibilityDescription: "New project")
        peopleButton.image = NSImage(systemSymbolName: "person.2", accessibilityDescription: "Organization people")
        peopleButton.target = self; peopleButton.action = #selector(showPeople); peopleButton.isBordered = false
        let navigation = NSStackView(views: [row("Home", symbol: "house", action: #selector(home)),
            row("Save something…", symbol: "plus.app", action: #selector(startWrite)),
            row("Find saved context", symbol: "magnifyingglass", action: #selector(findSaved)),
            row("Ask ECHO", symbol: "sparkle", action: #selector(askMode)), newProject, peopleButton])
        navigation.orientation = .vertical; navigation.alignment = .leading; navigation.spacing = 4
        accountButton.target = self; accountButton.action = #selector(showAccount); accountButton.isBordered = false
        accountButton.setAccessibilityLabel("Account")
        sidebar.addSubview(navigation); sidebar.addSubview(accountButton)
        back.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Home")
        back.isBordered = false; back.target = self; back.action = #selector(home)
        empty.font = .systemFont(ofSize: 15); empty.textColor = EchoTheme.faintText; empty.alignment = .center
        status.font = .systemFont(ofSize: 12); status.textColor = EchoTheme.mutedText
        results.orientation = .vertical; results.alignment = .leading; results.spacing = 10
        let document = NSView(); document.addSubview(results); scroll.documentView = document
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let bar = BarBackgroundView()
        let write = circleButton(symbol: "plus", label: "Write something", filled: false, target: self, action: #selector(startWrite))
        askField.font = .systemFont(ofSize: 15); askField.textColor = EchoTheme.text
        askField.isBordered = false; askField.drawsBackground = false
        askField.target = self; askField.action = #selector(askSubmitted); askField.setAccessibilityLabel("Ask or find context")
        send.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "Submit")
        send.isBordered = false; send.target = self; send.action = #selector(askSubmitted); send.setAccessibilityLabel("Submit")
        bar.addSubview(write); bar.addSubview(askField); bar.addSubview(send)
        let content = NSView()
        for view in [back, empty, scroll, answerContainer, status, bar] { content.addSubview(view) }
        guard let root = window.contentView else { return }; root.addSubview(sidebar); root.addSubview(content)
        for view in [sidebar, navigation, accountButton, content, back, empty, scroll, document, results,
                     answerContainer, status, bar, write, askField, send] { view.translatesAutoresizingMaskIntoConstraints = false }
        let width = sidebar.widthAnchor.constraint(equalToConstant: 0); sidebarWidth = width
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor), sidebar.topAnchor.constraint(equalTo: root.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor), width,
            navigation.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 12),
            navigation.widthAnchor.constraint(equalToConstant: 196),
            navigation.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 18),
            accountButton.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 12),
            accountButton.widthAnchor.constraint(equalToConstant: 196),
            accountButton.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -18),
            content.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor), content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            content.topAnchor.constraint(equalTo: root.topAnchor), content.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            back.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16), back.topAnchor.constraint(equalTo: content.topAnchor, constant: 10),
            empty.centerXAnchor.constraint(equalTo: content.centerXAnchor), empty.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -30),
            empty.widthAnchor.constraint(equalToConstant: 480),
            bar.centerXAnchor.constraint(equalTo: content.centerXAnchor), bar.widthAnchor.constraint(equalToConstant: 520),
            bar.heightAnchor.constraint(equalToConstant: 46), bar.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -28),
            status.leadingAnchor.constraint(equalTo: bar.leadingAnchor), status.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            status.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -10),
            scroll.centerXAnchor.constraint(equalTo: content.centerXAnchor), scroll.widthAnchor.constraint(equalToConstant: 520),
            scroll.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 12), scroll.bottomAnchor.constraint(equalTo: status.topAnchor, constant: -12),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            results.leadingAnchor.constraint(equalTo: document.leadingAnchor), results.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            results.topAnchor.constraint(equalTo: document.topAnchor), results.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            answerContainer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            answerContainer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            answerContainer.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 8), answerContainer.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -12),
            write.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 6), write.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            write.widthAnchor.constraint(equalToConstant: 34), write.heightAnchor.constraint(equalToConstant: 34),
            send.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -6), send.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            send.widthAnchor.constraint(equalToConstant: 34), send.heightAnchor.constraint(equalToConstant: 34),
            askField.leadingAnchor.constraint(equalTo: write.trailingAnchor, constant: 10), askField.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -10),
            askField.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
        ])
        for item in navigation.arrangedSubviews { item.widthAnchor.constraint(equalTo: navigation.widthAnchor).isActive = true }
    }
}
