import AppKit
import Foundation

private let accountStatusTimeout: TimeInterval = 5
private let accountLoginTimeout: TimeInterval = 10 * 60
private let accountLastAuthorityDefaultsKey = "org.echobrain.echo.last-authority-origin"

private final class AccountOutputReader: @unchecked Sendable {
    private let limit: Int
    private let lock = NSLock()
    private var bytes = Data()
    private var overflowed = false

    init(limit: Int) { self.limit = limit }

    func read(from handle: FileHandle, overflow: @escaping @Sendable () -> Void) {
        defer { try? handle.close() }
        do {
            while let chunk = try handle.read(upToCount: 8 * 1024), !chunk.isEmpty {
                lock.lock()
                if bytes.count + chunk.count > limit {
                    overflowed = true
                    lock.unlock()
                    overflow()
                    return
                }
                bytes.append(chunk)
                lock.unlock()
            }
        } catch {
            lock.lock(); overflowed = true; lock.unlock()
            overflow()
        }
    }

    func result() -> (Data, Bool) {
        lock.lock(); defer { lock.unlock() }
        return (bytes, overflowed)
    }
}

// The controller owns this on the main actor. A completed subprocess may only
// update presentation if it still belongs to the current account generation.
final class AccountRequestGate {
    private var generation = 0

    func replace() -> Int {
        generation &+= 1
        return generation
    }

    func accepts(_ candidate: Int) -> Bool { candidate == generation }
}

private struct AccountStatusResponse: Decodable {
    let schema_version: Int
    let kind: String
    let signed_in: Bool
    let display_name: String?
    let membership_type: String?
    let connected_authority: String?
    let installed_version: String?
    let membership_id: String?
}

struct AccountIdentity: Equatable {
    let displayName: String
    let role: String
    let authority: String
    let version: String
    var membershipID: String? = nil
}

enum AccountStatus {
    case signedIn(AccountIdentity)
    case signedOut
    case unavailable
}

enum AccountOperation {
    case status
    case loginAuthority(String)
    case loginInvitation(URL)
    case logout
}

enum AccountOutcome: Equatable {
    case ready(AccountIdentity)
    case signedOut
    case unavailable
    case accessDenied
    case failed
    case cancelled
}

