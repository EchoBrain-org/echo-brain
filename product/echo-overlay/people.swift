import AppKit
import Darwin
import Foundation

// Local role information controls presentation only. Every roster read and
// membership operation still passes through the Authority's owner check.
struct PeopleIdentity: Equatable, Sendable {
    let name: String
    let authority: String
}

struct PeopleStatus: Decodable {
    let schema_version: Int
    let kind: String
    let signed_in: Bool
    let display_name: String?
    let membership_type: String?
    let connected_authority: String?

    var owner: PeopleIdentity? {
        guard schema_version == 1, kind == "echo-person-client-status-v1",
              signed_in, membership_type == "owner",
              let name = display_name, peopleLabel(name, maximum: 200),
              let authority = connected_authority,
              let url = URLComponents(string: authority), url.scheme == "https",
              url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil
        else { return nil }
        return PeopleIdentity(name: name, authority: authority)
    }
}

enum PeopleMembership: String, Decodable, Sendable { case active, revoked }
enum PeopleInvitation: String, Decodable, Sendable { case pending, expired, redeemed, none }

struct PeopleEmployee: Decodable, Sendable {
    let email: String
    let display_name: String
    let membership_status: PeopleMembership
    let invitation_state: PeopleInvitation

    var mayReissue: Bool {
        membership_status == .active && [.pending, .expired].contains(invitation_state)
    }
    var invitationLabel: String {
        switch invitation_state {
        case .pending: return "Awaiting sign-in"
        case .expired: return "Expired"
        case .redeemed: return "Onboarded"
        case .none: return "None"
        }
    }
}

private func peopleLabel(_ value: String, maximum: Int) -> Bool {
    !value.isEmpty && value.count <= maximum &&
        value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
}

private struct PeopleRoster: Decodable {
    let schema_version: Int
    let kind: String
    let employees: [PeopleEmployee]
}
private struct PeopleRosterEnvelope: Decodable { let ok: Bool; let result: PeopleRoster }
private struct PeopleInvitationResult: Decodable {
    let ok: Bool
    let output_path: String
    let expires_at: String
}
private struct PeopleRevokeResult: Decodable { let ok: Bool; let revoked: Bool }
private struct PeopleFailure: Decodable {
    let ok: Bool
    let action: String?
    let error: String?
    let code: String?
    let mutation_outcome: String?
}

private enum PeopleMutationOutcome: String { case not_submitted, rejected, committed, unknown }

enum PeopleCommand: Sendable {
    case list
    case invite(name: String, email: String, path: String)
    case reissue(email: String, path: String)
    case revoke(email: String)

    var arguments: [String] {
        switch self {
        case .list: return ["person", "employee", "list"]
        case .invite(let name, let email, let path):
            return ["person", "employee", "invite", "--name", name, "--email", email, "--out", path]
        case .reissue(let email, let path):
            return ["person", "employee", "reissue", "--email", email, "--out", path]
        case .revoke(let email): return ["person", "employee", "revoke", "--email", email]
        }
    }
    var mutates: Bool { if case .list = self { return false }; return true }
    var action: String {
        switch self {
        case .list: return "employee-list"
        case .invite: return "employee-invite"
        case .reissue: return "employee-reissue"
        case .revoke: return "employee-revoke"
        }
    }
    var recoveryMessage: String {
        switch self {
        case .list:
            return "Could not load people. Check your connection and owner access, then refresh."
        case .invite:
            return "The invitation may already have been issued. Check the selected folder and refresh before retrying."
        case .reissue:
            return "The replacement may already have been issued and the previous invitation invalidated. Check the selected folder and refresh before retrying."
        case .revoke:
            return "Revocation may already have completed. Refresh to check this employee's status before retrying."
        }
    }
}

enum PeopleResult: Sendable {
    case roster([PeopleEmployee])
    case invitation(path: String, expires: Date)
    case revoked
    case unavailable
    case unconfirmedMutation
    case unconfirmedMutationAfterIdentityChange
    case authorizationRejected(String)
    case invitationSaveCommitted(String)
    case rejected(String)
    case failed
}

private enum PeopleRunResult {
    case completed(stdout: Data, stderr: Data, exitStatus: Int32)
    case cancelledBeforeLaunch
    case cancelledAfterLaunch
    case unknown
}

final class PeopleClient: @unchecked Sendable {
    private let executable: URL

    init(executable: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ECHO/bin/echo-brain")) {
        self.executable = executable
    }

