import AppKit
import Carbon
import Foundation

private let askTimeoutSeconds: TimeInterval = 145
private let identityTimeoutSeconds: TimeInterval = 5
private let maximumQuestionBytes = 64 * 1024
private let maximumProcessOutputBytes = 128 * 1024
private let hotKeySignature: OSType = 0x4543484F // "ECHO"
private let hotKeyIdentifier = EventHotKeyID(signature: hotKeySignature, id: 1)
private let allowedCitationPolicies: Set<String> = [
    "organization-member-readable-person-v2",
    "restricted-reviewer-person-v2",
]

private struct CliCitation: Decodable {
    let policy_id: String
}

private struct CliAnswer: Decodable {
    let schema_version: Int
    let kind: String
    let answer: String
    let citations: [CliCitation]
}

private struct CliSuccessEnvelope: Decodable {
    let ok: Bool
    let result: CliAnswer
}

private struct CliFailureEnvelope: Decodable {
    let ok: Bool
    let action: String
    let error: String
}

private struct CliStatus: Decodable {
    let schema_version: Int
    let kind: String
    let signed_in: Bool
    let display_name: String?
}

private struct DisplayAnswer: Sendable {
    let answer: String
    let citationCount: Int
    let citationPolicies: [String]
}

private enum AskOutcome: Sendable {
    case success(DisplayAnswer)
    case failure(String)
    case cancelled
}

private enum IdentityOutcome: Sendable {
    case signedIn(String)
    case signedOut
    case failure
}

private final class BoundedReader: @unchecked Sendable {
    private let maximumBytes: Int
    private let lock = NSLock()
    private var bytes = Data()
    private(set) var exceeded = false

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    func read(from handle: FileHandle, overflow: @escaping @Sendable () -> Void) {
        defer { try? handle.close() }
        do {
            while let chunk = try handle.read(upToCount: 8 * 1024), !chunk.isEmpty {
                lock.lock()
                if bytes.count + chunk.count > maximumBytes {
                    exceeded = true
                    lock.unlock()
                    overflow()
                    return
                }
                bytes.append(chunk)
                lock.unlock()
            }
        } catch {
            lock.lock()
            exceeded = true
            lock.unlock()
            overflow()
        }
    }

    func data() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return bytes
    }

    func didExceedLimit() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return exceeded
    }
}

