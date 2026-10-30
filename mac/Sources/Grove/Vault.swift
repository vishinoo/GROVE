/*
  What Grove remembers about them, kept on this Mac between launches.

  The phone keeps its memory encrypted at rest (vault.ts), and a plain copy
  here would undo that, so this is the same arrangement: AES-GCM, with the
  key in this Mac's Keychain as this-device-only, so it never rides an
  iCloud sync or a backup onto another machine. One small file in
  Application Support/Grove; nothing else on the Mac is touched. If the key
  or the file is lost, the next sync from the phone writes it again.
*/

import CryptoKit
import Foundation
import Security

enum Vault {
  private static let account = "grove.memory.key"
  private static var file: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Grove")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("memory.sealed")
  }

  private static func key() -> SymmetricKey? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account,
                                kSecReturnData as String: true]
    var out: CFTypeRef?
    if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data { return SymmetricKey(data: data) }
    let fresh = SymmetricKey(size: .bits256)
    let data = fresh.withUnsafeBytes { Data($0) }
    let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account,
                              kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? fresh : nil
  }

  static func save(_ text: String) {
    guard let key = key(), let sealed = try? AES.GCM.seal(Data(text.utf8), using: key).combined else {
      Log.say("vault: could not seal; memory kept in memory only")
      return
    }
    try? sealed.write(to: file, options: [.atomic, .completeFileProtection])
  }

  static func load() -> String {
    guard let data = try? Data(contentsOf: file), let key = key(),
          let box = try? AES.GCM.SealedBox(combined: data),
          let plain = try? AES.GCM.open(box, using: key) else { return "" }
    return String(decoding: plain, as: UTF8.self)
  }
}
