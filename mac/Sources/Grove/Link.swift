/*
  The connection to the phone, through the person's Noctus account.

  Both devices sign in with Google through Noctus (Account.swift on the Mac,
  noctusAuth on the phone) and join one Supabase Realtime broadcast channel,
  `grove-link-<secret>`, where the secret is 48 random characters kept in the
  account's own metadata — readable only with that account's sign-in. So only
  that account's devices can find the channel. No pairing code, nothing to
  keep running, and no need to share a Wi-Fi network; the earlier version was
  a WebSocket on the local network with a six-digit code.

  Not a private channel, deliberately: those are authorised through a
  realtime.messages table that Noctus's project does not have set up
  ("MissingPartition" on join), and a broadcast channel never touches the
  database at all.

  The phone keeps the memory and the accounts; nothing it knows is copied
  here. What crosses is small, one JSON object per broadcast, each with a
  "from" and a "t":

    phone → mac   hello {}                           settings {colour, label, stops, speed, warp, name, manner}
                  job {id, kind, args}               thought {id, kind, text}
                  said {heard, replied}              (a phone turn, for the Mac's GIFs only; not kept)
    mac → phone   welcome {mac}                      done {id, ok, spoken, state?, task?, detail?}
                  think {id, instruction, text}      news {what, state, said, task?, speak}

  "Connected" means heard from the phone in the last two and a half minutes;
  it says hello once a minute — about 90,000 messages a month, well inside
  Realtime's free two million.

  Realtime speaks the Phoenix channel protocol over a WebSocket, written by
  hand here so the app needs no packages: join with the access token, a
  heartbeat every 25 seconds, the token renewed before it expires.
*/

import Foundation

final class Link {
  var onLook: ((LookUpdate) -> Void)?
  var onJob: ((Job, @escaping (Bool, String, [String: String]) -> Void) -> Void)?
  var onStatus: ((Bool) -> Void)?
  var onSaid: ((String, String) -> Void)?

  private(set) var connected = false
  private let account: Account
  private var socket: URLSessionWebSocketTask?
  private var topic = ""
  private var ref = 0
  private var joined = false
  private var heartbeat: Timer?
  private var renew: Timer?
  private var lastHeard = Date.distantPast
  private var watch: Timer?
  private var backoff: TimeInterval = 2
  private var pending: [String: CheckedContinuation<Reply?, Never>] = [:]

  /*
    Connecting a phone without its own sign-in.

    Google sign-in on the phone depends on Supabase sending the browser back
    to the app, which is easy to misconfigure and impossible to see from the
    phone. So the Mac, already signed in, can show a six-digit code; the phone
    types it, both meet briefly on `grove-pair-<code>`, and the Mac hands over
    the account's channel secret. The code lasts five minutes and is used once.
  */
  private var pairTopic: String?
  private var pairExpiry: Timer?
  var onPaired: (() -> Void)?

  init(account: Account) {
    self.account = account
  }

