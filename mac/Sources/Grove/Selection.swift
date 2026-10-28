/*
  The highlighted text in whatever app is in front, and putting new text back.

  Accessibility first: ask the focused element for its selected text, and to
  replace it, set that attribute. Native apps answer — Notes, Mail, Pages,
  TextEdit, most text fields. Some apps do not expose it, Chrome and Electron
  apps among them, and for those the fallback is the clipboard: press ⌘C to
  read, paste over the selection to replace, and put back whatever was on the
  clipboard before, so using Grove never costs someone what they had copied.
*/

import AppKit
import ApplicationServices

struct Captured {
  let text: String
  let app: NSRunningApplication?
  let element: AXUIElement?
  /** Read through the clipboard rather than Accessibility, so replace the same way. */
  let viaClipboard: Bool
  var result: String? = nil
}

enum Read {
  case text(Captured)
  case none
  /** The app did not say. Try a copy. */
  case unknown(NSRunningApplication?)

  var summary: String {
    switch self {
    case .text(let c): return "\(c.text.count) characters"
    case .none: return "empty, passing it on"
    case .unknown: return "not reported, trying a copy"
    }
  }
}

enum Selection {
  static func read() -> Read {
    let app = NSWorkspace.shared.frontmostApplication
    if app?.bundleIdentifier == Bundle.main.bundleIdentifier { return .none }
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
          let element = focused else { return .unknown(app) }
    let el = element as! AXUIElement
    var selected: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(el, kAXSelectedTextAttribute as CFString, &selected)
    if status == .success, let text = selected as? String {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? .none : .text(Captured(text: text, app: app, element: el, viaClipboard: false))
    }
    return .unknown(app)
  }

  /** ⌘C, then read the clipboard if it changed. The old contents go back afterwards. */
  static func copyFallback(app: NSRunningApplication?, done: @escaping (Captured?) -> Void) {
    let board = NSPasteboard.general
    let before = board.changeCount
    let saved = board.string(forType: .string)
    press(key: 8, command: true) // kVK_ANSI_C
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
      guard board.changeCount != before, let text = board.string(forType: .string),
            !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        done(nil)
        return
      }
      restore(saved)
      done(Captured(text: text, app: app, element: nil, viaClipboard: true))
    }
  }

  static func replace(_ captured: Captured, with text: String) {
    captured.app?.activate()
    if !captured.viaClipboard, let el = captured.element,
       AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success {
      return
    }
    // Paste over the selection, then put the clipboard back as it was.
    let board = NSPasteboard.general
    let saved = board.string(forType: .string)
    board.clearContents()
    board.setString(text, forType: .string)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
      press(key: 9, command: true) // kVK_ANSI_V
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { restore(saved) }
    }
  }

  private static func restore(_ saved: String?) {
    let board = NSPasteboard.general
    board.clearContents()
    if let saved { board.setString(saved, forType: .string) }
  }

  private static func press(key: CGKeyCode, command: Bool) {
    let source = CGEventSource(stateID: .combinedSessionState)
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { continue }
      if command { e.flags = .maskCommand }
      e.setIntegerValueField(.eventSourceUserData, value: Shortcut.mark)
      e.post(tap: .cgSessionEventTap)
    }
  }
}
