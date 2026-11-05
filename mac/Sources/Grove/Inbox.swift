/*
  Messages, read directly.

  Contacts only knows who was saved, and what people call somebody ("dad") is
  often not on a card. The Messages app knows everyone they actually talk to.
  So its people are a catalogue, names and handles only, sealed like the rest,
  and it answers when Contacts cannot.

  The messages themselves are read from Messages' own database when something
  asks ("any new ones?", "what did Akash say?"), which needs Full Disk Access.
  Read-only, a recent handful, and never kept: they go to the model for that one
  answer and nowhere else. They do not join the long memory, because they are
  other people's words.
*/

import Foundation

enum Inbox {
  struct Row { let who: String; let mine: Bool; let unread: Bool; let at: String; let text: String; let group: String }

  private static var database: String { NSHomeDirectory() + "/Library/Messages/chat.db" }
  nonisolated(unsafe) private static var people: [(name: String, handle: String)] = {
    let saved = Vault.load("catalogue").split(separator: "\n").map { $0.split(separator: "\t", maxSplits: 1).map(String.init) }
    return saved.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
  }()
  nonisolated(unsafe) private static var refreshed = Date.distantPast

  /** Whether Grove has been given Full Disk Access: the only thing that decides this is trying. */
  static var canRead: Bool { FileManager.default.isReadableFile(atPath: database) }

  /** Everyone in their chats, from the app, at most hourly. */
  static func refresh() async {
    guard Date().timeIntervalSince(refreshed) > 3600 else { return }
    let (ok, out) = await Browser.run("""
    tell application "Messages"
      set out to ""
      set sep to character id 9
      repeat with c in chats
        repeat with p in (participants of c)
          try
            set out to out & (full name of p) & sep & (handle of p) & linefeed
          end try
        end repeat
      end repeat
      return out
    end tell
    """)
    guard ok else { return }
    var seen = Set<String>(), found: [(name: String, handle: String)] = []
    for line in out.split(separator: "\n") {
      let f = line.split(separator: "\t", maxSplits: 1).map(String.init)
      guard f.count == 2, seen.insert(f[1]).inserted else { continue }
      found.append((f[0], f[1]))
    }
    guard !found.isEmpty else { return }
    people = found
    refreshed = Date()
    Vault.save(found.map { "\($0.name)\t\($0.handle)" }.joined(separator: "\n"), as: "catalogue")
    Log.say("messages: \(found.count) people in the catalogue")
  }

  /** People they message whose name fits, a phone number before an email, one entry a name. */
  static func match(_ who: String) async -> [Contact] {
    await refresh()
    let wanted = who.lowercased().replacingOccurrences(of: #"^(my|the) +"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    guard wanted.count > 1 else { return [] }
    let hits = people.filter { p in
      let name = p.name.lowercased()
      return name == wanted || name.hasPrefix(wanted + " ") || name.split { !$0.isLetter }.contains { $0 == wanted[...] } || p.handle.lowercased() == wanted
    }
    var byName: [String: Contact] = [:]
    for hit in hits {
      let spoken = Contacts.sayable(hit.name)
      if byName[spoken] == nil || hit.handle.first == "+" { byName[spoken] = Contact(name: spoken, address: hit.handle) }
    }
    return Array(byName.values).sorted { $0.name < $1.name }
  }

  private static func name(for handle: String) -> String {
    func tail(_ s: String) -> String { String(s.filter(\.isNumber).suffix(10)) }
    let hit = people.first { $0.handle == handle || (tail($0.handle).count == 10 && tail($0.handle) == tail(handle)) }
    return hit.map { Contacts.sayable($0.name) } ?? handle
  }

  /**
    Recent messages, newest first, or nil when the database cannot be opened.
    From a person if one is named. Through the system's sqlite3, read-only.
  */
  static func recent(who: String = "", limit: Int = 40) async -> [Row]? {
    await refresh()
    guard canRead else { return nil }
    let sql = "select h.id as handle, m.is_from_me as mine, m.is_read as seen, datetime(m.date/1000000000+978307200,'unixepoch','localtime') as at, m.text as text, hex(m.attributedBody) as body, c.display_name as room from message m left join handle h on m.handle_id=h.ROWID left join chat_message_join j on j.message_id=m.ROWID left join chat c on c.ROWID=j.chat_id where m.associated_message_type=0 order by m.date desc limit 400"
    let p = Process(), out = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    p.arguments = ["-readonly", "-json", database, sql]
    p.standardOutput = out
    p.standardError = Pipe()
    guard (try? p.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0, let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return nil }
    let wanted = who.lowercased().replacingOccurrences(of: #"^(my|the) +"#, with: "", options: .regularExpression)
    var rows: [Row] = []
    for r in list {
      let handle = (r["handle"] as? String) ?? ""
      let text = ((r["text"] as? String).flatMap { $0.isEmpty ? nil : $0 }) ?? words(fromHex: (r["body"] as? String) ?? "")
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
      let person = name(for: handle)
      if !wanted.isEmpty, !person.lowercased().contains(wanted) { continue }
      let mine = ((r["mine"] as? Int) ?? 0) == 1
      rows.append(Row(who: person, mine: mine, unread: !mine && ((r["seen"] as? Int) ?? 1) == 0, at: (r["at"] as? String) ?? "", text: String(text.prefix(400)), group: (r["room"] as? String) ?? ""))
      if rows.count >= limit { break }
    }
    return rows
  }

  /**
    Newer messages keep their words only in an archived blob. The string sits
    after the class name, behind a '+' and a length: one byte, or 0x81 and two.
  */
  private static func words(fromHex hex: String) -> String {
    guard !hex.isEmpty else { return "" }
    var bytes = [UInt8](); bytes.reserveCapacity(hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
      guard let b = UInt8(hex[index..<next], radix: 16) else { return "" }
      bytes.append(b)
      index = next
    }
    let marker = Array("NSString".utf8)
    guard let start = (0..<max(0, bytes.count - marker.count)).first(where: { Array(bytes[$0..<$0 + marker.count]) == marker }) else { return "" }
    var i = start + marker.count
    while i < bytes.count, i < start + marker.count + 16, bytes[i] != 0x2B { i += 1 }
    i += 1
    guard i < bytes.count else { return "" }
    var length = Int(bytes[i]); i += 1
    if length == 0x81, i + 1 < bytes.count { length = Int(bytes[i]) | Int(bytes[i + 1]) << 8; i += 2 }
    guard length > 0, i + length <= bytes.count else { return "" }
    return String(decoding: bytes[i..<i + length], as: UTF8.self)
  }

  /** The rows as lines for a model. */
  static func lines(_ rows: [Row]) -> String {
    rows.map { "\($0.at) \($0.mine ? "You → " : "")\($0.who)\($0.group.isEmpty ? "" : " in \($0.group)")\($0.unread ? " (unread)" : ""): \($0.text)" }.joined(separator: "\n")
  }

  static let refused = "I can see who you message, but reading what they said needs Full Disk Access. System Settings, Privacy and Security, Full Disk Access: turn on Grove."
}
