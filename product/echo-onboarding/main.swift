import AppKit
import Foundation

private struct SetupResult: Decodable {
    let ok: Bool
    let phase: String
    let display_name: String?
    let authority: String?
}

private let onboardingLastAuthorityDefaultsKey = "org.echobrain.echo-onboarding.last-authority-origin"

func onboardingAuthorityOrigin(_ source: String) -> String? {
    guard source.count <= 2_048,
          let components = URLComponents(string: source),
          components.scheme?.lowercased() == "https", let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil,
          components.query == nil, components.fragment == nil,
          components.path.isEmpty || components.path == "/"
    else { return nil }
    var origin = URLComponents()
    origin.scheme = "https"
    origin.host = host.lowercased()
    origin.port = components.port == 443 ? nil : components.port
    origin.path = ""
    return origin.url?.absoluteString
}

@MainActor
private final class SetupController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 520, height: 360),
        styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false
    )
    private let heading = NSTextField(labelWithString: "Welcome to ECHO")
    private let detail = NSTextField(wrappingLabelWithString: "Install ECHO, then sign in with the work account your organization invited.")
    private let status = NSTextField(wrappingLabelWithString: "Your invitation stays private. Setup takes just a few steps.")
    private let primary = NSButton(title: "Install ECHO", target: nil, action: nil)
    private let secondary = NSButton(title: "Use another account", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private var nextAction = "prepare"
    private var active: Process?
    private var cancelled = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A setup process is separate from the overlay it may replace. Keep only
        // one setup window, including when Finder opens the download twice.
        if let identifier = Bundle.main.bundleIdentifier {
            let ownPID = ProcessInfo.processInfo.processIdentifier
            if let previous = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
                .filter({ !$0.isTerminated && $0.processIdentifier < ownPID }).first {
                previous.activate(options: [])
                NSApp.terminate(nil)
                return
            }
        }
        window.title = "Set up ECHO"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 29/255, green: 28/255, blue: 28/255, alpha: 1)
        heading.font = .systemFont(ofSize: 28, weight: .semibold)
        detail.font = .systemFont(ofSize: 14)
        status.font = .systemFont(ofSize: 13)
        status.textColor = .secondaryLabelColor
        primary.bezelStyle = .rounded
        primary.keyEquivalent = "\r"
        primary.target = self
        primary.action = #selector(proceed)
        secondary.bezelStyle = .rounded
        secondary.target = self
        secondary.action = #selector(alternate)
        secondary.isHidden = true
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        let controls = NSStackView(views: [primary, secondary, spinner])
        controls.orientation = .horizontal
        controls.spacing = 12
        let stack = NSStackView(views: [heading, detail, status, controls])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)
        if let view = window.contentView {
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 36),
                stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -36),
                stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
                status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            ])
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        active == nil ? .terminateNow : .terminateCancel
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { active == nil }

    @objc private func proceed() {
        guard active == nil else { return }
        if nextAction == "open" { openInstalledApp(); return }
        if nextAction == "start" {
            let picker = NSOpenPanel()
            picker.title = "Choose your ECHO invitation"
            picker.message = "Choose the invitation file your organization owner sent you."
            picker.canChooseDirectories = false
            picker.allowsMultipleSelection = false
            guard picker.runModal() == .OK, let invitation = picker.url else { return }
            run("start", value: invitation.path)
        } else {
            run(nextAction)
        }
    }

    @objc private func alternate() {
        if (nextAction == "start" || nextAction == "login"), let active {
            cancelled = true
            secondary.isEnabled = false
            status.stringValue = "Cancelling sign-in…"
            active.terminate()
            return
        }
        guard active == nil else { return }
        if nextAction == "start" {
            guard let authority = chooseAuthorityOrigin() else { return }
            run("login", value: authority)
            return
        }
        let alert = NSAlert()
        alert.messageText = "Sign out of this ECHO account?"
        alert.informativeText = "You can then choose another person's invitation."
        alert.addButton(withTitle: "Sign out")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { run("logout") }
    }

    private func run(_ action: String, value: String? = nil) {
        guard let kit = Bundle.main.resourceURL?.appendingPathComponent("kit") else {
            showFailure("install-failed")
            return
        }
        let process = Process()
        let output = Pipe()
        process.executableURL = kit.appendingPathComponent("node")
        process.arguments = [kit.appendingPathComponent("person-onboarding-ui.mjs").path, action] + (value.map { [$0] } ?? [])
        process.environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": NSTemporaryDirectory(),
            "LANG": "en_US.UTF-8",
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { showFailure("install-failed"); return }
        active = process
        cancelled = false
        nextAction = action
        primary.isEnabled = false
        secondary.isHidden = action != "start" && action != "login"
        secondary.isEnabled = true
        secondary.title = "Cancel sign-in"
        spinner.startAnimation(nil)
        status.stringValue = action == "prepare" ? "Installing the approved ECHO app…" :
            (action == "start" || action == "login") ? "Complete Google sign-in in this Mac’s browser within 10 minutes. Invitations expire 15 minutes after issue; ask your owner for a new one if needed. Keep setup open." :
            action == "logout" ? "Signing out…" : "Checking your organization access…"
        try? output.fileHandleForWriting.close()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var bytes = Data()
            while let chunk = try? output.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
                if bytes.count + chunk.count <= 64 * 1024 { bytes.append(chunk) }
                else { process.terminate(); break }
            }
            try? output.fileHandleForReading.close()
            process.waitUntilExit()
            let last = String(data: bytes, encoding: .utf8)?.split(separator: "\n").last
            let result = last.flatMap { try? JSONDecoder().decode(SetupResult.self, from: Data($0.utf8)) }
            let succeeded = process.terminationStatus == 0
            DispatchQueue.main.async { self?.finished(result, succeeded: succeeded) }
        }
    }

    private func finished(_ result: SetupResult?, succeeded: Bool) {
        active = nil
        spinner.stopAnimation(nil)
        primary.isEnabled = true
        secondary.isEnabled = true
        secondary.isHidden = true
        if cancelled {
            nextAction = "status"
            primary.title = "Continue setup"
            status.stringValue = "Sign-in was cancelled. Continue when you're ready; ECHO will check where you left off."
            return
        }
        guard let result else { showFailure("install-failed"); return }
        guard succeeded && result.ok else { showFailure(result.phase); return }
        switch result.phase {
        case "signed-in":
            rememberAuthority(result.authority)
            heading.stringValue = "ECHO is installed"
            detail.stringValue = "Signed in as \(result.display_name ?? "your existing account")."
            status.stringValue = "Continue to verify your organization access."
            primary.title = "Continue"
            nextAction = "continue"
            secondary.title = "Use another account"
            secondary.isHidden = false
        case "needs-invitation":
            heading.stringValue = "Join your organization"
            detail.stringValue = "Choose your private invitation, then sign in with your invited work account."
            status.stringValue = "Choose person-invitation.json inside the ECHO-invitation-… folder your owner sent."
            primary.title = "Choose invitation"
            nextAction = "start"
            secondary.title = "Sign in with existing account"
            secondary.isHidden = false
        case "ready":
            rememberAuthority(result.authority)
            heading.stringValue = "You're ready"
            detail.stringValue = "Your organization access is verified. Ask ECHO is opening."
            status.stringValue = "Use ⌘E or the ECHO menu bar icon to ask a question."
            primary.title = "Open ECHO"
            nextAction = "open"
            openInstalledApp()
        default: showFailure("install-failed")
        }
    }

    private func showFailure(_ phase: String) {
        let installRecovery = [
            "compatibility-failed": "This kit requires an Apple-silicon Mac with macOS 14 or later. Update macOS or use a supported machine.",
            "kit-failed": "Re-extract the approved download and verify the archive checksum your owner supplied.",
            "destination-failed": "Check free disk space and permissions in your Applications and Library/Application Support folders, then retry."
        ]
        if let recovery = installRecovery[phase] {
            heading.stringValue = "Setup needs attention"
            status.stringValue = recovery
            primary.title = "Try again"
            nextAction = "prepare"
            return
        }

        active = nil
        spinner.stopAnimation(nil)
        primary.isEnabled = true
        secondary.isHidden = true
        if phase == "login-failed" || phase == "invalid-request" || phase == "browser-failed" {
            nextAction = "status"
            primary.title = "Continue setup"
            status.stringValue = phase == "browser-failed" ?
                "Your browser could not open. Check your default browser, then try sign-in again." :
                "Browser sign-in has a 10-minute window. Try again on this Mac. Invitations expire 15 minutes after issue; ask your owner for a new one if needed."
        } else if phase == "access-failed" {
            nextAction = "continue"
            primary.title = "Try again"
            secondary.title = "Use another account"
            secondary.isHidden = false
            status.stringValue = "ECHO could not verify your access. Check your connection or ask your owner to check your membership."
        } else {
            nextAction = "prepare"
            primary.title = "Try installation again"
            status.stringValue = "ECHO could not finish setup. Try again with the approved download from your owner."
        }
    }

    private func chooseAuthorityOrigin() -> String? {
        let alert = NSAlert()
        alert.messageText = "Sign in with an existing account"
        alert.informativeText = "Enter your organization’s HTTPS address. Setup remembers only the last successful address on this Mac."
        let field = NSTextField(string: UserDefaults.standard.string(forKey: onboardingLastAuthorityDefaultsKey) ?? "")
        field.placeholderString = "https://organization.example"
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        guard let authority = onboardingAuthorityOrigin(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            status.stringValue = "Enter an HTTPS organization address without a path, query, or fragment."
            return nil
        }
        return authority
    }

    private func rememberAuthority(_ authority: String?) {
        guard let authority, let origin = onboardingAuthorityOrigin(authority) else { return }
        UserDefaults.standard.set(origin, forKey: onboardingLastAuthorityDefaultsKey)
    }

    private func openInstalledApp() {
        let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/ECHO.app")
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = ["--show-ask"]
        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { [weak self] _, error in
            DispatchQueue.main.async {
                if error == nil { NSApp.terminate(nil) }
                else { self?.status.stringValue = "ECHO is ready. Open ECHO from your Applications folder." }
            }
        }
    }
}

@main
private enum EchoOnboardingMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let controller = SetupController()
        application.delegate = controller
        application.setActivationPolicy(.regular)
        application.run()
    }
}
