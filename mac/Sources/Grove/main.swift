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
  /** The window opening Grove from Finder shows: modes. */
  var home: Home!

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
    installEditMenu()
    // The window nobody has asked for yet, so the click that asks is instant.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { MainActor.assumeIsolated { self.home.warm() } }
    // Asked once, so Grove is in the Screen Recording list to be switched on.
    if !CGPreflightScreenCaptureAccess() && !UserDefaults.standard.bool(forKey: "grove.asked.screen") {
      UserDefaults.standard.set(true, forKey: "grove.asked.screen")
      _ = CGRequestScreenCaptureAccess()
    }
    Log.say("launch: messages database \(Inbox.canRead ? "readable" : "not readable")")
    Log.say("launch: accessibility \(AXIsProcessTrusted() ? "granted" : "not granted"), screen recording \(CGPreflightScreenCaptureAccess() ? "granted" : "not granted"), signed in \(account.session != nil)")

    notch = Notch(look: look)
    home = MainActor.assumeIsolated { Home(look: look) }
    MainActor.assumeIsolated {
      home.onDone = { [weak self] said in self?.notch.show("done", ["title": said, "text": "", "ok": true], pin: false, closeAfter: 2.5) }
    }
    link = Link(account: account)
    shortcut = Shortcut()

    notch.onGlance = { [weak self] in self?.remark() }
    notch.wantsMic = { [weak self] mode, data in self?.openMicOn(mode, data) ?? false }
    notch.onMessage = { [weak self] message in self?.fromPanel(message) }

    link.onLook = { [weak self] incoming in
      guard let self else { return }
      let changedColour = incoming.colour != nil && incoming.colour != self.look.colour
      self.look.apply(incoming)
      self.notch.setLook(self.look)
      MainActor.assumeIsolated { self.home.setLook() }
      if changedColour { self.notch.show("synced", ["label": self.look.colourLabel], pin: false, closeAfter: 2.2) }
      self.refreshMenu()
    }
    link.onStatus = { [weak self] _ in
      guard let self else { return }
      self.notch.setPhone(self.link.connected)
      self.refreshMenu()
    }
    link.onJob = { [weak self] job, reply in self?.run(job, reply: reply) }
    link.onSaid = { [weak self] heard, replied in self?.reactToPhone(heard: heard, replied: replied) }
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
    shortcut.onSummon = { [weak self] in self?.summon() }
    shortcut.onReady = { [weak self] in self?.refreshMenu() }
    // On screen for a second first: ⌘K Return landing as a question appears
    // would approve something nobody has had the chance to read.
    shortcut.waitingForYes = { [weak self] in
      guard let self, self.waitingYes != nil else { return false }
      return Date().timeIntervalSince(self.yesSince) > 1
    }
    shortcut.onArm = { [weak self] on in
      guard let self else { return }
      if on, let waiting = self.waitingYes {
        // Put back up if it had gone: this is what they are about to approve.
        self.notch.show("waiting", ["text": waiting.text, "task": waiting.task, "confirm": true], pin: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.notch.send("armed", ["on": true]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8.1) { self.notch.send("armed", ["on": false]) }
      } else {
        self.notch.send("armed", ["on": false])
      }
    }
    shortcut.onAnswer = { [weak self] yes in
      guard let self, let waiting = self.waitingYes else { return }
      Log.say("⌘K: \(yes ? "approved" : "declined") from the keyboard")
      self.fromPanel(["t": yes ? "approve" : "decline", "task": waiting.task])
    }
    shortcut.onEscape = { [weak self] in
      guard let self, self.notch.isShowing else { return false }
      self.stopListening()
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

    // `open Grove.app --args --ask "text"` asks the notch at launch, as if typed into it.
    // Several, as "first || then", are asked 35 seconds apart: a conversation in layers.
    if let i = CommandLine.arguments.firstIndex(of: "--ask"), i + 1 < CommandLine.arguments.count {
      for (k, text) in CommandLine.arguments[i + 1].components(separatedBy: " || ").enumerated() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3 + Double(k) * 35) { self.askFree(text, earlier: "") }
      }
    }

    // `open Grove.app --args --gif URL` shows the reaction pop-up at launch, to check it draws.
    if let i = CommandLine.arguments.firstIndex(of: "--gif"), i + 1 < CommandLine.arguments.count {
      let url = CommandLine.arguments[i + 1]
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { Task { @MainActor in await Popup.show(url); Log.say("test: gif shown") } }
    }

    // `open Grove.app --args --react "what happened"` picks and shows a reaction for it, to test the rule in Gifs.swift.
    if let i = CommandLine.arguments.firstIndex(of: "--react"), i + 1 < CommandLine.arguments.count {
      let happened = CommandLine.arguments[i + 1]
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.react(to: happened, said: "") }
    }

    // `open Grove.app --args --peek` opens the panel once at launch, to check it draws.
    // `open Grove.app --args --job music.now` runs a phone job at launch, as the phone would send it.
    if let i = CommandLine.arguments.firstIndex(of: "--job"), i + 1 < CommandLine.arguments.count {
      let kind = CommandLine.arguments[i + 1]
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        self.run(Job(id: "test", kind: kind, args: [:], fromPhone: true)) { ok, spoken, extra in
          Log.say("test: job \(kind) \(ok ? "ok" : "failed") — \(spoken) \(extra["detail"].map { "[\($0.prefix(80))]" } ?? "")")
        }
      }
    }
    if CommandLine.arguments.contains("--peek") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.notch.show("idle", [:], pin: true); self.remark() }
    }
  }

  func applicationDidBecomeActive(_ notification: Notification) { refreshMenu() }

  /**
    Opened again from Finder, Spotlight or Launchpad while already running,
    which before did nothing visible at all. It toggles the Grove window.
  */
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    MainActor.assumeIsolated { home.toggle() }
    return false
  }

  @objc private func openHome() { MainActor.assumeIsolated { home.show() } }

  /** A mode, started or ended by name: in code, with no model asked what "study mode" meant. */
  private func runMode(_ start: Bool, _ mode: Mode, said: String, reply: ((Bool, String, [String: String]) -> Void)? = nil) {
    Log.say("mode: \(said.prefix(40)) → \(start ? "start" : "end") \(mode.name)")
    Recent.said(said, did: "\(start ? "Started" : "Ended") \(mode.name) mode", from: reply != nil)
    Task { @MainActor in
      let line = start ? await Modes.start(mode) : await Modes.stop(mode)
      self.notch.show("done", ["title": line, "text": "", "ok": true], pin: false, closeAfter: 2.5)
      reply?(true, line, ["state": "done"])
    }
  }

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
    stopListening()
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
  private func askFree(_ said: String, earlier: String = "") {
    // A word they corrected once stays corrected, typed or from the phone too.
    let instruction = Heard.fix(said)
    // A command is done, not discussed: the model cannot press play, and
    // asked to, it says so politely, which is the worst answer there is.
    // "Never mind", or a bare "stop" with something going: everything stops,
    // here, with a word, and no model is asked what it meant.
    let t = instruction.lowercased().replacingOccurrences(of: #"[.!?,]+"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"^\s*(ok(ay)?|actually|no|nah|wait|grove|buddy|hey)\s+"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    let always = t.range(of: #"^(never ?mind|forget it|forget about it|cancel( that| it)?|scratch that|don'?t worry about it|leave it)$"#, options: .regularExpression) != nil
    let reading0 = MainActor.assumeIsolated { Speaker.shared.isReading }
    let busy = agent.running || waitingYes != nil || reading0
    if always || (busy && t.range(of: #"^(stop|stop it|stop that|stop everything|hold on|that'?s enough)$"#, options: .regularExpression) != nil) {
      MainActor.assumeIsolated { Speaker.shared.pause() }
      waitingYes = nil
      if agent.running { agent.stop() }
      Recent.said(instruction, did: "Stopped everything")
      Log.say("ask: \(instruction.prefix(40)) → stopped everything\(busy ? "" : " (nothing was going)")")
      notch.show("done", ["title": busy ? "Stopped" : "Okay", "text": "", "ok": true], pin: false, closeAfter: 2.5)
      Say.manner = look.manner
      Task { @MainActor in
        let line = await Say.line(busy ? "Stopped what I was doing, as they asked." : "Nothing was going on; no harm done.", within: 1.5)
        self.notch.show("done", ["title": busy ? "Stopped" : "Okay", "text": line, "ok": true], pin: false, closeAfter: 2.5)
      }
      return
    }
    if let hit = MainActor.assumeIsolated({ Modes.heard(instruction) }) {
      runMode(hit.start, hit.mode, said: instruction)
      return
    }
    // While the Mac is reading aloud, "stop" or "pause" is about the reading.
    let reading = MainActor.assumeIsolated { Speaker.shared.isReading }
    if reading, instruction.lowercased().range(of: #"^(stop|pause|wait|hold on|stop reading|pause there)\W*$"#, options: .regularExpression) != nil {
      MainActor.assumeIsolated { Speaker.shared.pause() }
      notch.close()
      return
    }
    if let job = Commands.job(for: instruction) {
      Recent.said(instruction, did: "\(Jobs.title(for: job)) (\(job.kind))")
      notch.close()
      run(job) { _, _, _ in }
      return
    }
    let clip = NSPasteboard.general.string(forType: .string) ?? ""
    // Only when they say so. "This" used to count, which sent "what do you think
    // of this song" to whatever was on the clipboard; "this" is for the model to
    // read against what is on their screen (Context.swift).
    let aboutClip = instruction.range(of: #"\b(copied|clipboard|what i copied)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    if aboutClip {
      captured = Captured(text: clip, app: nil, element: nil, viaClipboard: true)
      think(instruction)
      return
    }
    // Not about anything highlighted: answer it, or go and do it in Chrome.
    notch.show("thinking", ["text": "", "ask": instruction], pin: true)
    Log.say("ask: \(instruction.prefix(80))")
    Task { @MainActor in
      let now = await Context.now()
      let decision = await Thinking.decide(earlier.isEmpty ? instruction : earlier + "Now they say: " + instruction, manner: self.look.manner, about: self.look.about, now: now.text,
                                           recent: [Recent.text, Speaker.shared.context].filter { !$0.isEmpty }.joined(separator: "\n")) { learned in
        // Kept here at once, and sent to the phone, where the memory is.
        guard !learned.remember.isEmpty || !learned.wrong.isEmpty else { return }
        Told.note(told: learned.remember, wrong: learned.wrong)
        self.link.fact(learned.remember, wrong: learned.wrong)
      }
      Log.say("ask: decided \(String(describing: decision).prefix(100))")
      switch decision {
      case .open(let what, let say):
        Recent.said(instruction, did: "Opened \(what)")
        let link = what.contains("://") || what.range(of: #"^[\w-]+(\.[\w-]+)+(/\S*)?$"#, options: .regularExpression) != nil
        self.run(Job(id: UUID().uuidString, kind: link ? "open.url" : "open.app", args: link ? ["url": what, "say": say] : ["app": what, "say": say], fromPhone: false)) { _, _, _ in }
      case .music(let action, let what, _, let say):
        Recent.said(instruction, did: "Music: \(action) \(what)")
        let kinds = ["pause": "music.pause", "resume": "music.resume", "next": "music.next", "previous": "music.previous", "louder": "volume.up", "quieter": "volume.down", "shuffle": "music.shuffle"]
        let kind = kinds[action] ?? "music.play"
        // `what` rides with every action, not just play: "pause YouTube"
        // paused Apple Music because the word never left this line.
        self.run(Job(id: UUID().uuidString, kind: kind, args: ["what": what, "say": say], fromPhone: false)) { _, _, _ in }
      case .act(let goal, let say):
        Recent.said(instruction, did: "On Chrome: \(goal)")
        self.runAgent(Job(id: UUID().uuidString, kind: "agent.start", args: ["goal": goal, "say": say, "said": instruction], fromPhone: false)) { _, _, _ in }
      case .message(let to, let text):
        Recent.said(instruction, did: "Text to \(to): \(text)")
        self.runAgent(Job(id: UUID().uuidString, kind: "agent.message", args: ["to": to, "text": text, "goal": "Text \(to)"], fromPhone: false)) { _, _, _ in }
      case .answer(let text, let gif):
        Recent.said(instruction, did: "Answered: \(text)")
        self.link.heard(instruction, replied: text)
        self.notch.show("answer", ["ask": instruction, "text": text, "via": "mac"], pin: true)
        self.react(gif)
      case .ask(let question):
        // Shown as an answer, so the reply box under it carries the question
        // back with their answer ("follows"), and Recent has it too.
        Recent.said(instruction, did: "Asked them first: \(question)")
        self.link.news(what: "Asked on the Mac: \(instruction)", state: "ask", said: question)
        self.notch.show("answer", ["ask": instruction, "text": question, "via": "mac"], pin: true)
      case .messageVia(let to, let text, let app):
        Recent.said(instruction, did: "\(app) message to \(to): \(text)")
        if Native.has(app) {
          self.runAgent(Job(id: UUID().uuidString, kind: "agent.message", args: ["to": to, "text": text, "app": app, "goal": "\(Native.name(app)) \(to)"], fromPhone: false)) { _, _, _ in }
        } else {
          self.runAgent(Job(id: UUID().uuidString, kind: "agent.start", args: ["goal": "Message \(to) on \(app) saying: \(text)"], fromPhone: false)) { _, _, _ in }
        }
      case .inbox(let who):
        Recent.said(instruction, did: "Read their messages\(who.isEmpty ? "" : " from \(who)")")
        guard let rows = await Inbox.recent(who: who) else {
          self.notch.show("answer", ["ask": instruction, "text": Inbox.refused, "via": "mac"], pin: true)
          return
        }
        let answer = await Thinking.aboutMessages(instruction, lines: Inbox.lines(rows), manner: self.look.manner) ?? "I couldn't make sense of your messages just then."
        Recent.ended(answer)
        self.notch.show("answer", ["ask": instruction, "text": answer, "via": "mac"], pin: true)
        // For the next sentence, not for the long memory: these are other people's words.
        self.link.news(what: "Read their messages on the Mac", state: "answered", said: answer)
      case .read(let action):
        // Reading pauses for whatever they say next, so a note about the
        // passage is written while the place is kept.
        if action == "new" {
          let got = await Screen.capture()
          guard !got.text.isEmpty else {
            self.notch.show("answer", ["ask": instruction, "text": "There's nothing in front of you I can read.", "via": "mac"], pin: true)
            return
          }
          Recent.said(instruction, did: "Reading aloud: \(got.title)")
          self.notch.close()
          Speaker.shared.start(title: got.title, text: got.text)
        } else if !Speaker.shared.steer(action) {
          self.notch.show("answer", ["ask": instruction, "text": "Nothing's being read right now.", "via": "mac"], pin: true)
        } else {
          self.notch.close()
        }
      case .note(let text, let title):
        Speaker.shared.pause()
        Recent.said(instruction, did: "Note: \(text)")
        Screen.note(text, title: title) { ok, said in
          self.notch.show("done", ["title": "Note", "text": ok ? "\(said) \(text.prefix(80))" : said, "ok": ok], pin: false, closeAfter: 3)
          self.link.news(what: "Note on the Mac: \(text)", state: ok ? "done" : "failed", said: said)
        }
      case .stop(let line):
        Recent.said(instruction, did: "Stopped what was going on the Mac")
        self.link.news(what: "On the Mac: \(instruction)", state: "stopped", said: line)
        self.agent.stop()
        self.notch.show("done", ["title": "Stopped", "text": line.isEmpty ? "All yours." : line, "ok": true], pin: false, closeAfter: 3)
      case nil:
        self.notch.show("answer", ["ask": instruction, "text": "I couldn't reach anything to think with. Check your connection and try again.", "failed": true], pin: true)
      }
    }
  }

  /**
    ⌘K with nothing highlighted: Grove, listening.

    The same shape as `begin` — the panel and the microphone together — because
    a shortcut that opens a box for you to type in has saved you a mouse and
    nothing else. What it is for is saying something without touching
    anything, so the microphone is the point and the box is the fallback.
  */
  private func summon() {
    Log.say("⌘K: opening Grove\(AppDelegate.listensItself ? ", listening" : "")")
    captured = nil
    notch.show("idle", ["summoned": true], pin: true)
  }

  /**
    Whether this card is one to have the microphone open on, and opening it.

    **The three with a microphone button on them**, which is not a
    coincidence: a card that listens is a card with something to say back
    into, and one without a button has nowhere to show that it is listening
    or any way to stop it. Grove thinking and Grove working are neither —
    they have a box for changing the job, but an open microphone for the
    ninety seconds of a task is a room being recorded, not a question being
    answered.

    Never on a confirmation. That is the same line as everywhere else: a yes
    is a press or two keys, and the worst thing a misheard sentence can do
    here is buy something.

    Not while it is already listening, which would tear the first one down
    mid-sentence, and not over Grove reading aloud, which would hear itself.
  */
  private func openMicOn(_ mode: String, _ data: [String: Any]) -> Bool {
    guard AppDelegate.listensItself else { return false }
    /*
      Only a ⌘K summon opens the microphone by itself.

      It was every card with a box, which is what was asked for and was
      wrong in use: a microphone that opens on an answer, on a question and
      on every step of a job is one that is on most of the time, and the
      worst of it was the Mac listening alongside the phone — two
      recognisers on one room, each hearing the other's half of a sentence.

      ⌘K is the one moment that cannot be anything else. Somebody pressed a
      key meaning to talk; nobody opens a panel by accident with a keyboard
      shortcut. Everywhere else there is still a button, and pressing it is
      a decision rather than a guess about one.

      Marked by the summon itself rather than inferred from "an idle card
      that happens to be pinned" — that is true of ⌘K today and would stop
      being true the moment somebody pins an idle card for another reason,
      and the failure would be a microphone opening with no explanation.
    */
    guard (data["summoned"] as? Bool) == true, !voice.busy else { return false }
    // Not over a film, a song, or Grove reading aloud: it would hear those.
    guard !(MainActor.assumeIsolated { Speaker.shared.isReading }), !Player.soundPlaying() else { return false }
    dictate()
    return true
  }

  /**
    Whether the microphone opens itself whenever Grove is waiting on them.

    On by default: a question on screen with a microphone already open is the
    difference between talking to something and operating it, and the whole
    reason the ring and the glasses exist is not having to touch anything.

    A switch all the same, because this is a microphone turning itself on in
    a room, and the honest default for that is one somebody can turn off
    without reading any code.
  */
  static var listensItself: Bool {
    get { UserDefaults.standard.object(forKey: "grove.listen.auto") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "grove.listen.auto") }
  }

  /** The mic beside the ask box: what is said fills the box, and is sent when they stop. */
  /**
    The microphone stays on until they close it.

    It used to be one sentence per press: speak, it sends, the microphone
    shuts, and saying the next thing meant reaching for the key again. In the
    middle of anything — a game with a clock, a back-and-forth about what to
    change — that reach is the whole cost, and it is paid every sentence.

    So it re-arms after each one. The ways out are all the ordinary ones: the
    ✕, Escape, the microphone button, or the panel closing. And it gives up
    after three silences in a row, because a microphone left open in a pocket
    is not a feature anybody asked for.
  */
  private func dictate() {
    notch.hold()
    listening = true
    quiet = 0
    listenOn()
  }

  private var listening = false
  private var quiet = 0

  private func listenOn() {
    // The button says what the microphone is doing, on every card: drawn
    // white while it is open, between sentences too, and off only when it shuts.
    notch.send("mic", ["on": true])
    voice.listen(
      partial: { [weak self] words in self?.notch.send("dictate", ["words": words]) },
      done: { [weak self] said in
        guard let self else { return }
        self.notch.send("dictate", ["words": said ?? "", "final": true])
        let heard = !(said ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        self.quiet = heard ? 0 : self.quiet + 1
        guard self.listening, self.quiet < 3, AppDelegate.listensItself else {
          if self.listening { Log.say("mic: three silences, closing it") }
          self.stopListening()
          return
        }
        // A beat, so the recogniser is not torn down and rebuilt in the same
        // instant it finished, which it does not survive on every build.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
          guard self.listening else { return }
          self.listenOn()
        }
      }
    )
  }

  /** Every way out of listening goes through here, so none of them can miss one. */
  private func stopListening() {
    // The microphone goes either way: `begin` listens without setting the
    // flag, and guarding the whole function on it meant the selected-text
    // listen survived everything that was supposed to end it.
    let wasSticky = listening
    listening = false
    quiet = 0
    voice.stop()
    notch.send("mic", ["on": false])
    if wasSticky { notch.send("dictate", ["words": "", "final": true, "off": true]) }
  }

  private func fromPanel(_ message: [String: Any]) {
    switch message["t"] as? String {
    case "ask":
      guard let text = message["instruction"] as? String else { break }
      /*
        Said while something is already running: a change to that, not a new
        task.

        Without this the only things you could do while watching it get a job
        wrong were let it finish or stop it — so you stopped it and said the
        whole thing over. Typing "I want to play" at a game it started and is
        now playing itself is the case this exists for, and it is the moment
        where you can see exactly what you want and have no way to say it.
      */
      if Agent.shared.redirect(text) != nil { break }
      let follows = (message["follows"] as? String).map { ask in "Earlier they asked: \(ask)\nYou answered: \((message["said"] as? String) ?? "")\n\n" } ?? ""
      if captured != nil { think(text) } else { askFree(text, earlier: follows) }
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
      stopListening()
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
      captured = nil
      notch.show("idle", [:], pin: false)
    case "mic":
      /*
        A one-off now, not the switch.

        While the microphone opened on every card, the only reason to press
        the button was to stop it, so the button and the setting were the
        same thing. With it opening on ⌘K alone, pressing it anywhere else
        means "listen now" — and turning off a thing that is already off is
        not what somebody reaching for a microphone wants. The setting is
        still in Settings, and it governs ⌘K.
      */
      if (message["on"] as? Bool) ?? true { dictate() } else { stopListening() }
    case "stop":
      run(Job(id: UUID().uuidString, kind: "agent.stop", args: [:], fromPhone: false)) { _, _, _ in }
    case "answer", "approve", "decline":
      stopListening()
      let kind = message["t"] as? String ?? ""
      // Said in the log in so many words: a send that happened should never
      // leave anyone wondering whether a person pressed for it.
      Log.say("panel: \(kind) pressed for task \(message["task"] as? String ?? "")")
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
    case "gifs":
      Gifs.on = (message["on"] as? Bool) ?? false
      showSettings()
    case "listen":
      AppDelegate.listensItself = (message["on"] as? Bool) ?? true
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
      waitingYes = nil
      agent.stop()
      notch.show("done", ["title": "Stopped", "text": "Left it where it was.", "ok": true], pin: false, closeAfter: 2.5)
      reply(true, "Stopped.", ["state": "stopped"])
      return
    }
    if job.kind == "mode.start" || job.kind == "mode.stop" {
      let name = job.args["name"] ?? ""
      guard let mode = MainActor.assumeIsolated({ Modes.all.first { $0.name.lowercased() == name.lowercased() } }) else {
        reply(false, "There's no mode called \(name) on your Mac.", [:]); return
      }
      runMode(job.kind == "mode.start", mode, said: name, reply: reply)
      return
    }
    // The phone writes its own goal ("Start study mode on the Mac"); a mode named in full is run, not browsed for.
    if job.kind == "agent.start", let hit = MainActor.assumeIsolated({ Modes.inGoal(job.args["goal"] ?? "") }) {
      runMode(hit.start, hit.mode, said: job.args["goal"] ?? "", reply: reply)
      return
    }
    if job.kind.hasPrefix("agent.") { runAgent(job, reply: reply); return }
    if job.kind == "music.now" {
      Task { @MainActor in
        let song = await Player.nowPlaying()
        Log.say("player: now playing \(song.isEmpty ? "nothing" : song.prefix(60).description)")
        reply(!song.isEmpty, song.isEmpty ? "Nothing's playing." : song, ["detail": song])
      }
      return
    }
    if job.kind == "messages.read" {
      Task { @MainActor in
        guard let rows = await Inbox.recent(who: job.args["who"] ?? "") else { reply(false, Inbox.refused, [:]); return }
        reply(true, rows.isEmpty ? "Nothing there." : "\(rows.count) recent messages.", ["detail": Inbox.lines(rows)])
      }
      return
    }
    // What is in front of them, as words for the phone to read aloud.
    if job.kind == "screen.read" {
      Task { @MainActor in
        let got = await Screen.capture()
        Recent.said("Read me this", did: "Read aloud from the phone: \(got.title)", from: true)
        reply(!got.text.isEmpty, got.text.isEmpty ? "There's nothing on your Mac's screen I can read." : (got.title.isEmpty ? "what is on your screen" : got.title), ["detail": got.text])
      }
      return
    }
    if job.kind == "note.add" {
      let text = job.args["text"] ?? ""
      Recent.said("Note", did: "Note from the phone: \(text)", from: true)
      Screen.note(text, title: job.args["title"] ?? "") { ok, said in reply(ok, said, [:]) }
      return
    }
    let title = Jobs.title(for: job)
    if job.fromPhone { Recent.said(title, did: job.kind, from: true) }
    if job.fromPhone { notch.show("job", ["title": title, "from": "From your iPhone", "steps": Jobs.steps(for: job), "at": 0], pin: true) }
    Jobs.run(job) { [weak self] ok, spoken in
      guard let self else { return }
      // Not an app or a site it can guess: "open my study notes" is a job, not a name.
      if job.kind == "open.app", spoken.hasPrefix(Music.elsewhere) {
        var args = job.args
        args["goal"] = "Open \(spoken.dropFirst(Music.elsewhere.count)) for them, wherever it lives: an app on this Mac, or a site"
        self.runAgent(Job(id: job.id, kind: "agent.start", args: args, fromPhone: job.fromPhone), reply: reply)
        return
      }
      // Not in their library: played on YouTube instead, in their YouTube tab
      // if one is open. Opening Music's catalogue search played nothing, and
      // "play Feel Good Inc." is a request to hear it, not to search for it.
      if job.kind == "music.play", spoken.hasPrefix(Music.elsewhere) {
        let what = String(spoken.dropFirst(Music.elsewhere.count))
        Script.run("tell application \"Music\" to pause") { _, _ in }
        var args = job.args
        args["goal"] = "Play \(what) on YouTube: the song itself, the official video or audio if there is one"
        self.runAgent(Job(id: job.id, kind: "agent.start", args: args, fromPhone: job.fromPhone), reply: reply)
        return
      }
      if job.fromPhone || job.kind.hasPrefix("music.") || job.kind.hasPrefix("open.") {
        // Grove's own line when it had one ("Some Calvin Harris. You've earned it."),
        // the plain receipt when it did not, or when it went wrong.
        Recent.ended(ok ? spoken : "failed: \(spoken)")
        if !job.fromPhone { self.link.news(what: "On the Mac: \(title)", state: ok ? "done" : "failed", said: spoken) }
        // Grove's own line when the decision wrote one; otherwise the receipt,
        // worded the way Grove would say it now rather than "Paused." every time.
        let own = ok ? job.args["say"].flatMap { $0.isEmpty ? nil : $0 } : nil
        Say.manner = self.look.manner
        Task { @MainActor in
          var said = spoken
          if let own { said = own } else { said = await Say.line(spoken, about: title, within: 1.8) }
          self.notch.show("done", ["title": title, "text": said, "ok": ok], pin: false, closeAfter: 4)
          if ok && ["music.play", "music.next", "music.previous"].contains(job.kind) { self.reactToSong(said: said) }
        }
      }
      reply(ok, spoken, [:])
    }
  }

  /** A goal for the browser (Agent.swift). Shown in the notch as it goes; questions go back to the phone. */
  private func runAgent(_ job: Job, reply: @escaping (Bool, String, [String: String]) -> Void) {
    let goal = job.args["goal"] ?? ""
    let from = job.fromPhone ? "From your iPhone" : "On this Mac"
    let began = Date()
    final class Pace { var next = Date().addingTimeInterval(25); var gap: TimeInterval = 45; var told = Date.distantPast }
    let pace = Pace()
    /*
      Said back at once when they speak mid-task.

      The model's answer to an interruption is a move away — a second or
      two at best — and on anything with a clock on it that is already too
      late. A word in code, now, is the difference between "it heard me" and
      saying it again louder. It carries their own words back so it cannot
      be a canned line that is wrong about what they said.
    */
    agent.onHeard = { [weak self] said in
      guard let self else { return }
      let short = said.count > 60 ? String(said.prefix(57)) + "…" : said
      self.link.news(what: "Heard mid-task", state: "working", said: "Got it — \(short)", speak: true)
      self.notch.send("heardyou", ["words": short])
    }
    agent.onStep = { [weak self] goal, steps in
      guard let self else { return }
      self.notch.show("job", ["title": goal, "from": from, "steps": steps, "at": max(0, steps.count - 1)], pin: true)
      /*
        What it is doing right now, quietly, for the phone's screen.

        The phone showed the goal and nothing else for the whole run — "On
        your Mac · order a burrito" sitting there unchanged for two minutes,
        which says a job exists and nothing about whether it is getting
        anywhere. The steps were already being written for the notch; they
        simply never left the Mac except on the speaking cadence below,
        which is deliberately slow because it interrupts.
        Looking at a screen is not being interrupted, so these go often and
        say nothing out loud. Every few seconds rather than every step: a
        run makes about one a second, and a line nobody can read before it
        changes is the same as no line.
      */
      if let step = steps.last, Date().timeIntervalSince(pace.told) > 3 {
        pace.told = Date()
        self.link.news(what: goal, state: "working", said: step, speak: false)
      }
      // Word from a long job, the way someone doing it for you would give it:
      // soon, then less and less, so a whole game of chess is a few lines.
      // Only when they are not sitting here watching the notch.
      if (job.fromPhone || self.away), Date() >= pace.next, let step = steps.last {
        pace.next = Date().addingTimeInterval(pace.gap)
        pace.gap *= 2
        self.link.news(what: goal, state: "working", said: step, speak: true)
      }
    }
    waitingYes = nil
    let said = job.args["say"].flatMap { $0.isEmpty ? nil : $0 }
    let first = said ?? ["agent.start": "Opening Chrome", "agent.message": "Finding them in Contacts"][job.kind] ?? "Carrying on"
    notch.show("job", ["title": goal.isEmpty ? "Carrying on" : goal, "from": from, "steps": [first], "at": 0], pin: true)
    agent.manner = look.manner
    Say.manner = look.manner
    if job.fromPhone && job.kind == "agent.start" { Recent.said(goal, did: "On Chrome: \(goal)", from: true) }
    agent.recent = Recent.text
    // The phone waits on an answer and the job may be a whole game of chess,
    // so a long run answers the phone once and carries on here. The check-in
    // that used to end a phone run after a minute stopped chess mid-search.
    final class Once { var done = false }
    let once = Once()
    let answer: (Bool, String, [String: String]) -> Void = { ok, said, detail in
      guard !once.done else { return }
      once.done = true
      reply(ok, said, detail)
    }
    if job.fromPhone {
      DispatchQueue.main.asyncAfter(deadline: .now() + 50) {
        answer(true, "It's still going on your Mac. I'll keep at it.", ["state": "working"])
      }
    }
    Task { @MainActor in
      // A run started here can take its time: someone is watching the notch.
      // The phone is waiting on an answer, so its runs check in sooner.
      let raw: AgentResult
      switch job.kind {
      case "agent.start": raw = await self.agent.start(goal: goal, budget: 240, said: job.args["said"] ?? "")
      case "agent.message": raw = await self.agent.message(to: job.args["to"] ?? "", text: job.args["text"] ?? "", app: job.args["app"] ?? "messages")
      default: raw = await self.agent.resume(task: job.args["task"] ?? "", answer: job.args["answer"] ?? "", approve: job.args["approve"] == "yes")
      }
      // A line written in code is worded before anyone hears it; the model's
      // own (a done summary, a question it asked) is said as it wrote it.
      var result = raw
      if raw.plain {
        result = AgentResult(state: raw.state, spoken: await Say.line(raw.spoken, about: goal), task: raw.task, detail: raw.detail)
      }
      switch result.state {
      case "ask" where !job.fromPhone, "confirm" where !job.fromPhone:
        // Asked here, answered here: a box for the answer, or the two buttons for a yes.
        self.notch.show("waiting", ["text": result.spoken, "task": result.task, "confirm": result.state == "confirm"], pin: true)
      case "ask", "confirm":
        self.notch.show("done", ["title": result.state == "confirm" ? "Waiting for your yes" : "A question", "text": result.spoken, "ok": true], pin: false, closeAfter: 6)
      case "stopped":
        // Stopping is not a reason to throw away what it had. It was halfway
        // down a recipe when they gave up on it, and saying nothing at that
        // moment is what made the whole thing feel like it had done nothing.
        if !result.detail.isEmpty {
          self.notch.show("done", ["title": "Stopped", "text": "It was on \(result.detail)", "ok": true], pin: false, closeAfter: 4)
        }
      default:
        /*
          A receipt goes; an answer stays.

          Everything here used to close itself after at most ten seconds,
          which is right for "Playing Interstellar" and wrong for a recipe —
          the thing they asked for, scrolling away while they read the
          ingredients. Length is what separates the two, because a line
          Grove wrote about what it did is short and a thing it went and
          found is not.
        */
        let answer = result.spoken.count > 280
        // Long enough to read once, not to sit on: the card then fades to the greeting.
        let read = min(6, 2.5 + Double(result.spoken.count) * 0.025)
        self.notch.show("done", ["title": "Done", "text": result.spoken, "ok": result.state == "done"],
                        pin: true, closeAfter: answer ? nil : read, thenHome: !answer)
        if result.state == "done" { self.react(to: "They asked for: \(goal)\nIt is done.", said: result.spoken) }
      }
      Recent.ended("\(result.state): \(result.spoken)\(result.detail.isEmpty ? "" : " (on \(result.detail))")")
      // The phone hears how it ended, always: it is what talks to the glasses,
      // and the next thing said to it may be about this. Said aloud only when
      // the phone started it and had stopped waiting ("still going on your Mac").
      self.waitingYes = result.state == "confirm" ? (result.task, result.spoken) : nil
      self.yesSince = Date()
      // Said on the phone when that is where they will hear it: a job from the
      // phone that outlived its wait (one still waiting says it itself), or one
      // from here when they have walked away or it took long enough to look away.
      let late = once.done
      let tellThem = job.fromPhone ? late : (self.away || Date().timeIntervalSince(began) > 20)
      self.link.news(what: job.fromPhone ? goal : "Asked on the Mac: \(goal)", state: result.state, said: result.spoken, task: result.task,
                     speak: tellThem && result.state != "stopped")
      if !job.fromPhone, result.state == "done" { self.link.heard(goal, replied: result.spoken) }
      answer(result.state != "failed", result.spoken, ["state": result.state, "task": result.task, "detail": result.detail])
    }
  }

  /**
    A hello when they open the notch, for the hour, with a word about what they are doing. Not every
    time: only when something changed (a new song, different work) and never
    twice in three minutes, so it stays a remark rather than a ticker. Shown
    in place of the greeting; its GIF goes through the usual rule.
  */
  private var remarked: (at: Date, signature: String)?
  private func remark() {
    // While Grove is driving the screen, what is in front is its own work.
    guard !agent.running else { return }
    Task { @MainActor in
      let now = await Context.now()
      if let last = remarked {
        let age = Date().timeIntervalSince(last.at)
        if age < 180 || (now.signature == last.signature && age < 1200) { return }
      }
      remarked = (Date(), now.signature)
      // A paused song is not what they are doing, and a playing one only is
      // when they are in their music app: otherwise the hello is about what is
      // in front of them, not a song they put on an hour ago.
      var seen = now
      if !now.playing || now.app != "Music" { seen.song = now.playing && now.app.isEmpty ? now.song : "" }
      guard let said = await Thinking.remark(now: seen.text, manner: look.manner, about: look.about, recent: Recent.text) else { return }
      Log.say("remark: \(said.line) [\(said.gif)]")
      notch.send("remark", ["text": said.line])
      react(said.gif)
    }
  }

  /** A reaction GIF in the corner of the screen (Popup.swift), when they turned them on. Never holds anything up. */
  private func react(_ words: String) {
    guard Gifs.on, !words.isEmpty, !Self.screenLocked else { return }
    lastGif = Date()
    Task { @MainActor in
      if let url = await Gifs.find(words) { await Popup.show(url) }
    }
  }
  private var lastGif = Date.distantPast

  /** A yes Grove is waiting on, for ⌘K then Return. */
  private var waitingYes: (task: String, text: String)?
  private var yesSince = Date.distantPast

  /** Not at this Mac: locked, or nothing touched for a minute and a half. */
  private var away: Bool {
    if Self.screenLocked { return true }
    let keys = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    let mouse = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .mouseMoved)
    return min(keys, mouse) > 90
  }

  /** Nobody is there to see a GIF on a locked or sleeping screen. */
  private static var screenLocked: Bool {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return (session?["CGSSessionScreenIsLocked"] as? Bool) == true || CGDisplayIsAsleep(CGMainDisplayID()) != 0
  }

  /**
    A face for something said to Grove on the phone, while they are at the
    Mac. Not for every line: the shared rule leaves it empty when nothing
    would add to it, and one a minute at most, never on top of a reaction
    that is already up (the song it just played has its own).
  */
  private func reactToPhone(heard: String, replied: String) {
    guard Gifs.on, !replied.isEmpty, Date().timeIntervalSince(lastGif) > 20, !Self.screenLocked else { return }
    react(to: "They said to you on their phone: \(heard)", said: replied)
  }

  /** The same, for a moment whose reaction was not picked with the reply: chosen now that it has happened. */
  private func react(to happened: String, said: String) {
    guard Gifs.on else { return }
    Task { @MainActor in
      self.react(await Gifs.choose(happened: happened, said: said, manner: self.look.manner))
    }
  }

  /**
    What is actually playing, not what was asked for: a skip, a bare "play" or
    a playlist lands on a particular song, and the face should fit that song.
    Asked of Music only when GIFs are on.
  */
  private func reactToSong(said: String) {
    guard Gifs.on else { return }
    Script.run(#"tell application "Music" to return (name of current track) & "|" & (artist of current track) & "|" & (genre of current track)"#) { [weak self] ok, out in
      let bits = out.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      guard ok, bits.count == 3, !bits[0].isEmpty else { return }
      let happened = "Now playing on their Mac: \u{201C}\(bits[0])\u{201D} by \(bits[1])\(bits[2].isEmpty ? "" : " (\(bits[2]))")."
      // A song always gets a face; the genre is the fallback when the model offers none.
      let fallback = bits[2].isEmpty ? "vibing to music" : "\(bits[2]) music vibing"
      Task { @MainActor in
        let words = await Gifs.choose(happened: happened, said: said, manner: self?.look.manner ?? "")
        self?.react(words.isEmpty ? fallback : words)
      }
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
    menu.addItem(item("Modes…", #selector(openHome), key: ","))
    menu.addItem(.separator())
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
      "gifs": Gifs.on,
      "listen": AppDelegate.listensItself,
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
  /**
    An Edit menu, so ⌘V works.

    Grove has no Dock icon and no menu bar of its own (LSUIElement), and
    nothing ever set `NSApp.mainMenu` — which is where the *key equivalents*
    for Cut, Copy, Paste and Select All live. Without it those shortcuts are
    not bound to anything, so ⌘V did nothing in every text field in the app:
    the notch's ask box, and every link field in the Grove window. Typing out
    a URL by hand is the opposite of what that window is for.

    The menu is never shown — there is no menu bar to show it in — and that
    is fine. It exists to carry the shortcuts. The selectors are the standard
    ones, which AppKit routes to whatever has focus, so this works for the
    web views and for anything added later without either knowing about it.
  */
  private func installEditMenu() {
    let edit = NSMenu(title: "Edit")
    for (title, selector, key) in [
      ("Undo", Selector(("undo:")), "z"),
      ("Redo", Selector(("redo:")), "Z"),
      ("Cut", #selector(NSText.cut(_:)), "x"),
      ("Copy", #selector(NSText.copy(_:)), "c"),
      ("Paste", #selector(NSText.paste(_:)), "v"),
      ("Select All", #selector(NSText.selectAll(_:)), "a"),
    ] {
      let item = NSMenuItem(title: title, action: selector, keyEquivalent: key.lowercased())
      if key != key.lowercased() { item.keyEquivalentModifierMask = [.command, .shift] }
      edit.addItem(item)
    }
    let holder = NSMenuItem()
    holder.submenu = edit
    let main = NSMenu()
    main.addItem(holder)
    NSApp.mainMenu = main
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