final class AccountRunning: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false
    private var timedOut = false

    func launch(_ process: Process) throws -> Bool {
        lock.lock()
        guard !cancelled else { lock.unlock(); return false }
        self.process = process
        do { try process.run(); lock.unlock(); return true }
        catch { self.process = nil; lock.unlock(); throw error }
    }

    func detach(_ process: Process) {
        lock.lock(); if self.process === process { self.process = nil }; lock.unlock()
    }

    func cancel() {
        lock.lock(); cancelled = true; let active = process; lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func timeOut() {
        lock.lock(); guard !cancelled else { lock.unlock(); return }
        timedOut = true; let active = process; lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func state() -> (cancelled: Bool, timedOut: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (cancelled, timedOut)
    }
}

final class AccountClient: @unchecked Sendable {
    private let executable: URL

    init(executable: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ECHO/bin/echo-brain")) {
        self.executable = executable
    }

    @discardableResult
    func status(completion: @escaping @MainActor (AccountStatus) -> Void) -> AccountRunning {
        let running = AccountRunning()
        DispatchQueue.global(qos: .userInitiated).async {
            let status = self.readStatus(running)
            DispatchQueue.main.async { completion(status) }
        }
        return running
    }

    @discardableResult
    func perform(_ operation: AccountOperation, completion: @escaping @MainActor (AccountOutcome) -> Void) -> AccountRunning {
        let running = AccountRunning()
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = self.execute(operation, running: running)
            DispatchQueue.main.async { completion(outcome) }
        }
        return running
    }

    func execute(_ operation: AccountOperation, running: AccountRunning) -> AccountOutcome {
        switch operation {
        case .status:
            switch readStatus(running) {
            case .signedIn(let identity): return .ready(identity)
            case .signedOut: return .signedOut
            case .unavailable: return state(for: running)
            }
        case .logout:
            guard runSilently(["person", "logout"], timeout: 45, running: running) else { return state(for: running) }
            switch readStatus(running) {
            case .signedOut: return .signedOut
            case .unavailable: return state(for: running)
            case .signedIn: return .failed
            }
        case .loginAuthority(let origin):
            return login(
                arguments: ["person", "login", "--authority-url", origin, "--open-browser"],
                expectedOrigin: origin,
                running: running
            )
        case .loginInvitation(let invitation):
            return login(
                arguments: ["person", "login", "--invitation", invitation.path, "--open-browser"],
                expectedOrigin: nil,
                running: running
            )
        }
    }

    private func login(arguments: [String], expectedOrigin: String?, running: AccountRunning) -> AccountOutcome {
        // Refuse to replace any local session without the explicit sign-out path.
        guard case .signedOut = readStatus(running) else { return state(for: running) }
        guard runSilently(arguments, timeout: accountLoginTimeout, running: running) else { return state(for: running) }
        guard case .signedIn(let beforeRead) = readStatus(running),
              expectedOrigin.map({ $0 == beforeRead.authority }) ?? true
        else { return state(for: running) }
        guard permissionAwareRead(running) else { return state(for: running, accessFailure: true) }
        guard case .signedIn(let afterRead) = readStatus(running), afterRead == beforeRead else {
            return state(for: running, accessFailure: true)
        }
        return .ready(afterRead)
    }

    private func state(for running: AccountRunning, accessFailure: Bool = false) -> AccountOutcome {
        let state = running.state()
        if state.cancelled { return .cancelled }
        if state.timedOut { return .failed }
        return accessFailure ? .accessDenied : .unavailable
    }

    func readStatus(_ running: AccountRunning) -> AccountStatus {
        guard let output = runStatus(running) else { return .unavailable }
        guard let response = try? JSONDecoder().decode(AccountStatusResponse.self, from: output),
              response.schema_version == 1,
              response.kind == "echo-person-client-status-v1"
        else { return .unavailable }
        guard response.signed_in else { return .signedOut }
        guard let displayName = response.display_name,
              validAccountLabel(displayName, maximum: 200),
              let role = response.membership_type,
              role == "owner" || role == "employee",
              let authority = response.connected_authority,
              let origin = validateAuthorityOrigin(authority),
              let version = response.installed_version,
              validAccountLabel(version, maximum: 64)
        else { return .unavailable }
        return .signedIn(AccountIdentity(
            displayName: displayName,
            role: role.capitalized,
            authority: origin,
            version: version,
            membershipID: response.membership_id
        ))
    }

    private func runStatus(_ running: AccountRunning) -> Data? {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
        let process = Process()
        let stdout = Pipe()
        process.executableURL = executable
        process.arguments = ["person", "status"]
        process.environment = safeEnvironment()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do { guard try running.launch(process) else { return nil } } catch { return nil }
        let reader = AccountOutputReader(limit: 32 * 1024)
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            reader.read(from: stdout.fileHandleForReading) {
                running.cancel()
            }
            readers.leave()
        }
        try? stdout.fileHandleForWriting.close()
        let deadline = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + accountStatusTimeout, execute: deadline)
        process.waitUntilExit()
        deadline.cancel()
        readers.wait(); running.detach(process)
        let (output, overflowed) = reader.result()
        let state = running.state()
        guard process.terminationStatus == 0, !overflowed, !state.cancelled, !state.timedOut else { return nil }
        return output
    }

    private func permissionAwareRead(_ running: AccountRunning) -> Bool {
        guard let output = runCaptured(["person", "records", "--limit", "1"], timeout: 45, running: running),
              let root = try? JSONSerialization.jsonObject(with: output) as? [String: Any],
              root["ok"] as? Bool == true,
              let result = root["result"] as? [String: Any],
              result["schema_version"] as? Int == 1,
              result["kind"] as? String == "echo-clean-person-record-list-v1",
              result["records"] is [Any]
        else { return false }
        return true
    }

    private func runSilently(_ arguments: [String], timeout: TimeInterval, running: AccountRunning) -> Bool {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else { return false }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = safeEnvironment()
        process.standardInput = FileHandle.nullDevice
        // Authentication diagnostics, including any browser handoff detail, do
        // not cross the native UI boundary.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { guard try running.launch(process) else { return false } } catch { return false }
        let deadline = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout, execute: deadline)
        process.waitUntilExit()
        deadline.cancel()
        running.detach(process)
        let state = running.state()
        return process.terminationStatus == 0 && !state.cancelled && !state.timedOut
    }

    func runCaptured(_ arguments: [String], timeout: TimeInterval, running: AccountRunning, input: Data? = nil) -> Data? {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
        let process = Process()
        let stdout = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = safeEnvironment()
        let stdin = Pipe()
        process.standardInput = input == nil ? FileHandle.nullDevice : stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do { guard try running.launch(process) else { return nil } } catch { return nil }
        if let input {
            try? stdin.fileHandleForWriting.write(contentsOf: input)
            try? stdin.fileHandleForWriting.close()
        }
        let reader = AccountOutputReader(limit: 128 * 1024)
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            reader.read(from: stdout.fileHandleForReading) { running.cancel() }
            readers.leave()
        }
        try? stdout.fileHandleForWriting.close()
        let deadline = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout, execute: deadline)
        process.waitUntilExit()
        deadline.cancel(); readers.wait(); running.detach(process)
        let (output, overflowed) = reader.result()
        let state = running.state()
        guard process.terminationStatus == 0, !overflowed, !state.cancelled, !state.timedOut else { return nil }
        return output
    }

    private func safeEnvironment() -> [String: String] {
        [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": NSTemporaryDirectory(),
            "LANG": "en_US.UTF-8",
        ]
    }
}

