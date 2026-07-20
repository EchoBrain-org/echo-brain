import CryptoKit
import Foundation
import Security

private let protocolVersion = 1
private let maximumRequestBytes = 8 * 1024 * 1024
private let maximumMessageBytes = 6 * 1024 * 1024
private let keychainGroupInfoKey = "EchoBrainKeychainAccessGroup"
private let keychainGroupPlaceholder = "__ECHO_SIGNER_KEYCHAIN_ACCESS_GROUP_REQUIRED__"
private let applicationTagPrefix = "echo-brain.installation-signing.v1:"
private let signatureAlgorithmName = "ecdsa-p256-sha256-der-low-s"

private let p256Order: [UInt8] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
    0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
]

private let p256HalfOrder: [UInt8] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00,
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42,
    0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
]

private let p256SubjectPublicKeyInfoPrefix = Data([
    0x30, 0x59,
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x03, 0x42, 0x00,
])

private struct SignerFailure: Error {
    let code: String
    let message: String
}

private struct KeyDescriptor {
    let installationID: String
    let keyID: String
    let publicKeySPKIDER: Data

    var json: [String: Any] {
        [
            "installation_id": installationID,
            "key_id": keyID,
            "algorithm": signatureAlgorithmName,
            "public_key_spki_der_base64": publicKeySPKIDER.base64EncodedString(),
            "protection": "secure-enclave",
            "assurance": "hardware_bound",
            "private_key_exportable": false,
        ]
    }
}

private enum Request {
    case create(installationID: String)
    case describe(installationID: String)
    case sign(installationID: String, expectedKeyID: String, message: Data)
    case delete(installationID: String, expectedKeyID: String)
}

private func boundedMessage(_ value: String) -> String {
    let normalized = value.replacingOccurrences(of: "\n", with: " ")
    return String(normalized.prefix(512))
}

private func securityStatusMessage(_ status: OSStatus) -> String {
    let description = SecCopyErrorMessageString(status, nil) as String?
    return description ?? "Security.framework status \(status)"
}

private func consumeError(_ error: Unmanaged<CFError>?) -> String {
    guard let error else { return "Security.framework returned no error detail" }
    return boundedMessage(error.takeRetainedValue().localizedDescription)
}

private func readBoundedStandardInput() throws -> Data {
    var request = Data()
    while true {
        let remaining = maximumRequestBytes + 1 - request.count
        if remaining <= 0 {
            throw SignerFailure(
                code: "invalid_request",
                message: "request exceeds the \(maximumRequestBytes)-byte limit"
            )
        }
        guard let chunk = try FileHandle.standardInput.read(upToCount: min(64 * 1024, remaining)) else {
            break
        }
        if chunk.isEmpty { break }
        request.append(chunk)
    }
    guard !request.isEmpty else {
        throw SignerFailure(code: "invalid_request", message: "request is empty")
    }
    return request
}

private func exactKeys(_ object: [String: Any], expected: Set<String>) throws {
    let actual = Set(object.keys)
    guard actual == expected else {
        let missing = expected.subtracting(actual).sorted()
        let unexpected = actual.subtracting(expected).sorted()
        var details: [String] = []
        if !missing.isEmpty { details.append("missing \(missing.joined(separator: ","))") }
        if !unexpected.isEmpty { details.append("unexpected \(unexpected.joined(separator: ","))") }
        throw SignerFailure(
            code: "invalid_request",
            message: "request fields are not exact: \(details.joined(separator: "; "))"
        )
    }
}

private func requiredString(_ object: [String: Any], key: String) throws -> String {
    guard let value = object[key] as? String, !value.isEmpty else {
        throw SignerFailure(code: "invalid_request", message: "\(key) must be a non-empty string")
    }
    return value
}

private func validateProtocolVersion(_ value: Any?) throws {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.intValue == protocolVersion,
          number.doubleValue == Double(protocolVersion)
    else {
        throw SignerFailure(
            code: "invalid_request",
            message: "schema_version must be \(protocolVersion)"
        )
    }
}