  func start() {
    watch?.invalidate()
    var ticks = 0
    watch = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.setConnected(self.joined && Date().timeIntervalSince(self.lastHeard) < 150)
      // Not connected: every two minutes, check the account's channel has not
      // moved. One small request, and only while there is no phone.
      ticks += 1
      if !self.connected, ticks % 12 == 0 {
        let before = self.topic
        Task { @MainActor in
          if let secret = await self.account.currentLink(), "realtime:grove-link-\(secret)" != before { self.connect() }
        }
      }
    }
    connect()
  }

  func stop() {
    joined = false
    heartbeat?.invalidate()
    renew?.invalidate()
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    setConnected(false)
  }

  // MARK: the socket

  private func connect() {
    guard let session = account.session, let url = account.realtimeURL else {
      Log.say("link: not signed in, not connecting")
      return
    }
    Task { @MainActor in
      guard let secret = await self.account.currentLink() else {
        Log.say("link: the account has no channel secret yet")
        self.retry()
        return
      }
      self.open(url: url, secret: secret, session: session)
    }
  }

  private func open(url: URL, secret: String, session: Session) {
    stop()
    topic = "realtime:grove-link-\(secret)"
    let task = URLSession.shared.webSocketTask(with: url)
    socket = task
    task.resume()
    receive(on: task)
    Task { @MainActor in
      let token = await self.account.freshAccess() ?? session.access
      self.ref += 1
      self.write([
        "topic": self.topic, "event": "phx_join", "ref": "\(self.ref)", "join_ref": "1",
        "payload": [
          "config": ["broadcast": ["ack": false, "self": false], "presence": ["key": ""], "private": false],
          "access_token": token,
        ],
      ])
      Log.say("link: joining \(self.topic)")
    }
    heartbeat = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.ref += 1
      self.write(["topic": "phoenix", "event": "heartbeat", "payload": [:], "ref": "\(self.ref)"])
    }
    renew = Timer.scheduledTimer(withTimeInterval: 50 * 60, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in
        guard let token = await self.account.freshAccess() else { return }
        self.ref += 1
        self.write(["topic": self.topic, "event": "access_token", "payload": ["access_token": token], "ref": "\(self.ref)", "join_ref": "1"])
      }
    }
  }

  private func receive(on task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, task === self.socket else { return }
        switch result {
        case .success(let message):
          if case .string(let text) = message, let data = text.data(using: .utf8),
             let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            self.frame(obj)
          }
          self.receive(on: task)
        case .failure(let error):
          Log.say("link: socket closed: \(error.localizedDescription)")
          self.joined = false
          self.setConnected(false)
          self.retry()
        }
      }
    }
  }

  private func retry() {
    let wait = backoff
    backoff = min(backoff * 2, 60)
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
      guard let self, self.account.session != nil, !self.joined else { return }
      self.connect()
    }
  }

  private func frame(_ obj: [String: Any]) {
    let event = obj["event"] as? String
    let payload = obj["payload"] as? [String: Any] ?? [:]
    if event == "phx_reply", (obj["topic"] as? String) == topic, !joined {
      if (payload["status"] as? String) == "ok" {
        joined = true
        backoff = 2
        Log.say("link: joined")
        broadcast(["t": "welcome", "mac": Host.current().localizedName ?? "Mac"])
        let held = outbox
        outbox = []
        held.forEach(broadcast)
      } else {
        Log.say("link: join refused: \(payload["response"] ?? "")")
      }
      return
    }
    if event == "system", let message = payload["message"] as? String { Log.say("link: \(message)") }
    if let pairTopic, (obj["topic"] as? String) == pairTopic, event == "broadcast",
       let inner = payload["payload"] as? [String: Any], (inner["from"] as? String) == "phone", (inner["t"] as? String) == "pair",
       let secret = account.session?.link {
      ref += 1
      write(["topic": pairTopic, "event": "broadcast", "ref": "\(ref)", "join_ref": "2", "payload": ["type": "broadcast", "event": "msg",
        "payload": ["from": "mac", "t": "secret", "secret": secret, "mac": Host.current().localizedName ?? "Mac"]]])
      Log.say("link: handed the channel to a phone")
      endPairing()
      onPaired?()
      return
    }
    guard event == "broadcast", let inner = payload["payload"] as? [String: Any], (inner["from"] as? String) == "phone" else { return }
    lastHeard = Date()
    setConnected(true)
    handle(inner)
  }

  private func write(_ obj: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else { return }
    socket.send(.string(text)) { error in if let error { Log.say("link: send failed: \(error.localizedDescription)") } }
  }

  /**
    What the Mac did, for the phone, which is what talks to the glasses and
    which has to know what the Mac is up to for the next sentence to make
    sense. `speak` is for a result or a question the phone is no longer
    waiting on: a job it started that outlived its wait.
  */
  func news(what: String, state: String, said: String, task: String = "", speak: Bool = false) {
    deliver(["t": "news", "what": String(what.prefix(240)), "state": state, "said": String(said.prefix(400)), "task": task, "speak": speak])
  }

  /**
    Sent now, or held until the link is back. A reconnect is a few seconds
    every few minutes, and a result sent into one was lost: "send failed:
    Socket is not connected", and the phone never heard how the job ended.
  */
  private var outbox: [[String: Any]] = []
  private func deliver(_ message: [String: Any]) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.deliver(message) }; return }
    guard joined else {
      outbox.append(message)
      if outbox.count > 20 { outbox.removeFirst() }
      return
    }
    broadcast(message)
  }

  private func broadcast(_ message: [String: Any]) {
    var m = message
    m["from"] = "mac"
    ref += 1
    write(["topic": topic, "event": "broadcast", "ref": "\(ref)", "join_ref": "1", "payload": ["type": "broadcast", "event": "msg", "payload": m]])
  }

  // MARK: messages from the phone

  private func handle(_ m: [String: Any]) {
    switch m["t"] as? String {
    case "hello":
      broadcast(["t": "welcome", "mac": Host.current().localizedName ?? "Mac"])
    case "settings":
      onLook?(LookUpdate(
        colour: m["colour"] as? String, label: m["label"] as? String, stops: m["stops"] as? [String],
        speed: m["speed"] as? Double, warp: m["warp"] as? Double, name: m["name"] as? String, manner: m["manner"] as? String,
        about: m["about"] as? String))
    case "job":
      let id = (m["id"] as? String) ?? UUID().uuidString
      let args = (m["args"] as? [String: Any] ?? [:]).compactMapValues { "\($0)" }
      Log.say("link: job \(m["kind"] ?? "")")
      onJob?(Job(id: id, kind: (m["kind"] as? String) ?? "", args: args, fromPhone: true)) { [weak self] ok, spoken, extra in
        var out: [String: Any] = ["t": "done", "id": id, "ok": ok, "spoken": spoken]
        extra.forEach { out[$0.key] = $0.value }
        self?.deliver(out)
      }
    case "said":
      onSaid?((m["heard"] as? String) ?? "", (m["replied"] as? String) ?? "")
    case "thought":
      guard let id = m["id"] as? String, let waiting = pending.removeValue(forKey: id) else { return }
      let text = (m["text"] as? String) ?? ""
      waiting.resume(returning: text.isEmpty ? nil : Reply(kind: (m["kind"] as? String) == "rewrite" ? .rewrite : .answer, text: text, via: "phone"))
    default:
      break
    }
  }

  private func setConnected(_ value: Bool) {
    guard connected != value else { return }
    connected = value
    Log.say("link: phone \(value ? "connected" : "gone")")
    if !value {
      pending.values.forEach { $0.resume(returning: nil) }
      pending.removeAll()
    }
    onStatus?(value)
  }

  /** A fresh six-digit code, listened for on its own channel for five minutes. */
  func startPairing() -> String? {
    guard joined, account.session?.link != nil else { return nil }
    endPairing()
    let code = String(format: "%06d", Int.random(in: 0...999_999))
    let topic = "realtime:grove-pair-\(code)"
    pairTopic = topic
    ref += 1
    write(["topic": topic, "event": "phx_join", "ref": "\(ref)", "join_ref": "2",
           "payload": ["config": ["broadcast": ["ack": false, "self": false], "presence": ["key": ""], "private": false]]])
    pairExpiry = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in self?.endPairing() }
    Log.say("link: waiting for a phone with a code")
    return code
  }

  private func endPairing() {
    pairExpiry?.invalidate()
    guard let topic = pairTopic else { return }
    ref += 1
    write(["topic": topic, "event": "phx_leave", "payload": [:], "ref": "\(ref)", "join_ref": "2"])
    pairTopic = nil
  }

  /** The phone's answer to a ⌘K, or nil after fifteen seconds. */
  func think(instruction: String, text: String) async -> Reply? {
    guard connected else { return nil }
    let id = UUID().uuidString
    return await withCheckedContinuation { (c: CheckedContinuation<Reply?, Never>) in
      pending[id] = c
      broadcast(["t": "think", "id": id, "instruction": instruction, "text": String(text.prefix(8000))])
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
        self?.pending.removeValue(forKey: id)?.resume(returning: nil)
      }
    }
  }
}
