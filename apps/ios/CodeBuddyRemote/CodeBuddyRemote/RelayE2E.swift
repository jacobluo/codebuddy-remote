import CryptoKit
import Foundation
import Security

enum RelayE2EError: Error {
  case sessionNotEstablished
  case invalidPublicKey
  case invalidEnvelope
  case invalidCiphertext
}

final class RelayE2EPeer {
  enum Role {
    case host
    case client
  }

  let role: Role
  let publicKey: String
  let version = 1
  let algorithm = "P256-HKDF-SHA256-CHACHA20-POLY1305"

  private let pairingCode: String
  private let privateKey = P256.KeyAgreement.PrivateKey()
  private var session: RelayE2ESession?
  private var outgoingSeq = 0

  init(role: Role, pairingCode: String) {
    self.role = role
    self.pairingCode = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    self.publicKey = privateKey.publicKey.x963Representation.base64URLEncodedString()
  }

  func deriveSession(peerPublicKey: String) throws {
    guard let publicKeyData = Data(base64URLEncoded: peerPublicKey) else {
      throw RelayE2EError.invalidPublicKey
    }
    let peerKey = try P256.KeyAgreement.PublicKey(x963Representation: publicKeyData)
    let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: peerKey)
    let salt = Data("codebuddy-remote relay e2e v1\n\(pairingCode)".utf8)
    session = RelayE2ESession(
      hostToClient: sharedSecret.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: salt,
        sharedInfo: Data("host-to-client".utf8),
        outputByteCount: 32
      ),
      clientToHost: sharedSecret.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: salt,
        sharedInfo: Data("client-to-host".utf8),
        outputByteCount: 32
      )
    )
  }

  func encryptPayload(_ payload: [String: Any]) throws -> [String: Any] {
    guard let session else { throw RelayE2EError.sessionNotEstablished }
    outgoingSeq += 1
    let direction = outgoingDirection
    let plaintext = try JSONSerialization.data(withJSONObject: payload)
    let nonce = try ChaChaPoly.Nonce(data: randomBytes(count: 12))
    let sealed = try ChaChaPoly.seal(
      plaintext,
      using: session.key(for: direction),
      nonce: nonce,
      authenticating: aad(direction: direction, seq: outgoingSeq)
    )
    return [
      "type": "encrypted",
      "version": version,
      "alg": algorithm,
      "seq": outgoingSeq,
      "nonce": Data(nonce).base64URLEncodedString(),
      "ciphertext": (sealed.ciphertext + sealed.tag).base64URLEncodedString(),
    ]
  }

  func decryptPayload(_ envelope: [String: Any]) throws -> [String: Any] {
    guard let session else { throw RelayE2EError.sessionNotEstablished }
    guard
      envelope["type"] as? String == "encrypted",
      envelope["version"] as? Int == version,
      envelope["alg"] as? String == algorithm,
      let seq = envelope["seq"] as? Int,
      let nonceText = envelope["nonce"] as? String,
      let ciphertextText = envelope["ciphertext"] as? String,
      let nonceData = Data(base64URLEncoded: nonceText),
      let sealedData = Data(base64URLEncoded: ciphertextText),
      sealedData.count > 16
    else {
      throw RelayE2EError.invalidEnvelope
    }
    let ciphertext = sealedData.prefix(sealedData.count - 16)
    let tag = sealedData.suffix(16)
    let sealedBox = try ChaChaPoly.SealedBox(
      nonce: ChaChaPoly.Nonce(data: nonceData),
      ciphertext: ciphertext,
      tag: tag
    )
    let plaintext = try ChaChaPoly.open(
      sealedBox,
      using: session.key(for: incomingDirection),
      authenticating: aad(direction: incomingDirection, seq: seq)
    )
    guard let payload = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else {
      throw RelayE2EError.invalidCiphertext
    }
    return payload
  }

  private var outgoingDirection: RelayE2EDirection {
    role == .host ? .hostToClient : .clientToHost
  }

  private var incomingDirection: RelayE2EDirection {
    role == .host ? .clientToHost : .hostToClient
  }

  private func aad(direction: RelayE2EDirection, seq: Int) -> Data {
    Data("codebuddy-remote relay e2e v1\n\(direction.rawValue)\n\(seq)".utf8)
  }
}

private struct RelayE2ESession {
  let hostToClient: SymmetricKey
  let clientToHost: SymmetricKey

  func key(for direction: RelayE2EDirection) -> SymmetricKey {
    direction == .hostToClient ? hostToClient : clientToHost
  }
}

private enum RelayE2EDirection: String {
  case hostToClient = "host-to-client"
  case clientToHost = "client-to-host"
}

private func randomBytes(count: Int) throws -> Data {
  var bytes = [UInt8](repeating: 0, count: count)
  let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
  guard status == errSecSuccess else {
    throw RelayE2EError.invalidCiphertext
  }
  return Data(bytes)
}

private extension Data {
  init?(base64URLEncoded value: String) {
    var base64 = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let padding = (4 - base64.count % 4) % 4
    base64.append(String(repeating: "=", count: padding))
    self.init(base64Encoded: base64)
  }

  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