private let installationIDExpression = try! NSRegularExpression(
    pattern: "^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
private let keyIDExpression = try! NSRegularExpression(pattern: "^sha256:[0-9a-f]{64}$")

private func matches(_ value: String, expression: NSRegularExpression) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return expression.firstMatch(in: value, range: range)?.range == range
}

private func validatedInstallationID(_ value: String) throws -> String {
    guard matches(value, expression: installationIDExpression) else {
        throw SignerFailure(
            code: "invalid_installation_id",
            message: "installation_id must be a canonical ins_ UUIDv4 identifier"
        )
    }
    return value
}

private func validatedKeyID(_ value: String) throws -> String {
    guard matches(value, expression: keyIDExpression) else {
        throw SignerFailure(
            code: "invalid_request",
            message: "expected_key_id must be sha256 followed by 64 lowercase hexadecimal characters"
        )
    }
    return value
}

private func decodeCanonicalBase64(_ value: String) throws -> Data {
    guard let decoded = Data(base64Encoded: value), decoded.base64EncodedString() == value else {
        throw SignerFailure(
            code: "invalid_request",
            message: "message_base64 must use canonical padded base64"
        )
    }
    guard decoded.count <= maximumMessageBytes else {
        throw SignerFailure(
            code: "invalid_request",
            message: "message exceeds the \(maximumMessageBytes)-byte limit"
        )
    }
    return decoded
}

private func parseRequest(_ data: Data) throws -> Request {
    let value: Any
    do {
        value = try JSONSerialization.jsonObject(with: data, options: [])
    } catch {
        throw SignerFailure(code: "invalid_request", message: "request is not valid JSON")
    }
    guard let object = value as? [String: Any] else {
        throw SignerFailure(code: "invalid_request", message: "request must be one JSON object")
    }
    try validateProtocolVersion(object["schema_version"])
    let command = try requiredString(object, key: "command")
    let installationID = try validatedInstallationID(
        requiredString(object, key: "installation_id")
    )

    switch command {
    case "create":
        try exactKeys(
            object,
            expected: ["schema_version", "command", "installation_id"]
        )
        return .create(installationID: installationID)
    case "describe":
        try exactKeys(
            object,
            expected: ["schema_version", "command", "installation_id"]
        )
        return .describe(installationID: installationID)
    case "sign":
        try exactKeys(
            object,
            expected: [
                "schema_version",
                "command",
                "installation_id",
                "expected_key_id",
                "message_base64",
            ]
        )
        let expectedKeyID = try validatedKeyID(
            requiredString(object, key: "expected_key_id")
        )
        let message = try decodeCanonicalBase64(
            requiredString(object, key: "message_base64")
        )
        return .sign(
            installationID: installationID,
            expectedKeyID: expectedKeyID,
            message: message
        )
    case "delete":
        try exactKeys(
            object,
            expected: [
                "schema_version",
                "command",
                "installation_id",
                "expected_key_id",
            ]
        )
        let expectedKeyID = try validatedKeyID(
            requiredString(object, key: "expected_key_id")
        )
        return .delete(
            installationID: installationID,
            expectedKeyID: expectedKeyID
        )
    default:
        throw SignerFailure(code: "invalid_request", message: "unsupported command")
    }
}

private func configuredKeychainAccessGroup() throws -> String {
    guard let group = Bundle.main.object(forInfoDictionaryKey: keychainGroupInfoKey) as? String,
          !group.isEmpty,
          group != keychainGroupPlaceholder,
          !group.contains("$("),
          !group.contains("__")
    else {
        throw SignerFailure(
            code: "invalid_configuration",
            message: "the signed helper is missing its stable keychain access group"
        )
    }
    guard let bundleID = Bundle.main.bundleIdentifier,
          !bundleID.isEmpty,
          !bundleID.contains("$("),
          !bundleID.contains("__")
    else {
        throw SignerFailure(
            code: "invalid_configuration",
            message: "the signed helper is missing its stable bundle identifier"
        )
    }
    return group
}

private func applicationTag(for installationID: String) -> Data {
    Data("\(applicationTagPrefix)\(installationID)".utf8)
}

