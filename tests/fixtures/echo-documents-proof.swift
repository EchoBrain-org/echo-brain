import AppKit
import Foundation

@main
enum DocumentProof {
    static let identity = AccountIdentity(displayName: "Casey", role: "Employee", authority: "https://authority.example", version: "1", membershipID: "mem_original")
    static let documentID = "doc_" + String(repeating: "d", count: 64)
    static let requestID = "11111111-1111-4111-8111-111111111111"
    static func require(_ condition: @autoclosure () -> Bool, _ message: String = "document proof failed") { if !condition() { fatalError(message) } }
    static func data(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    static func metadata(_ snapshot: DocumentSnapshot, receipt: Bool = false) -> [String: Any] {
        var object: [String: Any] = ["schema_version": 1, "kind": receipt ? "echo-person-document-receipt-v1" : "echo-person-document-metadata-v1",
          "document_id": documentID, "request_id": requestID, "filename": snapshot.filename, "title": "Robot PRD",
          "content_length": snapshot.size, "sha256": snapshot.sha256, "audience": ["kind": "only_me"], "project_id": NSNull(),
          "detected_media_type": "application/pdf", "received_at": "2026-09-23T00:00:00.000Z", "state": "saved", "extraction_state": "ready"]
        if !receipt { object["extraction_detail"] = NSNull(); object["extractor"] = "fixture-v1"; object["extracted_text_bytes"] = 26 }
        return object
    }
    @MainActor static func wait(_ label: String, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(10)
        while !condition() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        require(condition(), label)
    }
    @MainActor static func main() {
        let mode = CommandLine.arguments[1], folder = URL(fileURLWithPath: CommandLine.arguments[3])
        let source = folder.appendingPathComponent("Robot PRD.pdf")
        let original = Data([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0xfe])
        try! original.write(to: source)
        let snapshot = try! DocumentSnapshot(source)
        let cli = ProjectCLI(executable: URL(fileURLWithPath: CommandLine.arguments[2]))
        switch mode {
        case "snapshot":
            try! Data("Changed after selection".utf8).write(to: source)
            require(try! Data(contentsOf: snapshot.file) == original)
            require(snapshot.size == original.count && snapshot.filename == "Robot PRD.pdf" && DocumentMetadata.hash(snapshot.sha256))
            let draft = try! UploadDraft(title: "Robot PRD", document: snapshot, visibility: .onlyMe)
            require(draft.document === snapshot && draft.file == snapshot.file)
            let args = UploadCommand.submit(draft).arguments
            require(args.prefix(3) == ["person", "documents", "upload"] && args.contains("--audience") && !args.contains("--visibility"))
            let attrs = try! FileManager.default.attributesOfItem(atPath: snapshot.file.path)
            let directory = try! FileManager.default.attributesOfItem(atPath: snapshot.file.deletingLastPathComponent().path)
            require((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600 && (directory[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        case "bounds":
            let limit = folder.appendingPathComponent("large.md")
            try! Data(repeating: 97, count: DocumentSnapshot.maximumBytes).write(to: limit)
            require((try? DocumentSnapshot(limit))?.size == DocumentSnapshot.maximumBytes)
            let handle = try! FileHandle(forWritingTo: limit); try! handle.seekToEnd(); try! handle.write(contentsOf: Data([97])); try! handle.close()
            require((try? DocumentSnapshot(limit)) == nil, "+1 byte")
            let empty = folder.appendingPathComponent("empty.txt"); try! Data().write(to: empty)
            require((try? DocumentSnapshot(empty)) == nil)
            let legacy = folder.appendingPathComponent("legacy.doc"); try! original.write(to: legacy)
            require((try? DocumentSnapshot(legacy)) == nil)
            let link = folder.appendingPathComponent("link.pdf"); try! FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
            require((try? DocumentSnapshot(link)) == nil && (try? DocumentSnapshot(folder)) == nil)
        case "parser":
            let object = metadata(snapshot)
            guard let parsed = DocumentMetadata.parse(object) else { fatalError("valid metadata") }
            require(parsed.stateMessage == "Original saved · Text ready.")
            for (key, value) in [("state", "received"), ("sha256", "bad"), ("extraction_state", "successful"), ("document_id", "ctx_" + String(repeating: "d", count: 64))] {
                var invalid = object; invalid[key] = value; require(DocumentMetadata.parse(invalid) == nil, key)
            }
            var extra = object; extra["text"] = "Unexpected"; require(DocumentMetadata.parse(extra) == nil)
            var page: [String: Any] = ["schema_version": 1, "kind": "echo-person-document-text-v1", "document_id": documentID,
                "original_sha256": snapshot.sha256, "extractor": "fixture-v1", "extraction_state": "ready",
                "chunks": [["ordinal": 0, "anchor_kind": "page", "anchor_start": 1, "text": "First page"]], "next_cursor": "Mg"]
            require(DocumentTextPage.parse(page, metadata: parsed)?.display == "Page 1\nFirst page")
            page["original_sha256"] = "sha256:" + String(repeating: "0", count: 64); require(DocumentTextPage.parse(page, metadata: parsed) == nil)
        case "recovery":
            let suite = "echo-document-proof-" + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            var recovery = UploadRecovery(identity: identity, requestID: requestID, visibility: .onlyMe)!
            recovery.carrier = "document-v1"; recovery.documentFilename = snapshot.filename; recovery.documentSize = snapshot.size
            recovery.documentSha256 = snapshot.sha256; recovery.documentTitle = "Robot PRD"
            require(recovery.save(for: identity, defaults: defaults))
            guard let restored = UploadRecovery.load(for: identity, defaults: defaults) else { fatalError("typed recovery") }
            require(restored == recovery && restored.matches(DocumentMetadata.parse(metadata(snapshot))!))
            require(UploadCommand.status(restored).arguments.prefix(3) == ["person", "documents", "status"])
            let other = AccountIdentity(displayName: "Other", role: "Employee", authority: identity.authority, version: "1", membershipID: "mem_other")
            require(!restored.belongs(to: other) && UploadRecovery.load(for: other, defaults: defaults) == nil)
            recovery.carrier = "document-v9"; require(!recovery.save(for: identity, defaults: defaults))
        case "round-trip", "unknown-retry":
            let client = UploadClient(cli: cli), draft = try! UploadDraft(title: "Robot PRD", document: snapshot, visibility: .onlyMe)
            let first = client.execute(.submit(draft), identity: identity, running: AccountRunning())
            if mode == "unknown-retry" {
                guard case .unconfirmed = first else { fatalError("expected unknown") }
                try! Data("Changed source".utf8).write(to: source)
            } else { guard case .saved(let receipt) = first, receipt.document?.extraction_state == "extracting" else { fatalError("saved custody") } }
            guard case .saved(let receipt) = client.execute(.submit(draft), identity: identity, running: AccountRunning()) else { fatalError("same snapshot retry") }
            require(receipt.document?.sha256 == snapshot.sha256 && receipt.document?.filename == snapshot.filename)
        case "download":
            let session = DocumentSession(cli: cli, foreground: { true }); session.bind(identity)
            session.search("", projectID: "prj_11111111-1111-4111-8111-111111111111")
            wait("list") { !session.busy }; session.read(documentID); wait("read") { !session.busy }
            guard let metadata = session.metadata else { fatalError("download metadata") }
            let output = folder.appendingPathComponent("saved.pdf")
            session.download(metadata, to: output); wait("download") { !session.busy }
            require(try! Data(contentsOf: output) == original, "download original bytes")
            require(session.status == "Original saved to your selected file.")
            session.bind(nil); session.download(metadata, to: folder.appendingPathComponent("after-account-change.pdf"))
            require(!session.busy && !FileManager.default.fileExists(atPath: folder.appendingPathComponent("after-account-change.pdf").path))
        case "pagination":
            let session = DocumentSession(cli: cli, foreground: { true }); session.bind(identity)
            session.search("", projectID: "prj_11111111-1111-4111-8111-111111111111")
            wait("list") { !session.busy }; require(session.matches.count == 1)
            session.read(documentID); wait("read") { !session.busy }
            require(session.page?.display == "Page 1\nFirst page" && session.page?.next_cursor == "Mg")
            session.nextTextPage(); wait("next page") { !session.busy }
            require(session.page?.display == "Page 2\nSecond page" && session.page?.next_cursor == nil)
            let reader = ReaderView(frame: .zero)
            reader.show(id: documentID, title: "PRD", meta: "Ready", text: "First page")
            reader.show(id: documentID, title: "PRD", meta: "Ready", text: "Second page")
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            require(descendants(reader).compactMap { $0 as? NSTextView }.contains { $0.string == "Second page" }, "same document page cache")
            session.bind(nil); require(session.metadata == nil && session.page == nil && session.matches.isEmpty)
        default: fatalError("unknown mode")
        }
        print("passed \(mode)")
    }
}
