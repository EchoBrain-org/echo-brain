import AppKit
import Carbon
import Darwin
import Foundation

private let askTimeoutSeconds: TimeInterval = 145
private let identityTimeoutSeconds: TimeInterval = 5
private let sourceTimeoutSeconds: TimeInterval = 15
private let maximumProcessOutputBytes = 128 * 1024
private let maximumSourceProcessOutputBytes = 512 * 1024 + 1024
private let maximumAnswerScalars = 12_000
private let maximumDisplayedSourceScalars = 2_000
private let maximumDisplayedSourceSignals = 32
private let maximumQuestionScalars = 240
private let maximumQuestionUniqueTerms = 32
private let maximumQuestionTermBytes = 64
private let maximumRawQuestionUTF16Units = 4_096
private let overlayBundleIdentifier = "org.echobrain.echo-overlay"
private let overlayRetirementTimeoutSeconds: TimeInterval = 5
private let overlayRetirementPollSeconds: TimeInterval = 0.05
private let hotKeySignature: OSType = 0x4543484F // "ECHO"
private let hotKeyIdentifier = EventHotKeyID(signature: hotKeySignature, id: 1)
private let allowedCitationPolicies: Set<String> = [
    "organization-member-readable-person-v2",
    "restricted-reviewer-person-v2",
]

// The warm dark palette published by echobrain.org, applied with native macOS typography.
enum EchoTheme {
    static let ink = NSColor(srgbRed: 36 / 255, green: 34 / 255, blue: 34 / 255, alpha: 1)
    static let surface = NSColor(srgbRed: 29 / 255, green: 28 / 255, blue: 28 / 255, alpha: 1)
    static let inkDeep = NSColor(srgbRed: 23 / 255, green: 22 / 255, blue: 22 / 255, alpha: 1)
    static let text = NSColor(srgbRed: 240 / 255, green: 236 / 255, blue: 230 / 255, alpha: 1)
    static let mutedText = text.withAlphaComponent(0.66)
    static let faintText = text.withAlphaComponent(0.55)
    static let border = text.withAlphaComponent(0.12)
    static let quietBorder = text.withAlphaComponent(0.08)
    static let gold = NSColor(srgbRed: 211 / 255, green: 154 / 255, blue: 76 / 255, alpha: 1)
    static let goldBright = NSColor(srgbRed: 240 / 255, green: 193 / 255, blue: 127 / 255, alpha: 1)
    static let ember = NSColor(srgbRed: 234 / 255, green: 96 / 255, blue: 71 / 255, alpha: 1)
    static let selection = gold.withAlphaComponent(0.36)
}

private let sha256Pattern = try! NSRegularExpression(pattern: "^sha256:[a-f0-9]{64}$")

private func isSha256(_ value: String) -> Bool {
    sha256Pattern.firstMatch(
        in: value,
        range: NSRange(location: 0, length: (value as NSString).length)
    ) != nil
}

private struct DynamicCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}

private func hasExactCodingKeys(_ keys: [DynamicCodingKey], _ expected: Set<String>) -> Bool {
    Set(keys.map(\.stringValue)) == expected
}

private struct CliCitation: Decodable {
    let atom_id: String
    let record_sha256: String
    let policy_id: String

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        guard hasExactCodingKeys(values.allKeys, ["atom_id", "record_sha256", "policy_id"]) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("atom_id"), in: values, debugDescription: "Unexpected citation fields")
        }
        atom_id = try values.decode(String.self, forKey: DynamicCodingKey("atom_id"))
        record_sha256 = try values.decode(String.self, forKey: DynamicCodingKey("record_sha256"))
        policy_id = try values.decode(String.self, forKey: DynamicCodingKey("policy_id"))
    }
}

private struct CliAnswer: Decodable {
    let schema_version: Int
    let kind: String
    let generation_id: String
    let record_head: CliRecordHead
    let answer: String
    let citations: [CliCitation]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        let base: Set<String> = ["schema_version", "kind", "generation_id", "record_head", "answer", "citations"]
        guard hasExactCodingKeys(values.allKeys, base) || hasExactCodingKeys(values.allKeys, base.union(["outcome"])) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("answer"), in: values, debugDescription: "Unexpected answer fields")
        }
        schema_version = try values.decode(Int.self, forKey: DynamicCodingKey("schema_version"))
        kind = try values.decode(String.self, forKey: DynamicCodingKey("kind"))
        generation_id = try values.decode(String.self, forKey: DynamicCodingKey("generation_id"))
        record_head = try values.decode(CliRecordHead.self, forKey: DynamicCodingKey("record_head"))
        answer = try values.decode(String.self, forKey: DynamicCodingKey("answer"))
        citations = try values.decode([CliCitation].self, forKey: DynamicCodingKey("citations"))
        let outcome = DynamicCodingKey("outcome")
        if values.contains(outcome) {
            guard try values.decode(String.self, forKey: outcome) == "authorship_unsupported" else {
                throw DecodingError.dataCorruptedError(forKey: outcome, in: values, debugDescription: "Unsupported answer outcome")
            }
        }
    }
}

private struct CliRecordHead: Decodable {
    let position: Int
    let record_sha256: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        guard hasExactCodingKeys(values.allKeys, ["position", "record_sha256"]) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("position"), in: values, debugDescription: "Unexpected record head fields")
        }
        position = try values.decode(Int.self, forKey: DynamicCodingKey("position"))
        record_sha256 = try values.decodeIfPresent(String.self, forKey: DynamicCodingKey("record_sha256"))
    }
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
    let sources: [DisplaySource]
}

private struct DisplaySource: Sendable {
    let label: String
    let recordSha256: String
    let policyID: String
}

private struct SourceRecord: Sendable {
    let source: DisplaySource
    let title: String
    let visibility: String
    let date: String?
    let shortDate: String?
    let approvedBy: String?
    let participants: [String]
    let decisions: [SourceSignal]
    let actions: [SourceSignal]
    let rationales: [SourceSignal]
}

private struct SourceSignal: Sendable {
    let text: String
    let status: String?
    let evidence: [SourceEvidence]
}

private struct SourceEvidence: Sendable {
    let quote: String
    let timestamp: String?
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

private enum SourceOutcome: Sendable {
    case success([SourceRecord])
    case unavailable
    case cancelled
}

final class BoundedReader: @unchecked Sendable {
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

final class RunningAsk: @unchecked Sendable {
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