private func keyQuery(
    installationID: String,
    accessGroup: String,
    returnReference: Bool
) -> [CFString: Any] {
    var query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyClass: kSecAttrKeyClassPrivate,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: applicationTag(for: installationID),
        kSecAttrAccessGroup: accessGroup,
        kSecUseDataProtectionKeychain: true,
        kSecMatchLimit: kSecMatchLimitOne,
    ]
    if returnReference { query[kSecReturnRef] = true }
    return query
}

private func loadKey(installationID: String, accessGroup: String) throws -> SecKey? {
    var item: CFTypeRef?
    let status = SecItemCopyMatching(
        keyQuery(
            installationID: installationID,
            accessGroup: accessGroup,
            returnReference: true
        ) as CFDictionary,
        &item
    )
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let item else {
        throw SignerFailure(
            code: status == errSecInteractionNotAllowed
                ? "keychain_unavailable"
                : "keychain_failed",
            message: securityStatusMessage(status)
        )
    }
    guard CFGetTypeID(item) == SecKeyGetTypeID() else {
        throw SignerFailure(
            code: "key_integrity_failed",
            message: "keychain returned an object that is not a SecKey"
        )
    }
    return unsafeBitCast(item, to: SecKey.self)
}

private func createKey(installationID: String, accessGroup: String) throws -> SecKey {
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        [.privateKeyUsage],
        &accessError
    ) else {
        throw SignerFailure(
            code: "secure_enclave_unavailable",
            message: consumeError(accessError)
        )
    }

    let privateAttributes: [CFString: Any] = [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: applicationTag(for: installationID),
        kSecAttrLabel: "Echo Brain installation \(installationID)",
        kSecAttrAccessGroup: accessGroup,
        kSecAttrAccessControl: access,
        kSecAttrCanSign: true,
    ]
    let parameters: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits: 256,
        kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
        kSecUseDataProtectionKeychain: true,
        kSecPrivateKeyAttrs: privateAttributes,
    ]
    var creationError: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(parameters as CFDictionary, &creationError) else {
        let detail = consumeError(creationError)
        if let existing = try loadKey(installationID: installationID, accessGroup: accessGroup) {
            return existing
        }
        throw SignerFailure(code: "secure_enclave_unavailable", message: detail)
    }
    return key
}

private func assertSecureEnclaveKey(_ key: SecKey) throws {
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          let tokenID = attributes[kSecAttrTokenID] as? String,
          tokenID == (kSecAttrTokenIDSecureEnclave as String),
          let keySize = attributes[kSecAttrKeySizeInBits] as? NSNumber,
          keySize.intValue == 256
    else {
        throw SignerFailure(
            code: "key_integrity_failed",
            message: "stored key is not a 256-bit Secure Enclave key"
        )
    }
    var exportError: Unmanaged<CFError>?
    if SecKeyCopyExternalRepresentation(key, &exportError) != nil {
        throw SignerFailure(
            code: "key_integrity_failed",
            message: "Secure Enclave private key unexpectedly allowed external representation"
        )
    }
    if let exportError { _ = exportError.takeRetainedValue() }
}

private func publicKeySPKI(for privateKey: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        throw SignerFailure(
            code: "key_integrity_failed",
            message: "Secure Enclave key has no recoverable public key"
        )
    }
    var exportError: Unmanaged<CFError>?
    guard let external = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data? else {
        throw SignerFailure(code: "key_integrity_failed", message: consumeError(exportError))
    }
    guard external.count == 65, external.first == 0x04 else {
        throw SignerFailure(
            code: "key_integrity_failed",
            message: "P-256 public key is not canonical ANSI X9.63 form"
        )
    }
    var spki = p256SubjectPublicKeyInfoPrefix
    spki.append(external)
    guard spki.count == 91 else {
        throw SignerFailure(code: "internal_error", message: "P-256 SPKI encoding failed")
    }
    return spki
}

private func keyID(for spki: Data) -> String {
    let hexadecimal = SHA256.hash(data: spki).map { String(format: "%02x", $0) }.joined()
    return "sha256:\(hexadecimal)"
}