private func validAccountLabel(_ value: String, maximum: Int) -> Bool {
    !value.isEmpty && value.count <= maximum &&
        value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
}

func validateAuthorityOrigin(_ source: String) -> String? {
    guard source.count <= 2_048,
          let components = URLComponents(string: source),
          components.scheme?.lowercased() == "https",
          let host = components.host, !host.isEmpty,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.path.isEmpty || components.path == "/"
    else { return nil }
    var origin = URLComponents()
    origin.scheme = "https"
    origin.host = host.lowercased()
    origin.port = components.port == 443 ? nil : components.port
    origin.path = ""
    guard let value = origin.url?.absoluteString else { return nil }
    return value
}

private enum AccountObservedState: Equatable {
    case signedIn(AccountIdentity)
    case signedOut
    case unavailable
}

// The first status has no prior account-scoped content to clear. Every later
// distinct result is an external account transition and must invalidate it.
final class AccountObservation {
    private var current: AccountObservedState?

    func accept(_ status: AccountStatus) -> Bool {
        let next = AccountObservedState(status)
        defer { current = next }
        guard let current else { return false }
        return current != next
    }

    func record(_ status: AccountStatus) { current = AccountObservedState(status) }
}

private extension AccountObservedState {
    init(_ status: AccountStatus) {
        switch status {
        case .signedIn(let identity): self = .signedIn(identity)
        case .signedOut: self = .signedOut
        case .unavailable: self = .unavailable
        }
    }
}

@MainActor
final class AccountController: NSObject {
    private let client = AccountClient()
    private let onSessionWillChange: () -> Void
    private let mayChangeSession: () -> Bool
    private let changed: () -> Void
    private let connectedTools = NSMenuItem(title: "Connected tools…", action: nil, keyEquivalent: "")
    private var toolsController: ConnectedToolsController?
    private let account = NSMenuItem(title: "Account", action: nil, keyEquivalent: "")
    private let detail = NSMenuItem(title: "Checking account…", action: nil, keyEquivalent: "")
    private let organization = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let version = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let signIn = NSMenuItem(title: "Sign in with Google…", action: nil, keyEquivalent: "")
    private let invitation = NSMenuItem(title: "Open invitation…", action: nil, keyEquivalent: "")
    private let switchAccount = NSMenuItem(title: "Switch account…", action: nil, keyEquivalent: "")
    private let signOut = NSMenuItem(title: "Sign out…", action: nil, keyEquivalent: "")
    private let cancelSignIn = NSMenuItem(title: "Cancel sign-in", action: nil, keyEquivalent: "")
    private var active = false
    private var identity: AccountIdentity?
    private var knownSignedOut = false
    private let statusGate = AccountRequestGate()
    private let operationGate = AccountRequestGate()
    private var activeStatus: AccountRunning?
    private var activeOperation: AccountRunning?
    private var activeOperationKind: AccountOperation?
    private var activityText = ""
    private let observation = AccountObservation()