    func identity(completion: @escaping @MainActor @Sendable (PeopleIdentity?) -> Void) -> RunningAsk {
        let running = RunningAsk()
        DispatchQueue.global(qos: .userInitiated).async {
            let owner = self.readOwner(running)
            DispatchQueue.main.async { completion(owner) }
        }
        return running
    }

    func perform(_ command: PeopleCommand, owner: PeopleIdentity,
                 completion: @escaping @MainActor @Sendable (PeopleResult) -> Void) -> RunningAsk {
        let running = RunningAsk()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.execute(command, owner: owner, running: running)
            DispatchQueue.main.async { completion(result) }
        }
        return running
    }

    // These methods also exercise the real subprocess boundary in the native
    // offline proof. No test mode, alternate client path, or credentials are
    // exposed by the application command line.
    func execute(_ command: PeopleCommand, owner: PeopleIdentity, running: RunningAsk) -> PeopleResult {
        guard readOwner(running) == owner else { return .unavailable }
        let output = run(command.arguments, timeout: 45, running: running)
        if case .cancelledBeforeLaunch = output { return .unavailable }
        if case .cancelledAfterLaunch = output {
            return command.mutates ? .unconfirmedMutation : .failed
        }
        guard readOwner(running) == owner else {
            // Withhold private data from a changed account, but retain the fact
            // that a write was submitted. The controller must warn before retry.
            return command.mutates ? .unconfirmedMutationAfterIdentityChange : .unavailable
        }
        switch output {
        case .cancelledBeforeLaunch, .cancelledAfterLaunch:
            return .unavailable
        case .unknown:
            return command.mutates ? .unconfirmedMutation : .failed
        case .completed(let stdout, let stderr, let exitStatus):
            guard exitStatus == 0 else {
                return Self.parseFailure(stdout: stdout, stderr: stderr, command: command)
            }
            let result = Self.parse(stdout, command: command)
            if command.mutates, case .failed = result { return .unconfirmedMutation }
            return result
        }
    }

    private func readOwner(_ running: RunningAsk) -> PeopleIdentity? {
        guard case let .completed(bytes, _, exitStatus) = run(["person", "status"], timeout: 5, running: running),
              exitStatus == 0,
              let status = try? JSONDecoder().decode(PeopleStatus.self, from: bytes)
        else { return nil }
        return status.owner
    }

    private func run(_ arguments: [String], timeout: TimeInterval, running: RunningAsk) -> PeopleRunResult {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else { return .unknown }
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
            "TMPDIR": NSTemporaryDirectory(),
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        let stdout = BoundedReader(maximumBytes: 128 * 1024)
        let stderr = BoundedReader(maximumBytes: 16 * 1024)
        let readers = DispatchGroup()
        for (reader, handle) in [(stdout, output.fileHandleForReading), (stderr, errors.fileHandleForReading)] {
            readers.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                reader.read(from: handle) { running.exceedOutputLimit() }
                readers.leave()
            }
        }
        do {
            guard try running.launch(process) else {
                try? output.fileHandleForWriting.close(); try? errors.fileHandleForWriting.close()
                readers.wait(); running.detach(process)
                return .cancelledBeforeLaunch
            }
        } catch {
            try? output.fileHandleForWriting.close(); try? errors.fileHandleForWriting.close()
            readers.wait(); running.detach(process)
            return .unknown
        }
        try? output.fileHandleForWriting.close(); try? errors.fileHandleForWriting.close()
        let deadline = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
        process.waitUntilExit()
        deadline.cancel(); readers.wait(); running.detach(process)
        let state = running.state()
        if state.cancelled { return .cancelledAfterLaunch }
        guard !state.timedOut, !state.outputExceeded,
              !stdout.didExceedLimit(), !stderr.didExceedLimit()
        else { return .unknown }
        return .completed(stdout: stdout.data(), stderr: stderr.data(), exitStatus: process.terminationStatus)
    }

    static func parse(_ data: Data, command: PeopleCommand) -> PeopleResult {
        let decoder = JSONDecoder()
        switch command {
        case .list:
            guard let value = try? decoder.decode(PeopleRosterEnvelope.self, from: data), value.ok,
                  value.result.schema_version == 1, value.result.kind == "echo-clean-person-employee-roster-v1",
                  value.result.employees.allSatisfy({ peopleLabel($0.email, maximum: 320) && peopleLabel($0.display_name, maximum: 200) }),
                  Set(value.result.employees.map(\.email)).count == value.result.employees.count
            else { return .failed }
            return .roster(value.result.employees)
        case .invite(_, _, let path), .reissue(_, let path):
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let value = try? decoder.decode(PeopleInvitationResult.self, from: data), value.ok,
                  value.output_path == path, let expires = formatter.date(from: value.expires_at)
            else { return .failed }
            // The CLI owns the grant, checksums and exclusive mode-0600 write.
            // The UI never reads, copies, or logs invitation contents.
            return .invitation(path: path, expires: expires)
        case .revoke:
            guard let value = try? decoder.decode(PeopleRevokeResult.self, from: data), value.ok, value.revoked
            else { return .failed }
            return .revoked
        }
    }

    private static func parseFailure(stdout: Data, stderr: Data, command: PeopleCommand) -> PeopleResult {
        for data in [stderr, stdout] {
            guard let failure = try? JSONDecoder().decode(PeopleFailure.self, from: data), !failure.ok,
                  failure.action == command.action,
                  let rawOutcome = failure.mutation_outcome,
                  let outcome = PeopleMutationOutcome(rawValue: rawOutcome),
                  let code = failure.code
            else { continue }
            if ["owner_access_required", "sign_in_required"].contains(code),
               [.not_submitted, .rejected].contains(outcome),
               let message = authorizationMessage(for: code) {
                return .authorizationRejected(message)
            }
            guard command.mutates else { continue }
            if code == "invitation_save_failed", outcome == .committed,
               let message = invitationSaveCommittedMessage(for: command) {
                return .invitationSaveCommitted(message)
            }
            if let message = rejectedMessage(for: code, outcome: outcome) {
                return .rejected(message)
            }
        }
        // Failure text can contain server details or grants. A missing, malformed,
        // committed, or otherwise unknown classification never establishes that a
        // mutation was rejected, so require a refresh before another submission.
        return command.mutates ? .unconfirmedMutation : .failed
    }

    private static func authorizationMessage(for code: String) -> String? {
        switch code {
        case "owner_access_required":
            return "Owner access is required to manage people. Sign in with your owner account."
        case "sign_in_required":
            return "Sign in with your owner account to manage people."
        default:
            return nil
        }
    }

    private static func invitationSaveCommittedMessage(for command: PeopleCommand) -> String? {
        switch command {
        case .invite, .reissue:
            return "Invitation was created, but the file could not be saved. Refresh, then reissue it into another folder."
        default:
            return nil
        }
    }

    private static func rejectedMessage(for code: String, outcome: PeopleMutationOutcome) -> String? {
        switch (code, outcome) {
        case ("invalid_email", .not_submitted), ("invalid_name", .not_submitted):
            return "Enter a valid employee name and email address."
        case ("invitation_output_invalid", .not_submitted):
            return "Could not save the invitation. Choose another location and try again."
        case ("employee_already_exists", .rejected):
            return "Already a member. Refresh to check whether to reissue or sign in."
        case ("employee_onboarding_complete", .rejected):
            return "This employee has already onboarded. Ask them to sign in."
        case ("request_rejected", .rejected):
            return "The request was rejected. Refresh and try again."
        case ("outcome_unknown", .not_submitted):
            return "The request was not sent. Check your connection and try again."
        default:
            return nil
        }
    }

    static func invitationDestination(in parent: URL) throws -> URL {
        guard parent.isFileURL else { throw CocoaError(.fileWriteInvalidFileName) }
        let canonical = parent.resolvingSymlinksInPath().standardizedFileURL
        var template = Array(canonical.appendingPathComponent("ECHO-invitation-XXXXXXXX").path.utf8CString)
        guard let created = mkdtemp(&template) else { throw CocoaError(.fileWriteUnknown) }
        return URL(fileURLWithPath: String(cString: created), isDirectory: true)
            .appendingPathComponent("person-invitation.json")
    }

    static func isInvitationEmail(_ email: String) -> Bool {
        // Same new-invitation contract as organization-api/person-session.ts.
        // The native proof compares these decisions against that validator.
        guard (3...254).contains(email.utf8.count), email == email.lowercased(),
              email == email.trimmingCharacters(in: .whitespacesAndNewlines),
              email.range(of: #"^[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$"#, options: .regularExpression) != nil
        else { return false }
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && parts[0].utf8.count <= 64 && parts[1].utf8.count <= 253 &&
            parts[1].split(separator: ".", omittingEmptySubsequences: false).allSatisfy { $0.utf8.count <= 63 }
    }

    static func activeInvitationConflict(for email: String, in employees: [PeopleEmployee]) -> String? {
        guard let existing = employees.first(where: { $0.membership_status == .active && $0.email == email }) else { return nil }
        switch existing.invitation_state {
        case .pending, .expired:
            return "This employee already has an invitation. Select them and reissue it instead."
        case .redeemed:
            return "This employee has already onboarded. Ask them to sign in."
        case .none:
            return "This employee is already a member. Ask them to sign in."
        }
    }
}

