import AppKit
import Carbon
import Foundation

private let askTimeoutSeconds: TimeInterval = 145
private let identityTimeoutSeconds: TimeInterval = 5
private let maximumProcessOutputBytes = 128 * 1024
private let maximumQuestionScalars = 240
private let maximumQuestionUniqueTerms = 32
private let maximumQuestionTermBytes = 64
private let maximumRawQuestionUTF16Units = 4_096
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

        return .success(DisplayAnswer(answer: envelope.result.answer))
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

private let questionTermExpression = try! NSRegularExpression(pattern: "[\\p{L}\\p{N}]+")

private struct QuestionValidation {
    let question: String
    let scalarCount: Int
    let uniqueTermCount: Int
    let message: String?

    var isValid: Bool { message == nil }
}

private func normalizeQuestion(_ source: String) -> String {
    let normalized = source.precomposedStringWithCanonicalMapping
    var result = ""
    var isReplacingInvalidRun = false
    for scalar in normalized.unicodeScalars {
        let isLineSeparator = scalar.value == 0x2028 || scalar.value == 0x2029
        if CharacterSet.controlCharacters.contains(scalar) || isLineSeparator {
            isReplacingInvalidRun = !result.isEmpty
            continue
        }
        if isReplacingInvalidRun {
            if !CharacterSet.whitespaces.contains(scalar) {
                result.append(" ")
            }
            isReplacingInvalidRun = false
        }
        result.unicodeScalars.append(scalar)
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func validateQuestion(_ source: String) -> QuestionValidation {
    let question = normalizeQuestion(source)
    let scalarCount = question.unicodeScalars.count
    let range = NSRange(question.startIndex..., in: question)
    let terms = Set(questionTermExpression.matches(in: question, range: range).compactMap { match -> String? in
        guard let termRange = Range(match.range, in: question) else { return nil }
        return String(question[termRange]).lowercased().precomposedStringWithCanonicalMapping
    })
    let uniqueTermCount = terms.count

    let message: String?
    if question.isEmpty {
        message = "Ask a question to search your approved team context."
    } else if uniqueTermCount == 0 {
        message = "Include at least one word or number in the question."
    } else if scalarCount > maximumQuestionScalars {
        let excess = scalarCount - maximumQuestionScalars
        message = "Keep the question to \(maximumQuestionScalars) characters. Remove \(excess) character\(excess == 1 ? "" : "s")."
    } else if uniqueTermCount > maximumQuestionUniqueTerms {
        let excess = uniqueTermCount - maximumQuestionUniqueTerms
        message = "Keep the question to \(maximumQuestionUniqueTerms) unique terms. Remove or repeat \(excess) term\(excess == 1 ? "" : "s")."
    } else if terms.contains(where: { $0.lengthOfBytes(using: .utf8) > maximumQuestionTermBytes }) {
        message = "One term is too long. Split it into shorter words."
    } else {
        message = nil
    }
    return QuestionValidation(
        question: question,
        scalarCount: scalarCount,
        uniqueTermCount: uniqueTermCount,
        message: message
    )
}

private final class QuestionTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var placeholder = "Ask ECHO a question"

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty else { return }
        let rect = NSRect(
            x: textContainerInset.width + 8,
            y: textContainerInset.height + 1,
            width: max(0, bounds.width - textContainerInset.width * 2 - 16),
            height: 22
        )
        placeholder.draw(
            in: rect,
            withAttributes: [
                .font: font ?? NSFont.systemFont(ofSize: 15),
                .foregroundColor: NSColor.placeholderTextColor,
            ]
        )
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard modifiers == .command,
              let key = event.charactersIgnoringModifiers?.lowercased()
        else {
            return super.performKeyEquivalent(with: event)
        }
        switch key {
        case "a": selectAll(nil)
        case "c": copy(nil)
        case "x": cut(nil)
        case "v": paste(nil)
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    override func keyDown(with event: NSEvent) {
        let key = event.charactersIgnoringModifiers
        if (key == "\r" || key == "\n") && !event.modifierFlags.contains(.shift) {
            if hasMarkedText() {
                super.keyDown(with: event)
                return
            }
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}

@MainActor
private final class OverlayController: NSObject, NSWindowDelegate, NSTextViewDelegate {
    private let runner = CliRunner()
    private let panel: EchoPanel
    private let composer = QuestionTextView()
    private let composerScrollView = NSScrollView()
    private let askButton = NSButton(title: "Ask", target: nil, action: nil)
    private let copyButton = NSButton(title: "Copy answer", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private let identityLabel = NSTextField(labelWithString: "Signed in")
    private let statusLabel = NSTextField(labelWithString: "Ready when you are")
    private let limitLabel = NSTextField(
        labelWithString: "0 / \(maximumQuestionScalars) characters · 0 / \(maximumQuestionUniqueTerms) terms"
    )
    private let emptyAnswerLabel = NSTextField(wrappingLabelWithString: "Ask a focused question and ECHO will synthesize the approved context you can access.")
    private let answerView = NSTextView()
    private let answerScrollView = NSScrollView()
    private let answerHeader = NSStackView()
    private var composerHeightConstraint: NSLayoutConstraint?
    private var activeAsk: RunningAsk?
    private var requestIdentifier: UUID?
    private var activeIdentityLookup: RunningAsk?
    private var identityRequestIdentifier: UUID?
    private var identityText = "Signed in"
    private var copyFeedbackWorkItem: DispatchWorkItem?

    override init() {
        panel = EchoPanel(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 500),
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
        if activeIdentityLookup == nil { refreshIdentity() }
        composer.string = ""
        composer.needsDisplay = true
        composer.isEditable = true
        askButton.title = "Ask"
        askButton.setAccessibilityLabel("Ask ECHO")
        resetCopyFeedback()
        copyButton.isEnabled = false
        statusLabel.stringValue = "Ready when you are"
        statusLabel.textColor = .secondaryLabelColor
        answerView.string = ""
        answerHeader.isHidden = true
        answerScrollView.isHidden = true
        emptyAnswerLabel.isHidden = false
        emptyAnswerLabel.stringValue = "Ask a focused question and ECHO will synthesize the approved context you can access."
        spinner.stopAnimation(nil)
        refreshQuestionPresentation()
        panel.center()
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(composer)
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

    func windowDidResize(_ notification: Notification) {
        updateComposerHeight()
    }

    func textDidChange(_ notification: Notification) {
        refreshQuestionPresentation()
    }

    func textView(
        _ textView: NSTextView,
        shouldChangeTextIn affectedCharRange: NSRange,
        replacementString: String?
    ) -> Bool {
        guard textView === composer, let replacementString else { return true }
        let currentLength = (composer.string as NSString).length
        let replacementLength = (replacementString as NSString).length
        let resultingLength = currentLength - affectedCharRange.length + replacementLength
        guard resultingLength <= maximumRawQuestionUTF16Units else {
            let message = "That paste is too large. Keep the draft under \(maximumRawQuestionUTF16Units.formatted()) characters."
            statusLabel.stringValue = message
            statusLabel.textColor = .systemRed
            announce(message)
            return false
        }
        return true
    }

    @objc private func submitOrCancel() {
        if activeAsk != nil {
            cancelActiveAsk()
            composer.isEditable = true
            askButton.title = "Ask"
            askButton.setAccessibilityLabel("Ask ECHO")
            statusLabel.stringValue = "Cancelled"
            statusLabel.textColor = .secondaryLabelColor
            refreshQuestionPresentation(preservingStatus: true)
            return
        }

        let validation = validateQuestion(composer.string)
        guard validation.isValid else {
            let message = validation.message ?? "Check the question and try again."
            statusLabel.stringValue = message
            statusLabel.textColor = .systemRed
            announce(message)
            return
        }
        if composer.string != validation.question { composer.string = validation.question }

        cancelActiveAsk()
        resetCopyFeedback()
        let identifier = UUID()
        requestIdentifier = identifier
        composer.isEditable = false
        askButton.title = "Cancel"
        askButton.setAccessibilityLabel("Cancel ECHO request")
        askButton.isEnabled = true
        copyButton.isEnabled = false
        answerView.string = ""
        answerHeader.isHidden = true
        answerScrollView.isHidden = true
        emptyAnswerLabel.isHidden = false
        emptyAnswerLabel.stringValue = "ECHO is checking the approved context available to you."
        statusLabel.stringValue = "Thinking…"
        statusLabel.textColor = .secondaryLabelColor
        spinner.startAnimation(nil)
        announce("ECHO is thinking.")

        activeAsk = runner.ask(question: validation.question) { [weak self] outcome in
            Task { @MainActor in self?.handle(outcome, identifier: identifier) }
        }
    }

    private func handle(_ outcome: AskOutcome, identifier: UUID) {
        guard requestIdentifier == identifier else { return }
        activeAsk = nil
        requestIdentifier = nil
        spinner.stopAnimation(nil)
        composer.isEditable = true
        askButton.title = "Ask"
        askButton.setAccessibilityLabel("Ask ECHO")
        askButton.isEnabled = true
        switch outcome {
        case .success(let answer):
            statusLabel.stringValue = "Answer ready"
            statusLabel.textColor = .secondaryLabelColor
            answerView.string = answer.answer
            answerHeader.isHidden = false
            answerScrollView.isHidden = false
            emptyAnswerLabel.isHidden = true
            copyButton.isEnabled = true
            announce("ECHO answer ready.")
        case .failure(let message):
            statusLabel.stringValue = "Couldn’t answer"
            statusLabel.textColor = .systemRed
            answerView.string = ""
            answerHeader.isHidden = true
            answerScrollView.isHidden = true
            emptyAnswerLabel.isHidden = false
            emptyAnswerLabel.stringValue = message
            announce(message)
        case .cancelled:
            break
        }
        refreshQuestionPresentation(preservingStatus: true)
    }

    private func cancelActiveAsk() {
        requestIdentifier = nil
        activeAsk?.cancel()
        activeAsk = nil
        spinner.stopAnimation(nil)
    }

    @objc private func copyAnswer() {
        let answer = answerView.string
        guard !answer.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(answer, forType: .string)
        resetCopyFeedback()
        copyButton.title = "Copied"
        copyButton.setAccessibilityLabel("Answer copied")
        let workItem = DispatchWorkItem { [weak self] in
            self?.copyButton.title = "Copy answer"
            self?.copyButton.setAccessibilityLabel("Copy answer")
        }
        copyFeedbackWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: workItem)
    }

    private func resetCopyFeedback() {
        copyFeedbackWorkItem?.cancel()
        copyFeedbackWorkItem = nil
        copyButton.title = "Copy answer"
        copyButton.setAccessibilityLabel("Copy answer")
    }

    private func announce(_ message: String) {
        NSAccessibility.post(
            element: statusLabel,
            notification: .announcementRequested,
            userInfo: [
                .announcement: message,
                .priority: NSAccessibilityPriorityLevel.medium.rawValue,
            ]
        )
    }

    private func refreshIdentity() {
        cancelIdentityLookup()
        identityLabel.stringValue = identityText
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
            identityText = "Signed in as \(firstName)"
        case .signedOut:
            identityText = "Not signed in"
        case .failure:
            identityText = "Signed-in user unavailable"
        }
        identityLabel.stringValue = identityText
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
        panel.minSize = NSSize(width: 600, height: 380)
        panel.backgroundColor = .windowBackgroundColor
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.delegate = self
        panel.onCancel = { [weak self] in self?.cancelAndHide() }
    }

    private func configureContent() {
        let root = NSVisualEffectView()
        root.material = .hudWindow
        root.blendingMode = .withinWindow
        root.state = .active
        panel.contentView = root

        let titleLabel = NSTextField(labelWithString: "ECHO")
        titleLabel.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        titleLabel.setAccessibilityLabel("ECHO")
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        identityLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        identityLabel.textColor = .secondaryLabelColor
        identityLabel.lineBreakMode = .byTruncatingTail
        identityLabel.setAccessibilityLabel("Signed-in user")
        identityLabel.translatesAutoresizingMaskIntoConstraints = false

        let header = NSStackView(views: [titleLabel, identityLabel])
        header.orientation = .vertical
        header.spacing = 3
        header.alignment = .leading
        header.translatesAutoresizingMaskIntoConstraints = false

        composer.delegate = self
        composer.font = NSFont.systemFont(ofSize: 15)
        composer.textColor = .labelColor
        composer.insertionPointColor = .controlAccentColor
        composer.drawsBackground = false
        composer.isRichText = false
        composer.allowsUndo = true
        composer.isAutomaticQuoteSubstitutionEnabled = false
        composer.isAutomaticDashSubstitutionEnabled = false
        composer.isAutomaticTextReplacementEnabled = false
        composer.textContainerInset = NSSize(width: 8, height: 9)
        composer.minSize = NSSize(width: 0, height: 42)
        composer.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        composer.isVerticallyResizable = true
        composer.isHorizontallyResizable = false
        composer.textContainer?.widthTracksTextView = true
        composer.textContainer?.lineFragmentPadding = 0
        composer.onSubmit = { [weak self] in self?.submitOrCancel() }
        composer.setAccessibilityLabel("Question for ECHO")
        composer.setAccessibilityHelp("Press Return to ask. Press Shift-Return for a new line.")

        composerScrollView.drawsBackground = false
        composerScrollView.borderType = .noBorder
        composerScrollView.hasVerticalScroller = false
        composerScrollView.autohidesScrollers = true
        composer.frame = composerScrollView.contentView.bounds
        composer.autoresizingMask = [.width]
        composerScrollView.documentView = composer
        composerScrollView.translatesAutoresizingMaskIntoConstraints = false

        let composerCard = NSView()
        composerCard.wantsLayer = true
        composerCard.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        composerCard.layer?.cornerRadius = 12
        composerCard.layer?.borderWidth = 1
        composerCard.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.65).cgColor
        composerCard.translatesAutoresizingMaskIntoConstraints = false
        composerCard.addSubview(composerScrollView)

        askButton.target = self
        askButton.action = #selector(submitOrCancel)
        askButton.keyEquivalent = "\r"
        askButton.bezelStyle = .rounded
        askButton.controlSize = .large
        askButton.contentTintColor = .controlAccentColor
        askButton.setAccessibilityLabel("Ask ECHO")
        askButton.translatesAutoresizingMaskIntoConstraints = false

        let promptRow = NSStackView(views: [composerCard, askButton])
        promptRow.orientation = .horizontal
        promptRow.spacing = 10
        promptRow.alignment = .bottom
        promptRow.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setAccessibilityLabel("Question status")
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        limitLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        limitLabel.textColor = .tertiaryLabelColor
        limitLabel.alignment = .right
        limitLabel.setAccessibilityLabel("Question limits")
        limitLabel.translatesAutoresizingMaskIntoConstraints = false

        let statusLeading = NSStackView(views: [spinner, statusLabel])
        statusLeading.orientation = .horizontal
        statusLeading.spacing = 7
        statusLeading.alignment = .centerY
        statusLeading.translatesAutoresizingMaskIntoConstraints = false

        let statusRow = NSStackView(views: [statusLeading, limitLabel])
        statusRow.orientation = .horizontal
        statusRow.spacing = 12
        statusRow.alignment = .centerY
        statusRow.distribution = .fill
        statusRow.translatesAutoresizingMaskIntoConstraints = false

        answerView.isEditable = false
        answerView.isSelectable = true
        answerView.drawsBackground = false
        answerView.font = NSFont.systemFont(ofSize: 14.5)
        answerView.textColor = .labelColor
        answerView.textContainerInset = NSSize(width: 4, height: 4)
        answerView.autoresizingMask = [.width]
        answerView.setAccessibilityLabel("ECHO answer")

        answerScrollView.hasVerticalScroller = true
        answerScrollView.autohidesScrollers = true
        answerScrollView.borderType = .noBorder
        answerScrollView.drawsBackground = false
        answerView.frame = answerScrollView.contentView.bounds
        answerView.minSize = .zero
        answerView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        answerView.isVerticallyResizable = true
        answerView.isHorizontallyResizable = false
        answerView.textContainer?.widthTracksTextView = true
        answerScrollView.documentView = answerView
        answerScrollView.translatesAutoresizingMaskIntoConstraints = false

        let answerTitle = NSTextField(labelWithString: "Answer")
        answerTitle.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        answerTitle.translatesAutoresizingMaskIntoConstraints = false

        copyButton.target = self
        copyButton.action = #selector(copyAnswer)
        copyButton.bezelStyle = .texturedRounded
        copyButton.controlSize = .small
        copyButton.isEnabled = false
        copyButton.setAccessibilityLabel("Copy answer")
        copyButton.translatesAutoresizingMaskIntoConstraints = false

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        answerHeader.addArrangedSubview(answerTitle)
        answerHeader.addArrangedSubview(spacer)
        answerHeader.addArrangedSubview(copyButton)
        answerHeader.orientation = .horizontal
        answerHeader.spacing = 8
        answerHeader.alignment = .centerY
        answerHeader.isHidden = true
        answerHeader.translatesAutoresizingMaskIntoConstraints = false

        emptyAnswerLabel.font = NSFont.systemFont(ofSize: 14)
        emptyAnswerLabel.textColor = .tertiaryLabelColor
        emptyAnswerLabel.alignment = .center
        emptyAnswerLabel.maximumNumberOfLines = 0
        emptyAnswerLabel.setAccessibilityLabel("Answer placeholder")
        emptyAnswerLabel.translatesAutoresizingMaskIntoConstraints = false

        let answerArea = NSView()
        answerArea.translatesAutoresizingMaskIntoConstraints = false
        answerArea.addSubview(answerHeader)
        answerArea.addSubview(answerScrollView)
        answerArea.addSubview(emptyAnswerLabel)

        let hintLabel = NSTextField(labelWithString: "Return to ask · Shift-Return for a new line · Esc to close")
        hintLabel.font = NSFont.systemFont(ofSize: 11)
        hintLabel.textColor = .tertiaryLabelColor
        hintLabel.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(header)
        root.addSubview(promptRow)
        root.addSubview(statusRow)
        root.addSubview(answerArea)
        root.addSubview(hintLabel)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 22),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),

            promptRow.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 18),
            promptRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            promptRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            composerScrollView.leadingAnchor.constraint(equalTo: composerCard.leadingAnchor, constant: 1),
            composerScrollView.trailingAnchor.constraint(equalTo: composerCard.trailingAnchor, constant: -1),
            composerScrollView.topAnchor.constraint(equalTo: composerCard.topAnchor, constant: 1),
            composerScrollView.bottomAnchor.constraint(equalTo: composerCard.bottomAnchor, constant: -1),
            composerCard.widthAnchor.constraint(greaterThanOrEqualToConstant: 410),
            askButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 78),

            statusRow.topAnchor.constraint(equalTo: promptRow.bottomAnchor, constant: 8),
            statusRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 25),
            statusRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -25),

            answerArea.topAnchor.constraint(equalTo: statusRow.bottomAnchor, constant: 18),
            answerArea.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            answerArea.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            answerArea.bottomAnchor.constraint(equalTo: hintLabel.topAnchor, constant: -14),

            answerHeader.topAnchor.constraint(equalTo: answerArea.topAnchor),
            answerHeader.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor),
            answerHeader.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor),
            answerScrollView.topAnchor.constraint(equalTo: answerHeader.bottomAnchor, constant: 8),
            answerScrollView.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor),
            answerScrollView.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor),
            answerScrollView.bottomAnchor.constraint(equalTo: answerArea.bottomAnchor),
            emptyAnswerLabel.topAnchor.constraint(equalTo: answerArea.topAnchor),
            emptyAnswerLabel.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor, constant: 38),
            emptyAnswerLabel.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor, constant: -38),
            emptyAnswerLabel.bottomAnchor.constraint(equalTo: answerArea.bottomAnchor),

            hintLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 25),
            hintLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -25),
            hintLabel.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
        ])
        let composerHeight = composerCard.heightAnchor.constraint(equalToConstant: 46)
        composerHeight.isActive = true
        composerHeightConstraint = composerHeight
    }

    private func refreshQuestionPresentation(preservingStatus: Bool = false) {
        let validation = validateQuestion(composer.string)
        limitLabel.stringValue = "\(validation.scalarCount) / \(maximumQuestionScalars) characters · \(validation.uniqueTermCount) / \(maximumQuestionUniqueTerms) terms"
        if activeAsk == nil {
            askButton.isEnabled = validation.isValid && !validation.question.isEmpty
            if let message = validation.message, !validation.question.isEmpty {
                statusLabel.stringValue = message
                statusLabel.textColor = .systemRed
            } else if !preservingStatus && (statusLabel.stringValue == "Ready when you are" || statusLabel.stringValue == "Cancelled" || statusLabel.textColor == .systemRed) {
                statusLabel.stringValue = "Ready when you are"
                statusLabel.textColor = .secondaryLabelColor
            }
        }
        updateComposerHeight()
    }

    private func updateComposerHeight() {
        guard let textContainer = composer.textContainer,
              let layoutManager = composer.layoutManager
        else { return }
        layoutManager.ensureLayout(for: textContainer)
        let contentHeight = layoutManager.usedRect(for: textContainer).height + (composer.textContainerInset.height * 2)
        composerHeightConstraint?.constant = min(max(46, ceil(contentHeight)), 132)
        composerScrollView.hasVerticalScroller = contentHeight > 132
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