    init(onSessionWillChange: @escaping () -> Void, mayChangeSession: @escaping () -> Bool, changed: @escaping () -> Void) {
        self.onSessionWillChange = onSessionWillChange
        self.mayChangeSession = mayChangeSession
        self.changed = changed
        super.init()
        let menu = NSMenu()
        detail.isEnabled = false; organization.isEnabled = false; version.isEnabled = false
        menu.addItem(detail); menu.addItem(organization); menu.addItem(version)
        menu.addItem(.separator())
        for item in [connectedTools, signIn, invitation, switchAccount, signOut, cancelSignIn] {
            item.target = self
            menu.addItem(item)
        }
        connectedTools.action = #selector(showConnectedTools)
        signIn.action = #selector(signInWithGoogle)
        invitation.action = #selector(openInvitation)
        switchAccount.action = #selector(switchPerson)
        signOut.action = #selector(signOutPerson)
        cancelSignIn.action = #selector(cancelPendingSignIn)
        account.submenu = menu
        updateMenu()
    }

    var menuItem: NSMenuItem { account }

    func shutdown() {
        toolsController?.conceal()
        _ = statusGate.replace()
        _ = operationGate.replace()
        activeStatus?.cancel()
        activeOperation?.cancel()
        activeStatus = nil
        activeOperation = nil
        activeOperationKind = nil
    }

    func refresh() {
        guard !active else { return }
        activeStatus?.cancel()
        let requestID = statusGate.replace()
        activeStatus = client.status { [weak self] status in
            guard let self, self.statusGate.accepts(requestID), !self.active else { return }
            self.activeStatus = nil
            self.receivedStableStatus(status)
        }
    }

    private func receivedStableStatus(_ status: AccountStatus) {
        if observation.accept(status) { toolsController?.conceal(); onSessionWillChange() }
        switch status {
        case .signedIn(let identity):
            self.identity = identity
            knownSignedOut = false
            UserDefaults.standard.set(identity.authority, forKey: accountLastAuthorityDefaultsKey)
        case .signedOut:
            identity = nil
            knownSignedOut = true
        case .unavailable:
            identity = nil
            knownSignedOut = false
        }
        updateMenu()
        changed()
    }

    private func updateMenu() {
        let signedIn = identity != nil
        if let identity {
            detail.title = "Signed in as \(identity.displayName) · \(identity.role)"
            organization.title = "Organization: \(identity.authority)"
            version.title = "ECHO \(identity.version)"
        } else {
            detail.title = active ? activityText : (knownSignedOut ? "Not signed in" : "Account status unavailable")
            organization.title = ""
            version.title = ""
        }
        organization.isHidden = !signedIn
        version.isHidden = !signedIn
        connectedTools.isHidden = !signedIn
        connectedTools.isEnabled = signedIn && !active
        signIn.isHidden = signedIn
        invitation.isHidden = signedIn
        switchAccount.isHidden = !signedIn
        signOut.isHidden = !signedIn
        cancelSignIn.isHidden = !active || !isLogin(activeOperationKind)
        cancelSignIn.isEnabled = active && isLogin(activeOperationKind)
        let signInEnabled = !active && knownSignedOut
        let signedInEnabled = !active && signedIn
        signIn.isEnabled = signInEnabled; invitation.isEnabled = signInEnabled
        switchAccount.isEnabled = signedInEnabled; signOut.isEnabled = signedInEnabled
    }

    @objc private func showConnectedTools() {
        guard !active, let identity else { return }
        if toolsController == nil { toolsController = ConnectedToolsController(client: client) }
        toolsController?.show(identity: identity)
    }

    private func allowSessionChange() -> Bool {
        guard mayChangeSession() else {
            showMessage("Finish the People change first", detail: "Wait for the pending People update to finish before changing accounts.")
            return false
        }
        return true
    }

    @objc private func signInWithGoogle() {
        guard !active, knownSignedOut, allowSessionChange(), let origin = chooseAuthorityOrigin() else { return }
        perform(.loginAuthority(origin), progress: "Complete Google sign-in in your browser. ECHO will verify the account when you return.")
    }

