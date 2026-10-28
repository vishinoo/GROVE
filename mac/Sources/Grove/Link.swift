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
    mac → phone   welcome {mac}                      done {id, ok, spoken}
                  think {id, instruction, text}

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
  var onJob: ((Job, @escaping (Bool, String) -> Void) -> Void)?
  var onStatus: ((Bool) -> Void)?

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

  init(account: Account) {
    self.account = account
  }

  func start() {
    watch?.invalidate()
    watch = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.setConnected(self.joined && Date().timeIntervalSince(self.lastHeard) < 150)
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
    guard let secret = session.link else {
      Log.say("link: the account has no channel secret yet")
      return
    }
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
      } else {
        Log.say("link: join refused: \(payload["response"] ?? "")")
      }
      return
    }
    if event == "system", let message = payload["message"] as? String { Log.say("link: \(message)") }
    guard event == "broadcast", let inner = payload["payload"] as? [String: Any], (inner["from"] as? String) == "phone" else { return }
    lastHeard = Date()
    setConnected(true)
    handle(inner)
  }

  private func write(_ obj: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else { return }
    socket.send(.string(text)) { error in if let error { Log.say("link: send failed: \(error.localizedDescription)") } }
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
        speed: m["speed"] as? Double, warp: m["warp"] as? Double, name: m["name"] as? String, manner: m["manner"] as? String))
    case "job":
      let id = (m["id"] as? String) ?? UUID().uuidString
      let args = (m["args"] as? [String: Any] ?? [:]).compactMapValues { "\($0)" }
      Log.say("link: job \(m["kind"] ?? "")")
      onJob?(Job(id: id, kind: (m["kind"] as? String) ?? "", args: args, fromPhone: true)) { [weak self] ok, spoken in
        self?.broadcast(["t": "done", "id": id, "ok": ok, "spoken": spoken])
      }
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
