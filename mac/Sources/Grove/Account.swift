/*
  Signing in with Noctus, on the Mac.

  The phone and the Mac find each other through the person's Noctus account:
  both sign in with Google through Noctus's Supabase project, and the channel
  they talk on is named by a secret kept in that account (Link.swift). Nothing
  to pair, no code to type, and no need to be on the same Wi-Fi.

  The flow is Supabase's own PKCE: the browser goes to Google through
  Supabase, Supabase sends it back to grove-mac://auth-callback with a code,
  and the code and the verifier are exchanged for a session here. That
  redirect has to be on the project's allowlist (Authentication › URL
  Configuration › Redirect URLs), or Supabase sends the browser to the
  Noctus website instead and nothing comes back.

  The session lives in the Keychain and is refreshed a minute before it runs
  out, so signing in is once.
*/

import AppKit
import CryptoKit
import Foundation
import Security

struct Session: Codable {
  var access: String
  var refresh: String
  var expires: Date
  var userId: String
  var email: String
  /** The account's channel secret (user_metadata.grove_link); see Link.swift. */
  var link: String?
}

final class Account {
  static let redirect = "grove-mac://auth-callback"

  var onChange: ((Session?) -> Void)?
  private(set) var session: Session?
  private var verifier: String?
  private var refreshTimer: Timer?

  private let base: String
  private let anon: String

  init() {
    let info = Bundle.main.infoDictionary ?? [:]
    base = ((info["GroveSupabaseURL"] as? String) ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
    anon = (info["GroveSupabaseAnon"] as? String) ?? ""
    session = Keychain.read()
    if session != nil { scheduleRefresh() }
  }

  var configured: Bool { !base.isEmpty && !anon.isEmpty }
  var anonKey: String { anon }
  var realtimeURL: URL? {
    URL(string: base.replacingOccurrences(of: "https://", with: "wss://") + "/realtime/v1/websocket?apikey=\(anon)&vsn=1.0.0")
  }

  /** Opens the browser at Google, through Noctus's Supabase project. */
  func signIn() {
    guard configured else { Log.say("account: Supabase not configured in this build"); return }
    let v = Account.random(64)
    verifier = v
    let challenge = Data(SHA256.hash(data: Data(v.utf8))).base64URL
    var c = URLComponents(string: base + "/auth/v1/authorize")!
    c.queryItems = [
      .init(name: "provider", value: "google"),
      .init(name: "redirect_to", value: Account.redirect),
      .init(name: "code_challenge", value: challenge),
      .init(name: "code_challenge_method", value: "s256"),
    ]
    if let url = c.url { NSWorkspace.shared.open(url) }
    Log.say("account: opened Google sign-in")
  }

  /** grove-mac://auth-callback?code=… */
  func handle(_ url: URL) {
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    if let error = items.first(where: { $0.name == "error_description" })?.value {
      Log.say("account: sign-in refused: \(error)")
      return
    }
    guard let code = items.first(where: { $0.name == "code" })?.value, let verifier else {
      Log.say("account: callback without a code")
      return
    }
    Task { await token(["auth_code": code, "code_verifier": verifier], grant: "pkce") }
  }

  func signOut() {
    session = nil
    refreshTimer?.invalidate()
    Keychain.delete()
    onChange?(nil)
  }

  /** A token good for at least another minute, refreshing if it has to. */
  func freshAccess() async -> String? {
    guard let s = session else { return nil }
    if s.expires.timeIntervalSinceNow > 60 { return s.access }
    await token(["refresh_token": s.refresh], grant: "refresh_token")
    return session?.access
  }

  private func token(_ body: [String: String], grant: String) async {
    guard let url = URL(string: base + "/auth/v1/token?grant_type=\(grant)") else { return }
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(anon, forHTTPHeaderField: "apikey")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, response) = try? await URLSession.shared.data(for: request) else {
      Log.say("account: token request failed (\(grant))")
      return
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let access = obj["access_token"] as? String,
          let refresh = obj["refresh_token"] as? String,
          let user = obj["user"] as? [String: Any],
          let id = user["id"] as? String else {
      Log.say("account: token refused (\(grant), \(status))")
      if grant == "refresh_token" && status >= 400 && status < 500 { await MainActor.run { self.signOut() } }
      return
    }
    let expiresIn = (obj["expires_in"] as? Double) ?? 3600
    var link = (user["user_metadata"] as? [String: Any])?["grove_link"] as? String
    if link == nil || link!.count < 32 {
      // First device on this account: make the secret and keep it in the account.
      let made = Account.random(48).filter { $0.isLetter || $0.isNumber }
      if await saveLink(made, access: access) { link = made }
    }
    let next = Session(access: access, refresh: refresh, expires: Date().addingTimeInterval(expiresIn), userId: id, email: (user["email"] as? String) ?? "", link: link)
    await MainActor.run {
      self.session = next
      Keychain.write(next)
      self.scheduleRefresh()
      Log.say("account: signed in as \(next.email)")
      self.onChange?(next)
    }
  }

  /**
    The account's channel secret as the server has it now, not as it was when
    this Mac signed in. If the phone made one first, or made a new one, this is
    how the Mac finds it — the two only meet if they agree.
  */
  func currentLink() async -> String? {
    guard let access = await freshAccess(), let url = URL(string: base + "/auth/v1/user") else { return session?.link }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.setValue(anon, forHTTPHeaderField: "apikey")
    request.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
    guard let (data, _) = try? await URLSession.shared.data(for: request),
          let user = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return session?.link }
    let found = (user["user_metadata"] as? [String: Any])?["grove_link"] as? String
    if let found, found.count >= 32 {
      await MainActor.run {
        if self.session?.link != found, var s = self.session {
          Log.say("account: the account's channel changed, following it")
          s.link = found
          self.session = s
          Keychain.write(s)
        }
      }
      return found
    }
    // None on the account at all: make one, so the phone can find it.
    let made = Account.random(48).filter { $0.isLetter || $0.isNumber }
    if await saveLink(made, access: access) {
      await MainActor.run { if var s = self.session { s.link = made; self.session = s; Keychain.write(s) } }
      return made
    }
    return session?.link
  }

  private func saveLink(_ secret: String, access: String) async -> Bool {
    guard let url = URL(string: base + "/auth/v1/user") else { return false }
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(anon, forHTTPHeaderField: "apikey")
    request.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["data": ["grove_link": secret]])
    let status = ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
    Log.say("account: saved the channel secret (\(status))")
    return status == 200
  }

  private func scheduleRefresh() {
    refreshTimer?.invalidate()
    guard let s = session else { return }
    let wait = max(5, s.expires.timeIntervalSinceNow - 60)
    refreshTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
      guard let self, let s = self.session else { return }
      Task { await self.token(["refresh_token": s.refresh], grant: "refresh_token") }
    }
  }

  private static func random(_ n: Int) -> String {
    let chars = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    return String((0..<n).map { _ in chars.randomElement()! })
  }
}

private extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

/** One generic-password item holding the session. */
enum Keychain {
  private static let service = "org.noctusai.grove.mac.session"

  static func read() -> Session? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return try? JSONDecoder().decode(Session.self, from: data)
  }

  static func write(_ s: Session) {
    guard let data = try? JSONEncoder().encode(s) else { return }
    delete()
    let item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    SecItemAdd(item as CFDictionary, nil)
  }

  static func delete() {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
  }
}