private final class RunningAsk: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false
    private var timedOut = false
    private var outputExceeded = false

    func launch(_ process: Process) throws -> Bool {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return false
        }
        self.process = process
        do {
            try process.run()
            lock.unlock()
            return true
        } catch {
            self.process = nil
            lock.unlock()
            throw error
        }
    }

    func detach(_ process: Process) {
        lock.lock()
        if self.process === process { self.process = nil }
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let active = process
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func timeOut() {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return
        }
        timedOut = true
        let active = process
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func exceedOutputLimit() {
        lock.lock()
        outputExceeded = true
        let active = process
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func state() -> (cancelled: Bool, timedOut: Bool, outputExceeded: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (cancelled, timedOut, outputExceeded)
    }
}

private final class CliRunner: @unchecked Sendable {
    private let executable: URL

    init() {
        executable = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ECHO/bin/echo-brain")
    }

    func ask(
        question: String,
        completion: @escaping @Sendable (AskOutcome) -> Void
    ) -> RunningAsk {
        let running = RunningAsk()
        let executable = self.executable
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Self.execute(executable: executable, question: question, running: running)
            DispatchQueue.main.async { completion(outcome) }
        }
        return running
    }

    func identity(
        completion: @escaping @Sendable (IdentityOutcome) -> Void
    ) -> RunningAsk {
        let running = RunningAsk()
        let executable = self.executable
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Self.executeIdentity(executable: executable, running: running)
            DispatchQueue.main.async { completion(outcome) }
        }
        return running
    }

    private static func execute(
        executable: URL,
        question: String,
        running: RunningAsk
    ) -> AskOutcome {
        guard executable.isFileURL,
              executable.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: executable.path)
        else {
            return .failure("The installed ECHO client is unavailable.")
        }

        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executable
        process.arguments = ["person", "ask", "--question", question]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr

        let stdoutReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let stderrReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stdoutReader.read(from: stdout.fileHandleForReading) {
                running.exceedOutputLimit()
            }
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stderrReader.read(from: stderr.fileHandleForReading) {
                running.exceedOutputLimit()
            }
            readers.leave()
        }

        do {
            guard try running.launch(process) else {
                try? stdout.fileHandleForWriting.close()
                try? stderr.fileHandleForWriting.close()
                readers.wait()
                return .cancelled
            }
        } catch {
            try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForWriting.close()
            readers.wait()
            running.detach(process)
            return .failure("The installed ECHO client is unavailable.")
        }
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()

        let timeout = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(
            deadline: .now() + askTimeoutSeconds,
            execute: timeout
        )
        process.waitUntilExit()
        timeout.cancel()
        readers.wait()
        running.detach(process)

        let state = running.state()
        if state.cancelled { return .cancelled }
        if state.timedOut {
            return .failure("The ECHO request timed out. Try again.")
        }
        if state.outputExceeded || stdoutReader.didExceedLimit() || stderrReader.didExceedLimit() {
            return .failure("The installed ECHO client returned an invalid response.")
        }

        if process.terminationStatus == 0 {
            return parseSuccess(stdoutReader.data())
        }
        return parseFailure(stderrReader.data())
    }

    private static func parseSuccess(_ data: Data) -> AskOutcome {
        guard let envelope = try? JSONDecoder().decode(CliSuccessEnvelope.self, from: data),
              envelope.ok,
              envelope.result.schema_version == 1,
              envelope.result.kind == "echo-clean-person-answer-v1",
              !envelope.result.answer.isEmpty,
              envelope.result.citations.allSatisfy({
                  allowedCitationPolicies.contains($0.policy_id)
              })
        else {
            return .failure("The installed ECHO client returned an invalid response.")
        }

        var seen = Set<String>()
        let policies = envelope.result.citations.compactMap { citation in
            seen.insert(citation.policy_id).inserted ? citation.policy_id : nil
        }
        return .success(DisplayAnswer(
            answer: envelope.result.answer,
            citationCount: envelope.result.citations.count,
            citationPolicies: policies
        ))
    }

    private static func parseFailure(_ data: Data) -> AskOutcome {
        guard let envelope = try? JSONDecoder().decode(CliFailureEnvelope.self, from: data),
              !envelope.ok,
              envelope.action == "ask",
              !envelope.error.isEmpty
        else {
            return .failure("ECHO could not answer that question. Try again.")
        }
        return .failure("ECHO could not answer that question. \(envelope.error)")
    }

    private static func executeIdentity(
        executable: URL,
        running: RunningAsk
    ) -> IdentityOutcome {
        guard executable.isFileURL,
              executable.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: executable.path)
        else {
            return .failure
        }

        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executable
        process.arguments = ["person", "status"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr

        let stdoutReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let stderrReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stdoutReader.read(from: stdout.fileHandleForReading) {
                running.exceedOutputLimit()
            }
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stderrReader.read(from: stderr.fileHandleForReading) {
                running.exceedOutputLimit()
            }
            readers.leave()
        }

        do {
            guard try running.launch(process) else {
                try? stdout.fileHandleForWriting.close()
                try? stderr.fileHandleForWriting.close()
                readers.wait()
                return .failure
            }
        } catch {
            try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForWriting.close()
            readers.wait()
            running.detach(process)
            return .failure
        }
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()

        let timeout = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(
            deadline: .now() + identityTimeoutSeconds,
            execute: timeout
        )
        process.waitUntilExit()
        timeout.cancel()
        readers.wait()
        running.detach(process)

        let state = running.state()
        guard process.terminationStatus == 0,
              !state.cancelled,
              !state.timedOut,
              !state.outputExceeded,
              !stdoutReader.didExceedLimit(),
              !stderrReader.didExceedLimit(),
              let status = try? JSONDecoder().decode(CliStatus.self, from: stdoutReader.data()),
              status.schema_version == 1,
              status.kind == "echo-person-client-status-v1"
        else {
            return .failure
        }
        guard status.signed_in else { return .signedOut }
        guard let displayName = status.display_name,
              let firstName = displayName.split(whereSeparator: { $0.isWhitespace }).first,
              !firstName.isEmpty,
              firstName.utf8.count <= 80
        else {
            return .failure
        }
        return .signedIn(String(firstName))
    }
}