private func descriptor(for key: SecKey, installationID: String) throws -> KeyDescriptor {
    try assertSecureEnclaveKey(key)
    let spki = try publicKeySPKI(for: key)
    return KeyDescriptor(
        installationID: installationID,
        keyID: keyID(for: spki),
        publicKeySPKIDER: spki
    )
}

private func compareScalar(_ left: [UInt8], _ right: [UInt8]) -> ComparisonResult {
    precondition(left.count == 32 && right.count == 32)
    for index in 0..<32 {
        if left[index] < right[index] { return .orderedAscending }
        if left[index] > right[index] { return .orderedDescending }
    }
    return .orderedSame
}

private func isZeroScalar(_ scalar: [UInt8]) -> Bool {
    scalar.allSatisfy { $0 == 0 }
}

private func paddedScalar(_ magnitude: ArraySlice<UInt8>) throws -> [UInt8] {
    guard magnitude.count <= 32 else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA scalar exceeds P-256")
    }
    return Array(repeating: 0, count: 32 - magnitude.count) + magnitude
}

private func readDERInteger(_ bytes: [UInt8], offset: inout Int) throws -> [UInt8] {
    guard offset + 2 <= bytes.count, bytes[offset] == 0x02 else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA integer tag is invalid")
    }
    let length = Int(bytes[offset + 1])
    offset += 2
    guard length > 0, length <= 33, offset + length <= bytes.count else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA integer length is invalid")
    }
    let integer = bytes[offset..<(offset + length)]
    offset += length
    guard let first = integer.first, (first & 0x80) == 0 else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA integer is negative")
    }
    if integer.count > 1,
       first == 0,
       let second = integer.dropFirst().first,
       (second & 0x80) == 0
    {
        throw SignerFailure(
            code: "signing_failed",
            message: "ECDSA integer is not minimally encoded"
        )
    }
    let magnitude = first == 0 ? integer.dropFirst() : integer[integer.startIndex...]
    let scalar = try paddedScalar(magnitude)
    guard !isZeroScalar(scalar), compareScalar(scalar, p256Order) == .orderedAscending else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA scalar is outside P-256")
    }
    return scalar
}

private func subtractScalar(_ right: [UInt8], from left: [UInt8]) -> [UInt8] {
    precondition(left.count == 32 && right.count == 32)
    var result = Array(repeating: UInt8(0), count: 32)
    var borrow = 0
    for index in stride(from: 31, through: 0, by: -1) {
        var difference = Int(left[index]) - Int(right[index]) - borrow
        if difference < 0 {
            difference += 256
            borrow = 1
        } else {
            borrow = 0
        }
        result[index] = UInt8(difference)
    }
    precondition(borrow == 0)
    return result
}

private func encodeDERInteger(_ scalar: [UInt8]) -> [UInt8] {
    precondition(scalar.count == 32 && !isZeroScalar(scalar))
    var first = 0
    while first < scalar.count - 1 && scalar[first] == 0 { first += 1 }
    var magnitude = Array(scalar[first...])
    if let leading = magnitude.first, (leading & 0x80) != 0 {
        magnitude.insert(0, at: 0)
    }
    return [0x02, UInt8(magnitude.count)] + magnitude
}

private func normalizeP256LowS(_ signature: Data) throws -> Data {
    let bytes = [UInt8](signature)
    guard bytes.count >= 8,
          bytes.count <= 72,
          bytes[0] == 0x30,
          Int(bytes[1]) == bytes.count - 2,
          (bytes[1] & 0x80) == 0
    else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA sequence is invalid")
    }
    var offset = 2
    let r = try readDERInteger(bytes, offset: &offset)
    var s = try readDERInteger(bytes, offset: &offset)
    guard offset == bytes.count else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA signature has trailing data")
    }
    if compareScalar(s, p256HalfOrder) == .orderedDescending {
        s = subtractScalar(s, from: p256Order)
    }
    let encodedR = encodeDERInteger(r)
    let encodedS = encodeDERInteger(s)
    let body = encodedR + encodedS
    guard body.count <= 70 else {
        throw SignerFailure(code: "signing_failed", message: "ECDSA encoding is too large")
    }
    return Data([0x30, UInt8(body.count)] + body)
}

