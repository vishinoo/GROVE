/*
  The Grove window: what opening Grove from Finder shows.

  Grove is always running — it lives in the notch and the menu bar — so
  opening it again from Applications, Spotlight or the Dock folder used to do
  nothing visible at all, which reads as the app being broken. Now it toggles
  this window: open it, and it appears; open it again while it is in front,
  and it goes away.

  This is the deliberate half of Grove's settings. The notch's own ⋯ is for
  quick switches somebody reaches for mid-task; this is where modes are made,
  which takes a minute and a window you can sit in. Drawn in HTML
  (home.html) in the phone's Settings style, in the phone's colours.
*/

import AppKit
import WebKit

@MainActor
final class Home: NSObject, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
  private var window: NSWindow?
  private var web: WKWebView?
  private var ready = false
  private let look: Look
  /** Said aloud or shown in the notch when a mode starts or ends from here. */
  var onDone: ((String) -> Void)?

  init(look: Look) {
    self.look = look
    super.init()
    Modes.onChange = { [weak self] in self?.push() }
  }

  /** Opened from Finder: show it, or put it away if it is already what they are looking at. */
  func toggle() {
    if let window, window.isVisible, window.isKeyWindow, NSApp.isActive {
      window.orderOut(nil)
      return
    }
    show()
  }

  /**
    Built before it is wanted, so the first click is not the slow one.

    `show()` built the window, loaded the page and compiled the field's
    shader all at once, which is most of a second with nothing on screen —
    and the first click of a session is the one somebody is most likely to
    think did not register, so they click again. Everything after it was
    instant, which made it look like a flaky app rather than a slow start.

    Built hidden at launch instead: by the time anybody opens it, the page
    has loaded and the shader is warm.
  */
  func warm() {
    if window == nil { build() }
  }

  func show() {
    if window == nil { build() }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
    push()
  }

  /** The phone's colours changed. */
  func setLook() { push() }

  /** The same four as the phone (field-shader.ts) and as home.html lists. */
  static let colours: [(key: String, label: String, stops: [String])] = [
    ("tide", "Tide", ["#061C26", "#1F7A8C", "#C9EDE6", "#E3B868"]),
    ("ember", "Ember", ["#2A0C07", "#C9431C", "#FBD29A", "#8E2A4A"]),
    ("moss", "Moss", ["#0B1710", "#2E6A45", "#DCE6B8", "#A8873A"]),
    ("aurora", "Aurora", ["#060A1E", "#22B394", "#D2F3E6", "#7B4FD4"]),
  ]

  /** Set once by main.swift: paint everything here, and tell the phone. */
  var onColour: ((String, String, [String]) -> Void)?

  private func build() {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "grove")
    let frame = NSRect(x: 0, y: 0, width: 760, height: 820)
    let web = WKWebView(frame: frame, configuration: config)
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self

    let window = NSWindow(
      contentRect: frame,
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Grove"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    window.minSize = NSSize(width: 560, height: 520)
    window.backgroundColor = NSColor(calibratedRed: 0.04, green: 0.06, blue: 0.08, alpha: 1)
    window.appearance = NSAppearance(named: .darkAqua)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("GroveHome")

    if let url = Bundle.module.url(forResource: "home", withExtension: "html") {
      web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }
    self.window = window
    self.web = web
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    ready = true
    push()
  }

  /** Everything the page draws, in one message. */
  private func push() {
    guard ready, web != nil else { return }
    let modes = Modes.all.map { m -> [String: Any] in
      [
        "id": m.id, "name": m.name, "tuck": m.tuck, "quitApps": m.quitApps,
        "running": Modes.isRunning(m.id),
        "steps": m.steps.map { ["kind": $0.kind, "value": $0.value] },
      ]
    }
    send("state", ["modes": modes, "look": look.json])
  }

  private func send(_ type: String, _ data: [String: Any]) {
    guard let web, let json = try? JSONSerialization.data(withJSONObject: ["t": type, "d": data]),
          let text = String(data: json, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.grove && window.grove(\(text))")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["t"] as? String else { return }
    switch type {
    case "save":
      guard let raw = body["modes"] as? [[String: Any]] else { return }
      Modes.save(raw.map { m in
        Mode(
          id: m["id"] as? String ?? UUID().uuidString,
          name: m["name"] as? String ?? "",
          steps: ((m["steps"] as? [[String: Any]]) ?? []).map { ModeStep(kind: $0["kind"] as? String ?? "site", value: $0["value"] as? String ?? "") },
          tuck: m["tuck"] as? Bool ?? true,
          quitApps: m["quitApps"] as? Bool ?? true
        )
      })
    case "start", "stop":
      guard let id = body["id"] as? String, let mode = Modes.all.first(where: { $0.id == id }) else { return }
      Task { @MainActor in
        let said = type == "start" ? await Modes.start(mode) : await Modes.stop(mode)
        self.send("said", ["id": id, "text": said])
        self.onDone?(said)
      }
    case "tabs":
      Task { @MainActor in self.send("tabs", ["id": body["id"] as? String ?? "", "urls": await Modes.frontTabs()]) }
    case "apps":
      send("apps", ["names": Modes.appNames()])
    case "colour":
      /*
        Changed here, and the phone follows.

        It has only ever gone the other way: the phone sends its colour and
        the Mac paints itself with it. But the Mac is where somebody sits
        with a keyboard, and a settings window you can look at but not change
        is a worse thing than no settings window.

        Applied locally first so the notch and this window recolour as they
        press, rather than when the phone gets round to answering — and the
        same if the phone is not connected at all.
      */
      guard let key = body["key"] as? String,
            let picked = Home.colours.first(where: { $0.key == key }) else { return }
      Log.say("look: colour changed to \(key) on the Mac")
      onColour?(key, picked.label, picked.stops)
    case "close":
      window?.orderOut(nil)
    default:
      break
    }
  }
}
