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

private final class UploadWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let editor = firstResponder as? NSTextView {
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
        return super.performKeyEquivalent(with: event)
    }
}

@MainActor
final class UploadsController: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private let client: UploadClient
    private let defaults: UserDefaults
    private let isForeground: @MainActor () -> Bool
    private let window = UploadWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 740),
                                     styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let identityLabel = NSTextField(labelWithString: "Checking your account…")
    private let titleField = NSTextField()
    private let fileLabel = NSTextField(labelWithString: "Choose a UTF-8 text file, up to 8 KiB.")
    private let visibility = NSPopUpButton()
    private let permissionLabel = NSTextField(wrappingLabelWithString: "Only you can search and read this upload.")
    private let choose = NSButton(title: "Choose file…", target: nil, action: nil)
    private let submit = NSButton(title: "Upload", target: nil, action: nil)
    private let check = NSButton(title: "Check upload status", target: nil, action: nil)
    private let startNew = NSButton(title: "New upload", target: nil, action: nil)
    private let openSaved = NSButton(title: "Open saved upload", target: nil, action: nil)
    private let uploadStatus = NSTextField(wrappingLabelWithString: "")
    private let query = NSSearchField()
    private let search = NSButton(title: "Search", target: nil, action: nil)
    private let searchStatus = NSTextField(wrappingLabelWithString: "Search titles, original text, and available search metadata.")
    private let table = NSTableView()
    private let detailTitle = NSTextField(labelWithString: "Select a result to read its original text.")
    private let original = NSTextView()
    private var identity: AccountIdentity?
    private var bytes: Data?
    private var draft: UploadDraft?
    private var recovery: UploadRecovery?
    private var receipt: UploadReceipt?
    private var rows: [UploadMatch] = []
    private var active: AccountRunning?
    private var generation = UUID()
    private var choosing = false
    private(set) var hasOutstandingMutation = false

    init(client: UploadClient = UploadClient(), defaults: UserDefaults = .standard,
         isForeground: @escaping @MainActor () -> Bool = { NSApp.isActive }) {
        self.client = client; self.defaults = defaults; self.isForeground = isForeground
        super.init(); configure()
    }

    func show() {
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate()
        refreshIdentity()
    }
    func refreshIdentity() {
        guard window.isVisible, isForeground(), active == nil, !choosing else { return }
        clearFetched()
        let id = UUID(); generation = id
        active = client.account.status { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil
            guard case .signedIn(let account) = result, account.membershipID?.isEmpty == false else {
                self.resetAccount(); self.identityLabel.stringValue = "Sign in from ECHO’s Account menu to use uploads."
                return
            }
            if self.identity != account {
                self.resetAccount(); self.identity = account
                self.recovery = UploadRecovery.load(for: account, defaults: self.defaults)
                self.uploadStatus.stringValue = self.recovery == nil ? "" : "A previous upload attempt is available. Check its status or search before starting another."
            }
            self.identityLabel.stringValue = "\(account.displayName) · \(account.authority)"
            self.updateControls()
        }
        updateControls()
    }
    func conceal() {
        clearFetched()
        guard !choosing else { return }
        if !hasOutstandingMutation { active?.cancel(); active = nil; generation = UUID() }
        updateControls()
    }
    func accountWillChange() {
        // A write may already be committed. Let it settle, but discard its UI
        // result after clearing this account. Its locator remains account-scoped.
        if !hasOutstandingMutation { active?.cancel(); active = nil; generation = UUID() }
        resetAccount()
    }
    func shutdown() { active?.cancel(); draft = nil }
    func windowDidBecomeKey(_ notification: Notification) { refreshIdentity() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !hasOutstandingMutation else { return false }
        conceal(); window.orderOut(nil); return false
    }
    private func clearFetched() {
        rows = []; table.reloadData(); original.string = ""
        detailTitle.stringValue = "Select a result to read its original text."
    }
    private func resetAccount() {
        clearFetched(); identity = nil; bytes = nil; draft = nil; recovery = nil; receipt = nil
        identityLabel.stringValue = "Checking your account…"
        searchStatus.stringValue = "Search titles, original text, and available search metadata."
        titleField.stringValue = ""; query.stringValue = ""
        fileLabel.stringValue = "Choose a UTF-8 text file, up to 8 KiB."
        uploadStatus.stringValue = ""; visibility.selectItem(at: 0); permissionChanged()
        updateControls()
    }
    private func updateControls() {
        let ready = identity != nil && active == nil
        let canCompose = ready && draft == nil && receipt == nil && recovery == nil
        choose.isEnabled = canCompose
        titleField.isEnabled = canCompose
        visibility.isEnabled = canCompose
        submit.isEnabled = ready && (bytes != nil || draft != nil) && receipt == nil
        submit.title = draft == nil ? "Upload" : "Retry same upload"
        startNew.isEnabled = ready && (draft != nil || recovery != nil || bytes != nil)
        check.isEnabled = ready && recovery != nil
        openSaved.isEnabled = ready && receipt != nil
        search.isEnabled = ready; query.isEnabled = ready
        table.isEnabled = ready
    }
    @objc private func permissionChanged() {
        permissionLabel.stringValue = visibility.indexOfSelectedItem == 1
            ? "Everyone currently in your organization can search and read this upload."
            : "Only you can search and read this upload."
    }
    @objc private func chooseFile() {
        guard active == nil, draft == nil else { return }
        let panel = NSOpenPanel(); panel.title = "Upload text to ECHO"
        panel.message = "Choose notes, a memo, or another UTF-8 text file up to 8 KiB."
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        choosing = true; defer { choosing = false }
        guard panel.runModal() == .OK, let file = panel.url else { return }
        selectFile(file)
    }
    func selectFile(_ file: URL) {
        guard active == nil, identity != nil, draft == nil, receipt == nil, recovery == nil else { return }
        do {
            bytes = try UploadDraft.readFile(file)
            fileLabel.stringValue = "\(file.lastPathComponent) · \(bytes!.count) bytes"
            if titleField.stringValue.isEmpty {
                let suggested = file.deletingPathExtension().lastPathComponent
                if uploadText(suggested, maximum: 200) { titleField.stringValue = suggested }
            }
            uploadStatus.stringValue = "File ready. Choose who can read it, then upload."
        } catch {
            bytes = nil; fileLabel.stringValue = "No file selected."
            uploadStatus.stringValue = "Choose a nonempty UTF-8 text file up to 8 KiB. Binary files and folders are not supported."
        }
        updateControls()
    }
    @objc private func upload() {
        guard active == nil, let identity else { return }
        if draft == nil {
            guard let bytes, uploadText(titleField.stringValue, maximum: 200) else {
                uploadStatus.stringValue = "Choose a text file and enter a title up to 200 UTF-8 bytes."; return
            }
            do { draft = try UploadDraft(title: titleField.stringValue, bytes: bytes,
                                         visibility: visibility.indexOfSelectedItem == 1 ? .team : .onlyMe) }
            catch { uploadStatus.stringValue = "Could not prepare this file for upload."; return }
        }
        guard let draft, let recovery = UploadRecovery(identity: identity, requestID: draft.requestID, visibility: draft.visibility) else { return }
        self.recovery = recovery; recovery.save(for: identity, defaults: defaults)
        self.bytes = nil; uploadStatus.stringValue = "Saving your original text…"
        run(.submit(draft))
    }
    @objc private func checkUpload() {
        guard let recovery else { return }
        uploadStatus.stringValue = "Checking the saved upload…"; run(.status(recovery))
    }
    @objc private func newUpload() {
        guard active == nil else { return }
        if recovery != nil && receipt == nil {
            let alert = NSAlert(); alert.messageText = "Start another upload?"
            alert.informativeText = "The previous attempt may already be saved. Check its status or search first to avoid a duplicate."
            alert.addButton(withTitle: "Start another upload"); alert.addButton(withTitle: "Cancel")
            choosing = true; let answer = alert.runModal(); choosing = false
            guard answer == .alertFirstButtonReturn else { return }
        }
        bytes = nil; draft = nil; receipt = nil; recovery = nil
        titleField.stringValue = ""; visibility.selectItem(at: 0); permissionChanged()
        fileLabel.stringValue = "Choose a UTF-8 text file, up to 8 KiB."; uploadStatus.stringValue = ""
        updateControls()
    }
    @objc private func searchUploads() {
        guard let text = uploadQuery(query.stringValue) else {
            searchStatus.stringValue = "Use one line, up to 240 characters and 32 distinct words. Split very long words."; return
        }
        clearFetched(); searchStatus.stringValue = "Searching uploads…"; run(.search(text))
    }
    @objc private func openSavedUpload() { if let receipt { read(receipt.context_id) } }
    private func read(_ id: String) {
        original.string = ""; detailTitle.stringValue = "Loading original text…"; run(.read(id))
    }
    private func run(_ command: UploadCommand) {
        guard active == nil, let identity else { return }
        let id = UUID(); generation = id; hasOutstandingMutation = command.mutates
        active = client.perform(command, identity: identity) { [weak self] result in
            guard let self, self.generation == id else { return }
            self.active = nil; self.hasOutstandingMutation = false
            guard self.identity == identity else {
                self.resetAccount()
                self.identityLabel.stringValue = "Account access changed. Reopen Uploads after signing in."
                if command.mutates { self.uploadStatus.stringValue = "The upload may already be saved. Check its status from the original account." }
                return
            }
            switch result {
            case .saved(let value):
                self.receipt = value; self.draft = nil
                self.uploadStatus.stringValue = value.message
            case .unconfirmed:
                self.clearFetched()
                self.uploadStatus.stringValue = "The upload may already be saved. Check its status first. Retrying uses the same original and upload ID."
            case .unconfirmedAccount:
                self.resetAccount()
                self.identityLabel.stringValue = "Account access could not be confirmed. Reopen Uploads after signing in."
                self.uploadStatus.stringValue = "The upload may already be saved. Check its status from the original account."
            case .unavailable:
                self.resetAccount(); self.identityLabel.stringValue = "Your account changed or sign-in is required. Reopen Uploads after signing in."
            case .failed:
                self.clearFetched()
                if case .status = command {
                    self.uploadStatus.stringValue = "Could not confirm this upload. Check your connection and sign-in, then check again or search."
                } else { self.searchStatus.stringValue = "Could not read uploads. Check your connection and sign-in, then try again." }
            case .matches(let matches):
                guard self.window.isVisible, self.isForeground() else { self.clearFetched(); self.updateControls(); return }
                self.rows = matches; self.table.reloadData()
                self.searchStatus.stringValue = matches.isEmpty ? "No matching uploads you can read." : "\(matches.count) matching uploads. Select one to read the original."
            case .content(let content):
                guard self.window.isVisible, self.isForeground() else { self.clearFetched(); self.updateControls(); return }
                self.detailTitle.stringValue = "\(content.title) · \(content.visibility.label)"
                self.original.string = content.text; self.original.scrollRangeToVisible(NSRange(location: 0, length: 0))
            }
            self.updateControls()
        }
        updateControls()
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard active == nil, rows.indices.contains(table.selectedRow) else { return }
        read(rows[table.selectedRow].context_id)
    }
    func tableView(_ tableView: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let item = rows[row]
        let value = column?.identifier.rawValue == "visibility" ? item.visibility.label : item.title
        let cell = NSTextField(labelWithString: value); cell.textColor = EchoTheme.text
        cell.lineBreakMode = .byTruncatingTail; cell.toolTip = item.excerpt
        return cell
    }
    private func configure() {
        window.title = "Uploads"; window.delegate = self; window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 760, height: 720)
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = EchoTheme.ink
        let heading = NSTextField(labelWithString: "Uploads")
        heading.font = .systemFont(ofSize: 26, weight: .semibold)
        let intro = NSTextField(wrappingLabelWithString: "Save notes, memos, and text artifacts in their original wording. Search them here; Ask currently uses approved records.")
        visibility.addItems(withTitles: ["Only me", "Team"])
        visibility.target = self; visibility.action = #selector(permissionChanged)
        visibility.setAccessibilityLabel("Who can read this upload")
        titleField.placeholderString = "Title"; titleField.setAccessibilityLabel("Upload title")
        query.placeholderString = "Search uploads"; query.setAccessibilityLabel("Search uploads")
        query.sendsWholeSearchString = true
        query.target = self; query.action = #selector(searchUploads)
        for (button, action) in [(choose, #selector(chooseFile)), (submit, #selector(upload)), (check, #selector(checkUpload)),
                                 (startNew, #selector(newUpload)), (openSaved, #selector(openSavedUpload)), (search, #selector(searchUploads))] {
            button.target = self; button.action = action; button.bezelStyle = .rounded
        }
        for label in [heading, identityLabel, intro, fileLabel, permissionLabel, uploadStatus, searchStatus, detailTitle] {
            label.textColor = label === heading ? EchoTheme.text : EchoTheme.mutedText
            label.isSelectable = true
        }
        fileLabel.lineBreakMode = .byTruncatingMiddle; detailTitle.lineBreakMode = .byTruncatingTail
        let fileRow = NSStackView(views: [choose, fileLabel]); fileRow.spacing = 12
        let formRow = NSStackView(views: [titleField, visibility, submit]); formRow.spacing = 12
        let receiptRow = NSStackView(views: [check, openSaved, startNew]); receiptRow.spacing = 12
        let searchRow = NSStackView(views: [query, search]); searchRow.spacing = 12
        for (id, name, width) in [("title", "Title", 610.0), ("visibility", "Visibility", 125.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id)); column.title = name; column.width = width
            table.addTableColumn(column)
        }
        table.delegate = self; table.dataSource = self; table.rowHeight = 30
        table.usesAlternatingRowBackgroundColors = true; table.setAccessibilityLabel("Upload search results")
        let results = NSScrollView(); results.documentView = table; results.hasVerticalScroller = true; results.borderType = .bezelBorder
        original.isEditable = false; original.isRichText = false; original.isSelectable = true
        original.font = .systemFont(ofSize: 14); original.textColor = EchoTheme.text; original.backgroundColor = EchoTheme.surface
        original.textContainerInset = NSSize(width: 12, height: 12); original.isVerticallyResizable = true
        original.isHorizontallyResizable = false; original.autoresizingMask = [.width]
        original.textContainer?.widthTracksTextView = true
        original.setAccessibilityLabel("Original uploaded text")
        let content = NSScrollView(); content.documentView = original; content.hasVerticalScroller = true; content.borderType = .bezelBorder
        let stack = NSStackView(views: [heading, identityLabel, intro, fileRow, formRow, permissionLabel,
                                        receiptRow, uploadStatus, searchRow, searchStatus, results, detailTitle, content])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let root = window.contentView else { return }; root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
            titleField.widthAnchor.constraint(greaterThanOrEqualToConstant: 280),
            visibility.widthAnchor.constraint(equalToConstant: 130),
            results.heightAnchor.constraint(equalToConstant: 140),
            content.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        for view in [intro, fileRow, formRow, permissionLabel, uploadStatus, searchRow, searchStatus, results, detailTitle, content] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        let spring = content.heightAnchor.constraint(equalToConstant: 10_000); spring.priority = NSLayoutConstraint.Priority(1); spring.isActive = true
        updateControls()
    }
}
