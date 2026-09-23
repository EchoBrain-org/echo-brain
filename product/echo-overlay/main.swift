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
private let captureHotKeyIdentifier = EventHotKeyID(signature: hotKeySignature, id: 2)
private let allowedCitationPolicies: Set<String> = [
    "organization-member-readable-person-v2",
    "restricted-reviewer-person-v2",
]

private let sha256Pattern = try! NSRegularExpression(pattern: "^sha256:[a-f0-9]{64}$")
private let sourceIDPattern = try! NSRegularExpression(pattern: "^source:[a-f0-9]{64}$")
private let documentIDPattern = try! NSRegularExpression(pattern: "^doc_[a-f0-9]{64}$")
private let projectIDPattern = try! NSRegularExpression(pattern: "^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

private func isSha256(_ value: String) -> Bool {
    sha256Pattern.firstMatch(
        in: value,
        range: NSRange(location: 0, length: (value as NSString).length)
    ) != nil
}

private func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
    expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
}

private func isSourceRevisionID(_ value: String) -> Bool {
    value == value.precomposedStringWithCanonicalMapping
        && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
        && !value.isEmpty && value.unicodeScalars.count <= 512
        && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
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

private struct CliSourceRevisionCitation: Decodable {
    let source_id: String
    let revision_id: String
    let source_sha256: String
    let representation_sha256: String
    let anchor_sha256: String
    let document_id: String?
    let label: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        let required: Set<String> = ["kind", "source_id", "revision_id", "source_sha256", "representation_sha256", "anchor_sha256"]
        let optional: Set<String> = ["document_id", "label"]
        guard values.allKeys.map(\.stringValue).allSatisfy({ required.contains($0) || optional.contains($0) }),
              required.isSubset(of: Set(values.allKeys.map(\.stringValue))),
              try values.decode(String.self, forKey: DynamicCodingKey("kind")) == "source_revision"
        else { throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("kind"), in: values, debugDescription: "Unexpected source citation fields") }
        source_id = try values.decode(String.self, forKey: DynamicCodingKey("source_id"))
        revision_id = try values.decode(String.self, forKey: DynamicCodingKey("revision_id"))
        source_sha256 = try values.decode(String.self, forKey: DynamicCodingKey("source_sha256"))
        representation_sha256 = try values.decode(String.self, forKey: DynamicCodingKey("representation_sha256"))
        anchor_sha256 = try values.decode(String.self, forKey: DynamicCodingKey("anchor_sha256"))
        document_id = try values.decodeIfPresent(String.self, forKey: DynamicCodingKey("document_id"))
        label = try values.decodeIfPresent(String.self, forKey: DynamicCodingKey("label"))
    }
}

private struct SourceRevisionReference: Sendable, Equatable, Hashable {
    let sourceID: String
    let revisionID: String
    let sourceSha256: String
    let representationSha256: String
    let anchorSha256: String
    let documentID: String?

    var isValid: Bool {
        matches(sourceIDPattern, sourceID) && isSourceRevisionID(revisionID)
            && isSha256(sourceSha256) && isSha256(representationSha256) && isSha256(anchorSha256)
            && (documentID == nil || matches(documentIDPattern, documentID!))
    }
}

private struct CliAskScopeV3: Decodable {
    let projectID: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        let kind = try values.decode(String.self, forKey: DynamicCodingKey("kind"))
        switch kind {
        case "global":
            guard hasExactCodingKeys(values.allKeys, ["kind"]) else { throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("kind"), in: values, debugDescription: "Unexpected global scope") }
            projectID = nil
        case "project":
            guard hasExactCodingKeys(values.allKeys, ["kind", "project_id"]) else { throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("kind"), in: values, debugDescription: "Unexpected project scope") }
            projectID = try values.decode(String.self, forKey: DynamicCodingKey("project_id"))
        default:
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("kind"), in: values, debugDescription: "Unknown Ask scope")
        }
    }
}

private struct CliApprovedRecordCitationV3: Decodable {
    let atom_id: String
    let record_sha256: String
    let policy_id: String

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        guard hasExactCodingKeys(values.allKeys, ["kind", "atom_id", "record_sha256", "policy_id"]),
              try values.decode(String.self, forKey: DynamicCodingKey("kind")) == "approved_record"
        else { throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("kind"), in: values, debugDescription: "Unexpected approved-record citation fields") }
        atom_id = try values.decode(String.self, forKey: DynamicCodingKey("atom_id"))
        record_sha256 = try values.decode(String.self, forKey: DynamicCodingKey("record_sha256"))
        policy_id = try values.decode(String.self, forKey: DynamicCodingKey("policy_id"))
    }
}

private enum CliCitationV3: Decodable {
    case approved(CliApprovedRecordCitationV3)
    case sourceRevision(CliSourceRevisionCitation)

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        let kind = try values.decode(String.self, forKey: DynamicCodingKey("kind"))
        switch kind {
        case "approved_record": self = .approved(try CliApprovedRecordCitationV3(from: decoder))
        case "source_revision": self = .sourceRevision(try CliSourceRevisionCitation(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("kind"), in: values, debugDescription: "Unknown citation kind")
        }
    }
}

