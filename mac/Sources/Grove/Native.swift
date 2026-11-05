/*
  Apps on this Mac, used as apps.

  The browser agent only knows Chrome, so "open the Messages app" went to
  Chrome, and asked to WhatsApp somebody it went to WhatsApp Web and wanted a
  QR code scanned, with the WhatsApp app signed in on the same Mac. An app
  someone uses is signed in; its website often is not.

  Three things here: finding and bringing forward any app by what they call
  it, sending through WhatsApp's own link, and doing things by hand (paste,
  keys) in an app the agent is working in by sight.
*/

import AppKit

enum Native {
  private static let bundles = ["whatsapp": "net.whatsapp.WhatsApp"]

  static func has(_ app: String) -> Bool {
    if app == "messages" { return true }
    guard let id = bundles[app] else { return false }
    return NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) != nil
  }

  static var apps: String { (["messages"] + bundles.keys.filter(has)).map(name).joined(separator: ", ") }

  static func name(_ app: String) -> String { app == "whatsapp" ? "WhatsApp" : "Messages" }

  /** An app where a slip sends something to somebody: typing and pressing there is held for a yes. */
  static func isComms(_ app: String) -> Bool {
    app.range(of: #"(?i)whatsapp|messages|slack|discord|telegram|signal|teams|messenger|mail|outlook|zoom|skype"#, options: .regularExpression) != nil
  }

  /**
    An app by what they call it. The usual folders first, then Spotlight, which
    knows about the ones nobody put in Applications. "my messages", "the mail
    app" and "Messages.app" are all Messages.
  */
  static func locate(_ said: String) -> URL? {
    var wanted = said.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    wanted = wanted.replacingOccurrences(of: #"^(my|the) +| +app$|\.app$"#, with: "", options: .regularExpression)
    guard !wanted.isEmpty else { return nil }
    let home = NSHomeDirectory()
    let dirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", home + "/Applications", home + "/Applications/Chrome Apps.localized"]
    let fm = FileManager.default
    var all: [URL] = []
    for dir in dirs {
      for item in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where item.hasSuffix(".app") {
        all.append(URL(fileURLWithPath: dir).appendingPathComponent(item))
      }
    }
    func title(_ u: URL) -> String { u.deletingPathExtension().lastPathComponent.lowercased() }
    if let hit = all.first(where: { title($0) == wanted }) ?? all.first(where: { title($0).hasPrefix(wanted) }) ?? all.first(where: { title($0).contains(wanted) }) { return hit }
    // Spotlight, for anything elsewhere.
    let p = Process(), out = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
    p.arguments = ["kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '*\(wanted.replacingOccurrences(of: "'", with: ""))*'c"]
    p.standardOutput = out
    guard (try? p.run()) != nil else { return nil }
    p.waitUntilExit()
    let found = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").first
    return found.map { URL(fileURLWithPath: String($0)) }
  }

  /** Opens it, or brings it forward if it is already open. The name it really has, or nil when there is no such app. */
  @discardableResult
  static func focus(_ said: String) async -> String? {
    guard let url = locate(said) else { return nil }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    let opened: Bool = await withCheckedContinuation { done in
      NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in done.resume(returning: error == nil) }
    }
    guard opened else { return nil }
    try? await Task.sleep(nanoseconds: 700_000_000)
    return url.deletingPathExtension().lastPathComponent
  }

  /** Words into whatever has focus, by pasting: typed key by key, anything outside plain letters comes out wrong. Puts the clipboard back. */
  static func paste(_ text: String) async {
    let board = NSPasteboard.general
    let kept = board.string(forType: .string)
    board.clearContents()
    board.setString(text, forType: .string)
    _ = await Browser.run("tell application \"System Events\" to keystroke \"v\" using command down")
    try? await Task.sleep(nanoseconds: 400_000_000)
    board.clearContents()
    if let kept { board.setString(kept, forType: .string) }
  }

  /** The words the app exposes through Accessibility, which is more than a window title and less than a picture. */
  static func words(in app: String) -> String {
    guard let running = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == app }) else { return "" }
    var out: [String] = []
    func walk(_ element: AXUIElement, _ depth: Int) {
      guard depth < 9, out.joined().count < 3000 else { return }
      for attribute in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let s = value as? String,
           !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, out.last != s { out.append(String(s.prefix(200))) }
      }
      var kids: CFTypeRef?
      if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &kids) == .success, let list = kids as? [AXUIElement] {
        for kid in list.prefix(60) { walk(kid, depth + 1) }
      }
    }
    var window: CFTypeRef?
    let root = AXUIElementCreateApplication(running.processIdentifier)
    if AXUIElementCopyAttributeValue(root, kAXFocusedWindowAttribute as CFString, &window) == .success, let window { walk(window as! AXUIElement, 0) }
    return out.joined(separator: "\n")
  }

  /**
    WhatsApp's own link opens the chat with the words already in the box, where
    they can be seen, and it needs a phone number, which Contacts has. Nothing
    is sent until `pressSend`, after their yes.
  */
  static func openWhatsApp(_ text: String, to address: String) async -> String? {
    let digits = address.filter(\.isNumber)
    guard digits.count >= 7 else { return "I only have an email for them, and WhatsApp needs a phone number." }
    guard let words = text.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
          let url = URL(string: "whatsapp://send?phone=\(digits.count == 10 ? "1" + digits : digits)&text=\(words)") else { return "WhatsApp wouldn't open that." }
    await MainActor.run { _ = NSWorkspace.shared.open(url) }
    try? await Task.sleep(nanoseconds: 2_500_000_000)
    return nil
  }

  static func pressSend() async -> String? {
    let (ok, out) = await Browser.run("""
    tell application "WhatsApp" to activate
    delay 0.5
    tell application "System Events" to key code 36
    return "sent"
    """)
    Log.say("whatsapp: \(ok ? out : "failed " + out)")
    return ok ? nil : "WhatsApp wouldn't send it. Is it signed in on this Mac?"
  }
}
