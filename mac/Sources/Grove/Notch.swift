/*
  The panel that grows out of the notch.

  A borderless, transparent, non-activating panel sits over the notch at the
  largest size Grove ever draws, and the page inside (panel.html) draws only
  as much of it as the moment needs. While closed it ignores the mouse
  entirely, so the menu bar under it keeps working; the pointer reaching the
  notch is noticed by a global mouse monitor, which needs no permission.

  Non-activating matters: ⌘K is pressed in another app, and the highlighted
  text has to still be highlighted, in a window that is still in front, when
  Replace puts the new words there.
*/

import AppKit
import WebKit

/*
  A borderless panel can never become key unless it says it may, so the
  "Ask Grove anything" box could not be typed into. This one may — as a
  non-activating panel, like Spotlight, so the app underneath stays the one
  in front and the text ⌘K captured is still selected in it.
*/
final class KeyablePanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class Notch: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let width: CGFloat = 640
  static let height: CGFloat = 360

  let panel: KeyablePanel
  let web: WKWebView
  var onMessage: (([String: Any]) -> Void)?

  private var notchRect = NSRect.zero
  private var notchSize = CGSize(width: 190, height: 32)
  private var ready = false
  private var queue: [String] = []
  private var isOpen = false
  private var pinned = false
  /**
    Stays out while the Mac is doing something or waiting on an answer, even
    with the pointer elsewhere: having to go back to the notch to see whether
    a task finished is the thing it exists to save. Done, stopped or a new
    state ends it.
  */
  private var sticky = false
  private var visible: CGFloat = 0
  private var visibleWidth: CGFloat = 0
  private var closeTimer: Timer?
  private var leaveTimer: Timer?
  private var shrinkTimer: Timer?
  private var top: CGFloat = 0
  /** A pinned panel the pointer left: hidden, not finished, and shown again from the notch. */
  private var tucked = false
  /** Whether the pointer has been over this panel since it opened. Only then does leaving mean anything. */
  private var entered = false
  var isShowing: Bool { isOpen }
  private var look: Look

  init(look: Look) {
    self.look = look
    panel = KeyablePanel(
      contentRect: NSRect(x: 0, y: 0, width: Notch.width, height: Notch.height),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    let config = WKWebViewConfiguration()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: Notch.width, height: Notch.height), configuration: config)
    super.init()

    config.userContentController.add(self, name: "grove")
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self

    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.ignoresMouseEvents = true
    panel.isMovable = false
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = false
    panel.contentView = web

    place()
    panel.orderFrontRegardless()

    if let url = Bundle.module.url(forResource: "panel", withExtension: "html") {
      web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    NotificationCenter.default.addObserver(
      self, selector: #selector(place), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in self?.pointer() }
    NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in self?.pointer(); return event }
  }

  /** The screen with a notch, and the notch on it. A screen without one gets a notch-sized patch at the top. */
  @objc private func place() {
    let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? NSScreen.screens[0]
    let frame = screen.frame
    if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea, screen.safeAreaInsets.top > 0 {
      let w = frame.width - left.width - right.width
      notchSize = CGSize(width: w, height: screen.safeAreaInsets.top)
      notchRect = NSRect(x: frame.minX + left.width, y: frame.maxY - notchSize.height, width: w, height: notchSize.height)
    } else {
      notchSize = CGSize(width: 190, height: 32)
      notchRect = NSRect(x: frame.midX - 95, y: frame.maxY - 32, width: 190, height: 32)
    }
    top = frame.maxY
    fullFrame()
    js("grove.setup(\(json(["notchWidth": notchSize.width, "notchHeight": notchSize.height, "hardware": screen.safeAreaInsets.top > 0])))")
  }

  /*
    The window's size follows the panel's.

    A transparent window still takes clicks, so at full size an open panel
    swallowed clicks on whatever sat under its empty corners. Open, the window
    is exactly the panel; closed, it is full size again but ignores the mouse,
    so the next panel has room to grow into.
  */
  private func fullFrame() {
    panel.setFrame(NSRect(x: notchRect.midX - Notch.width / 2, y: top - Notch.height, width: Notch.width, height: Notch.height), display: true)
  }

  private func fit(width: CGFloat, height: CGFloat) {
    shrinkTimer?.invalidate()
    if width <= 0 || height <= 0 {
      // After the closing animation, so the panel is not clipped mid-shrink.
      shrinkTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
        guard let self, !self.isOpen else { return }
        self.fullFrame()
      }
      return
    }
    let w = min(width, Notch.width), h = min(height, Notch.height)
    panel.setFrame(NSRect(x: notchRect.midX - w / 2, y: top - h, width: w, height: h), display: true)
  }

  // MARK: opening and closing

  private func pointer() {
    let p = NSEvent.mouseLocation
    if !isOpen {
      // A little forgiveness below the notch, none at the sides: the menu
      // bar items either side are things people click on purpose.
      if notchRect.insetBy(dx: 0, dy: -6).contains(p) {
        if tucked { untuck() } else { show("idle", [:], pin: false) }
      }
      return
    }
    // No size reported yet means the panel is still growing: never treat
    // that as the pointer having left, or it closes as it opens.
    guard visible > 0, visibleWidth > 0 else { return }
    let shown = NSRect(x: notchRect.midX - visibleWidth / 2, y: top - visible, width: visibleWidth, height: visible)
    if shown.insetBy(dx: -4, dy: -4).contains(p) {
      entered = true
      leaveTimer?.invalidate()
      leaveTimer = nil
    } else if entered, leaveTimer == nil, !sticky {
      // Short: the panel should feel like it follows the pointer, not like
      // it is deciding whether to.
      let wasPinned = pinned
      leaveTimer = Timer.scheduledTimer(withTimeInterval: wasPinned ? 0.35 : 0.1, repeats: false) { [weak self] _ in
        guard let self else { return }
        self.leaveTimer = nil
        if wasPinned { self.tuck() } else { self.close() }
      }
    }
  }

  /** `thenHome`: when the time is up, go back to the notch's own page rather than closing. */
  func show(_ mode: String, _ data: [String: Any], pin: Bool, closeAfter: TimeInterval? = nil, thenHome: Bool = false) {
    tucked = false
    // Opened from the notch, the pointer is already on it.
    entered = notchRect.insetBy(dx: 0, dy: -6).contains(NSEvent.mouseLocation)
    closeTimer?.invalidate()
    leaveTimer?.invalidate()
    leaveTimer = nil
    shrinkTimer?.invalidate()
    if !isOpen { Log.say("notch: open (\(mode))") }
    isOpen = true
    pinned = pin
    sticky = mode == "job" || mode == "waiting"
    panel.ignoresMouseEvents = false
    var payload = data
    payload["mode"] = mode
    js("grove.show(\(json(payload)))")
    if let closeAfter {
      closeTimer = Timer.scheduledTimer(withTimeInterval: closeAfter, repeats: false) { [weak self] _ in
        guard let self else { return }
        if thenHome { self.show("idle", [:], pin: false); return }
        // Stay open while the pointer is over it; it goes when the pointer does,
        // and straight away if the pointer never came near it.
        self.pinned = false
        if self.entered { self.pointer() } else { self.close() }
      }
    }
  }

  /** Out of the way, with what it was showing kept for when the pointer comes back. */
  private func tuck() {
    tucked = true
    isOpen = false
    panel.ignoresMouseEvents = true
    js("grove.tuck()")
  }

  private func untuck() {
    tucked = false
    isOpen = true
    panel.ignoresMouseEvents = false
    js("grove.untuck()")
  }

  /** Keep it open while something is under way in it — dictation, a question. */
  func hold() {
    pinned = true
    closeTimer?.invalidate()
  }

  func send(_ event: String, _ data: [String: Any]) {
    js("grove.event(\(json(["event": event, "data": data])))")
  }

  func close() {
    tucked = false
    if panel.isKeyWindow { panel.resignKey() }
    closeTimer?.invalidate()
    leaveTimer?.invalidate()
    leaveTimer = nil
    visible = 0
    visibleWidth = 0
    isOpen = false
    pinned = false
    panel.ignoresMouseEvents = true
    js("grove.close()")
  }

  func setLook(_ look: Look) {
    self.look = look
    js("grove.look(\(json(look.json)))")
  }

  func setPhone(_ connected: Bool) {
    js("grove.phone(\(connected ? "true" : "false"))")
  }

  func setSuggestions(_ list: [Suggestion]) {
    js("grove.suggestions(\(json(list.map(\.json))))")
  }

  func setAccount(_ signedIn: Bool) {
    js("grove.account(\(signedIn ? "true" : "false"))")
  }

  // MARK: the page

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    if body["t"] as? String == "size" {
      visible = CGFloat((body["h"] as? Double) ?? 0)
      visibleWidth = CGFloat((body["w"] as? Double) ?? 0)
      fit(width: visibleWidth, height: visible)
      return
    }
    if body["t"] as? String == "focus" {
      // Typing into the panel needs it to take the keyboard, just for that.
      panel.makeKey()
      return
    }
    onMessage?(body)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    NSLog("grove: panel loaded")
    ready = true
    place()
    js("grove.look(\(json(look.json)))")
    queue.forEach { web.evaluateJavaScript($0) }
    queue.removeAll()
  }

  private func js(_ script: String) {
    guard ready else { queue.append(script); return }
    web.evaluateJavaScript(script)
  }

  private func json(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let s = String(data: data, encoding: .utf8) else { return "{}" }
    return s
  }
}