private func sign(_ message: Data, with key: SecKey) throws -> Data {
    let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
    guard SecKeyIsAlgorithmSupported(key, .sign, algorithm) else {
        throw SignerFailure(
            code: "signing_failed",
            message: "Secure Enclave key does not support the required signature algorithm"
        )
    }
    var signingError: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
        key,
        algorithm,
        message as CFData,
        &signingError
    ) as Data? else {
        throw SignerFailure(code: "signing_failed", message: consumeError(signingError))
    }
    return try normalizeP256LowS(signature)
}

private func deleteKey(
    installationID: String,
    expectedKeyID: String,
    accessGroup: String
) throws -> Bool {
    guard let key = try loadKey(installationID: installationID, accessGroup: accessGroup) else {
        return false
    }
    let actual = try descriptor(for: key, installationID: installationID)
    guard actual.keyID == expectedKeyID else {
        throw SignerFailure(
            code: "key_mismatch",
            message: "installation signing key does not match expected_key_id"
        )
    }

    // Delete only the exact transient SecKey reference whose fingerprint was
    // just checked. A tag-only query would delete every matching item.
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrAccessGroup: accessGroup,
        kSecUseDataProtectionKeychain: true,
        kSecMatchItemList: [key],
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess else {
        throw SignerFailure(
            code: status == errSecInteractionNotAllowed
                ? "keychain_unavailable"
                : "keychain_failed",
            message: securityStatusMessage(status)
        )
    }
    return true
}

private func success(_ fields: [String: Any] = [:]) -> [String: Any] {
    var response: [String: Any] = ["schema_version": protocolVersion, "ok": true]
    for (key, value) in fields { response[key] = value }
    return response
}

private func failure(_ error: SignerFailure) -> [String: Any] {
    [
        "schema_version": protocolVersion,
        "ok": false,
        "error": ["code": error.code, "message": boundedMessage(error.message)],
    ]
}

private func handle(_ request: Request) throws -> [String: Any] {
    let accessGroup = try configuredKeychainAccessGroup()
    switch request {
    case .create(let installationID):
        let key = try loadKey(installationID: installationID, accessGroup: accessGroup)
            ?? createKey(installationID: installationID, accessGroup: accessGroup)
        return success(["descriptor": try descriptor(for: key, installationID: installationID).json])
    case .describe(let installationID):
        guard let key = try loadKey(installationID: installationID, accessGroup: accessGroup) else {
            return success(["descriptor": NSNull()])
        }
        return success(["descriptor": try descriptor(for: key, installationID: installationID).json])
    case .sign(let installationID, let expectedKeyID, let message):
        guard let key = try loadKey(installationID: installationID, accessGroup: accessGroup) else {
            throw SignerFailure(code: "key_not_found", message: "installation signing key is unavailable")
        }
        let actual = try descriptor(for: key, installationID: installationID)
        guard actual.keyID == expectedKeyID else {
            throw SignerFailure(
                code: "key_mismatch",
                message: "installation signing key does not match expected_key_id"
            )
        }
        return success(["signature_base64": try sign(message, with: key).base64EncodedString()])
    case .delete(let installationID, let expectedKeyID):
        return success([
            "deleted": try deleteKey(
                installationID: installationID,
                expectedKeyID: expectedKeyID,
                accessGroup: accessGroup
            ),
        ])
    }
}

private func writeResponse(_ response: [String: Any]) {
    let output: Data
    do {
        output = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    } catch {
        let fallback = "{\"error\":{\"code\":\"internal_error\",\"message\":\"response encoding failed\"},\"ok\":false,\"schema_version\":1}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
        return
    }
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data([0x0a]))
}

do {
    writeResponse(try handle(parseRequest(readBoundedStandardInput())))
} catch let error as SignerFailure {
    writeResponse(failure(error))
} catch {
    writeResponse(
        failure(
            SignerFailure(
                code: "internal_error",
                message: boundedMessage(error.localizedDescription)
            )
        )
    )
}