private final class EchoPanel: NSPanel {
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

@MainActor
private final class OverlayController: NSObject, NSWindowDelegate {
    private let runner = CliRunner()
    private let panel: EchoPanel
    private let questionField = NSSearchField()
    private let askButton = NSButton(title: "Ask", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private let identityLabel = NSTextField(labelWithString: "Checking signed-in user…")
    private let statusLabel = NSTextField(labelWithString: "Ask ECHO a question")
    private let answerView = NSTextView()
    private let citationLabel = NSTextField(labelWithString: "")
    private var activeAsk: RunningAsk?
    private var requestIdentifier: UUID?
    private var activeIdentityLookup: RunningAsk?
    private var identityRequestIdentifier: UUID?

    override init() {
        panel = EchoPanel(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 420),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        super.init()
        configurePanel()
        configureContent()
    }

    func showPrompt() {
        cancelActiveAsk()
        refreshIdentity()
        questionField.stringValue = ""
        questionField.isEnabled = true
        askButton.isEnabled = true
        statusLabel.stringValue = "Ask ECHO a question"
        answerView.string = ""
        citationLabel.stringValue = ""
        spinner.stopAnimation(nil)
        panel.center()
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(questionField)
    }

    func cancelAndHide() {
        cancelActiveAsk()
        cancelIdentityLookup()
        panel.orderOut(nil)
    }

    func windowWillClose(_ notification: Notification) {
        cancelActiveAsk()
        cancelIdentityLookup()
    }

    @objc private func submit() {
        let question = questionField.stringValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else {
            statusLabel.stringValue = "Type a question first."
            return
        }
        guard question.lengthOfBytes(using: .utf8) <= maximumQuestionBytes else {
            statusLabel.stringValue = "The question is too long."
            return
        }

        cancelActiveAsk()
        let identifier = UUID()
        requestIdentifier = identifier
        questionField.isEnabled = false
        askButton.isEnabled = false
        answerView.string = ""
        citationLabel.stringValue = ""
        statusLabel.stringValue = "Asking ECHO…"
        spinner.startAnimation(nil)

        activeAsk = runner.ask(question: question) { [weak self] outcome in
            Task { @MainActor in self?.handle(outcome, identifier: identifier) }
        }
    }

    private func handle(_ outcome: AskOutcome, identifier: UUID) {
        guard requestIdentifier == identifier else { return }
        activeAsk = nil
        requestIdentifier = nil
        spinner.stopAnimation(nil)
        questionField.isEnabled = true
        askButton.isEnabled = true
        switch outcome {
        case .success(let answer):
            statusLabel.stringValue = "Done"
            answerView.string = answer.answer
            let policies = answer.citationPolicies.isEmpty
                ? "none"
                : answer.citationPolicies.joined(separator: ", ")
            citationLabel.stringValue = "Citations: \(answer.citationCount)\nPolicies: \(policies)"
        case .failure(let message):
            statusLabel.stringValue = message
            answerView.string = ""
            citationLabel.stringValue = ""
        case .cancelled:
            break
        }
    }

    private func cancelActiveAsk() {
        requestIdentifier = nil
        activeAsk?.cancel()
        activeAsk = nil
        spinner.stopAnimation(nil)
    }

    private func refreshIdentity() {
        cancelIdentityLookup()
        identityLabel.stringValue = "Checking signed-in user…"
        let identifier = UUID()
        identityRequestIdentifier = identifier
        activeIdentityLookup = runner.identity { [weak self] outcome in
            Task { @MainActor in self?.handleIdentity(outcome, identifier: identifier) }
        }
    }

    private func handleIdentity(_ outcome: IdentityOutcome, identifier: UUID) {
        guard identityRequestIdentifier == identifier else { return }
        activeIdentityLookup = nil
        identityRequestIdentifier = nil
        switch outcome {
        case .signedIn(let firstName):
            identityLabel.stringValue = "Signed in as \(firstName)"
        case .signedOut:
            identityLabel.stringValue = "Not signed in"
        case .failure:
            identityLabel.stringValue = "Signed-in user unavailable"
        }
    }

    private func cancelIdentityLookup() {
        identityRequestIdentifier = nil
        activeIdentityLookup?.cancel()
        activeIdentityLookup = nil
    }

    private func configurePanel() {
        panel.title = "ECHO"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 520, height: 300)
        panel.delegate = self
        panel.onCancel = { [weak self] in self?.cancelAndHide() }
    }