private final class PeopleWindow: NSWindow {
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
final class PeopleController: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private let client = PeopleClient()
    private let availability: (Bool) -> Void
    private let window = PeopleWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 600),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let identityLabel = NSTextField(labelWithString: "Checking owner access…")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let table = NSTableView()
    private let name = NSTextField()
    private let email = NSTextField()
    private let invite = NSButton(title: "Invite employee…", target: nil, action: nil)
    private let refresh = NSButton(title: "Refresh", target: nil, action: nil)
    private let reissue = NSButton(title: "Reissue invitation…", target: nil, action: nil)
    private let revoke = NSButton(title: "Revoke access…", target: nil, action: nil)
    private let reveal = NSButton(title: "Show invitation in Finder", target: nil, action: nil)
    private var rows: [PeopleEmployee] = []
    private var owner: PeopleIdentity?
    private var active: RunningAsk?
    private var requestID = UUID()
    private var mutation = false
    private var choosing = false
    private var savedInvitation: URL?
    private var mutationNotice: String?

    var hasOutstandingMutation: Bool { mutation }

    init(availability: @escaping (Bool) -> Void) {
        self.availability = availability
        super.init()
        configure()
    }

    func checkAccess() {
        guard active == nil, !choosing else { return }
        let id = UUID(); requestID = id
        active = client.identity { [weak self] identity in
            guard let self, self.requestID == id else { return }
            self.active = nil
            if self.owner != identity { self.clear() }
            self.owner = identity
            self.availability(identity != nil)
            self.identityLabel.stringValue = identity.map { "Owner: \($0.name) · \($0.authority)" }
                ?? "Sign in with your owner account to manage people."
            self.updateControls()
            if self.window.isVisible, NSApp.isActive, identity != nil { self.loadRoster() }
        }
        updateControls()
    }

    func show() {
        clear()
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate()
        checkAccess()
    }

    func conceal() {
        guard !choosing else { return }
        clear(resetDraft: false)
        if !mutation { active?.cancel(); active = nil; requestID = UUID() }
    }

    func shutdown() { active?.cancel() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !mutation else { return false }
        conceal(); window.orderOut(nil)
        return false
    }
    func windowDidBecomeKey(_ notification: Notification) { checkAccess() }

    private func clear(resetDraft: Bool = true) {
        rows = []; table.reloadData()
        savedInvitation = nil; reveal.isHidden = true
        status.stringValue = mutationNotice ?? ""
        if resetDraft { name.stringValue = ""; email.stringValue = "" }
        updateControls()
    }

    private func updateControls() {
        let ready = owner != nil && active == nil
        invite.isEnabled = ready; refresh.isEnabled = active == nil
        name.isEnabled = owner != nil && !mutation; email.isEnabled = owner != nil && !mutation
        let row = selected()
        reissue.isEnabled = ready && row?.mayReissue == true
        revoke.isEnabled = ready && row?.membership_status == .active
        reveal.isEnabled = ready && savedInvitation != nil
    }
    private func selected() -> PeopleEmployee? {
        rows.indices.contains(table.selectedRow) ? rows[table.selectedRow] : nil
    }

    @objc private func refreshPeople() { checkAccess() }

    private func loadRoster() {
        guard let owner, active == nil, !choosing else { return }
        run(.list, owner: owner)
    }

    private func run(_ command: PeopleCommand, owner: PeopleIdentity) {
        guard active == nil else { return }
        let id = UUID(); requestID = id; mutation = command.mutates
        if command.mutates { mutationNotice = nil; status.stringValue = "Saving…" }
        active = client.perform(command, owner: owner) { [weak self] result in
            guard let self, self.requestID == id else { return }
            self.active = nil; self.mutation = false
            if command.mutates {
                switch result {
                case .unconfirmedMutation, .unconfirmedMutationAfterIdentityChange, .failed:
                    self.mutationNotice = command.recoveryMessage
                case .invitationSaveCommitted(let message):
                    self.mutationNotice = message
                case .invitation, .revoked:
                    if !self.window.isVisible || !NSApp.isActive { self.mutationNotice = command.recoveryMessage }
                default: break
                }
            }
            // Finish submitted mutations, but do not redisplay a private roster
            // while the user is outside ECHO. Focus/Refresh reads it afresh.
            guard self.window.isVisible, NSApp.isActive else { self.clear(); return }
            switch result {
            case .unavailable:
                self.clear(); self.owner = nil; self.availability(false)
                self.identityLabel.stringValue = "Owner access changed. Sign in with your owner account."
            case .unconfirmedMutation:
                // The owner check still matched, but an unknown write outcome
                // cannot justify retaining a potentially stale private roster.
                self.clear()
                self.status.stringValue = self.mutationNotice ?? command.recoveryMessage
            case .unconfirmedMutationAfterIdentityChange:
                // Do not retain a prior account's roster after a submitted write.
                self.clear(); self.owner = nil; self.availability(false)
                self.identityLabel.stringValue = "Owner access changed. Sign in with your owner account."
                self.status.stringValue = self.mutationNotice ?? command.recoveryMessage
            case .authorizationRejected(let message):
                // Server authorization is authoritative for roster disclosure,
                // even if the local status command still names this owner.
                self.mutationNotice = nil; self.clear(); self.owner = nil; self.availability(false)
                self.identityLabel.stringValue = "Owner access could not be verified."
                self.status.stringValue = message
            case .invitationSaveCommitted(let message):
                self.clear()
                self.status.stringValue = message
            case .rejected(let message):
                // A structured rejection was confirmed after the owner recheck.
                // Preserve the visible roster until the owner chooses Refresh.
                self.status.stringValue = message
            case .failed:
                self.clear()
                if !command.mutates {
                    // An unverified list result must never leave a prior account's
                    // private roster visible.
                    self.mutationNotice = nil; self.owner = nil; self.availability(false)
                    self.identityLabel.stringValue = "Owner access could not be verified."
                }
                self.status.stringValue = self.mutationNotice ?? command.recoveryMessage
            case .roster(let rows):
                let previous = self.selected()?.email
                self.rows = rows; self.table.reloadData()
                if let previous, let index = rows.firstIndex(where: { $0.email == previous }) {
                    self.table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
                }
                if self.savedInvitation == nil, self.mutationNotice == nil {
                    self.status.stringValue = rows.isEmpty ? "No employees yet. Invite your first employee below." : "\(rows.count) employee\(rows.count == 1 ? "" : "s"). Membership and invitation status are separate."
                }
            case .invitation(let path, let expires):
                self.savedInvitation = URL(fileURLWithPath: path); self.reveal.isHidden = false
                self.status.stringValue = "Invitation saved at \(path). Expires \(expires.formatted(date: .omitted, time: .shortened)). Privately send this file and the approved ECHO setup package to this employee."
                self.name.stringValue = ""; self.email.stringValue = ""
                self.loadRoster()
            case .revoked:
                self.savedInvitation = nil; self.reveal.isHidden = true
                self.status.stringValue = "Employee access revoked."
                self.loadRoster()
            }
            self.updateControls()
        }
        updateControls()
    }

    private func chooseDestination() -> URL? {
        let picker = NSOpenPanel()
        picker.title = "Save employee invitation"
        picker.message = "Choose a location. ECHO creates a private invitation folder inside it."
        picker.prompt = "Save here"
        picker.canChooseFiles = false; picker.canChooseDirectories = true
        picker.allowsMultipleSelection = false; picker.canCreateDirectories = true
        choosing = true
        defer { choosing = false }
        guard picker.runModal() == .OK, let parent = picker.url else { return nil }
        do { return try PeopleClient.invitationDestination(in: parent) }
        catch { status.stringValue = "Could not create a private invitation folder. Choose another location."; return nil }
    }

    @objc private func inviteEmployee() {
        guard active == nil, let owner else { return }
        let employeeName = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            .precomposedStringWithCanonicalMapping
        let employeeEmail = email.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard peopleLabel(employeeName, maximum: 200), PeopleClient.isInvitationEmail(employeeEmail)
        else { status.stringValue = "Enter the employee's name and email address."; return }
        if let message = PeopleClient.activeInvitationConflict(for: employeeEmail, in: rows) {
            status.stringValue = message; return
        }
        guard let destination = chooseDestination() else { return }
        run(.invite(name: employeeName, email: employeeEmail, path: destination.path), owner: owner)
    }

    private func confirm(_ title: String, detail: String, button: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: button); alert.addButton(withTitle: "Cancel")
        choosing = true
        defer { choosing = false }
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func reissueInvitation() {
        guard active == nil, let owner, let row = selected(), row.mayReissue else { return }
        guard confirm("Replace invitation for \(row.display_name)?", detail: "The previous invitation for \(row.email) will stop working.", button: "Reissue invitation"),
              let destination = chooseDestination() else { return }
        run(.reissue(email: row.email, path: destination.path), owner: owner)
    }

    @objc private func revokeEmployee() {
        guard active == nil, let owner, let row = selected(), row.membership_status == .active else { return }
        guard confirm("Revoke access for \(row.display_name)?", detail: "\(row.email) will lose organization access and pending invitations will stop working.", button: "Revoke access") else { return }
        run(.revoke(email: row.email), owner: owner)
    }

    @objc private func revealInvitation() {
        guard let savedInvitation else { return }
        NSWorkspace.shared.activateFileViewerSelecting([savedInvitation])
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableViewSelectionDidChange(_ notification: Notification) { updateControls() }
    func tableView(_ tableView: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row), let column else { return nil }
        let employee = rows[row]
        let text: String
        switch column.identifier.rawValue {
        case "name": text = employee.display_name
        case "email": text = employee.email
        case "membership": text = employee.membership_status.rawValue.capitalized
        default: text = employee.invitationLabel
        }
        let cell = NSTextField(labelWithString: text)
        cell.lineBreakMode = .byTruncatingTail; cell.toolTip = text
        cell.textColor = EchoTheme.text
        return cell
    }

    private func configure() {
        window.title = "Organization · People"; window.isReleasedWhenClosed = false
        window.delegate = self; window.minSize = NSSize(width: 800, height: 600)
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = EchoTheme.ink
        let title = NSTextField(labelWithString: "People")
        title.font = .systemFont(ofSize: 26, weight: .semibold); title.textColor = EchoTheme.text
        identityLabel.font = .systemFont(ofSize: 12); identityLabel.textColor = EchoTheme.mutedText
        status.isSelectable = true
        status.font = .systemFont(ofSize: 13); status.textColor = EchoTheme.mutedText
        name.placeholderString = "Employee name"; email.placeholderString = "Email address"
        name.setAccessibilityLabel("Employee name"); email.setAccessibilityLabel("Employee email")
        for (button, action) in [(invite, #selector(inviteEmployee)), (refresh, #selector(refreshPeople)),
                                 (reissue, #selector(reissueInvitation)), (revoke, #selector(revokeEmployee)),
                                 (reveal, #selector(revealInvitation))] {
            button.target = self; button.action = action; button.bezelStyle = .rounded
        }
        reveal.isHidden = true
        for (id, label, width) in [("name", "Name", 165.0), ("email", "Email", 265.0),
                                   ("membership", "Membership", 105.0), ("invitation", "Invitation", 140.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            column.title = label; column.width = width; table.addTableColumn(column)
        }
        table.delegate = self; table.dataSource = self; table.rowHeight = 32
        table.usesAlternatingRowBackgroundColors = true
        table.setAccessibilityLabel("Organization employees")
        let scroll = NSScrollView(); scroll.documentView = table
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        let fields = NSStackView(views: [name, email, invite]); fields.spacing = 10
        let actions = NSStackView(views: [refresh, reissue, revoke]); actions.spacing = 10
        let content = NSStackView(views: [title, identityLabel, scroll, actions, fields, status, reveal])
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 14
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(content)
        guard let root = window.contentView else { return }
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            content.topAnchor.constraint(equalTo: root.topAnchor, constant: 24),
            content.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -24),
            scroll.widthAnchor.constraint(equalTo: content.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 180),
            fields.widthAnchor.constraint(equalTo: content.widthAnchor),
            name.widthAnchor.constraint(equalToConstant: 190),
            email.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
            status.widthAnchor.constraint(equalTo: content.widthAnchor),
            identityLabel.widthAnchor.constraint(equalTo: content.widthAnchor),
        ])
        let tableSpring = scroll.heightAnchor.constraint(equalToConstant: 10_000)
        tableSpring.priority = NSLayoutConstraint.Priority(1)
        tableSpring.isActive = true
        updateControls()
    }
}
