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

private struct AccountStatusResponse: Decodable {
    let schema_version: Int
    let kind: String
    let signed_in: Bool
    let display_name: String?
    let membership_type: String?
    let connected_authority: String?
    let installed_version: String?
}

private struct AccountIdentity: Equatable {
    let displayName: String
    let role: String
    let authority: String
    let version: String
}

private enum AccountStatus {
    case signedIn(AccountIdentity)
    case signedOut
    case unavailable
}

private enum AccountOperation {
    case status
    case loginAuthority(String)
    case loginInvitation(URL)
    case logout
}

private final class AccountClient: @unchecked Sendable {
    private let executable: URL

    init(executable: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ECHO/bin/echo-brain")) {
        self.executable = executable
    }

    func status(completion: @escaping @MainActor (AccountStatus) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let status = self.readStatus()
            DispatchQueue.main.async { completion(status) }
        }
    }

    func perform(_ operation: AccountOperation, completion: @escaping @MainActor (AccountStatus?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let arguments: [String]
            let timeout: TimeInterval
            switch operation {
            case .status:
                DispatchQueue.main.async { completion(self.readStatus()) }
                return
            case .loginAuthority(let origin):
                arguments = ["person", "login", "--authority-url", origin, "--open-browser"]
                timeout = accountLoginTimeout
            case .loginInvitation(let invitation):
                arguments = ["person", "login", "--invitation", invitation.path, "--open-browser"]
                timeout = accountLoginTimeout
            case .logout:
                arguments = ["person", "logout"]
                timeout = 45
            }
            guard self.runSilently(arguments, timeout: timeout) else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            let status = self.readStatus()
            DispatchQueue.main.async { completion(status) }
        }
    }

    private func readStatus() -> AccountStatus {
        guard let output = runStatus() else { return .unavailable }
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
            version: version
        ))
    }

    private func runStatus() -> Data? {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
        let process = Process()
        let stdout = Pipe()
        process.executableURL = executable
        process.arguments = ["person", "status"]
        process.environment = safeEnvironment()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let reader = AccountOutputReader(limit: 32 * 1024)
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            reader.read(from: stdout.fileHandleForReading) {
                if process.isRunning { process.terminate() }
            }
            readers.leave()
        }
        try? stdout.fileHandleForWriting.close()
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + accountStatusTimeout, execute: deadline)
        process.waitUntilExit()
        deadline.cancel()
        readers.wait()
        let (output, overflowed) = reader.result()
        guard process.terminationStatus == 0, !overflowed else { return nil }
        return output
    }

    private func runSilently(_ arguments: [String], timeout: TimeInterval) -> Bool {
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
        do { try process.run() } catch { return false }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout, execute: deadline)
        process.waitUntilExit()
        deadline.cancel()
        return process.terminationStatus == 0
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

private func validateAuthorityOrigin(_ source: String) -> String? {
    guard source.count <= 2_048,
          let components = URLComponents(string: source),
          components.scheme?.lowercased() == "https",
          components.host != nil,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.path.isEmpty || components.path == "/"
    else { return nil }
    var origin = components
    origin.path = ""
    guard let value = origin.url?.absoluteString else { return nil }
    return value
}

@MainActor
final class AccountController: NSObject {
    private let client = AccountClient()
    private let onSessionWillChange: () -> Void
    private let mayChangeSession: () -> Bool
    private let changed: () -> Void
    private let account = NSMenuItem(title: "Account", action: nil, keyEquivalent: "")
    private let detail = NSMenuItem(title: "Checking account…", action: nil, keyEquivalent: "")
    private let organization = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let version = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let signIn = NSMenuItem(title: "Sign in with Google…", action: nil, keyEquivalent: "")
    private let invitation = NSMenuItem(title: "Open invitation…", action: nil, keyEquivalent: "")
    private let switchAccount = NSMenuItem(title: "Switch account…", action: nil, keyEquivalent: "")
    private let signOut = NSMenuItem(title: "Sign out…", action: nil, keyEquivalent: "")
    private var active = false
    private var identity: AccountIdentity?

    init(onSessionWillChange: @escaping () -> Void, mayChangeSession: @escaping () -> Bool, changed: @escaping () -> Void) {
        self.onSessionWillChange = onSessionWillChange
        self.mayChangeSession = mayChangeSession
        self.changed = changed
        super.init()
        let menu = NSMenu()
        detail.isEnabled = false; organization.isEnabled = false; version.isEnabled = false
        menu.addItem(detail); menu.addItem(organization); menu.addItem(version)
        menu.addItem(.separator())
        for item in [signIn, invitation, switchAccount, signOut] {
            item.target = self
            menu.addItem(item)
        }
        signIn.action = #selector(signInWithGoogle)
        invitation.action = #selector(openInvitation)
        switchAccount.action = #selector(switchPerson)
        signOut.action = #selector(signOutPerson)
        account.submenu = menu
        updateMenu()
    }

    var menuItem: NSMenuItem { account }

    func refresh() {
        guard !active else { return }
        client.status { [weak self] status in self?.received(status) }
    }

    private func received(_ status: AccountStatus) {
        active = false
        switch status {
        case .signedIn(let identity):
            self.identity = identity
            UserDefaults.standard.set(identity.authority, forKey: accountLastAuthorityDefaultsKey)
        case .signedOut, .unavailable:
            identity = nil
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
            detail.title = active ? "Updating account…" : "Not signed in"
            organization.title = ""
            version.title = ""
        }
        organization.isHidden = !signedIn
        version.isHidden = !signedIn
        signIn.isHidden = signedIn
        invitation.isHidden = signedIn
        switchAccount.isHidden = !signedIn
        signOut.isHidden = !signedIn
        let enabled = !active
        signIn.isEnabled = enabled; invitation.isEnabled = enabled
        switchAccount.isEnabled = enabled; signOut.isEnabled = enabled
    }

    private func allowSessionChange() -> Bool {
        guard mayChangeSession() else {
            showMessage("Finish the People change first", detail: "Wait for the pending People update to finish before changing accounts.")
            return false
        }
        return true
    }

    @objc private func signInWithGoogle() {
        guard !active, allowSessionChange(), let origin = chooseAuthorityOrigin() else { return }
        perform(.loginAuthority(origin), progress: "Complete Google sign-in in your browser. ECHO will verify the account when you return.")
    }

    @objc private func openInvitation() {
        guard !active, allowSessionChange() else { return }
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

    private func perform(_ operation: AccountOperation, progress: String, thenChooseOrganization: Bool = false) {
        onSessionWillChange()
        active = true
        identity = nil
        detail.title = progress
        updateMenu()
        client.perform(operation) { [weak self] status in
            guard let self else { return }
            guard let status else {
                self.active = false; self.updateMenu()
                self.showMessage("Account action did not finish", detail: "No account changes were retried. Try again when you are ready.")
                return
            }
            self.received(status)
            if case .logout = operation, case .signedOut = status, thenChooseOrganization {
                self.signInWithGoogle()
            } else if case .logout = operation, case .signedOut = status {
                self.showMessage("Signed out", detail: "You can sign in with another organization account from the ECHO menu.")
            } else if case .signedIn = status {
                self.showMessage("Account ready", detail: "Your organization account is signed in.")
            } else {
                self.showMessage("Account action did not finish", detail: "Check your connection or invitation, then try again.")
            }
        }
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