    private func configureContent() {
        let root = NSView()
        panel.contentView = root

        identityLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        identityLabel.textColor = .labelColor
        identityLabel.lineBreakMode = .byTruncatingTail
        identityLabel.translatesAutoresizingMaskIntoConstraints = false

        questionField.placeholderString = "Ask ECHO a question"
        questionField.target = self
        questionField.action = #selector(submit)
        questionField.sendsWholeSearchString = true
        questionField.sendsSearchStringImmediately = false
        questionField.translatesAutoresizingMaskIntoConstraints = false

        askButton.target = self
        askButton.action = #selector(submit)
        askButton.keyEquivalent = "\r"
        askButton.translatesAutoresizingMaskIntoConstraints = false

        let promptRow = NSStackView(views: [questionField, askButton])
        promptRow.orientation = .horizontal
        promptRow.spacing = 8
        promptRow.alignment = .centerY
        promptRow.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        let statusRow = NSStackView(views: [spinner, statusLabel])
        statusRow.orientation = .horizontal
        statusRow.spacing = 8
        statusRow.alignment = .centerY
        statusRow.translatesAutoresizingMaskIntoConstraints = false

        answerView.isEditable = false
        answerView.isSelectable = true
        answerView.drawsBackground = false
        answerView.font = NSFont.systemFont(ofSize: 14)
        answerView.textContainerInset = NSSize(width: 8, height: 8)
        answerView.autoresizingMask = [.width]

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        answerView.frame = scrollView.contentView.bounds
        answerView.minSize = .zero
        answerView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        answerView.isVerticallyResizable = true
        answerView.isHorizontallyResizable = false
        answerView.textContainer?.widthTracksTextView = true
        scrollView.documentView = answerView
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        citationLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        citationLabel.textColor = .secondaryLabelColor
        citationLabel.maximumNumberOfLines = 2
        citationLabel.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(identityLabel)
        root.addSubview(promptRow)
        root.addSubview(statusRow)
        root.addSubview(scrollView)
        root.addSubview(citationLabel)

        NSLayoutConstraint.activate([
            identityLabel.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            identityLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            identityLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),

            promptRow.topAnchor.constraint(equalTo: identityLabel.bottomAnchor, constant: 8),
            promptRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            promptRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            questionField.widthAnchor.constraint(greaterThanOrEqualToConstant: 320),

            statusRow.topAnchor.constraint(equalTo: promptRow.bottomAnchor, constant: 12),
            statusRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            statusRow.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -16),

            scrollView.topAnchor.constraint(equalTo: statusRow.bottomAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),

            citationLabel.topAnchor.constraint(equalTo: scrollView.bottomAnchor, constant: 10),
            citationLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            citationLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            citationLabel.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
        ])
    }
}

private func echoHotKeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let userData else { return OSStatus(eventNotHandledErr) }
    let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
    DispatchQueue.main.async { delegate.showOverlay() }
    return noErr
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: OverlayController?
    private var statusItem: NSStatusItem?
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = OverlayController()
        configureStatusItem()
        registerHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.cancelAndHide()
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
    }

    func showOverlay() {
        controller?.showPrompt()
    }

    @objc private func askEcho() {
        showOverlay()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(
            systemSymbolName: "waveform.circle",
            accessibilityDescription: "ECHO"
        )
        let menu = NSMenu()
        let ask = NSMenuItem(title: "Ask ECHO  ⌘E", action: #selector(askEcho), keyEquivalent: "")
        ask.target = self
        menu.addItem(ask)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit ECHO", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
    }

    private func registerHotKey() {
        var event = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let handlerStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            echoHotKeyHandler,
            1,
            &event,
            userData,
            &hotKeyHandler
        )
        guard handlerStatus == noErr else {
            showHotKeyError()
            return
        }
        let registrationStatus = RegisterEventHotKey(
            UInt32(kVK_ANSI_E),
            UInt32(cmdKey),
            hotKeyIdentifier,
            GetApplicationEventTarget(),
            OptionBits(kEventHotKeyExclusive),
            &hotKey
        )
        if registrationStatus != noErr { showHotKeyError() }
    }

    private func showHotKeyError() {
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "ECHO could not register ⌘E."
        alert.informativeText = "Another app may already be using that shortcut. You can still open Ask ECHO from the menu bar."
        alert.alertStyle = .warning
        alert.runModal()
    }
}

@main
private enum EchoOverlayMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
