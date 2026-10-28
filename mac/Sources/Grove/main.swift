/*
  Grove for Mac.

  Two jobs in one small app. It is the phone's hands: Grove on the iPhone stays
  the brain — memory, accounts, voice, the decision about what to do — and when
  a job needs a computer it hands it here over the local network (Link.swift).
  And it is a quicker Grove at the keyboard: it lives in the notch, opens when
  the pointer reaches it, and ⌘K on highlighted text in any app hands that text
  to Grove with a spoken instruction (Shortcut.swift, Selection.swift).

  It never appears in the Dock (LSUIElement). The menu bar icon is for pairing,
  the shortcut, permissions and quitting.
*/

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  let look = Look.load()
  var notch: Notch!
  var link: Link!
  var shortcut: Shortcut!
  var voice = Voice()
  var status: NSStatusItem!

  /** What ⌘K captured, held until the answer comes back. */
  var captured: Captured?

  func applicationDidFinishLaunching(_ notification: Notification) {
    notch = Notch(look: look)
    link = Link()
    shortcut = Shortcut()

    notch.onMessage = { [weak self] message in self?.fromPanel(message) }

    link.onLook = { [weak self] incoming in
      guard let self else { return }
      let changedColour = incoming.colour != self.look.colour
      self.look.apply(incoming)
      self.notch.setLook(self.look)
      if changedColour { self.notch.show("synced", ["label": self.look.colourLabel], pin: false, closeAfter: 2.2) }
      self.refreshMenu()
    }
    link.onStatus = { [weak self] _ in
      guard let self else { return }
      self.notch.setPhone(self.link.connected)
      self.refreshMenu()
    }
    link.onJob = { [weak self] job, reply in self?.run(job, reply: reply) }
    link.start()

    shortcut.useOption = UserDefaults.standard.bool(forKey: "grove.shortcut.option")
    shortcut.onTrigger = { [weak self] captured in self?.begin(captured) }
    shortcut.start()

    makeMenu()

    // `open Grove.app --args --peek` opens the panel once at launch, to check it draws.
    if CommandLine.arguments.contains("--peek") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.notch.show("idle", [:], pin: true) }
    }
  }

  // MARK: ⌘K

  private func begin(_ captured: Captured) {
    self.captured = captured
    notch.show("listening", ["text": captured.text], pin: true)
    voice.listen(
      partial: { [weak self] words in self?.notch.send("heard", ["words": words]) },
      done: { [weak self] said in
        guard let self else { return }
        if let said, !said.isEmpty { self.think(said) } else { self.notch.send("choose", [:]) }
      }
    )
  }

  private func think(_ instruction: String) {
    guard let captured else { return }
    voice.stop()
    notch.show("thinking", ["text": captured.text, "ask": instruction], pin: true)
    Task { @MainActor in
      let reply = await Thinking.run(instruction: instruction, text: captured.text, link: link, manner: look.manner)
      guard let reply else {
        notch.show("answer", ["ask": instruction, "text": "I couldn't reach anything to think with. Check your phone or your connection and try again.", "failed": true], pin: true)
        return
      }
      notch.show(reply.kind == .rewrite ? "rewrite" : "answer", ["ask": instruction, "text": reply.text, "via": reply.via], pin: true)
      self.captured?.result = reply.text
    }
  }

  private func fromPanel(_ message: [String: Any]) {
    switch message["t"] as? String {
    case "ask":
      if let text = message["instruction"] as? String { think(text) }
    case "replace":
      if let captured, let result = captured.result {
        notch.close()
        Selection.replace(captured, with: result)
        self.captured = nil
      }
    case "copy":
      if let text = message["text"] as? String {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
      }
    case "close":
      voice.stop()
      captured = nil
      notch.close()
    case "music":
      let action = (message["action"] as? String) ?? "play"
      run(Job(id: UUID().uuidString, kind: "music.\(action)", args: [:], fromPhone: false)) { _, _ in }
    default:
      break
    }
  }

  // MARK: jobs from the phone

  private func run(_ job: Job, reply: @escaping (Bool, String) -> Void) {
    let title = Jobs.title(for: job)
    if job.fromPhone { notch.show("job", ["title": title, "from": "From your iPhone", "steps": Jobs.steps(for: job), "at": 0], pin: true) }
    Jobs.run(job) { [weak self] ok, spoken in
      guard let self else { return }
      if job.fromPhone || job.kind.hasPrefix("music.") {
        self.notch.show("done", ["title": title, "text": spoken, "ok": ok], pin: false, closeAfter: 2.8)
      }
      reply(ok, spoken)
    }
  }

  // MARK: menu

  private func makeMenu() {
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = status.button {
      button.image = NSImage(systemSymbolName: "circle.hexagongrid", accessibilityDescription: "Grove")
    }
    refreshMenu()
  }

  private func refreshMenu() {
    guard let status else { return }
    let menu = NSMenu()
    let phone = NSMenuItem(title: link.connected ? "iPhone connected" : "iPhone not connected", action: nil, keyEquivalent: "")
    phone.isEnabled = false
    menu.addItem(phone)
    menu.addItem(NSMenuItem(title: "Pair an iPhone…", action: #selector(pair), keyEquivalent: ""))
    menu.addItem(.separator())
    let k = NSMenuItem(title: "Shortcut: ⌘K", action: #selector(useCommandK), keyEquivalent: "")
    k.state = shortcut.useOption ? .off : .on
    menu.addItem(k)
    let ok = NSMenuItem(title: "Shortcut: ⌥⌘K", action: #selector(useOptionCommandK), keyEquivalent: "")
    ok.state = shortcut.useOption ? .on : .off
    menu.addItem(ok)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Accessibility settings…", action: #selector(openAccessibility), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Quit Grove", action: #selector(quit), keyEquivalent: "q"))
    menu.items.forEach { $0.target = self }
    status.menu = menu
  }

  @objc private func pair() {
    let code = link.newPairingCode()
    notch.show("pair", ["host": Link.hostName, "code": code], pin: true)
  }
  @objc private func useCommandK() { setShortcut(option: false) }
  @objc private func useOptionCommandK() { setShortcut(option: true) }
  private func setShortcut(option: Bool) {
    shortcut.useOption = option
    UserDefaults.standard.set(option, forKey: "grove.shortcut.option")
    refreshMenu()
  }
  @objc private func openAccessibility() {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
  }
  @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