private struct CliAnswer: Decodable {
    let schema_version: Int
    let kind: String
    let answer: String
    let citations: [CliCitation]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        let base: Set<String> = ["schema_version", "kind", "answer", "citations"]
        guard hasExactCodingKeys(values.allKeys, base) || hasExactCodingKeys(values.allKeys, base.union(["outcome"])) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("answer"), in: values, debugDescription: "Unexpected answer fields")
        }
        schema_version = try values.decode(Int.self, forKey: DynamicCodingKey("schema_version"))
        kind = try values.decode(String.self, forKey: DynamicCodingKey("kind"))
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

private struct CliSuccessEnvelope: Decodable {
    let ok: Bool
    let result: CliAnswer
}

private struct CliAnswerV3: Decodable {
    let schema_version: Int
    let kind: String
    let answer: String
    let citations: [CliCitationV3]
    let scope: CliAskScopeV3
    let outcome: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        let base: Set<String> = ["schema_version", "kind", "answer", "citations", "scope"]
        guard hasExactCodingKeys(values.allKeys, base) || hasExactCodingKeys(values.allKeys, base.union(["outcome"])) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("answer"), in: values, debugDescription: "Unexpected answer fields")
        }
        schema_version = try values.decode(Int.self, forKey: DynamicCodingKey("schema_version"))
        kind = try values.decode(String.self, forKey: DynamicCodingKey("kind"))
        answer = try values.decode(String.self, forKey: DynamicCodingKey("answer"))
        citations = try values.decode([CliCitationV3].self, forKey: DynamicCodingKey("citations"))
        scope = try values.decode(CliAskScopeV3.self, forKey: DynamicCodingKey("scope"))
        let outcomeKey = DynamicCodingKey("outcome")
        outcome = values.contains(outcomeKey) ? try values.decode(String.self, forKey: outcomeKey) : nil
        guard outcome == nil || (outcome == "authorship_unsupported" && citations.isEmpty) else {
            throw DecodingError.dataCorruptedError(forKey: outcomeKey, in: values, debugDescription: "Unsupported answer outcome")
        }
    }
}

private struct CliSuccessEnvelopeV3: Decodable { let ok: Bool; let result: CliAnswerV3 }

private struct CliSourceEvidence: Decodable {
    let schema_version: Int
    let kind: String
    let scope: CliAskScopeV3
    let citation: CliSourceRevisionCitation
    let text: String

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        guard hasExactCodingKeys(values.allKeys, ["schema_version", "kind", "scope", "citation", "text"]) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("text"), in: values, debugDescription: "Unexpected evidence fields")
        }
        schema_version = try values.decode(Int.self, forKey: DynamicCodingKey("schema_version"))
        kind = try values.decode(String.self, forKey: DynamicCodingKey("kind"))
        scope = try values.decode(CliAskScopeV3.self, forKey: DynamicCodingKey("scope"))
        citation = try values.decode(CliSourceRevisionCitation.self, forKey: DynamicCodingKey("citation"))
        text = try values.decode(String.self, forKey: DynamicCodingKey("text"))
    }
}

private struct CliSourceEvidenceEnvelope: Decodable {
    let ok: Bool
    let result: CliSourceEvidence
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: DynamicCodingKey.self)
        guard hasExactCodingKeys(values.allKeys, ["ok", "result"]) else {
            throw DecodingError.dataCorruptedError(forKey: DynamicCodingKey("ok"), in: values, debugDescription: "Unexpected evidence envelope")
        }
        ok = try values.decode(Bool.self, forKey: DynamicCodingKey("ok"))
        result = try values.decode(CliSourceEvidence.self, forKey: DynamicCodingKey("result"))
    }
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
    let loadable: Bool
    let sourceRevision: SourceRevisionReference?

    init(label: String, recordSha256: String, policyID: String, loadable: Bool = true, sourceRevision: SourceRevisionReference? = nil) {
        self.label = label; self.recordSha256 = recordSha256; self.policyID = policyID; self.loadable = loadable; self.sourceRevision = sourceRevision
    }
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

private enum SourceEvidenceOutcome: Sendable {
    case success(label: String?, text: String)
    case unavailable
    case cancelled
}

private final class CliRunner: @unchecked Sendable {
    private let executable: URL

    init(executable: URL? = nil) {
        self.executable = executable ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ECHO/bin/echo-brain")
    }

