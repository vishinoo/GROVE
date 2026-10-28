/*
  ⌘K, but only when something is highlighted.

  macOS itself does not use ⌘K, but a great many apps do — insert link in
  Notes, Pages, Docs and Mail, the quick switcher in Slack and Notion, clear
  in Terminal — and most of them use it exactly when text is selected. So
  Grove does not register a hotkey, which would take ⌘K away from every app.
  It watches key presses with an event tap and claims ⌘K only when it can see
  highlighted text in the app in front; otherwise the press goes through
  untouched. ⌥⌘K is offered for anyone who would rather Grove never shared.

  An event tap needs Accessibility permission. Without it Grove still opens
  from the notch and still takes jobs from the phone; only ⌘K waits.

  Reading the selection has two routes (Selection.swift). Most apps answer
  the Accessibility question directly; some — Chrome, Electron apps — do not
  say, and for those the press is held, a copy is tried, and if nothing came
  back the original ⌘K is sent on, marked so this tap lets it through.
*/

import AppKit
import ApplicationServices

final class Shortcut {
  var useOption = false
  var onTrigger: ((Captured) -> Void)?
  private var tap: CFMachPort?

  /** Marks the ⌘K this tap sends on itself, so it is not caught twice. */
  static let mark: Int64 = 0x6772_6F76

  func start() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    if !AXIsProcessTrustedWithOptions(options) {
      // Asked once; checked again until it is granted, so turning it on in
      // System Settings starts ⌘K without a relaunch.
      Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] timer in
        if AXIsProcessTrusted() { timer.invalidate(); self?.install() }
      }
      return
    }
    install()
  }

  private func install() {
    guard tap == nil else { return }
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .defaultTap,
      eventsOfInterest: mask,
      callback: { _, type, event, refcon in
        guard let refcon else { return Unmanaged.passUnretained(event) }
        let me = Unmanaged<Shortcut>.fromOpaque(refcon).takeUnretainedValue()
        return me.handle(type, event)
      },
      userInfo: refcon
    ) else { return }
    self.tap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  }

  private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown else { return Unmanaged.passUnretained(event) }
    if event.getIntegerValueField(.eventSourceUserData) == Shortcut.mark { return Unmanaged.passUnretained(event) }

    let k: Int64 = 40 // kVK_ANSI_K
    guard event.getIntegerValueField(.keyboardEventKeycode) == k else { return Unmanaged.passUnretained(event) }
    let flags = event.flags
    let command = flags.contains(.maskCommand)
    let option = flags.contains(.maskAlternate)
    let others = flags.contains(.maskShift) || flags.contains(.maskControl)
    guard command, !others, option == useOption else { return Unmanaged.passUnretained(event) }

    switch Selection.read() {
    case .text(let captured):
      DispatchQueue.main.async { [weak self] in self?.onTrigger?(captured) }
      return nil
    case .none:
      return Unmanaged.passUnretained(event)
    case .unknown(let app):
      // Held: try a copy, and send the press on if nothing was highlighted.
      let option = useOption
      Selection.copyFallback(app: app) { [weak self] captured in
        if let captured { self?.onTrigger?(captured) } else { Shortcut.resend(option: option) }
      }
      return nil
    }
  }

  private static func resend(option: Bool) {
    let source = CGEventSource(stateID: .combinedSessionState)
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: source, virtualKey: 40, keyDown: down) else { continue }
      e.flags = option ? [.maskCommand, .maskAlternate] : [.maskCommand]
      e.setIntegerValueField(.eventSourceUserData, value: Shortcut.mark)
      e.post(tap: .cgSessionEventTap)
    }
  }
}
