/*
  The connection to the phone.

  Grove on the iPhone connects to this Mac over the local network — a
  WebSocket on port 47321, advertised over Bonjour as _grove._tcp — and there
  is no server anywhere in between. The phone keeps the memory and the
  accounts; nothing it knows is copied here. What crosses is small: the phone's
  colour, name and manner when they change, jobs for the Mac to do, and the
  Mac's ⌘K questions for the phone to answer in its own voice.

  PAIRING

  The first time, the phone sends the six-digit code this Mac shows from the
  menu bar (Pair an iPhone…). The Mac answers with a long random token, which
  the phone keeps and presents every time after, and the code is spent. Anyone
  else on the same Wi-Fi can see the service but not use it.

  Messages are JSON, one per WebSocket text frame, each with a "t":

    phone → mac   hello {code | token, device}     settings {colour, label, stops, speed, warp, name, manner}
                  job {id, kind, args}               thought {id, kind, text}
    mac → phone   welcome {token, mac}  refused {why}
                  done {id, ok, spoken}              think {id, instruction, text}
*/

import Foundation
import Network

final class Link {
  static let port: UInt16 = 47321
  static var hostName: String {
    // "Vishnus-MacBook-Air.local": what the phone types, and what Bonjour resolves.
    let name = ProcessInfo.processInfo.hostName
    return name.hasSuffix(".local") ? name : name + ".local"
  }

  var onLook: ((LookUpdate) -> Void)?
  var onJob: ((Job, @escaping (Bool, String) -> Void) -> Void)?
  var onStatus: ((Bool) -> Void)?

  private(set) var connected = false
  private var listener: NWListener?
  private var phone: NWConnection?
  private var code: String?
  private var pending: [String: CheckedContinuation<Reply?, Never>] = [:]

  private var tokens: [String] {
    get { UserDefaults.standard.stringArray(forKey: "grove.link.tokens") ?? [] }
    set { UserDefaults.standard.set(Array(newValue.suffix(4)), forKey: "grove.link.tokens") }
  }

  func start() {
    let params = NWParameters.tcp
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    params.includePeerToPeer = false
    guard let port = NWEndpoint.Port(rawValue: Link.port), let listener = try? NWListener(using: params, on: port) else { return }
    listener.service = NWListener.Service(name: Host.current().localizedName ?? "Grove", type: "_grove._tcp")
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.stateUpdateHandler = { [weak self] state in
      if case .failed = state {
        // Port taken or network gone: try again shortly rather than give up for the session.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self?.start() }
      }
    }
    listener.start(queue: .main)
    self.listener = listener
  }

  /** A fresh code, good until it is used once. */
  func newPairingCode() -> String {
    let fresh = String(format: "%06d", Int.random(in: 0...999_999))
    code = fresh
    return fresh
  }

  // MARK: connections

  private func accept(_ connection: NWConnection) {
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection else { return }
      switch state {
      case .failed, .cancelled:
        if connection === self.phone { self.phone = nil; self.setConnected(false) }
      default: break
      }
    }
    connection.start(queue: .main)
    receive(on: connection)
  }

  private func receive(on connection: NWConnection) {
    connection.receiveMessage { [weak self, weak connection] data, _, _, error in
      guard let self, let connection else { return }
      if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        self.handle(obj, from: connection)
      }
      if error == nil { self.receive(on: connection) } else { connection.cancel() }
    }
  }

  private func handle(_ m: [String: Any], from connection: NWConnection) {
    let type = m["t"] as? String
    if type == "hello" {
      if let token = m["token"] as? String, tokens.contains(token) {
        adopt(connection)
        send(["t": "welcome", "token": token, "mac": Host.current().localizedName ?? "Mac"], on: connection)
      } else if let given = m["code"] as? String, let code, given == code {
        let token = UUID().uuidString + UUID().uuidString
        tokens = tokens + [token]
        self.code = nil
        adopt(connection)
        send(["t": "welcome", "token": token, "mac": Host.current().localizedName ?? "Mac"], on: connection)
      } else {
        send(["t": "refused", "why": "That code doesn't match. Get a new one from the Grove menu on your Mac."], on: connection)
        connection.cancel()
      }
      return
    }
    // Everything else only from the paired phone.
    guard connection === phone else { return }
    switch type {
    case "settings":
      onLook?(LookUpdate(
        colour: m["colour"] as? String, label: m["label"] as? String, stops: m["stops"] as? [String],
        speed: m["speed"] as? Double, warp: m["warp"] as? Double, name: m["name"] as? String, manner: m["manner"] as? String))
    case "job":
      let id = (m["id"] as? String) ?? UUID().uuidString
      let args = (m["args"] as? [String: Any] ?? [:]).compactMapValues { "\($0)" }
      let job = Job(id: id, kind: (m["kind"] as? String) ?? "", args: args, fromPhone: true)
      onJob?(job) { [weak self] ok, spoken in
        self?.send(["t": "done", "id": id, "ok": ok, "spoken": spoken], on: connection)
      }
    case "thought":
      guard let id = m["id"] as? String, let waiting = pending.removeValue(forKey: id) else { return }
      let text = (m["text"] as? String) ?? ""
      waiting.resume(returning: text.isEmpty ? nil : Reply(kind: (m["kind"] as? String) == "rewrite" ? .rewrite : .answer, text: text, via: "phone"))
    default:
      break
    }
  }

  private func adopt(_ connection: NWConnection) {
    if let old = phone, old !== connection { old.cancel() }
    phone = connection
    setConnected(true)
  }

  private func setConnected(_ value: Bool) {
    guard connected != value else { return }
    connected = value
    if !value {
      pending.values.forEach { $0.resume(returning: nil) }
      pending.removeAll()
    }
    onStatus?(value)
  }

  // MARK: asking the phone

  /** The phone's answer to a ⌘K, or nil after fifteen seconds. */
  func think(instruction: String, text: String) async -> Reply? {
    guard let phone else { return nil }
    let id = UUID().uuidString
    return await withCheckedContinuation { (c: CheckedContinuation<Reply?, Never>) in
      pending[id] = c
      send(["t": "think", "id": id, "instruction": instruction, "text": String(text.prefix(8000))], on: phone)
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
        self?.pending.removeValue(forKey: id)?.resume(returning: nil)
      }
    }
  }

  private func send(_ obj: [String: Any], on connection: NWConnection) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    let meta = NWProtocolWebSocket.Metadata(opcode: .text)
    let context = NWConnection.ContentContext(identifier: "grove", metadata: [meta])
    connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
  }
}
