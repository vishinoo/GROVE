/*
  Grove for Mac.

  Two jobs in one small app. It is the phone's hands: Grove on the iPhone stays
  the brain — memory, accounts, voice, the decision about what to do — and when
  a job needs a computer it hands it here, over a private channel on the
  person's Noctus account (Link.swift). And it is a quicker Grove at the
  keyboard: it lives in the notch, opens when the pointer reaches it, and ⌘K
  on highlighted text in any app hands that text to Grove with a spoken
  instruction (Shortcut.swift, Selection.swift).

  It never appears in the Dock (LSUIElement). The menu bar icon is for signing
  in, the permissions, the shortcut and quitting.
*/

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  let look = Look.load()
  let account = Account()
  var notch: Notch!
  var link: Link!
  var shortcut: Shortcut!
  var voice = Voice()
  let agent = Agent.shared
  var status: NSStatusItem!

  /** What ⌘K captured, held until the answer comes back. */
  var captured: Captured?

  func applicationWillFinishLaunching(_ notification: Notification) {
    // grove-mac://auth-callback, from the browser after Google.
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(openURL(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    Log.trim()
    Log.say("launch: accessibility \(AXIsProcessTrusted() ? "granted" : "not granted"), signed in \(account.session != nil)")

    notch = Notch(look: look)
    link = Link(account: account)
    shortcut = Shortcut()

    notch.onMessage = { [weak self] message in self?.fromPanel(message) }

    link.onLook = { [weak self] incoming in
      guard let self else { return }
      let changedColour = incoming.colour != nil && incoming.colour != self.look.colour
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
    link.onPaired = { [weak self] in self?.notch.show("done", ["title": "iPhone connected", "text": "Your phone and this Mac are one Grove now.", "ok": true], pin: false, closeAfter: 3) }
    account.onChange = { [weak self] session in
      guard let self else { return }
      self.notch.setAccount(session != nil)
      if session != nil { self.link.start() } else { self.link.stop() }
      self.refreshMenu()
    }
    notch.setAccount(account.session != nil)
    if account.session != nil { link.start() }

    shortcut.useOption = UserDefaults.standard.bool(forKey: "grove.shortcut.option")
    shortcut.onTrigger = { [weak self] captured in self?.begin(captured) }
    shortcut.onReady = { [weak self] in self?.refreshMenu() }
    shortcut.onEscape = { [weak self] in
      guard let self, self.notch.isShowing else { return false }
      self.voice.stop()
      self.captured = nil
      self.notch.close()
      return true
    }
    notch.setSuggestions(Suggestions.all())
    Suggestions.refresh { [weak self] in self?.notch.setSuggestions(Suggestions.all()) }
    shortcut.start()

    makeMenu()

    // The first launch asks for everything at once, in order, rather than one
    // prompt at a time at odd moments later.
    if !UserDefaults.standard.bool(forKey: "grove.asked.permissions") {
      UserDefaults.standard.set(true, forKey: "grove.asked.permissions")
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { Permission.requestAll { [weak self] in self?.refreshMenu() } }
    }

    // `open Grove.app --args --pair` starts a pairing and logs the code, to test the hand-off.
    if CommandLine.arguments.contains("--pair") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 4) { Log.say("test: pairing code \(self.link.startPairing() ?? "none")") }
    }

    // `open Grove.app --args --agent "goal"` runs a browser goal at launch, to test Agent.swift without the phone.
    if let i = CommandLine.arguments.firstIndex(of: "--agent"), i + 1 < CommandLine.arguments.count {
      let goal = CommandLine.arguments[i + 1]
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        self.run(Job(id: "test", kind: "agent.start", args: ["goal": goal], fromPhone: false)) { _, spoken, extra in
          Log.say("test: agent \(extra["state"] ?? "") — \(spoken)")
        }
      }
    }

    // `open Grove.app --args --peek` opens the panel once at launch, to check it draws.
    if CommandLine.arguments.contains("--peek") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.notch.show("idle", [:], pin: true) }
    }
  }

  func applicationDidBecomeActive(_ notification: Notification) { refreshMenu() }

  @objc private func openURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: text) else { return }
    if url.scheme == "grove-mac" { account.handle(url) }
  }

  // MARK: ⌘K

  private func begin(_ captured: Captured) {
    Log.say("⌘K: \(captured.text.count) characters from \(captured.app?.localizedName ?? "an app")")
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

  /**
    A question from the notch with nothing highlighted. What was last copied
    stands in for a selection when the question is about "this" or "what I
    copied" — the commonest reason to ask from the notch at all.
  */
  private func askFree(_ instruction: String) {
    // A command is done, not discussed: the model cannot press play, and
    // asked to, it says so politely, which is the worst answer there is.
    if let job = Commands.job(for: instruction) {
      notch.close()
      run(job) { _, _, _ in }
      return
    }
    let clip = NSPasteboard.general.string(forType: .string) ?? ""
    let aboutClip = instruction.lowercased().contains("copied") || instruction.lowercased().contains("this")
    if aboutClip {
      captured = Captured(text: clip, app: nil, element: nil, viaClipboard: true)
      think(instruction)
      return
    }
    // Not about anything highlighted: answer it, or go and do it in Chrome.
    notch.show("thinking", ["text": "", "ask": instruction], pin: true)
    Task { @MainActor in
      switch await Thinking.decide(instruction, manner: self.look.manner) {
      case .act(let goal):
        self.runAgent(Job(id: UUID().uuidString, kind: "agent.start", args: ["goal": goal], fromPhone: false)) { _, _, _ in }
      case .answer(let text):
        self.notch.show("answer", ["ask": instruction, "text": text, "via": "mac"], pin: true)
      case nil:
        self.notch.show("answer", ["ask": instruction, "text": "I couldn't reach anything to think with. Check your connection and try again.", "failed": true], pin: true)
      }
    }
  }

  /** The mic beside the ask box: what is said fills the box, and is sent when they stop. */
  private func dictate() {
    notch.hold()
    voice.listen(
      partial: { [weak self] words in self?.notch.send("dictate", ["words": words]) },
      done: { [weak self] said in self?.notch.send("dictate", ["words": said ?? "", "final": true]) }
    )
  }

  private func fromPanel(_ message: [String: Any]) {
    switch message["t"] as? String {
    case "ask":
      guard let text = message["instruction"] as? String else { break }
      if captured != nil { think(text) } else { askFree(text) }
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
    case "run":
      let kind = (message["kind"] as? String) ?? ""
      let args = (message["args"] as? [String: Any] ?? [:]).compactMapValues { "\($0)" }
      run(Job(id: UUID().uuidString, kind: kind, args: args, fromPhone: false)) { _, _, _ in }
    case "music":
      let action = (message["action"] as? String) ?? "play"
      run(Job(id: UUID().uuidString, kind: "music.\(action)", args: [:], fromPhone: false)) { _, _, _ in }
    case "pair":
      connectPhone()
    case "settings":
      showSettings()
    case "back":
      notch.show("idle", [:], pin: false)
    case "mic":
      dictate()
    case "stop":
      run(Job(id: UUID().uuidString, kind: "agent.stop", args: [:], fromPhone: false)) { _, _, _ in }
    case "answer", "approve", "decline":
      voice.stop()
      let kind = message["t"] as? String ?? ""
      let answer = kind == "decline" ? "No, don't press that. Stop and ask me what to change." : (message["text"] as? String ?? "")
      runAgent(Job(id: UUID().uuidString, kind: "agent.resume",
                   args: ["task": message["task"] as? String ?? "", "answer": answer, "approve": kind == "approve" ? "yes" : ""],
                   fromPhone: false)) { _, _, _ in }
    case "signout":
      account.signOut()
      showSettings()
    case "shortcut":
      setShortcut(option: (message["option"] as? Bool) ?? false)
      showSettings()
    case "permissions":
      Permission.requestAll { [weak self] in self?.showSettings() }
    case "signin":
      account.signIn()
    case "log":
      Log.say("panel: \(message["text"] ?? "")")
    default:
      break
    }
  }

  // MARK: jobs from the phone

  private func run(_ job: Job, reply: @escaping (Bool, String, [String: String]) -> Void) {
    if job.kind == "agent.stop" {
      agent.stop()
      notch.show("done", ["title": "Stopped", "text": "Left it where it was.", "ok": true], pin: false, closeAfter: 2.5)
      reply(true, "Stopped.", ["state": "stopped"])
      return
    }
    if job.kind.hasPrefix("agent.") { runAgent(job, reply: reply); return }
    let title = Jobs.title(for: job)
    if job.fromPhone { notch.show("job", ["title": title, "from": "From your iPhone", "steps": Jobs.steps(for: job), "at": 0], pin: true) }
    Jobs.run(job) { [weak self] ok, spoken in
      guard let self else { return }
      if job.fromPhone || job.kind.hasPrefix("music.") || job.kind.hasPrefix("open.") {
        self.notch.show("done", ["title": title, "text": spoken, "ok": ok], pin: false, closeAfter: 2.8)
      }
      reply(ok, spoken, [:])
    }
  }

  /** A goal for the browser (Agent.swift). Shown in the notch as it goes; questions go back to the phone. */
  private func runAgent(_ job: Job, reply: @escaping (Bool, String, [String: String]) -> Void) {
    let goal = job.args["goal"] ?? ""
    let from = job.fromPhone ? "From your iPhone" : "On this Mac"
    agent.onStep = { [weak self] goal, steps in
      self?.notch.show("job", ["title": goal, "from": from, "steps": steps, "at": max(0, steps.count - 1)], pin: true)
    }
    notch.show("job", ["title": goal.isEmpty ? "Carrying on" : goal, "from": from, "steps": [job.kind == "agent.start" ? "Opening Chrome" : "Carrying on"], "at": 0], pin: true)
    Task { @MainActor in
      let result = job.kind == "agent.start"
        ? await self.agent.start(goal: goal)
        : await self.agent.resume(task: job.args["task"] ?? "", answer: job.args["answer"] ?? "", approve: job.args["approve"] == "yes")
      switch result.state {
      case "ask" where !job.fromPhone, "confirm" where !job.fromPhone:
        // Asked here, answered here: a box for the answer, or the two buttons for a yes.
        self.notch.show("waiting", ["text": result.spoken, "task": result.task, "confirm": result.state == "confirm"], pin: true)
      case "ask", "confirm":
        self.notch.show("done", ["title": result.state == "confirm" ? "Waiting for your yes" : "A question", "text": result.spoken, "ok": true], pin: false, closeAfter: 6)
      case "stopped":
        break  // the Stop already said so
      default:
        self.notch.show("done", ["title": "Done", "text": result.spoken, "ok": result.state == "done"], pin: false, closeAfter: 4)
      }
      reply(result.state != "failed", result.spoken, ["state": result.state, "task": result.task, "detail": result.detail])
    }
  }

  // MARK: menu

  private func makeMenu() {
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = status.button {
      // The g, as a template so the menu bar tints it for light and dark.
      if let url = Bundle.module.url(forResource: "menubar", withExtension: "png"), let image = NSImage(contentsOf: url) {
        image.isTemplate = true
        image.size = NSSize(width: 15, height: 18)
        button.image = image
      } else {
        button.title = "g"
      }
    }
    refreshMenu()
  }

  private func refreshMenu() {
    guard let status, let link, let shortcut else { return }
    let menu = NSMenu()

    if let session = account.session {
      menu.addItem(disabled("Signed in as \(session.email.isEmpty ? "your Noctus account" : session.email)"))
      menu.addItem(disabled(link.connected ? "iPhone connected" : "iPhone not connected yet"))
      if !link.connected { menu.addItem(item("Connect iPhone…", #selector(connectPhone))) }
      menu.addItem(item("Sign out", #selector(signOut)))
    } else {
      menu.addItem(item("Sign in with Google (Noctus)…", #selector(signIn)))
    }

    menu.addItem(.separator())
    menu.addItem(disabled("Permissions"))
    for p in Permission.allCases {
      let row = NSMenuItem(title: p.title, action: #selector(askPermission(_:)), keyEquivalent: "")
      row.representedObject = p.title
      row.state = p.granted == true ? .on : .off
      row.indentationLevel = 1
      menu.addItem(row)
    }
    menu.addItem(item("Ask for all of them again", #selector(askAll)))

    menu.addItem(.separator())
    menu.addItem(disabled(shortcut.ready ? "⌘K is ready" : "⌘K needs Accessibility"))
    let k = item("Shortcut: ⌘K", #selector(useCommandK))
    k.state = shortcut.useOption ? .off : .on
    menu.addItem(k)
    let ok = item("Shortcut: ⌥⌘K", #selector(useOptionCommandK))
    ok.state = shortcut.useOption ? .on : .off
    menu.addItem(ok)

    menu.addItem(.separator())
    menu.addItem(item("Show the log", #selector(showLog)))
    menu.addItem(item("Quit Grove", #selector(quit), key: "q"))
    status.menu = menu
  }

  private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.target = self
    return i
  }

  private func disabled(_ title: String) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    i.isEnabled = false
    return i
  }

  @objc private func signIn() { account.signIn() }
  /** The notch's own settings, from the ⋯ opposite the close button. */
  private func showSettings() {
    let missing = Permission.allCases.filter { $0.granted != true }.map(\.title)
    notch.show("settings", [
      "email": account.session?.email ?? "",
      "signedIn": account.session != nil,
      "phone": link.connected,
      "option": shortcut.useOption,
      "missing": missing,
    ], pin: true)
  }

  @objc private func connectPhone() {
    guard let code = link.startPairing() else {
      notch.show("answer", ["ask": "Connect iPhone", "text": "Still connecting to Noctus. Try again in a moment.", "failed": true], pin: true)
      return
    }
    notch.show("pair", ["code": code], pin: true)
  }
  @objc private func signOut() { account.signOut() }
  @objc private func askPermission(_ sender: NSMenuItem) {
    guard let title = sender.representedObject as? String, let p = Permission.allCases.first(where: { $0.title == title }) else { return }
    p.request { [weak self] in self?.refreshMenu() }
  }
  @objc private func askAll() { Permission.requestAll { [weak self] in self?.refreshMenu() } }
  @objc private func useCommandK() { setShortcut(option: false) }
  @objc private func useOptionCommandK() { setShortcut(option: true) }
  private func setShortcut(option: Bool) {
    shortcut.useOption = option
    UserDefaults.standard.set(option, forKey: "grove.shortcut.option")
    refreshMenu()
  }
  @objc private func showLog() { NSWorkspace.shared.open(Log.url) }
  @objc private func quit() { NSApp.terminate(nil) }
}

// One Grove at a time. Two copies each draw a panel over the notch, one on top
// of the other, and each answers every ⌘K. The running-apps list is not ready
// this early in a launch, so a lock decides: the first copy holds it until it
// exits, and a second one cannot take it and gives way.
let lockFD = open(NSTemporaryDirectory() + "grove-mac.lock", O_CREAT | O_RDWR, 0o600)
if lockFD >= 0 && flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
  Log.say("launch: another Grove is already running, quitting this one")
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