    func ask(
        question: String,
        projectID: String? = nil,
        completion: @escaping @Sendable (AskOutcome) -> Void
    ) -> RunningAsk {
        let running = RunningAsk()
        let executable = self.executable
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Self.execute(executable: executable, question: question, projectID: projectID, running: running)
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
        onRecord: @escaping @Sendable (SourceRecord) -> Void,
        completion: @escaping @Sendable (SourceOutcome) -> Void
    ) -> RunningAsk {
        let running = RunningAsk()
        let executable = self.executable
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Self.executeSources(
                executable: executable,
                sources: sources,
                running: running,
                onRecord: { record in
                    DispatchQueue.main.async {
                        guard !running.state().cancelled else { return }
                        onRecord(record)
                    }
                }
            )
            DispatchQueue.main.async { completion(outcome) }
        }
        return running
    }

    func sourceEvidence(
        source: DisplaySource,
        projectID: String?,
        completion: @escaping @Sendable (SourceEvidenceOutcome) -> Void
    ) -> RunningAsk {
        let running = RunningAsk()
        let executable = self.executable
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Self.executeSourceEvidence(executable: executable, source: source, projectID: projectID, running: running)
            DispatchQueue.main.async { completion(outcome) }
        }
        return running
    }

    private static func execute(
        executable: URL,
        question: String,
        projectID: String?,
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
        var arguments = ["person", "ask", "--question", question]
        if let projectID { arguments += ["--project", projectID] }
        process.arguments = arguments
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
            return parseSuccess(stdoutReader.data(), expectedProjectID: projectID)
        }
        return parseFailure(stderrReader.data())
    }

    fileprivate static func parseSuccess(_ data: Data, expectedProjectID: String? = nil) -> AskOutcome {
        if let envelope = try? JSONDecoder().decode(CliSuccessEnvelopeV3.self, from: data), envelope.ok,
           envelope.result.schema_version == 3, envelope.result.kind == "echo-clean-person-answer-v3",
           !envelope.result.answer.isEmpty, envelope.result.answer.unicodeScalars.count <= maximumAnswerScalars,
           envelope.result.scope.projectID == expectedProjectID {
            return parseV3(envelope.result)
        }
        guard expectedProjectID == nil,
              let envelope = try? JSONDecoder().decode(CliSuccessEnvelope.self, from: data),
              envelope.ok,
              envelope.result.schema_version == 2,
              envelope.result.kind == "echo-clean-person-answer-v2",
              !envelope.result.answer.isEmpty,
              envelope.result.answer.unicodeScalars.count <= maximumAnswerScalars
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

    private static func parseV3(_ answer: CliAnswerV3) -> AskOutcome {
        var citedAtoms = Set<String>()
        var sourceKeys = Set<String>()
        var sources: [DisplaySource] = []
        for citation in answer.citations {
            switch citation {
            case .approved(let record):
                guard isSha256(record.atom_id), isSha256(record.record_sha256),
                      allowedCitationPolicies.contains(record.policy_id), citedAtoms.insert(record.atom_id).inserted
                else { return .failure("The installed ECHO client returned an invalid response.") }
                let key = "approved|\(record.record_sha256)|\(record.policy_id)"
                guard sourceKeys.insert(key).inserted else { continue }
                sources.append(DisplaySource(label: "Approved record \(sources.count + 1)", recordSha256: record.record_sha256, policyID: record.policy_id))
            case .sourceRevision(let source):
                let reference = SourceRevisionReference(sourceID: source.source_id, revisionID: source.revision_id,
                                                        sourceSha256: source.source_sha256, representationSha256: source.representation_sha256,
                                                        anchorSha256: source.anchor_sha256, documentID: source.document_id)
                guard reference.isValid
                else { return .failure("The installed ECHO client returned an invalid response.") }
                let key = "source|\(source.source_id)|\(source.revision_id)|\(source.anchor_sha256)"
                guard sourceKeys.insert(key).inserted else { continue }
                let label = source.label?.trimmingCharacters(in: .whitespacesAndNewlines)
                sources.append(DisplaySource(
                    label: label?.isEmpty == false ? label! : "Original source \(sources.count + 1)",
                    recordSha256: source.source_sha256,
                    policyID: "source_revision",
                    loadable: false,
                    sourceRevision: reference
                ))
            }
        }
        return .success(DisplayAnswer(answer: answer.answer, sources: sources))
    }

    fileprivate static func executeSources(
        executable: URL,
        sources: [DisplaySource],
        running: RunningAsk,
        onRecord: @escaping (SourceRecord) -> Void = { _ in }
    ) -> SourceOutcome {
        guard executable.isFileURL,
              executable.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: executable.path)
        else { return .unavailable }

        var records: [SourceRecord] = []
        for source in sources {
            if running.state().cancelled { return .cancelled }
            let sourceRunning = RunningAsk()
            running.attachCancellationHandler { sourceRunning.cancel() }
            let record = executeSource(
                executable: executable,
                source: source,
                running: sourceRunning
            )
            running.removeCancellationHandler()
            guard let record else {
                if running.state().cancelled { return .cancelled }
                continue
            }
            if running.state().cancelled { return .cancelled }
            records.append(record)
            onRecord(record)
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

    private static func executeSourceEvidence(
        executable: URL,
        source: DisplaySource,
        projectID: String?,
        running: RunningAsk
    ) -> SourceEvidenceOutcome {
        guard executable.isFileURL, executable.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: executable.path),
              let reference = source.sourceRevision, reference.isValid,
              projectID == nil || matches(projectIDPattern, projectID!)
        else { return .unavailable }
        var arguments = ["person", "ask-source", "--source-id", reference.sourceID, "--revision-id", reference.revisionID,
                         "--source-sha256", reference.sourceSha256, "--representation-sha256", reference.representationSha256,
                         "--anchor-sha256", reference.anchorSha256]
        if let documentID = reference.documentID { arguments += ["--document-id", documentID] }
        if let projectID { arguments += ["--project", projectID] }
        let process = Process(); let stdout = Pipe(); let stderr = Pipe()
        process.executableURL = executable; process.arguments = arguments
        process.standardInput = FileHandle.nullDevice; process.standardOutput = stdout; process.standardError = stderr
        let stdoutReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let stderrReader = BoundedReader(maximumBytes: maximumProcessOutputBytes)
        let readers = DispatchGroup()
        readers.enter(); DispatchQueue.global(qos: .userInitiated).async { stdoutReader.read(from: stdout.fileHandleForReading) { running.exceedOutputLimit() }; readers.leave() }
        readers.enter(); DispatchQueue.global(qos: .userInitiated).async { stderrReader.read(from: stderr.fileHandleForReading) { running.exceedOutputLimit() }; readers.leave() }
        do {
            guard try running.launch(process) else {
                try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close(); readers.wait(); return .cancelled
            }
        } catch {
            try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close(); readers.wait(); running.detach(process); return .unavailable
        }
        try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close()
        let timeout = DispatchWorkItem { running.timeOut() }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + sourceTimeoutSeconds, execute: timeout)
        process.waitUntilExit(); timeout.cancel(); readers.wait(); running.detach(process)
        let state = running.state()
        guard !state.cancelled else { return .cancelled }
        guard !state.timedOut, !state.outputExceeded, !stdoutReader.didExceedLimit(), !stderrReader.didExceedLimit(), process.terminationStatus == 0 else { return .unavailable }
        return parseSourceEvidence(stdoutReader.data(), reference: reference, expectedProjectID: projectID)
    }

    fileprivate static func parseSourceEvidence(_ data: Data, reference: SourceRevisionReference, expectedProjectID: String?) -> SourceEvidenceOutcome {
        guard let envelope = try? JSONDecoder().decode(CliSourceEvidenceEnvelope.self, from: data), envelope.ok,
              envelope.result.schema_version == 1, envelope.result.kind == "echo-person-source-evidence-v1",
              envelope.result.scope.projectID == expectedProjectID,
              envelope.result.text.utf8.count <= 3 * 1024, !envelope.result.text.isEmpty
        else { return .unavailable }
        let citation = envelope.result.citation
        let returned = SourceRevisionReference(sourceID: citation.source_id, revisionID: citation.revision_id,
                                               sourceSha256: citation.source_sha256, representationSha256: citation.representation_sha256,
                                               anchorSha256: citation.anchor_sha256, documentID: citation.document_id)
        guard returned == reference, returned.isValid else { return .unavailable }
        let label = citation.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        return .success(label: label?.isEmpty == false ? label : nil, text: envelope.result.text)
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
        message = "Ask a question about the context you can access."
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

@MainActor
private final class SourceDocumentView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class AnswerController: NSObject, NSWindowDelegate {
    private var runner = CliRunner()
    private let panel: NSWindow
    private let container: NSView
    private var question = ""
    private var scope = AskScope.global
    private let askButton = PillButton(title: "Ask", target: nil, action: nil)
    private let copyButton = PillButton(title: "Copy answer", target: nil, action: nil)
    private let sourcesButton = PillButton(title: "Sources (0)", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private let identityLabel = NSTextField(labelWithString: "Signed in")
    private let statusLabel = NSTextField(labelWithString: "Ready when you are")
    private let emptyAnswerLabel = NSTextField(wrappingLabelWithString: "Ask across the context you can access, or scope a question to one project.")
    private let answerView = NSTextView()
    private let answerScrollView = NSScrollView()
    private let sourceScrollView = NSScrollView()
    private let sourcePane = NSView()
    private let sourceDetails = NSStackView()
    private let sourceTabs = NSScrollView()
    private let sourceChips = NSScrollView()
    private let basedOn = NSStackView()
    private var answerScrollBottomWithSourcesConstraint: NSLayoutConstraint?
    private var answerScrollBottomWithoutSourcesConstraint: NSLayoutConstraint?
    private var answerColumn: NSView?
    private var answerColumnTrailing: NSLayoutConstraint?
    private var sourcePaneWidth: NSLayoutConstraint?
    private var sourcePaneOpen = false
    private var sourceRecords: [String: SourceRecord] = [:]
    private var selectedSourceIndex = 0
    private let answerHeader = NSStackView()
    private let answerTitle = NSTextField(labelWithString: "ANSWER")
    private let submittedQuestionLabel = NSTextField(wrappingLabelWithString: "")
    private let scopeLabel = NSTextField(labelWithString: "")
    private var activeAsk: RunningAsk?
    private var requestIdentifier: UUID?
    private var activeSources: RunningAsk?
    private var sourceRequestIdentifier: UUID?
    private var activeSourceEvidence: RunningAsk?
    private var sourceEvidenceRequestIdentifier: UUID?
    private var sourceEvidence: [SourceRevisionReference: (label: String?, text: String)] = [:]
    private var unavailableSourceEvidence = Set<SourceRevisionReference>()
    private var currentSources: [DisplaySource] = []
    private var activeIdentityLookup: RunningAsk?
    private var identityRequestIdentifier: UUID?
    private var identityText = "Signed in"
    private var copyFeedbackWorkItem: DispatchWorkItem?
    private var retryAvailable = false

    init(window: NSWindow, container: NSView) {
        panel = window; self.container = container
        super.init(); configureContent()
    }

    /// Rejects without changing the draft when it cannot be sent. In
    /// particular, a second Enter never silently cancels or replaces an Ask
    /// that is still running.
    func submit(question: String, scope: AskScope) -> AskSubmission {
        guard activeAsk == nil else {
            statusLabel.stringValue = "ECHO is still answering your earlier question."
            statusLabel.textColor = EchoTheme.mutedText
            announce(statusLabel.stringValue)
            return .rejected(statusLabel.stringValue)
        }
        guard question.utf16.count <= maximumRawQuestionUTF16Units else {
            statusLabel.stringValue = "That question is too long. Use up to 240 characters."
            statusLabel.textColor = EchoTheme.ember
            return .rejected(statusLabel.stringValue)
        }
        let validation = validateQuestion(question)
        guard validation.isValid else {
            statusLabel.stringValue = validation.message ?? "Check the question and try again."
            statusLabel.textColor = EchoTheme.ember
            announce(statusLabel.stringValue)
            return .rejected(statusLabel.stringValue)
        }
        self.question = validation.question
        self.scope = scope
        retryAvailable = false
        startAsk()
        return .accepted
    }

    private func resetConversation() {
        clearSources()
        question = ""
        scope = .global
        retryAvailable = false
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
        submittedQuestionLabel.stringValue = ""
        scopeLabel.stringValue = ""
        answerHeader.isHidden = true
        answerScrollView.isHidden = true
        sourceScrollView.isHidden = true
        emptyAnswerLabel.isHidden = false
        emptyAnswerLabel.textColor = EchoTheme.faintText
        emptyAnswerLabel.stringValue = "Ask across the context you can access, or scope a question to one project."
        setThinking(false)
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
        // The host window can lose focus while the app remains active.
        clearFetchedSources()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        if panel.isVisible, !currentSources.isEmpty { loadSources() }
    }

    func windowDidResize(_ notification: Notification) {
        if sourcePaneOpen, answerColumn?.isHidden == true {
            sourcePaneWidth?.constant = container.bounds.width
        }
    }

    @objc private func submitOrCancel() {
        if activeAsk != nil {
            cancelActiveAsk()
            askButton.title = "Ask"
            askButton.style = .primary
            askButton.setAccessibilityLabel("Ask ECHO")
            statusLabel.stringValue = "Cancelled"
            statusLabel.textColor = EchoTheme.mutedText
            return
        }
        guard !question.isEmpty else { return }
        retryAvailable = false
        startAsk()
    }

    private func startAsk() {
        let validation = validateQuestion(question)
        guard validation.isValid else { return }
        question = validation.question
        clearSources()
        resetCopyFeedback()
        let identifier = UUID()
        requestIdentifier = identifier
        askButton.title = "Cancel"
        askButton.style = .quiet
        askButton.setAccessibilityLabel("Cancel ECHO request")
        askButton.isEnabled = true
        copyButton.isEnabled = false
        sourcesButton.isEnabled = false
        sourcesButton.title = "Sources (0)"
        answerView.string = ""
        submittedQuestionLabel.stringValue = "You asked: \(question)"
        scopeLabel.stringValue = "Scope: \(scope.displayName)"
        answerHeader.isHidden = false
        answerScrollView.isHidden = true
        sourceScrollView.isHidden = true
        emptyAnswerLabel.isHidden = false
        emptyAnswerLabel.textColor = EchoTheme.faintText
        emptyAnswerLabel.stringValue = "ECHO is checking \(scope.displayName.lowercased())."
        statusLabel.stringValue = "Thinking…"
        statusLabel.textColor = EchoTheme.mutedText
        setThinking(true)
        announce("ECHO is thinking.")

        activeAsk = runner.ask(question: validation.question, projectID: scope.projectID) { [weak self] outcome in
            Task { @MainActor in self?.handle(outcome, identifier: identifier) }
        }
    }

    private func handle(_ outcome: AskOutcome, identifier: UUID) {
        guard requestIdentifier == identifier else { return }
        activeAsk = nil
        requestIdentifier = nil
        setThinking(false)
        askButton.title = "Ask"
        askButton.style = .primary
        askButton.setAccessibilityLabel("Ask ECHO")
        askButton.isEnabled = true
        switch outcome {
        case .success(let answer):
            retryAvailable = false
            statusLabel.stringValue = "Answer ready"
            statusLabel.textColor = EchoTheme.mutedText
            answerView.textStorage?.setAttributedString(
                NSAttributedString(string: answer.answer, attributes: Self.answerAttributes)
            )
            submittedQuestionLabel.stringValue = "You asked: \(question)"
            scopeLabel.stringValue = "Scope: \(scope.displayName)"
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
            retryAvailable = true
            askButton.title = "Retry"
            askButton.setAccessibilityLabel("Retry ECHO request")
            setThinking(false)
            statusLabel.stringValue = "Couldn’t answer"
            statusLabel.textColor = EchoTheme.ember
            answerView.string = ""
            answerHeader.isHidden = false
            answerScrollView.isHidden = true
            sourceScrollView.isHidden = true
            emptyAnswerLabel.isHidden = false
            emptyAnswerLabel.textColor = EchoTheme.mutedText
            emptyAnswerLabel.stringValue = message
            announce(message)
        case .cancelled:
            break
        }
    }

    private func setThinking(_ thinking: Bool) {
        askButton.isHidden = !(thinking || retryAvailable)
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
        retryAvailable = false
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
        loadSources()
    }

    private func loadSources(prioritizingSelected: Bool = false) {
        guard activeSources == nil, !currentSources.isEmpty else { return }
        let missingSources = currentSources.filter { $0.loadable && sourceRecords[$0.recordSha256] == nil }
        guard !missingSources.isEmpty else { return }
        let selectedSource = currentSources.indices.contains(selectedSourceIndex)
            ? currentSources[selectedSourceIndex]
            : nil
        let sourcesToLoad: [DisplaySource]
        if prioritizingSelected,
           let selectedSource,
           selectedSource.loadable, sourceRecords[selectedSource.recordSha256] == nil {
            sourcesToLoad = [selectedSource] + missingSources.filter {
                $0.recordSha256 != selectedSource.recordSha256
            }
        } else if !sourceRecords.isEmpty,
           let selectedSource,
           selectedSource.loadable, sourceRecords[selectedSource.recordSha256] == nil {
            sourcesToLoad = [selectedSource]
        } else if sourceRecords.isEmpty {
            sourcesToLoad = missingSources
        } else {
            return
        }
        let identifier = UUID()
        sourceRequestIdentifier = identifier
        activeSources = runner.sources(sources: sourcesToLoad, onRecord: { [weak self] record in
            Task { @MainActor in self?.handleSource(record, identifier: identifier) }
        }) { [weak self] outcome in
            Task { @MainActor in self?.handleSources(outcome, identifier: identifier) }
        }
        if sourcePaneOpen { renderSelectedSource() }
    }

    private func prioritizeSelectedSourceLoad() {
        guard activeSources != nil,
              currentSources.indices.contains(selectedSourceIndex),
              sourceRecords[currentSources[selectedSourceIndex].recordSha256] == nil
        else { return }
        sourceRequestIdentifier = nil
        activeSources?.cancel()
        activeSources = nil
        loadSources(prioritizingSelected: true)
    }

    private func handleSource(_ record: SourceRecord, identifier: UUID) {
        guard sourceRequestIdentifier == identifier else { return }
        let isSelected = currentSources.indices.contains(selectedSourceIndex)
            && currentSources[selectedSourceIndex].recordSha256 == record.source.recordSha256
        sourceRecords[record.source.recordSha256] = record
        refreshSourceChips()
        if sourcePaneOpen, isSelected { renderSelectedSource() }
    }

    private func handleSources(_ outcome: SourceOutcome, identifier: UUID) {
        guard sourceRequestIdentifier == identifier else { return }
        activeSources = nil
        sourceRequestIdentifier = nil
        sourcesButton.title = sourcePaneOpen ? "Back to answer" : "Sources (\(currentSources.count))"
        sourcesButton.isEnabled = !currentSources.isEmpty
        switch outcome {
        case .success(let records):
            let selectedRecordWasAvailable = currentSources.indices.contains(selectedSourceIndex)
                && sourceRecords[currentSources[selectedSourceIndex].recordSha256] != nil
            for record in records { sourceRecords[record.source.recordSha256] = record }
            refreshSourceChips()
            if sourcePaneOpen {
                if !selectedRecordWasAvailable { renderSelectedSource() }
                announce("Sources ready.")
            }
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
        sourceEvidenceRequestIdentifier = nil
        activeSourceEvidence?.cancel()
        activeSourceEvidence = nil
        sourceEvidence = [:]
        unavailableSourceEvidence = []
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
        if activeSources != nil {
            prioritizeSelectedSourceLoad()
        } else {
            loadSources()
        }
    }

    @objc private func closeSources() { showAnswer() }

    private func openSourcePane() {
        guard !sourcePaneOpen else { return }
        sourcePaneOpen = true
        if container.bounds.width >= 1000 {
            sourcePaneWidth?.constant = 420
            answerColumnTrailing?.constant = -420
        } else {
            sourcePaneWidth?.constant = container.bounds.width
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
        sourcesButton.title = "Sources (\(currentSources.count))"
        refreshSourceChips()
    }

    private func refreshSourceChips() {
        let hasSources = !currentSources.isEmpty
        basedOn.isHidden = !hasSources
        let activeBottom = hasSources ? answerScrollBottomWithSourcesConstraint : answerScrollBottomWithoutSourcesConstraint
        let inactiveBottom = hasSources ? answerScrollBottomWithoutSourcesConstraint : answerScrollBottomWithSourcesConstraint
        inactiveBottom?.isActive = false
        activeBottom?.isActive = true
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
                button.setAccessibilityHelp(source.loadable
                    ? "Show the approved record and supporting excerpts"
                    : "Show the verified evidence packet for this original source")
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

    private func loadSourceEvidence(_ source: DisplaySource) {
        guard activeSourceEvidence == nil, let reference = source.sourceRevision,
              sourceEvidence[reference] == nil else { return }
        let identifier = UUID()
        sourceEvidenceRequestIdentifier = identifier
        let expectedProjectID = scope.projectID
        activeSourceEvidence = runner.sourceEvidence(source: source, projectID: expectedProjectID) { [weak self] outcome in
            Task { @MainActor in
                guard let self, self.sourceEvidenceRequestIdentifier == identifier,
                      self.currentSources.contains(where: { $0.sourceRevision == reference }),
                      self.scope.projectID == expectedProjectID
                else { return }
                self.activeSourceEvidence = nil; self.sourceEvidenceRequestIdentifier = nil
                if case .success(let label, let text) = outcome {
                    self.sourceEvidence[reference] = (label, text)
                } else if case .unavailable = outcome {
                    self.unavailableSourceEvidence.insert(reference)
                }
                self.renderSelectedSource()
            }
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
        if !source.loadable {
            appendDetail(sourceLabel("ORIGINAL SOURCE", size: 10.5, color: EchoTheme.goldBright, weight: .semibold))
            let evidence = source.sourceRevision.flatMap { sourceEvidence[$0] }
            appendDetail(sourceLabel(evidence?.label ?? source.label, size: 18, weight: .semibold))
            if let evidence {
                appendDetail(sourceLabel(evidence.text, color: EchoTheme.text))
            } else if let reference = source.sourceRevision, unavailableSourceEvidence.contains(reference) {
                appendDetail(sourceLabel("Evidence is unavailable.", color: EchoTheme.mutedText))
                let retry = PillButton(title: "Retry evidence", target: self, action: #selector(retrySourceEvidence(_:)))
                retry.style = .quiet; retry.tag = selectedSourceIndex
                appendDetail(retry)
            } else {
                appendDetail(sourceLabel(activeSourceEvidence == nil ? "Evidence is unavailable." : "Loading verified evidence…", color: EchoTheme.mutedText))
                loadSourceEvidence(source)
            }
            return
        }
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

    @objc private func retrySourceEvidence(_ sender: NSButton) {
        guard currentSources.indices.contains(sender.tag), let reference = currentSources[sender.tag].sourceRevision else { return }
        unavailableSourceEvidence.remove(reference)
        renderSelectedSource()
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
        let root = NSView(); root.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(root); answerColumn = root
        let trailing = root.trailingAnchor.constraint(equalTo: container.trailingAnchor); answerColumnTrailing = trailing
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            root.topAnchor.constraint(equalTo: container.topAnchor), root.bottomAnchor.constraint(equalTo: container.bottomAnchor), trailing])
        configureSourcePane(in: container)
        spinner.style = .spinning; spinner.controlSize = .small; spinner.isDisplayedWhenStopped = false
        statusLabel.font = .systemFont(ofSize: 12); statusLabel.textColor = EchoTheme.mutedText
        askButton.title = "Cancel"; askButton.target = self; askButton.action = #selector(submitOrCancel)
        askButton.isHidden = true; askButton.style = .quiet
        let statusRow = NSStackView(views: [spinner, statusLabel, askButton]); statusRow.spacing = 8
        answerView.isEditable = false; answerView.isSelectable = true; answerView.drawsBackground = false
        answerView.font = .systemFont(ofSize: 14.5); answerView.textColor = EchoTheme.text
        answerView.textContainerInset = NSSize(width: 4, height: 6); answerView.autoresizingMask = [.width]
        answerView.isVerticallyResizable = true; answerView.isHorizontallyResizable = false
        answerView.textContainer?.widthTracksTextView = true; answerView.setAccessibilityLabel("ECHO answer")
        answerScrollView.documentView = answerView; answerScrollView.hasVerticalScroller = true
        answerScrollView.autohidesScrollers = true; answerScrollView.drawsBackground = false
        basedOn.orientation = .vertical; basedOn.alignment = .leading; basedOn.spacing = 2
        basedOn.addArrangedSubview(sourceLabel("BASED ON", size: 10.5, color: EchoTheme.faintText, weight: .semibold))
        configureChipScroll(sourceChips); basedOn.addArrangedSubview(sourceChips)
        sourceChips.widthAnchor.constraint(equalTo: basedOn.widthAnchor).isActive = true; basedOn.isHidden = true
        copyButton.target = self; copyButton.action = #selector(copyAnswer); copyButton.style = .quiet; copyButton.isEnabled = false
        sourcesButton.target = self; sourcesButton.action = #selector(showSources); sourcesButton.style = .quiet; sourcesButton.isEnabled = false
        answerTitle.font = .systemFont(ofSize: 11, weight: .semibold)
        answerTitle.textColor = EchoTheme.mutedText
        answerTitle.stringValue = "ANSWER"
        scopeLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        scopeLabel.textColor = EchoTheme.goldBright
        submittedQuestionLabel.font = .systemFont(ofSize: 14, weight: .medium)
        submittedQuestionLabel.textColor = EchoTheme.text
        submittedQuestionLabel.maximumNumberOfLines = 2
        submittedQuestionLabel.setAccessibilityLabel("Submitted question")
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let titleRow = NSStackView(views: [answerTitle, scopeLabel, spacer, sourcesButton, copyButton])
        titleRow.orientation = .horizontal; titleRow.alignment = .centerY; titleRow.spacing = 8
        answerHeader.setViews([titleRow, submittedQuestionLabel], in: .top)
        answerHeader.orientation = .vertical; answerHeader.alignment = .leading; answerHeader.spacing = 5; answerHeader.isHidden = true
        emptyAnswerLabel.font = .systemFont(ofSize: 14); emptyAnswerLabel.textColor = EchoTheme.faintText
        emptyAnswerLabel.alignment = .center; emptyAnswerLabel.maximumNumberOfLines = 0
        for view in [statusRow, answerHeader, answerScrollView, basedOn, emptyAnswerLabel] {
            view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            statusRow.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
            statusRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            statusRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            answerHeader.topAnchor.constraint(equalTo: statusRow.bottomAnchor, constant: 14),
            answerHeader.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            answerHeader.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            answerScrollView.topAnchor.constraint(equalTo: answerHeader.bottomAnchor, constant: 8),
            answerScrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            answerScrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            basedOn.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            basedOn.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            basedOn.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -10),
            emptyAnswerLabel.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            emptyAnswerLabel.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            emptyAnswerLabel.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 24),
            emptyAnswerLabel.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -24),
        ])
        answerScrollBottomWithSourcesConstraint = answerScrollView.bottomAnchor.constraint(equalTo: basedOn.topAnchor, constant: -12)
        answerScrollBottomWithoutSourcesConstraint = answerScrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12)
        refreshSourceChips()
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


}

private func echoHotKeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event, let userData else { return OSStatus(eventNotHandledErr) }
    var pressed = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &pressed
    )
    guard status == noErr, pressed.signature == hotKeySignature else { return OSStatus(eventNotHandledErr) }
    let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
    switch pressed.id {
    case hotKeyIdentifier.id:
        DispatchQueue.main.async { delegate.showOverlay() }
    case captureHotKeyIdentifier.id:
        DispatchQueue.main.async { delegate.showCapture() }
    default:
        return OSStatus(eventNotHandledErr)
    }
    return noErr
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var controller: AnswerController?
    private var statusItem: NSStatusItem?
    private var people: PeopleController?
    private var account: AccountController?
    private var projects: ProjectsController?
    private var peopleMenuItem: NSMenuItem?
    private var hotKey: EventHotKeyRef?
    private var captureHotKey: EventHotKeyRef?
    private var captureMenuItem: NSMenuItem?
    private var hotKeyHandler: EventHandlerRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        people = PeopleController { [weak self] available in
            self?.peopleMenuItem?.isHidden = !available
        }
        account = AccountController(
            makeToolsController: { SlackConnectedToolsController(client: $0) },
            onSessionWillChange: { [weak self] in
                self?.controller?.accountWillChange()
                self?.people?.conceal()
                self?.projects?.accountWillChange()
            },
            mayChangeSession: { [weak self] in
                !(self?.people?.hasOutstandingMutation ?? false) && !(self?.projects?.hasOutstandingMutation ?? false)
            },
            changed: { [weak self] in self?.people?.checkAccess(); self?.projects?.refreshIdentity() }
        )
        let home = ProjectsController(onAsk: { [weak self] question, scope in
            self?.controller?.submit(question: question, scope: scope) ?? .rejected("ECHO is unavailable.")
        })
        projects = home
        controller = AnswerController(window: home.window, container: home.answerContainer)
        home.accountMenu = account?.menuItem.submenu
        home.onPeople = { [weak self] in self?.people?.show() }
        home.onIdentityChanged = { [weak self] in self?.controller?.accountWillChange() }
        home.onConceal = { [weak self] in self?.controller?.applicationDidDeactivate() }
        home.onActivateAnswer = { [weak self, weak home] in
            guard let home else { return }
            self?.controller?.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: home.window))
        }
        home.onResizeAnswer = { [weak self, weak home] in
            guard let home else { return }
            self?.controller?.windowDidResize(Notification(name: NSWindow.didResizeNotification, object: home.window))
        }
        configureStatusItem()
        people?.checkAccess()
        account?.refresh()
        registerHotKey()
        // Another app may already hold ⌘⇧E: then never advertise it.
        let captureShortcut = captureHotKey != nil
        captureMenuItem?.title = captureShortcut ? "Capture  ⌘⇧E" : "Capture"
        projects?.setCaptureShortcutAvailable(captureShortcut)
        projects?.show()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        projects?.show()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
        people?.shutdown()
        account?.shutdown()
        projects?.shutdown()
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let captureHotKey { UnregisterEventHotKey(captureHotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
    }

    func showOverlay() {
        projects?.summon()
    }

    @objc func showCapture() {
        projects?.capture()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        people?.checkAccess()
        projects?.refreshIdentity()
        account?.refresh()
    }

    func applicationDidResignActive(_ notification: Notification) {
        people?.conceal()
        projects?.conceal()
        controller?.applicationDidDeactivate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        people?.checkAccess()
        account?.refresh()
    }

    @objc private func showPeople() {
        people?.show()
    }

    @objc private func showProjects() {
        projects?.show()
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
        let projectsItem = NSMenuItem(title: "Open ECHO  ⌘E", action: #selector(showProjects), keyEquivalent: "")
        projectsItem.target = self
        menu.addItem(projectsItem)
        let captureItem = NSMenuItem(title: "Capture  ⌘⇧E", action: #selector(showCapture), keyEquivalent: "")
        captureItem.target = self
        captureMenuItem = captureItem
        menu.addItem(captureItem)
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
        let captureStatus = RegisterEventHotKey(
            UInt32(kVK_ANSI_E),
            UInt32(cmdKey | shiftKey),
            captureHotKeyIdentifier,
            GetApplicationEventTarget(),
            OptionBits(kEventHotKeyExclusive),
            &captureHotKey
        )
        if captureStatus != noErr { captureHotKey = nil }
        if registrationStatus != noErr { showHotKeyError() }
    }

    private func showHotKeyError() {
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "ECHO could not register ⌘E."
        alert.informativeText = "Another app may already be using that shortcut. You can still open ECHO from the menu bar."
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
