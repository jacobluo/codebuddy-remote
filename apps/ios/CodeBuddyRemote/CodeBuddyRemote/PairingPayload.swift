import Foundation

struct PairingPayload: Equatable {
  enum Mode: String {
    case relay
  }

  enum ParseError: LocalizedError {
    case invalidURL
    case unsupportedVersion
    case invalidMode
    case expired
    case missingField(String)

    var errorDescription: String? {
      switch self {
      case .invalidURL:
        return "无效的配对二维码"
      case .unsupportedVersion:
        return "不支持的配对二维码版本"
      case .invalidMode:
        return "不支持的配对模式"
      case .expired:
        return "配对二维码已过期"
      case .missingField(let field):
        return "配对二维码缺少 \(field)"
      }
    }
  }

  let mode: Mode
  let relayURL: String
  let relayToken: String
  let pairingCode: String
  let pairingSecret: String
  let workspace: String
  let host: String
  let expiresAt: Date

  static func parse(_ rawValue: String, now: Date = Date()) throws -> PairingPayload {
    guard
      let components = URLComponents(string: rawValue),
      components.scheme == "cbr",
      components.host == "pair"
    else {
      throw ParseError.invalidURL
    }

    let query = Dictionary(
      uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
        item.value.map { (item.name, $0) }
      }
    )

    guard query["v"] == "1" else {
      throw ParseError.unsupportedVersion
    }
    guard let rawMode = query["mode"], let mode = Mode(rawValue: rawMode) else {
      throw ParseError.invalidMode
    }
    guard let rawExpiresAt = query["expiresAt"], let expiresAtMilliseconds = TimeInterval(rawExpiresAt) else {
      throw ParseError.missingField("expiresAt")
    }

    let expiresAt = Date(timeIntervalSince1970: expiresAtMilliseconds / 1000)
    guard expiresAt > now else {
      throw ParseError.expired
    }

    return PairingPayload(
      mode: mode,
      relayURL: try required("relayURL", in: query),
      relayToken: query["relayToken"] ?? "",
      pairingCode: try required("pairingCode", in: query),
      pairingSecret: query["pairingSecret"] ?? query["relayToken"] ?? "",
      workspace: query["workspace"] ?? "",
      host: query["host"] ?? "",
      expiresAt: expiresAt
    )
  }

  private static func required(_ key: String, in query: [String: String]) throws -> String {
    guard let value = query[key], !value.isEmpty else {
      throw ParseError.missingField(key)
    }
    return value
  }
}