    func sources(
        sources: [DisplaySource],
        completion: @escaping @Sendable (SourceOutcome) -> Void
    ) -> RunningAsk {
        let running = RunningAsk()
        let executable = self.executable
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Self.executeSources(executable: executable, sources: sources, running: running)
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

    fileprivate static func parseSuccess(_ data: Data) -> AskOutcome {
        guard let envelope = try? JSONDecoder().decode(CliSuccessEnvelope.self, from: data),
              envelope.ok,
              envelope.result.schema_version == 1,
              envelope.result.kind == "echo-clean-person-answer-v1",
              !envelope.result.answer.isEmpty,
              envelope.result.answer.unicodeScalars.count <= maximumAnswerScalars,
              isSha256(envelope.result.generation_id),
              envelope.result.record_head.position >= 0,
              (envelope.result.record_head.position == 0) == (envelope.result.record_head.record_sha256 == nil),
              envelope.result.record_head.record_sha256.map(isSha256) ?? true
        else {
            return .failure("The installed ECHO client returned an invalid response.")
        }

        var citedAtoms = Set<String>()
        var sourceIndexByRecord = [String: Int]()
        var sources: [DisplaySource] = []
        for citation in envelope.result.citations {
            guard isSha256(citation.atom_id),
                  isSha256(citation.record_sha256),
                  allowedCitationPolicies.contains(citation.policy_id),
                  citedAtoms.insert(citation.atom_id).inserted
            else {
                return .failure("The installed ECHO client returned an invalid response.")
            }
            if let existing = sourceIndexByRecord[citation.record_sha256] {
                guard sources[existing].policyID == citation.policy_id else {
                    return .failure("The installed ECHO client returned an invalid response.")
                }
                continue
            }
            sourceIndexByRecord[citation.record_sha256] = sources.count
            sources.append(DisplaySource(
                label: "Source \(sources.count + 1)",
                recordSha256: citation.record_sha256,
                policyID: citation.policy_id
            ))
        }
        return .success(DisplayAnswer(answer: envelope.result.answer, sources: sources))
    }

    private static func executeSources(
        executable: URL,
        sources: [DisplaySource],
        running: RunningAsk
    ) -> SourceOutcome {
        guard executable.isFileURL,
              executable.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: executable.path)
        else { return .unavailable }

        var records: [SourceRecord] = []
        for source in sources {
            if running.state().cancelled { return .cancelled }
            guard let record = executeSource(
                executable: executable,
                source: source,
                running: running
            ) else {
                if running.state().cancelled { return .cancelled }
                continue
            }
            records.append(record)
        }
        return records.isEmpty ? .unavailable : .success(records)
    }

    private static func executeSource(
        executable: URL,
        source: DisplaySource,
        running: RunningAsk
    ) -> SourceRecord? {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executable
        let recordSha256 = source.recordSha256
        process.arguments = ["person", "records", "--record-sha256", recordSha256]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr

        let stdoutReader = BoundedReader(maximumBytes: maximumSourceProcessOutputBytes)
        let stderrReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stdoutReader.read(from: stdout.fileHandleForReading) { running.exceedOutputLimit() }
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stderrReader.read(from: stderr.fileHandleForReading) { running.exceedOutputLimit() }
            readers.leave()
        }
        do {
            guard try running.launch(process) else {
                try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close(); readers.wait()
                return nil
            }
        } catch {
            try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close(); readers.wait()
            running.detach(process)
            return nil
        }
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()
        let timeout = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(
            deadline: .now() + sourceTimeoutSeconds,
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
              !stderrReader.didExceedLimit()
        else { return nil }
        return parseSourceRecord(stdoutReader.data(), source: source)
    }

    fileprivate static func parseSourceRecord(_ data: Data, source: DisplaySource) -> SourceRecord? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              hasExactKeys(root, ["ok", "result"]),
              root["ok"] as? Bool == true,
              let result = root["result"] as? [String: Any],
              hasExactKeys(result, ["schema_version", "kind", "records"]),
              result["schema_version"] as? Int == 1,
              result["kind"] as? String == "echo-clean-person-record-list-v1",
              let records = result["records"] as? [[String: Any]], records.count == 1,
              let record = records.first,
              (hasExactKeys(record, ["position", "approval_id", "record_sha256", "envelope"]) ||
               hasExactKeys(record, ["position", "approval_id", "record_sha256", "envelope", "source_metadata"])),
              record["position"] as? Int ?? 0 > 0,
              let recordSha256 = record["record_sha256"] as? String,
              recordSha256 == source.recordSha256,
              let envelope = record["envelope"] as? [String: Any],
              let envelopeSha256 = envelope["record_sha256"] as? String,
              envelopeSha256 == source.recordSha256,
              let body = envelope["body"] as? [String: Any],
              let event = body["event"] as? [String: Any],
              event["kind"] as? String == "approved",
              event["policy_id"] as? String == source.policyID,
              let snapshot = event["approved_snapshot"] as? [String: Any],
              let payload = snapshot["approved_payload"] as? [String: Any],
              let brief = payload["brief"] as? [String: Any],
              let meeting = brief["meeting"] as? [String: Any],
              let decisions = safeSourceSignals(brief["decisions"], kind: "decision"),
              let actions = safeSourceSignals(brief["actions"], kind: "action"),
              let rationales = safeSourceSignals(brief["rationales"], kind: "rationale")
        else { return nil }
        let title = safeSourceText(meeting["title"] as? String) ?? "Untitled meeting"
        let visibility = source.policyID == "organization-member-readable-person-v2"
            ? "Visible to active organization members"
            : "Only the approver"
        let metadata = record["source_metadata"] as? [String: Any]
        let approver = metadata?["record_approved_by"] as? [String: Any]
        var participants: [String] = []
        for participant in (meeting["participants"] as? [[String: Any]] ?? []).prefix(10_000) {
            guard let name = safeSourceText(participant["display_name"] as? String),
                  !participants.contains(name) else { continue }
            if participants.count == 32 { participants.append("Additional participants not shown"); break }
            participants.append(name)
        }
        let time = meeting["time"] as? [String: Any]
        let startedAt = (time?["actual_start_at"] as? String) ?? (time?["scheduled_start_at"] as? String)
        let timezone = (time?["timezone"] as? String).flatMap(TimeZone.init(identifier:))
        let meetingDate = sourceDate(startedAt)
        return SourceRecord(
            source: source,
            title: title,
            visibility: visibility,
            date: meetingDate.map { formatSourceDate($0, timezone: timezone, includeTime: time?["all_day"] as? Bool != true) },
            shortDate: meetingDate.map { formatSourceDate($0, timezone: timezone, includeTime: false) },
            approvedBy: safeSourceText(approver?["display_name"] as? String),
            participants: participants,
            decisions: decisions,
            actions: actions,
            rationales: rationales
        )
    }

    private static func hasExactKeys(_ object: [String: Any], _ keys: Set<String>) -> Bool {
        Set(object.keys) == keys
    }

    private static func safeSourceText(_ value: String?) -> String? {
        guard let value else { return nil }
        let cleaned = value.unicodeScalars.map { scalar -> String in
            CharacterSet.controlCharacters.contains(scalar) || scalar.properties.generalCategory == .format ? " " : String(scalar)
        }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        guard cleaned.unicodeScalars.count > maximumDisplayedSourceScalars else { return cleaned }
        let ending = cleaned.unicodeScalars.index(cleaned.startIndex, offsetBy: maximumDisplayedSourceScalars - 1)
        return String(cleaned.unicodeScalars[..<ending]) + "… (truncated)"
    }

