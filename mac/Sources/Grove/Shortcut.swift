/*
  ⌘K: on highlighted text, and otherwise to open Grove.

  macOS itself does not use ⌘K, but a great many apps do — insert link in
  Notes, Pages, Docs and Mail, the quick switcher in Slack and Notion, clear
  in Terminal — so Grove does not register a hotkey, which would take ⌘K away
  from every app. It watches key presses with an event tap and decides each
  one. ⌥⌘K is offered for anyone who would rather Grove never shared, and it
  is never shared: no app uses it.

  **With text highlighted it is Grove's, and with nothing highlighted it is
  Grove's too, except in the few apps that would really miss it.** That
  second half is new. The rule used to be "only when something is
  highlighted", which is a good rule for not taking somebody's shortcut and a
  bad one for being summoned: the whole point of a key is that it works when
  you have nothing in particular to say, and the way to reach Grove with
  nothing selected was to go and find the notch with a mouse.

  The old reasoning was not wrong, it was incomplete. It measured the cost of
  taking ⌘K and never measured the cost of not having a key at all. What it
  got right is that the cost is not the same in every app, so the answer is
  not the same in every app either: `shared` is the short list where the
  app's own ⌘K is worth more than a shortcut to Grove — an editor's chord
  prefix, a terminal's clear, a quick switcher — and everywhere else the
  press opens Grove with its microphone already on.

  A list is the honest shape for this, rather than a cleverer test. There is
  no way to ask an app whether it uses a key: AppKit will not say, and
  guessing from whether the press appeared to do anything means doing it
  first and looking afterwards, which is the one thing a shortcut cannot do.

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
  /** ⌘K with nothing highlighted, in an app that is not on the shared list. */
  var onSummon: (() -> Void)?
  var onReady: (() -> Void)?
  /** Esc while Grove's panel is up: returns true if it closed something. */
  var onEscape: (() -> Bool)?
  /**
    A yes from the keyboard: ⌘K then Return. The two keys are the point. ⌘K says
    "show me what you are waiting on", and only then does Return mean yes, for
    eight seconds, with what it approves on screen. A Return on its own is
    somebody typing, and must never send anything.
  */
  var waitingForYes: (() -> Bool)?
  var onArm: ((Bool) -> Void)?
  var onAnswer: ((Bool) -> Void)?
  private var armedUntil = Date.distantPast
  private var tap: CFMachPort?
  var ready: Bool { tap != nil }

  /** Marks the ⌘K this tap sends on itself, so it is not caught twice. */
  static let mark: Int64 = 0x6772_6F76

  /**
    Apps whose own ⌘K is worth more than a shortcut to Grove.

    Four of the five are a keystroke people use many times an hour and would
    notice losing within a minute: a chord prefix in the two editors (⌘K ⌘S
    and the rest of them), clear in a terminal, the quick switcher in Slack.
    They are matched on the app's own name, loosely, so "Visual Studio Code"
    and "Code" are the same thing and a beta or a fork with a suffix is still
    caught.

    Editable, because this is a judgement about how somebody works and
    nobody here can make it for them. The default is the small end on
    purpose: a shortcut that quietly does nothing in half their apps is
    worse than one that takes something back, because the second is visible
    and the first reads as Grove being broken.
  */
  static let sharedByDefault = ["Code", "Cursor", "Xcode", "Terminal", "iTerm", "Slack"]
  static var shared: [String] {
    get {
      let saved = UserDefaults.standard.string(forKey: "grove.shortcut.shared")
      guard let saved else { return sharedByDefault }
      return saved.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    set { UserDefaults.standard.set(newValue.joined(separator: ", "), forKey: "grove.shortcut.shared") }
  }

  /**
    Whether this press belongs to the app in front rather than to Grove.

    ⌥⌘K is never shared — that is what choosing it means — and a name that
    contains one of the listed ones counts, so "Visual Studio Code - Insiders"
    does not quietly lose its chords.
  */
  static func sharesK(with app: String?, option: Bool) -> Bool {
    guard !option, let app, !app.isEmpty else { return false }
    let name = app.lowercased()
    /*
      A listed name matches where a word of the app's name begins with it,
      never anywhere inside one.

      Plain containment was the first version and it was wrong in both
      directions at once. "Code" — which is what VS Code actually calls
      itself, whatever its folder is named — appears inside **Xcode**, so a
      list meant to protect an editor's chords silently took the key away
      from a different editor by accident rather than by anybody's decision.
      Meanwhile a strict word match would have missed "iTerm2", which is one
      word and is obviously iTerm.

      Beginning a word is the rule that gets both: iTerm2 and "Visual Studio
      Code - Insiders" match, Xcode does not, and what the list does can be
      worked out by reading it.
    */
    return shared.contains { entry in
      let want = entry.lowercased()
      guard !want.isEmpty else { return false }
      return name.split { !$0.isLetter && !$0.isNumber }.contains { $0.hasPrefix(want) }
    }
  }

  func start() {
    // The asking is Permissions.swift's job. This waits for the answer, so
    // switching Grove on in System Settings starts ⌘K without a relaunch.
    if AXIsProcessTrusted() { install(); return }
    Log.say("⌘K: waiting for Accessibility")
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] timer in
      if AXIsProcessTrusted() { timer.invalidate(); self?.install() }
    }
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
    ) else {
      Log.say("⌘K: macOS refused the key watcher; Accessibility may be granted to an older copy of Grove")
      return
    }
    self.tap = tap
    Log.say("⌘K: ready")
    DispatchQueue.main.async { [weak self] in self?.onReady?() }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  }

  private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      Log.say("⌘K: watcher was paused by macOS, turning it back on")
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown else { return Unmanaged.passUnretained(event) }
    if event.getIntegerValueField(.eventSourceUserData) == Shortcut.mark { return Unmanaged.passUnretained(event) }

    if armedUntil != .distantPast {
      let live = Date() < armedUntil
      armedUntil = .distantPast
      let code = event.getIntegerValueField(.keyboardEventKeycode)
      if live, code == 36 || code == 76 {
        DispatchQueue.main.async { [weak self] in self?.onAnswer?(true) }
        return nil
      }
      if live, code == 53 {
        DispatchQueue.main.async { [weak self] in self?.onAnswer?(false) }
        return nil
      }
      DispatchQueue.main.async { [weak self] in self?.onArm?(false) }
    }

    if event.getIntegerValueField(.keyboardEventKeycode) == 53, event.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift]).isEmpty,
       onEscape?() == true {
      return nil
    }

    let k: Int64 = 40 // kVK_ANSI_K
    guard event.getIntegerValueField(.keyboardEventKeycode) == k else { return Unmanaged.passUnretained(event) }
    let flags = event.flags
    let command = flags.contains(.maskCommand)
    let option = flags.contains(.maskAlternate)
    let others = flags.contains(.maskShift) || flags.contains(.maskControl)
    guard command, !others, option == useOption else { return Unmanaged.passUnretained(event) }

    if waitingForYes?() == true {
      armedUntil = Date().addingTimeInterval(8)
      DispatchQueue.main.async { [weak self] in self?.onArm?(true) }
      Log.say("⌘K: armed for a yes")
      return nil
    }

    let front = NSWorkspace.shared.frontmostApplication?.localizedName
    let read = Selection.read()
    Log.say("⌘K: pressed in \(front ?? "?"), selection \(read.summary)\(Shortcut.sharesK(with: front, option: useOption) ? " — this app keeps ⌘K" : "")")
    switch read {
    case .text(let captured):
      DispatchQueue.main.async { [weak self] in self?.onTrigger?(captured) }
      return nil
    case .none:
      // Nothing highlighted: Grove, unless this app would miss its own ⌘K.
      if Shortcut.sharesK(with: front, option: useOption) { return Unmanaged.passUnretained(event) }
      DispatchQueue.main.async { [weak self] in self?.onSummon?() }
      return nil
    case .unknown(let app):
      // Held: try a copy, and decide on what came back. An app that does not
      // say (Chrome, anything Electron) is not a reason to do nothing — it
      // gets the same answer an app that said "nothing" would get.
      let option = useOption
      let mine = !Shortcut.sharesK(with: front, option: option)
      Selection.copyFallback(app: app) { [weak self] captured in
        if let captured { self?.onTrigger?(captured) }
        else if mine { self?.onSummon?() }
        else { Shortcut.resend(option: option) }
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
