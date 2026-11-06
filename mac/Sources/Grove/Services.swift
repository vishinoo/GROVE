/*
  Which of several apps they actually use, for the jobs where there is a choice.

  Nearly every request Grove gets on the Mac has a fork in it that Grove
  cannot see. "Put a song on" is Spotify for one person and Apple Music for
  another; "order dinner" is DoorDash or Uber Eats; "put a film on" is
  whichever of five services they pay for. Grove was guessing, and a guess
  here is not a small error — it opens the wrong app, signs into nothing, and
  comes back saying it could not find their playlist.

  The fix is not a better guess. **It is asking once and never asking again.**
  The first time a kind of job comes up and Grove does not know, it asks a
  one-line question naming the two or three real options; the answer is kept
  here, sealed, and rides in every decision after it. That is one interruption
  in exchange for every later request going to the right place, which is the
  trade the rest of this app makes everywhere else.

  Deliberately a short list of KINDS rather than a list of apps. A kind is a
  question somebody can answer ("what do you use for music?"); an app is an
  answer looking for a question, and a file full of them goes stale the week
  a new one appears. What goes in the value is whatever they said, in their
  words, because the browser agent and the decision both read it as a name
  and neither needs it to be from a list.

  This is the same bet as `Lessons.swift`, one level up: that one learns how a
  site works, this one learns which site to be on. Both make Grove better at
  the Mac the more it is used, which is the only kind of improvement that does
  not cost a release.
*/

import Foundation

enum Services {
  /**
    The forks worth asking about.

    Each is a job where picking wrong wastes the whole attempt, and where the
    right answer is a fact about them rather than a judgement about the
    request. Things with no real fork are not here: a web search is a web
    search.
  */
  static let kinds: [(key: String, asks: String)] = [
    ("music", "music — Spotify, Apple Music, YouTube Music?"),
    ("film", "films and TV — Netflix, Crave, Prime Video, Disney+?"),
    ("food", "food delivery — DoorDash, Uber Eats, SkipTheDishes?"),
    ("shopping", "shopping — Amazon, Walmart, Costco?"),
    ("rides", "getting about — Uber, Lyft?"),
    ("messages", "messaging — iMessage, WhatsApp?"),
  ]

  private struct Book: Codable { var use: [String: String] = [:] }
  nonisolated(unsafe) private static var book: Book = {
    (try? JSONDecoder().decode(Book.self, from: Data(Vault.load("services").utf8))) ?? Book()
  }()
  private static let lock = NSLock()

  /** What they use for this kind of job, or empty. */
  static func use(_ kind: String) -> String {
    lock.lock(); defer { lock.unlock() }
    return book.use[kind.lowercased()] ?? ""
  }

  /**
    Remember that this is what they use.

    Matched loosely to a known kind, because the model writes the kind in its
    own words — "songs", "takeout", "streaming" — and refusing those would
    mean the answer to a question Grove itself asked gets thrown away, which
    is the worst possible place to be strict.
  */
  static func note(_ kind: String, _ app: String) {
    let app = app.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !app.isEmpty, let key = match(kind) else { return }
    lock.lock()
    book.use[key] = String(app.prefix(40))
    let data = (try? JSONEncoder().encode(book)) ?? Data()
    lock.unlock()
    Log.say("services: \(key) is \(app)")
    Vault.save(String(data: data, encoding: .utf8) ?? "", as: "services")
  }

  static func forget(_ kind: String) {
    guard let key = match(kind) else { return }
    lock.lock()
    book.use.removeValue(forKey: key)
    let data = (try? JSONEncoder().encode(book)) ?? Data()
    lock.unlock()
    Vault.save(String(data: data, encoding: .utf8) ?? "", as: "services")
  }

  private static let also: [String: [String]] = [
    "music": ["music", "song", "songs", "audio", "playlist"],
    "film": ["film", "films", "movie", "movies", "tv", "show", "shows", "streaming", "watch"],
    "food": ["food", "takeout", "takeaway", "delivery", "dinner", "eat", "restaurant"],
    "shopping": ["shopping", "shop", "buy", "store", "order"],
    "rides": ["rides", "ride", "taxi", "cab", "travel", "transport"],
    "messages": ["messages", "message", "messaging", "text", "texts", "chat"],
  ]

  /**
    A whole word, never a substring.

    Containment was the first version and it decided that **"weather"** was
    about food, because "weather" contains "eat". The same shape as the
    stemmer that turned "notes" into "not": a rule that reads as obviously
    correct, is wrong on a word nobody thought to try, and fails by quietly
    filing something under the wrong heading rather than by breaking.

    Split into words rather than matched whole, because the model writes
    "food delivery" and "my music" as readily as "food".
  */
  private static func match(_ kind: String) -> String? {
    let k = kind.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty else { return nil }
    if also[k] != nil { return k }
    let words = Set(k.split { !$0.isLetter }.map(String.init))
    return also.first { $0.value.contains(where: { words.contains($0) }) }?.key
  }

  /**
    What the decision is told: what is known, and what to do about what is not.

    Both halves in one block, because a list of known services with no
    instruction beside it is the mistake this project has made before — the
    model reads it as background and carries on guessing. The sentence that
    makes it work is the one saying an unknown is a question, not a gap to
    fill in.
  */
  static var block: String {
    lock.lock()
    let known = kinds.compactMap { k -> String? in
      guard let app = book.use[k.key], !app.isEmpty else { return nil }
      return "\(k.key): \(app)"
    }
    let unknown = kinds.filter { (book.use[$0.key] ?? "").isEmpty }
    lock.unlock()
    var out = known.isEmpty ? "" : "What they use, which is settled — use these and never ask again:\n" + known.joined(separator: "\n") + "\n"
    if !unknown.isEmpty {
      out += """
      Not settled yet: \(unknown.map(\.asks).joined(separator: " / "))
      If this request needs one of those and it is not settled, do not guess and do not pick the one you know best: reply "ask" with that one short question, naming the real options. One interruption now is worth every later request going to the right place.
      """
    }
    return out
  }
}