    @objc private func openInvitation() {
        guard !active, knownSignedOut, allowSessionChange() else { return }
        let picker = NSOpenPanel()
        picker.title = "Choose your ECHO invitation"
        picker.message = "Choose the invitation file your organization owner sent you."
        picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        guard picker.runModal() == .OK, let invitation = picker.url else { return }
        perform(.loginInvitation(invitation), progress: "Complete Google sign-in in your browser. ECHO will verify the account when you return.")
    }

    @objc private func switchPerson() {
        guard !active, allowSessionChange(), confirmSignOut("Switch account", detail: "ECHO will sign out before you choose the next organization account.") else { return }
        perform(.logout, progress: "Signing out…", thenChooseOrganization: true)
    }

    @objc private func signOutPerson() {
        guard !active, allowSessionChange(), confirmSignOut("Sign out of this ECHO account?", detail: "Ask and organization information will be cleared on this Mac.") else { return }
        perform(.logout, progress: "Signing out…")
    }

    @objc private func cancelPendingSignIn() {
        guard active, isLogin(activeOperationKind) else { return }
        activityText = "Cancelling sign-in…"
        activeOperation?.cancel()
        updateMenu()
    }

    private func perform(_ operation: AccountOperation, progress: String, thenChooseOrganization: Bool = false) {
        _ = statusGate.replace()
        activeStatus?.cancel()
        activeStatus = nil
        toolsController?.conceal()
        onSessionWillChange()
        active = true
        identity = nil
        knownSignedOut = false
        activityText = progress
        let requestID = operationGate.replace()
        activeOperationKind = operation
        updateMenu()
        activeOperation = client.perform(operation) { [weak self] outcome in
            guard let self else { return }
            guard self.operationGate.accepts(requestID) else { return }
            self.active = false
            self.activeOperation = nil
            self.activeOperationKind = nil
            self.activityText = ""
            switch outcome {
            case .ready(let identity):
                self.identity = identity
                self.knownSignedOut = false
                UserDefaults.standard.set(identity.authority, forKey: accountLastAuthorityDefaultsKey)
                self.observation.record(.signedIn(identity))
                self.changed()
            case .signedOut:
                self.identity = nil
                self.knownSignedOut = true
                self.observation.record(.signedOut)
                self.changed()
            case .unavailable, .accessDenied, .failed, .cancelled:
                self.identity = nil
                self.knownSignedOut = false
                self.observation.record(.unavailable)
            }
            self.updateMenu()
            if case .logout = operation, case .signedOut = outcome, thenChooseOrganization {
                self.signInWithGoogle()
            } else if case .logout = operation, case .signedOut = outcome {
                self.showMessage("Signed out", detail: "You can sign in with another organization account from the ECHO menu.")
            } else if case .ready = outcome {
                self.showMessage("Account ready", detail: "Your organization account is signed in.")
            } else if case .cancelled = outcome {
                self.showMessage("Sign-in cancelled", detail: "ECHO did not retry the account action.")
            } else if case .accessDenied = outcome {
                self.showMessage("Account access was not verified", detail: "ECHO could not complete an organization read. Check your membership before trying again.")
            } else {
                self.showMessage("Account status was not verified", detail: "ECHO did not retry the account action. Check your connection or invitation, then try again.")
            }
        }
    }

    private func isLogin(_ operation: AccountOperation?) -> Bool {
        if case .loginAuthority? = operation { return true }
        if case .loginInvitation? = operation { return true }
        return false
    }

    private func chooseAuthorityOrigin() -> String? {
        let alert = NSAlert()
        alert.messageText = "Sign in with Google"
        alert.informativeText = "Enter your organization’s HTTPS address. ECHO remembers only the last successful address on this Mac."
        let field = NSTextField(string: UserDefaults.standard.string(forKey: accountLastAuthorityDefaultsKey) ?? "")
        field.placeholderString = "https://organization.example"
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        guard let origin = validateAuthorityOrigin(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            showMessage("Enter a valid organization address", detail: "Use an HTTPS address without a path, query, or fragment.")
            return nil
        }
        return origin
    }