    private static func sourceDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: value) { return date }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: value)
    }

    private static func formatSourceDate(_ value: Date, timezone: TimeZone?, includeTime: Bool) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = includeTime ? .short : .none
        formatter.timeZone = timezone ?? .current
        let result = formatter.string(from: value)
        return includeTime ? "\(result) \(formatter.timeZone.abbreviation(for: value) ?? "")" : result
    }

    private static func safeSourceSignals(_ value: Any?, kind: String) -> [SourceSignal]? {
        guard let signals = value as? [[String: Any]] else { return nil }
        var ids = Set<String>()
        var result: [SourceSignal] = []
        for signal in signals {
            guard signal["kind"] as? String == kind,
                  let id = signal["id"] as? String,
                  !id.isEmpty,
                  ids.insert(id).inserted,
                  let text = safeSourceText(signal["text"] as? String)
            else { return nil }
            if result.count < maximumDisplayedSourceSignals {
                var evidence: [SourceEvidence] = []
                for span in (signal["evidence"] as? [[String: Any]] ?? []).prefix(32) {
                    guard let quote = safeSourceText(span["quote"] as? String),
                          !evidence.contains(where: { $0.quote == quote }) else { continue }
                    let timestamp = sourceDate(span["started_at"] as? String).map {
                        formatSourceDate($0, timezone: nil, includeTime: true)
                    }
                    evidence.append(SourceEvidence(quote: quote, timestamp: timestamp))
                    if evidence.count == 3 { break }
                }
                let status = kind == "decision" ? signal["status"] as? String : nil
                result.append(SourceSignal(text: text, status: status, evidence: evidence))
            }
        }
        if signals.count > maximumDisplayedSourceSignals {
            result.append(SourceSignal(text: "Additional approved \(kind) items are not shown.", status: nil, evidence: []))
        }
        return result
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
                .foregroundColor: EchoTheme.faintText,
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

// A self-drawn pill so the two controls look identical on every macOS release
// instead of inheriting whichever bezel the system is shipping this year.
private final class PillButton: NSButton {
    enum Style {
        case primary
        case quiet
    }

    var style: Style = .primary {
        didSet { needsDisplay = true }
    }

    private var titleFont: NSFont {
        style == .primary
            ? NSFont.systemFont(ofSize: 13, weight: .semibold)
            : NSFont.systemFont(ofSize: 12, weight: .medium)
    }

    private var pillHeight: CGFloat { style == .primary ? 46 : 24 }
    private var horizontalPadding: CGFloat { style == .primary ? 20 : 12 }

    override var intrinsicContentSize: NSSize {
        let width = ceil((title as NSString).size(withAttributes: [.font: titleFont]).width)
        return NSSize(width: width + horizontalPadding * 2, height: pillHeight)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func drawFocusRingMask() {
        pillPath().fill()
    }

    override func draw(_ dirtyRect: NSRect) {
        let fill: NSColor
        let ink: NSColor
        switch style {
        case .primary:
            fill = isHighlighted ? EchoTheme.gold : EchoTheme.goldBright
            ink = EchoTheme.inkDeep
        case .quiet:
            fill = isHighlighted ? EchoTheme.text.withAlphaComponent(0.16) : EchoTheme.text.withAlphaComponent(0.08)
            ink = EchoTheme.text.withAlphaComponent(0.8)
        }
        let alpha: CGFloat = isEnabled ? 1 : 0.38
        fill.withAlphaComponent(fill.alphaComponent * alpha).setFill()
        pillPath().fill()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: titleFont,
            .foregroundColor: ink.withAlphaComponent(ink.alphaComponent * alpha),
            .paragraphStyle: paragraph,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        let rect = NSRect(
            x: 0,
            y: floor((bounds.height - size.height) / 2),
            width: bounds.width,
            height: ceil(size.height)
        )
        (title as NSString).draw(in: rect, withAttributes: attributes)
    }

    private func pillPath() -> NSBezierPath {
        let radius = bounds.height / 2
        return NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
    }
}

@MainActor
private final class SourceDocumentView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class OverlayController: NSObject, NSWindowDelegate, NSTextViewDelegate {
    private let runner = CliRunner()
    private let panel: EchoPanel
    private let composer = QuestionTextView()
    private let composerScrollView = NSScrollView()
    private let askButton = PillButton(title: "Ask", target: nil, action: nil)
    private let copyButton = PillButton(title: "Copy answer", target: nil, action: nil)
    private let sourcesButton = PillButton(title: "Sources (0)", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private let identityLabel = NSTextField(labelWithString: "Signed in")
    private let statusLabel = NSTextField(labelWithString: "Ready when you are")
    private let limitLabel = NSTextField(
        labelWithString: "0 / \(maximumQuestionScalars) characters · 0 / \(maximumQuestionUniqueTerms) terms"
    )
    private let emptyAnswerLabel = NSTextField(wrappingLabelWithString: "Ask a focused question and ECHO will synthesize the approved context you can access.")
    private let answerView = NSTextView()
    private let answerScrollView = NSScrollView()
    private let sourceScrollView = NSScrollView()
    private let sourcePane = NSView()
    private let sourceDetails = NSStackView()
    private let sourceTabs = NSScrollView()
    private let sourceChips = NSScrollView()
    private let basedOn = NSStackView()
    private var answerColumn: NSView?
    private var answerColumnTrailing: NSLayoutConstraint?
    private var sourcePaneWidth: NSLayoutConstraint?
    private var sourceExpansion: CGFloat = 0
    private var sourcePaneOpen = false
    private var sourceRecords: [String: SourceRecord] = [:]
    private var selectedSourceIndex = 0
    private let answerHeader = NSStackView()
    private var composerHeightConstraint: NSLayoutConstraint?
    private var activeAsk: RunningAsk?
    private var requestIdentifier: UUID?
    private var activeSources: RunningAsk?
    private var sourceRequestIdentifier: UUID?
    private var currentSources: [DisplaySource] = []
    private var activeIdentityLookup: RunningAsk?
    private var identityRequestIdentifier: UUID?
    private var identityText = "Signed in"
    private var copyFeedbackWorkItem: DispatchWorkItem?

    override init() {
        panel = EchoPanel(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
            // Non-activating: the panel takes keyboard focus without making ECHO the
            // active app, the way Spotlight does. Plain NSApp.activate() is declined
            // by cooperative activation whenever the last click was in another app.
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()
        configurePanel()
        configureContent()
    }

    /// Hotkey and menu entry point. A visible key panel toggles away; a visible
    /// background panel comes forward; a hidden panel is shown.
    func summon() {
        if panel.isVisible {
            if panel.isKeyWindow {
                hidePanel()
            } else {
                panel.makeKeyAndOrderFront(nil)
                focusComposer()
            }
            return
        }
        showPrompt()
    }

    func showPrompt() {
        if activeIdentityLookup == nil { refreshIdentity() }
        // Like Spotlight, a re-summoned panel keeps the last question and answer
        // and selects the question so typing replaces it. A request that was in
        // flight when the panel hid keeps running and lands when it lands.
        let hasConversation = !composer.string.isEmpty || !answerView.string.isEmpty
        if activeAsk == nil, !hasConversation {
            resetConversation()
        }
        placePanel()
        panel.makeKeyAndOrderFront(nil)
        focusComposer()
    }

    private func resetConversation() {
        clearSources()
        composer.string = ""
        composer.needsDisplay = true
        composer.isEditable = true
        askButton.title = "Ask"
        askButton.style = .primary
        askButton.setAccessibilityLabel("Ask ECHO")
        resetCopyFeedback()
        copyButton.isEnabled = false
        sourcesButton.isEnabled = false
        sourcesButton.title = "Sources (0)"
        statusLabel.stringValue = "Ready when you are"
        statusLabel.textColor = EchoTheme.mutedText
        answerView.string = ""
        answerHeader.isHidden = true
        answerScrollView.isHidden = true
        sourceScrollView.isHidden = true
        emptyAnswerLabel.isHidden = false
        emptyAnswerLabel.textColor = EchoTheme.faintText
        emptyAnswerLabel.stringValue = "Ask a focused question and ECHO will synthesize the approved context you can access."
        setThinking(false)
        refreshQuestionPresentation()
    }

    private func focusComposer() {
        panel.makeFirstResponder(composer)
        if composer.isEditable, !composer.string.isEmpty {
            composer.selectAll(nil)
        }
    }

    /// Sit on the screen that holds the pointer, centred, with the top edge a
    /// fifth of the way down: where Spotlight lands, so a demo never has to hunt.
    private func placePanel() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else {
            panel.center()
            return
        }
        let area = screen.visibleFrame
        let size = panel.frame.size
        let x = max(area.minX, area.midX - size.width / 2)
        let y = max(area.minY, area.maxY - area.height * 0.2 - size.height)
        panel.setFrameOrigin(NSPoint(x: floor(x), y: floor(y)))
    }

    func hidePanel() {
        cancelIdentityLookup()
        clearFetchedSources()
        panel.orderOut(nil)
    }

    func shutdown() {
        cancelActiveAsk()
        cancelIdentityLookup()
        clearSources()
        panel.orderOut(nil)
    }

    func accountWillChange() {
        cancelActiveAsk()
        cancelIdentityLookup()
        resetConversation()
        identityText = "Signed in"
        identityLabel.stringValue = identityText
    }

    func applicationDidDeactivate() {
        clearFetchedSources()
    }

    func windowDidResignKey(_ notification: Notification) {
        // A nonactivating hotkey panel can lose focus without ECHO ever
        // becoming the active application.
        clearFetchedSources()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        if panel.isVisible, !currentSources.isEmpty, sourceRecords.isEmpty { loadSources() }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hidePanel()
        return false
    }

    func windowDidResize(_ notification: Notification) {
        if sourcePaneOpen, answerColumn?.isHidden == true {
            sourcePaneWidth?.constant = panel.contentView?.bounds.width ?? panel.frame.width
        }
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
            statusLabel.textColor = EchoTheme.ember
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
            askButton.style = .primary
            askButton.setAccessibilityLabel("Ask ECHO")
            statusLabel.stringValue = "Cancelled"
            statusLabel.textColor = EchoTheme.mutedText
            refreshQuestionPresentation(preservingStatus: true)
            return
        }

        let validation = validateQuestion(composer.string)
        guard validation.isValid else {
            let message = validation.message ?? "Check the question and try again."
            statusLabel.stringValue = message
            statusLabel.textColor = EchoTheme.ember
            announce(message)
            return
        }
        if composer.string != validation.question { composer.string = validation.question }

        cancelActiveAsk()
        clearSources()
        resetCopyFeedback()
        let identifier = UUID()
        requestIdentifier = identifier
        composer.isEditable = false
        askButton.title = "Cancel"
        askButton.style = .quiet
        askButton.setAccessibilityLabel("Cancel ECHO request")
        askButton.isEnabled = true
        copyButton.isEnabled = false
        sourcesButton.isEnabled = false
        sourcesButton.title = "Sources (0)"
        answerView.string = ""
        answerHeader.isHidden = true
        answerScrollView.isHidden = true
        sourceScrollView.isHidden = true
        emptyAnswerLabel.isHidden = false
        emptyAnswerLabel.textColor = EchoTheme.faintText
        emptyAnswerLabel.stringValue = "ECHO is checking the approved context available to you."
        statusLabel.stringValue = "Thinking…"
        statusLabel.textColor = EchoTheme.mutedText
        setThinking(true)
        announce("ECHO is thinking.")

        activeAsk = runner.ask(question: validation.question) { [weak self] outcome in
            Task { @MainActor in self?.handle(outcome, identifier: identifier) }
        }
    }

    private func handle(_ outcome: AskOutcome, identifier: UUID) {
        guard requestIdentifier == identifier else { return }
        activeAsk = nil
        requestIdentifier = nil
        setThinking(false)
        composer.isEditable = true
        askButton.title = "Ask"
        askButton.style = .primary
        askButton.setAccessibilityLabel("Ask ECHO")
        askButton.isEnabled = true
        switch outcome {
        case .success(let answer):
            statusLabel.stringValue = "Answer ready"
            statusLabel.textColor = EchoTheme.mutedText
            answerView.textStorage?.setAttributedString(
                NSAttributedString(string: answer.answer, attributes: Self.answerAttributes)
            )
            answerView.scrollRangeToVisible(NSRange(location: 0, length: 0))
            answerHeader.isHidden = false
            answerScrollView.isHidden = false
            sourceScrollView.isHidden = true
            emptyAnswerLabel.isHidden = true
            copyButton.isEnabled = true
            currentSources = answer.sources
            sourcesButton.isEnabled = !answer.sources.isEmpty
            sourcesButton.title = "Sources (\(answer.sources.count))"
            refreshSourceChips()
            if panel.isVisible, panel.isKeyWindow { loadSources() }
            announce("ECHO answer ready.")
        case .failure(let message):
            statusLabel.stringValue = "Couldn’t answer"
            statusLabel.textColor = EchoTheme.ember
            answerView.string = ""
            answerHeader.isHidden = true
            answerScrollView.isHidden = true
            sourceScrollView.isHidden = true
            emptyAnswerLabel.isHidden = false
            emptyAnswerLabel.textColor = EchoTheme.mutedText
            emptyAnswerLabel.stringValue = message
            announce(message)
        case .cancelled:
            break
        }
        refreshQuestionPresentation(preservingStatus: true)
    }

    private func setThinking(_ thinking: Bool) {
        spinner.isHidden = !thinking
        if thinking {
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
        }
    }

    private func cancelActiveAsk() {
        requestIdentifier = nil
        activeAsk?.cancel()
        activeAsk = nil
        setThinking(false)
    }

    @objc private func showSources() {
        if sourcePaneOpen {
            showAnswer()
            return
        }
        guard !currentSources.isEmpty else { return }
        openSourcePane()
        renderSelectedSource()
        if sourceRecords.isEmpty { loadSources() }
    }

    private func loadSources() {
        guard activeSources == nil, !currentSources.isEmpty else { return }
        let identifier = UUID()
        sourceRequestIdentifier = identifier
        activeSources = runner.sources(sources: currentSources) { [weak self] outcome in
            Task { @MainActor in self?.handleSources(outcome, identifier: identifier) }
        }
        if sourcePaneOpen { renderSelectedSource() }
    }

    private func handleSources(_ outcome: SourceOutcome, identifier: UUID) {
        guard sourceRequestIdentifier == identifier else { return }
        activeSources = nil
        sourceRequestIdentifier = nil
        sourcesButton.title = sourcePaneOpen ? "Back to answer" : "Sources (\(currentSources.count))"
        sourcesButton.isEnabled = !currentSources.isEmpty
        switch outcome {
        case .success(let records):
            sourceRecords = Dictionary(uniqueKeysWithValues: records.map { ($0.source.recordSha256, $0) })
            refreshSourceChips()
            if sourcePaneOpen { renderSelectedSource(); announce("Sources ready.") }
        case .unavailable:
            if sourcePaneOpen { renderSelectedSource(); announce("Source details are unavailable.") }
        case .cancelled:
            break
        }
    }

    private func clearSources() {
        clearFetchedSources()
        currentSources = []
        selectedSourceIndex = 0
        refreshSourceChips()
        sourcesButton.title = "Sources (0)"
        sourcesButton.isEnabled = false
    }

    private func clearFetchedSources() {
        sourceRequestIdentifier = nil
        activeSources?.cancel()
        activeSources = nil
        sourceRecords = [:]
        clearSourceDetails()
        closeSourcePane()
        refreshSourceChips()
        sourceScrollView.isHidden = true
        if !answerView.string.isEmpty { answerScrollView.isHidden = false }
        sourcesButton.title = "Sources (\(currentSources.count))"
        sourcesButton.isEnabled = !currentSources.isEmpty
    }

    private func showAnswer() {
        closeSourcePane()
        answerScrollView.isHidden = false
        sourcesButton.title = "Sources (\(currentSources.count))"
        sourcesButton.isEnabled = !currentSources.isEmpty
    }

    @objc private func selectSource(_ sender: NSButton) {
        guard currentSources.indices.contains(sender.tag) else { return }
        selectedSourceIndex = sender.tag
        openSourcePane()
        refreshSourceChips()
        renderSelectedSource()
        if sourceRecords.isEmpty { loadSources() }
    }

    @objc private func closeSources() { showAnswer() }

    private func openSourcePane() {
        guard !sourcePaneOpen else { return }
        sourcePaneOpen = true
        let area = panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? panel.frame
        // On a narrow display the source card replaces the column until Back;
        // on a wide display it sits alongside the unchanged answer.
        if area.width >= 1000 {
            let targetWidth = min(panel.frame.width + 420, area.width)
            sourceExpansion = targetWidth - panel.frame.width
            let paneWidth = min(420, targetWidth - 600)
            sourcePaneWidth?.constant = paneWidth
            answerColumnTrailing?.constant = -paneWidth
            var frame = panel.frame
            frame.size.width = targetWidth
            frame.origin.x = max(area.minX, min(frame.minX, area.maxX - targetWidth))
            panel.setFrame(frame, display: true)
            panel.minSize.width = 600 + paneWidth
        } else {
            sourceExpansion = 0
            sourcePaneWidth?.constant = panel.contentView?.bounds.width ?? panel.frame.width
            answerColumn?.isHidden = true
        }
        sourcePane.isHidden = false
        sourceScrollView.isHidden = false
        sourcesButton.title = "Back to answer"
        refreshSourceChips()
    }

    private func closeSourcePane() {
        guard sourcePaneOpen else { return }
        sourcePaneOpen = false
        sourcePane.isHidden = true
        answerColumn?.isHidden = false
        answerColumnTrailing?.constant = 0
        sourcePaneWidth?.constant = 420
        panel.minSize.width = 600
        if sourceExpansion > 0 {
            var frame = panel.frame
            frame.size.width = max(600, frame.width - sourceExpansion)
            panel.setFrame(frame, display: true)
        }
        sourceExpansion = 0
        sourcesButton.title = "Sources (\(currentSources.count))"
        refreshSourceChips()
    }

    private func refreshSourceChips() {
        basedOn.isHidden = currentSources.isEmpty
        for (scroll, isTab) in [(sourceChips, false), (sourceTabs, true)] {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 6
            row.edgeInsets = NSEdgeInsets(top: 3, left: 0, bottom: 3, right: 0)
            for (index, source) in currentSources.enumerated() {
                let record = sourceRecords[source.recordSha256]
                let title = record?.title ?? source.label
                let maximum = isTab ? 24 : 52
                let shortened = title.count > maximum ? String(title.prefix(maximum)) + "…" : title
                let date = !isTab ? record?.shortDate.map { " · \($0)" } ?? "" : ""
                let button = PillButton(title: "\(index + 1)  \(shortened)\(date)", target: self, action: #selector(selectSource(_:)))
                button.style = sourcePaneOpen && selectedSourceIndex == index ? .primary : .quiet
                button.tag = index
                button.toolTip = title
                button.setAccessibilityLabel("Source \(index + 1): \(title)\(date)")
                button.setAccessibilityHelp("Show the approved record and supporting excerpts")
                button.translatesAutoresizingMaskIntoConstraints = false
                button.heightAnchor.constraint(equalToConstant: 28).isActive = true
                row.addArrangedSubview(button)
            }
            scroll.documentView = row
            row.setFrameSize(row.fittingSize)
        }
    }

    private func clearSourceDetails() {
        for view in sourceDetails.arrangedSubviews {
            sourceDetails.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }

    private func sourceLabel(_ text: String, size: CGFloat = 13, color: NSColor = EchoTheme.text, weight: NSFont.Weight = .regular) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.isSelectable = true
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }

    private func appendDetail(_ view: NSView) {
        sourceDetails.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: sourceDetails.widthAnchor).isActive = true
    }

    private func renderSelectedSource() {
        clearSourceDetails()
        guard currentSources.indices.contains(selectedSourceIndex) else { return }
        let source = currentSources[selectedSourceIndex]
        guard let record = sourceRecords[source.recordSha256] else {
            appendDetail(sourceLabel(activeSources == nil ? "Source details are unavailable." : "Loading sources…", color: EchoTheme.mutedText))
            return
        }
        appendDetail(sourceLabel("MEETING · APPROVED RECORD", size: 10.5, color: EchoTheme.goldBright, weight: .semibold))
        appendDetail(sourceLabel(record.title, size: 18, weight: .semibold))
        if let date = record.date { appendDetail(sourceLabel(date, size: 12, color: EchoTheme.mutedText)) }

        let metadata = NSStackView()
        metadata.orientation = .vertical
        metadata.alignment = .leading
        metadata.spacing = 10
        func field(_ name: String, _ value: String) {
            let entry = NSStackView(views: [sourceLabel(name, size: 11, color: EchoTheme.faintText), sourceLabel(value)])
            entry.orientation = .vertical
            entry.alignment = .leading
            entry.spacing = 3
            metadata.addArrangedSubview(entry)
            entry.widthAnchor.constraint(equalTo: metadata.widthAnchor).isActive = true
            for child in entry.arrangedSubviews { child.widthAnchor.constraint(equalTo: entry.widthAnchor).isActive = true }
        }
        if let name = record.approvedBy { field("Record approved by", name) }
        if !record.participants.isEmpty { field("Participants", record.participants.joined(separator: ", ")) }
        field("Visibility", record.visibility)
        appendDetail(metadata)
        for (title, signals) in [("DECISIONS", record.decisions), ("ACTIONS", record.actions), ("RATIONALE", record.rationales)] {
            guard !signals.isEmpty else { continue }
            appendDetail(sourceLabel(title, size: 10.5, color: EchoTheme.faintText, weight: .semibold))
            for signal in signals { appendDetail(sourceSignalCard(signal)) }
        }
        sourceScrollView.contentView.scroll(to: .zero)
        sourceScrollView.reflectScrolledClipView(sourceScrollView.contentView)
    }

    private func sourceSignalCard(_ signal: SourceSignal) -> NSView {
        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = EchoTheme.text.withAlphaComponent(0.04).cgColor
        card.layer?.cornerRadius = 8
        card.layer?.borderWidth = 1
        card.layer?.borderColor = EchoTheme.quietBorder.cgColor
        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 8
        content.translatesAutoresizingMaskIntoConstraints = false
        if let status = signal.status, ["proposed", "unresolved"].contains(status) {
            content.addArrangedSubview(sourceLabel(status.capitalized, size: 11, color: EchoTheme.goldBright, weight: .semibold))
        }
        content.addArrangedSubview(sourceLabel(signal.text, size: 13.5))
        for excerpt in signal.evidence {
            content.addArrangedSubview(sourceLabel("“\(excerpt.quote)”", size: 12.5, color: EchoTheme.goldBright))
            if let timestamp = excerpt.timestamp {
                content.addArrangedSubview(sourceLabel(timestamp, size: 11, color: EchoTheme.faintText))
            }
        }
        card.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),
        ])
        for view in content.arrangedSubviews { view.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true }
        return card
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
        panel.minSize = NSSize(width: 600, height: 470)
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.backgroundColor = EchoTheme.ink
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.delegate = self
        panel.onCancel = { [weak self] in
            guard let self else { return }
            if self.sourcePaneOpen { self.showAnswer() } else { self.hidePanel() }
        }
    }

    private func configureChipScroll(_ scroll: NSScrollView) {
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 38).isActive = true
    }

    private func configureSourcePane(in container: NSView) {
        sourcePane.wantsLayer = true
        sourcePane.layer?.backgroundColor = EchoTheme.inkDeep.cgColor
        sourcePane.translatesAutoresizingMaskIntoConstraints = false
        sourcePane.isHidden = true
        container.addSubview(sourcePane)
        let width = sourcePane.widthAnchor.constraint(equalToConstant: 420)
        sourcePaneWidth = width
        let close = PillButton(title: "Back to answer", target: self, action: #selector(closeSources))
        close.style = .quiet
        close.translatesAutoresizingMaskIntoConstraints = false
        close.setAccessibilityLabel("Back to answer")
        let heading = sourceLabel("SOURCES", size: 11, color: EchoTheme.faintText, weight: .semibold)
        sourcePane.addSubview(close)
        sourcePane.addSubview(heading)
        configureChipScroll(sourceTabs)
        sourcePane.addSubview(sourceTabs)

        sourceScrollView.drawsBackground = false
        sourceScrollView.hasVerticalScroller = true
        sourceScrollView.autohidesScrollers = true
        sourceScrollView.translatesAutoresizingMaskIntoConstraints = false
        sourceScrollView.isHidden = true
        sourcePane.addSubview(sourceScrollView)
        let document = SourceDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        sourceScrollView.documentView = document
        sourceDetails.orientation = .vertical
        sourceDetails.alignment = .leading
        sourceDetails.spacing = 14
        sourceDetails.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(sourceDetails)
        NSLayoutConstraint.activate([
            width,
            sourcePane.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            sourcePane.topAnchor.constraint(equalTo: container.topAnchor),
            sourcePane.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            close.topAnchor.constraint(equalTo: sourcePane.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: sourcePane.trailingAnchor, constant: -18),
            close.heightAnchor.constraint(equalToConstant: 26),
            heading.leadingAnchor.constraint(equalTo: sourcePane.leadingAnchor, constant: 18),
            heading.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            sourceTabs.topAnchor.constraint(equalTo: close.bottomAnchor, constant: 10),
            sourceTabs.leadingAnchor.constraint(equalTo: sourcePane.leadingAnchor, constant: 18),
            sourceTabs.trailingAnchor.constraint(equalTo: sourcePane.trailingAnchor, constant: -18),
            sourceScrollView.topAnchor.constraint(equalTo: sourceTabs.bottomAnchor, constant: 8),
            sourceScrollView.leadingAnchor.constraint(equalTo: sourcePane.leadingAnchor),
            sourceScrollView.trailingAnchor.constraint(equalTo: sourcePane.trailingAnchor),
            sourceScrollView.bottomAnchor.constraint(equalTo: sourcePane.bottomAnchor),
            document.widthAnchor.constraint(equalTo: sourceScrollView.contentView.widthAnchor),
            sourceDetails.topAnchor.constraint(equalTo: document.topAnchor, constant: 8),
            sourceDetails.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -20),
            sourceDetails.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 18),
            sourceDetails.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -18),
        ])
    }

    private func configureContent() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = EchoTheme.ink.cgColor
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = EchoTheme.ink.cgColor
        panel.contentView = container
        root.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(root)
        answerColumn = root
        let trailing = root.trailingAnchor.constraint(equalTo: container.trailingAnchor)
        answerColumnTrailing = trailing
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            root.topAnchor.constraint(equalTo: container.topAnchor),
            root.bottomAnchor.constraint(equalTo: container.bottomAnchor), trailing,
        ])
        configureSourcePane(in: container)

        let titleLabel = NSTextField(labelWithString: "ECHO")
        titleLabel.attributedStringValue = NSAttributedString(
            string: "ECHO",
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
                .foregroundColor: EchoTheme.text,
                .kern: 1.8,
            ]
        )
        titleLabel.setAccessibilityLabel("ECHO")
        titleLabel.setContentHuggingPriority(.required, for: .horizontal)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        identityLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        identityLabel.textColor = EchoTheme.mutedText
        identityLabel.alignment = .right
        identityLabel.lineBreakMode = .byTruncatingTail
        identityLabel.setAccessibilityLabel("Signed-in user")
        identityLabel.translatesAutoresizingMaskIntoConstraints = false

        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let header = NSStackView(views: [titleLabel, headerSpacer, identityLabel])
        header.orientation = .horizontal
        header.spacing = 12
        header.alignment = .firstBaseline
        header.setHuggingPriority(.required, for: .vertical)
        header.translatesAutoresizingMaskIntoConstraints = false

        composer.delegate = self
        composer.font = NSFont.systemFont(ofSize: 15)
        composer.textColor = EchoTheme.text
        composer.insertionPointColor = EchoTheme.goldBright
        composer.selectedTextAttributes = [
            .backgroundColor: EchoTheme.selection,
            .foregroundColor: EchoTheme.text,
        ]
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
        composerCard.layer?.backgroundColor = EchoTheme.inkDeep.cgColor
        composerCard.layer?.cornerRadius = 12
        composerCard.layer?.borderWidth = 1
        composerCard.layer?.borderColor = EchoTheme.border.cgColor
        composerCard.translatesAutoresizingMaskIntoConstraints = false
        composerCard.addSubview(composerScrollView)

        askButton.target = self
        askButton.action = #selector(submitOrCancel)
        askButton.keyEquivalent = "\r"
        askButton.isBordered = false
        askButton.style = .primary
        askButton.setAccessibilityLabel("Ask ECHO")
        askButton.translatesAutoresizingMaskIntoConstraints = false

        // A plain container, not a stack view: the card sets the row height as the
        // draft grows, and the pill stays anchored to the bottom trailing corner.
        let promptRow = NSView()
        promptRow.translatesAutoresizingMaskIntoConstraints = false
        promptRow.addSubview(composerCard)
        promptRow.addSubview(askButton)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        statusLabel.textColor = EchoTheme.mutedText
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setAccessibilityLabel("Question status")
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        limitLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        limitLabel.textColor = EchoTheme.faintText
        limitLabel.alignment = .right
        limitLabel.isHidden = true
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
        statusRow.setHuggingPriority(.required, for: .vertical)
        statusRow.translatesAutoresizingMaskIntoConstraints = false

        answerView.isEditable = false
        answerView.isSelectable = true
        answerView.drawsBackground = false
        answerView.font = NSFont.systemFont(ofSize: 14.5)
        answerView.textColor = EchoTheme.text
        answerView.selectedTextAttributes = [
            .backgroundColor: EchoTheme.selection,
            .foregroundColor: EchoTheme.text,
        ]
        answerView.textContainerInset = NSSize(width: 4, height: 6)
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

        basedOn.orientation = .vertical
        basedOn.alignment = .leading
        basedOn.spacing = 2
        basedOn.translatesAutoresizingMaskIntoConstraints = false
        basedOn.addArrangedSubview(sourceLabel("BASED ON", size: 10.5, color: EchoTheme.faintText, weight: .semibold))
        configureChipScroll(sourceChips)
        basedOn.addArrangedSubview(sourceChips)
        sourceChips.widthAnchor.constraint(equalTo: basedOn.widthAnchor).isActive = true
        basedOn.isHidden = true

        let answerTitle = NSTextField(labelWithString: "Answer")
        answerTitle.attributedStringValue = NSAttributedString(
            string: "ANSWER",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: EchoTheme.mutedText,
                .kern: 1.2,
            ]
        )
        answerTitle.setAccessibilityLabel("Answer")
        answerTitle.translatesAutoresizingMaskIntoConstraints = false

        copyButton.target = self
        copyButton.action = #selector(copyAnswer)
        copyButton.isBordered = false
        copyButton.style = .quiet
        copyButton.isEnabled = false
        copyButton.setAccessibilityLabel("Copy answer")
        copyButton.translatesAutoresizingMaskIntoConstraints = false

        sourcesButton.target = self
        sourcesButton.action = #selector(showSources)
        sourcesButton.isBordered = false
        sourcesButton.style = .quiet
        sourcesButton.isEnabled = false
        sourcesButton.setAccessibilityLabel("Show answer sources")
        sourcesButton.translatesAutoresizingMaskIntoConstraints = false

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        answerHeader.addArrangedSubview(answerTitle)
        answerHeader.addArrangedSubview(spacer)
        answerHeader.addArrangedSubview(sourcesButton)
        answerHeader.addArrangedSubview(copyButton)
        answerHeader.orientation = .horizontal
        answerHeader.spacing = 8
        answerHeader.alignment = .centerY
        answerHeader.setHuggingPriority(.required, for: .vertical)
        answerHeader.isHidden = true
        answerHeader.translatesAutoresizingMaskIntoConstraints = false

        emptyAnswerLabel.font = NSFont.systemFont(ofSize: 14)
        emptyAnswerLabel.textColor = EchoTheme.faintText
        emptyAnswerLabel.alignment = .center
        emptyAnswerLabel.maximumNumberOfLines = 0
        emptyAnswerLabel.setAccessibilityLabel("Answer placeholder")
        emptyAnswerLabel.translatesAutoresizingMaskIntoConstraints = false

        let answerArea = NSView()
        answerArea.wantsLayer = true
        answerArea.layer?.backgroundColor = EchoTheme.surface.cgColor
        answerArea.layer?.cornerRadius = 10
        answerArea.layer?.borderWidth = 1
        answerArea.layer?.borderColor = EchoTheme.quietBorder.cgColor
        answerArea.translatesAutoresizingMaskIntoConstraints = false
        answerArea.addSubview(answerHeader)
        answerArea.addSubview(answerScrollView)
        answerArea.addSubview(basedOn)
        answerArea.addSubview(emptyAnswerLabel)

        let hintLabel = NSTextField(labelWithString: "Return to ask · Shift-Return for a new line · Esc to close")
        hintLabel.font = NSFont.systemFont(ofSize: 11)
        hintLabel.textColor = EchoTheme.faintText
        hintLabel.setContentHuggingPriority(.required, for: .vertical)
        hintLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        hintLabel.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(header)
        root.addSubview(promptRow)
        root.addSubview(statusRow)
        root.addSubview(answerArea)
        root.addSubview(hintLabel)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),

            promptRow.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 16),
            promptRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            promptRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            composerScrollView.leadingAnchor.constraint(equalTo: composerCard.leadingAnchor, constant: 1),
            composerScrollView.trailingAnchor.constraint(equalTo: composerCard.trailingAnchor, constant: -1),
            composerScrollView.topAnchor.constraint(equalTo: composerCard.topAnchor, constant: 1),
            composerScrollView.bottomAnchor.constraint(equalTo: composerCard.bottomAnchor, constant: -1),
            composerCard.topAnchor.constraint(equalTo: promptRow.topAnchor),
            composerCard.bottomAnchor.constraint(equalTo: promptRow.bottomAnchor),
            composerCard.leadingAnchor.constraint(equalTo: promptRow.leadingAnchor),
            composerCard.trailingAnchor.constraint(equalTo: askButton.leadingAnchor, constant: -10),
            composerCard.widthAnchor.constraint(greaterThanOrEqualToConstant: 410),
            askButton.trailingAnchor.constraint(equalTo: promptRow.trailingAnchor),
            askButton.bottomAnchor.constraint(equalTo: promptRow.bottomAnchor),
            askButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 78),
            askButton.heightAnchor.constraint(equalToConstant: 46),

            statusRow.topAnchor.constraint(equalTo: promptRow.bottomAnchor, constant: 8),
            statusRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 25),
            statusRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -25),

            answerArea.topAnchor.constraint(equalTo: statusRow.bottomAnchor, constant: 18),
            answerArea.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            answerArea.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            answerArea.bottomAnchor.constraint(equalTo: hintLabel.topAnchor, constant: -14),
            answerArea.heightAnchor.constraint(greaterThanOrEqualToConstant: 140),

            answerHeader.topAnchor.constraint(equalTo: answerArea.topAnchor, constant: 14),
            answerHeader.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor, constant: 16),
            answerHeader.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor, constant: -16),
            answerScrollView.topAnchor.constraint(equalTo: answerHeader.bottomAnchor, constant: 8),
            answerScrollView.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor, constant: 12),
            answerScrollView.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor, constant: -12),
            answerScrollView.bottomAnchor.constraint(equalTo: basedOn.topAnchor, constant: -8),
            basedOn.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor, constant: 16),
            basedOn.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor, constant: -16),
            basedOn.bottomAnchor.constraint(equalTo: answerArea.bottomAnchor, constant: -10),
            emptyAnswerLabel.centerYAnchor.constraint(equalTo: answerArea.centerYAnchor),
            emptyAnswerLabel.topAnchor.constraint(greaterThanOrEqualTo: answerArea.topAnchor, constant: 16),
            emptyAnswerLabel.leadingAnchor.constraint(equalTo: answerArea.leadingAnchor, constant: 38),
            emptyAnswerLabel.trailingAnchor.constraint(equalTo: answerArea.trailingAnchor, constant: -38),
            emptyAnswerLabel.bottomAnchor.constraint(lessThanOrEqualTo: answerArea.bottomAnchor, constant: -16),

            hintLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 25),
            hintLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -25),
            hintLabel.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
        ])
        let composerHeight = composerCard.heightAnchor.constraint(equalToConstant: 46)
        composerHeight.isActive = true
        composerHeightConstraint = composerHeight

        // The answer area is the only row that absorbs spare height. This near-zero
        // priority spring asks for more height than the panel can give, so every other
        // row settles at its fitting size and the answer takes whatever remains.
        let answerSpring = answerArea.heightAnchor.constraint(equalToConstant: 10_000)
        answerSpring.priority = NSLayoutConstraint.Priority(1)
        answerSpring.isActive = true
    }

    private func refreshQuestionPresentation(preservingStatus: Bool = false) {
        let validation = validateQuestion(composer.string)
        limitLabel.stringValue = "\(validation.scalarCount) / \(maximumQuestionScalars) characters · \(validation.uniqueTermCount) / \(maximumQuestionUniqueTerms) terms"
        let nearLimit = validation.scalarCount * 5 >= maximumQuestionScalars * 4
            || validation.uniqueTermCount * 5 >= maximumQuestionUniqueTerms * 4
        limitLabel.isHidden = !(nearLimit || (!validation.isValid && !validation.question.isEmpty))
        if activeAsk == nil {
            askButton.isEnabled = validation.isValid && !validation.question.isEmpty
            if let message = validation.message, !validation.question.isEmpty {
                statusLabel.stringValue = message
                statusLabel.textColor = EchoTheme.ember
            } else if !preservingStatus && (statusLabel.stringValue == "Ready when you are" || statusLabel.stringValue == "Cancelled" || statusLabel.textColor == EchoTheme.ember) {
                statusLabel.stringValue = "Ready when you are"
                statusLabel.textColor = EchoTheme.mutedText
            }
        }
        updateComposerHeight()
    }

    private static let answerAttributes: [NSAttributedString.Key: Any] = {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        paragraph.paragraphSpacing = 6
        return [
            .font: NSFont.systemFont(ofSize: 14.5),
            .foregroundColor: EchoTheme.text,
            .paragraphStyle: paragraph,
        ]
    }()

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
private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var controller: OverlayController?
    private var statusItem: NSStatusItem?
    private var people: PeopleController?
    private var account: AccountController?
    private var peopleMenuItem: NSMenuItem?
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = OverlayController()
        people = PeopleController { [weak self] available in
            self?.peopleMenuItem?.isHidden = !available
        }
        account = AccountController(
            onSessionWillChange: { [weak self] in
                self?.controller?.accountWillChange()
                self?.people?.conceal()
            },
            mayChangeSession: { [weak self] in
                !(self?.people?.hasOutstandingMutation ?? false)
            },
            changed: { [weak self] in self?.people?.checkAccess() }
        )
        configureStatusItem()
        people?.checkAccess()
        account?.refresh()
        registerHotKey()
        if CommandLine.arguments.contains("--show-ask") { showOverlay() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showOverlay()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
        people?.shutdown()
        account?.shutdown()
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
    }

    func showOverlay() {
        controller?.summon()
    }

    @objc private func askEcho() {
        showOverlay()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        people?.checkAccess()
        account?.refresh()
    }

    func applicationDidResignActive(_ notification: Notification) {
        people?.conceal()
        controller?.applicationDidDeactivate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        people?.checkAccess()
        account?.refresh()
    }

    @objc private func showPeople() {
        people?.show()
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
        if let account { menu.addItem(account.menuItem) }
        let organization = NSMenuItem(title: "Organization", action: nil, keyEquivalent: "")
        let organizationMenu = NSMenu()
        let peopleItem = NSMenuItem(title: "People…", action: #selector(showPeople), keyEquivalent: "")
        peopleItem.target = self
        organizationMenu.addItem(peopleItem)
        organization.submenu = organizationMenu
        organization.isHidden = true
        menu.addItem(organization)
        peopleMenuItem = organization
        menu.delegate = self
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

@MainActor
private func retireRunningOverlay() -> Bool {
    let currentProcessIdentifier = ProcessInfo.processInfo.processIdentifier
    let deadline = Date().addingTimeInterval(overlayRetirementTimeoutSeconds)
    while true {
        let runningApplications = NSRunningApplication.runningApplications(
            withBundleIdentifier: overlayBundleIdentifier
        ).filter { application in
            application.processIdentifier != currentProcessIdentifier && !application.isTerminated
        }
        if runningApplications.isEmpty { return true }
        for application in runningApplications {
            _ = application.terminate()
        }

        let now = Date()
        if now >= deadline { return false }
        RunLoop.current.run(
            until: min(deadline, now.addingTimeInterval(overlayRetirementPollSeconds))
        )
    }
}

@main
private enum EchoOverlayMain {
    @MainActor
    static func main() {
        if CommandLine.arguments.count == 2,
           CommandLine.arguments[1] == "--quit-running-overlay" {
            guard retireRunningOverlay() else {
                FileHandle.standardError.write(
                    Data("ECHO setup: the running ECHO application did not stop\n".utf8)
                )
                Darwin.exit(EXIT_FAILURE)
            }
            return
        }
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
