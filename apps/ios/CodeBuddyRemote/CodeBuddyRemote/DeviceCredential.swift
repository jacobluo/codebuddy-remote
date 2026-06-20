import CryptoKit
import Foundation
import Security
import UIKit

struct DeviceCredential: Codable, Equatable {
  let deviceId: String
  let deviceSecret: String
  let deviceName: String

  static func generate(deviceName: String = UIDeviceName.current) -> DeviceCredential {
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return DeviceCredential(
      deviceId: UUID().uuidString,
      deviceSecret: Data(bytes).base64URLEncodedString(),
      deviceName: deviceName
    )
  }

  func signature(method: String, path: String, body: String, timestamp: String, nonce: String) -> String {
    let message = [method, path, body, timestamp, nonce].joined(separator: "\n")
    let key = SymmetricKey(data: Data(deviceSecret.utf8))
    let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
    return Data(mac).base64URLEncodedString()
  }

  func relayJoinSignature(pairingCode: String, timestamp: String, nonce: String) -> String {
    let message = ["relay.join", pairingCode, timestamp, nonce].joined(separator: "\n")
    let key = SymmetricKey(data: Data(deviceSecret.utf8))
    let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
    return Data(mac).base64URLEncodedString()
  }
}

enum DeviceCredentialStore {
  private static let service = "com.relaxorg.CodeBuddyRemote"
  private static let account = "local-device-credential"

  static func load() -> DeviceCredential? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data
    else {
      return nil
    }
    return try? JSONDecoder().decode(DeviceCredential.self, from: data)
  }

  static func save(_ credential: DeviceCredential) throws {
    let data = try JSONEncoder().encode(credential)
    var query = baseQuery
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let attributes = [kSecValueData as String: data]
      let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
      guard updateStatus == errSecSuccess else {
        throw KeychainError(status: updateStatus)
      }
      return
    }
    guard status == errSecSuccess else {
      throw KeychainError(status: status)
    }
  }

  private static var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}

struct KeychainError: LocalizedError {
  let status: OSStatus

  var errorDescription: String? {
    "Keychain 保存失败：\(status)"
  }
}

private enum UIDeviceName {
  static var current: String {
    #if os(iOS)
    return UIDevice.current.name
    #else
    return "CodeBuddy Remote"
    #endif
  }
}

private extension Data {
  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