    private func confirmSignOut(_ title: String, detail: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "Sign out")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func showMessage(_ title: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

// This screen receives only the bounded installed-client tools contract.
struct ConnectedTool: Decodable {
    let provider: String
    let availability: String
    let personal_status: String
    let workspace_id: String?
    let account_id: String?
}
struct ConnectedToolsResult: Decodable {
    let schema_version: Int
    let kind: String
    let organization_id: String
    let membership_id: String
    let tools: [ConnectedTool]
}
struct ConnectedToolsEnvelope: Decodable { let ok: Bool; let result: ConnectedToolsResult }

func decodeConnectedTools(_ data: Data, membershipID: String?) -> ConnectedToolsResult? {
    guard data.count <= 4096,
          let value = try? JSONDecoder().decode(ConnectedToolsEnvelope.self, from: data), value.ok,
          value.result.schema_version == 2, value.result.kind == "echo-organization-person-tools",
          membershipID == value.result.membership_id, value.result.tools.count <= 1
    else { return nil }
    for tool in value.result.tools {
        guard tool.provider == "slack" else { return nil }
        if tool.availability == "unavailable" {
            guard tool.personal_status == "unavailable", tool.workspace_id == nil, tool.account_id == nil else { return nil }
        } else {
            guard tool.availability == "enabled", let workspace = tool.workspace_id,
                  workspace.range(of: "^T[A-Z0-9]{2,127}$", options: .regularExpression) != nil,
                  ["linked", "unlinked", "revoked"].contains(tool.personal_status) else { return nil }
            if tool.personal_status == "linked" {
                guard let account = tool.account_id, account.range(of: "^[UW][A-Z0-9]{2,127}$", options: .regularExpression) != nil else { return nil }
            } else if tool.account_id != nil { return nil }
        }
    }
    return value.result
}

func connectedToolsSummary(_ result: ConnectedToolsResult?) -> String {
    guard let result else { return "Status unknown. Could not read connected tools. Try Refresh." }
    guard let tool = result.tools.first else { return "Your organization has no supported tools enabled." }
    guard tool.availability == "enabled" else { return "Slack · Organization: unavailable\nYour link: unavailable" }
    return "Slack · Organization: enabled (\(tool.workspace_id ?? ""))\nYour link: \(tool.personal_status)" + (tool.account_id.map { " (\($0))" } ?? "")
}

struct SlackLinkChallenge: Decodable {
    let challenge_attempt_id: String
    let challenge_message_ts: String
    let challenge_code: String
    let channel_id: String
    let expires_at: String
}

@MainActor
final class ConnectedToolsController: NSObject {
    private let client: AccountClient
    private let gate = AccountRequestGate()
    private var running: AccountRunning?
    private var identity: AccountIdentity?
    private var challenge: SlackLinkChallenge?
    private var window: NSWindow?
    private let context = NSTextField(wrappingLabelWithString: "")
    private let state = NSTextField(wrappingLabelWithString: "")
    private let recipient = NSTextField(string: "")
    private let code = NSTextField(string: "")
    private let refreshButton = NSButton(title: "Refresh", target: nil, action: nil)
    private let linkButton = NSButton(title: "Send private Slack DM", target: nil, action: nil)
    private let completeButton = NSButton(title: "I replied in Slack", target: nil, action: nil)

    init(client: AccountClient) { self.client = client; super.init() }

    func show(identity: AccountIdentity) {
        conceal()
        self.identity = identity
        if window == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 490, height: 370), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "Connected tools"; panel.isReleasedWhenClosed = false
            recipient.placeholderString = "Slack member ID (U… or W…)"
            code.isEditable = false; code.isSelectable = true
            let optional = NSTextField(wrappingLabelWithString: "Linking Slack is optional. Ask and Sources use your existing organization access.")
            let stack = NSStackView(views: [context, state, recipient, linkButton, code, completeButton, refreshButton, optional])
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
            stack.translatesAutoresizingMaskIntoConstraints = false
            panel.contentView?.addSubview(stack)
            if let content = panel.contentView {
                NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24)])
            }
            for button in [linkButton, completeButton, refreshButton] { button.target = self }
            refreshButton.action = #selector(refresh)
            linkButton.action = #selector(beginLink)
            completeButton.action = #selector(completeLink)
            window = panel
        }
        context.stringValue = "\(identity.displayName) · \(identity.authority)"
        window?.center(); window?.makeKeyAndOrderFront(nil)
        refresh()
    }

    func conceal() {
        _ = gate.replace(); running?.cancel(); running = nil; identity = nil
        challenge = nil; code.stringValue = ""; code.isHidden = true; recipient.stringValue = ""
        context.stringValue = ""; state.stringValue = "Status unknown"
        linkButton.isHidden = true; completeButton.isHidden = true
        window?.orderOut(nil)
    }

    private func request(_ arguments: [String], input: Data? = nil, completion: @escaping (Data?) -> Void) {
        running?.cancel()
        let requestID = gate.replace(); let operation = AccountRunning(); running = operation
        refreshButton.isEnabled = false; linkButton.isEnabled = false; completeButton.isEnabled = false
        let client = self.client
        let expectedIdentity = self.identity
        DispatchQueue.global(qos: .userInitiated).async {
            var output: Data? = nil
            if case .signedIn(let before) = client.readStatus(operation), before == expectedIdentity {
                output = client.runCaptured(arguments, timeout: 80, running: operation, input: input)
                if case .signedIn(let after) = client.readStatus(operation), after == expectedIdentity {} else { output = nil }
            }
            let result = output
            DispatchQueue.main.async { [weak self] in
                guard let self, self.gate.accepts(requestID), self.identity != nil else { return }
                self.running = nil; self.refreshButton.isEnabled = true; self.linkButton.isEnabled = true; self.completeButton.isEnabled = true
                completion(result)
            }
        }
    }

    @objc func refresh() {
        challenge = nil; code.stringValue = ""; code.isHidden = true; completeButton.isHidden = true
        recipient.isHidden = true; linkButton.isHidden = true; state.stringValue = "Checking organization tools…"
        request(["person", "tools"]) { [weak self] data in
            guard let self else { return }
            guard let data, let result = decodeConnectedTools(data, membershipID: self.identity?.membershipID) else {
                self.state.stringValue = connectedToolsSummary(nil)
                return
            }
            guard let slack = result.tools.first else {
                self.state.stringValue = connectedToolsSummary(result)
                return
            }
            if slack.availability == "unavailable" {
                self.state.stringValue = connectedToolsSummary(result)
                return
            }
            self.state.stringValue = connectedToolsSummary(result)
            self.recipient.isHidden = slack.personal_status == "linked"
            self.linkButton.isHidden = slack.personal_status == "linked"
        }
    }

    @objc private func beginLink() {
        let user = recipient.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard user.range(of: "^[UW][A-Z0-9]{2,127}$", options: .regularExpression) != nil else {
            state.stringValue = "Enter your Slack member ID from your Slack profile, then try again."
            return
        }
        challenge = nil; code.stringValue = ""; code.isHidden = true; completeButton.isHidden = true
        state.stringValue = "Opening your private Slack DM…"
        request(["person", "slack-link-begin", "--slack-user", user]) { [weak self] data in
            guard let self else { return }
            guard let data, let value = try? JSONDecoder().decode(SlackLinkChallenge.self, from: data),
                  value.channel_id.hasPrefix("D"), value.challenge_code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  value.challenge_attempt_id.range(of: "^cat_[A-Za-z0-9_-]{1,96}$", options: .regularExpression) != nil,
                  value.challenge_message_ts.range(of: "^[0-9]{1,16}\\.[0-9]{1,16}$", options: .regularExpression) != nil
            else {
                self.state.stringValue = "Could not deliver a private DM. Check your Slack member ID and connection, then retry or Refresh."
                return
            }
            self.challenge = value; self.code.isHidden = false; self.code.stringValue = value.challenge_code
            self.completeButton.isHidden = false; self.linkButton.isHidden = true
            self.state.stringValue = "Reply with this code in the ECHO bot’s private DM thread, then choose ‘I replied in Slack’. The code expires in 15 minutes."
        }
    }

    @objc private func completeLink() {
        guard let challenge else { return }
        state.stringValue = "Verifying your Slack reply…"
        request(["person", "slack-link-complete", "--challenge-attempt", challenge.challenge_attempt_id, "--challenge-message-ts", challenge.challenge_message_ts], input: Data(challenge.challenge_code.utf8)) { [weak self] data in
            guard let self else { return }
            if data != nil { self.refresh() }
            else { self.state.stringValue = "The reply was not verified. Check the exact DM thread and retry, or Refresh to start again if the code expired." }
        }
    }
}
