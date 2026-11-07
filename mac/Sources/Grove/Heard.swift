/*
  Words the recogniser gets wrong, put right once and kept right.

  "Play Krillion" came out of the recogniser as "Play Crillion" every time —
  a real DOS game from 1997, which Grove then dutifully found and played.
  Saying "with a K" did nothing: the decision kept the misspelling, because
  nothing anywhere said that the sentence was a correction of a word rather
  than a request. So the one name somebody cared about was the one Grove
  could never reach, and saying it louder could not help, because the
  mistake was the same every time.

  Two halves, and both are needed. The recogniser is handed the names Grove
  already knows (`hints`, as contextualStrings, the same thing the phone does
  with the long memory), so it is less likely to mishear them at all. And
  when it still does and they say so, the decision reports the pair
  (`misheard`), which is kept and applied to every later transcript as a
  whole word — never a substring, for the same reason as Services' matcher.
*/

import Foundation

enum Heard {
  nonisolated(unsafe) private static var book: [String: String] = {
    (try? JSONDecoder().decode([String: String].self, from: Data(Vault.load("heard").utf8))) ?? [:]
  }()
  private static let lock = NSLock()

  /** They said a word came out wrong: keep the pair, keyed by what was heard. */
  static func learn(heard: String, meant: String) {
    let h = heard.trimmingCharacters(in: .whitespacesAndNewlines), m = meant.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !h.isEmpty, !m.isEmpty, h.lowercased() != m.lowercased(), h.count <= 40, m.count <= 40 else { return }
    lock.lock()
    book[h.lowercased()] = m
    if book.count > 80 { book.removeValue(forKey: book.keys.sorted().first!) }
    let data = (try? JSONEncoder().encode(book)) ?? Data()
    lock.unlock()
    Vault.save(String(decoding: data, as: UTF8.self), as: "heard")
    Log.say("heard: \"\(h)\" means \"\(m)\" from now on")
  }

  /** A transcript with every known mishearing put right, whole words only. */
  static func fix(_ text: String) -> String {
    lock.lock(); let pairs = book; lock.unlock()
    var out = text
    for (heard, meant) in pairs {
      let pattern = "(?i)(?<![\\p{L}\\p{N}])" + NSRegularExpression.escapedPattern(for: heard) + "(?![\\p{L}\\p{N}])"
      out = out.replacingOccurrences(of: pattern, with: NSRegularExpression.escapedTemplate(for: meant), options: .regularExpression)
    }
    return out
  }

  /**
    Names worth listening for: every word somebody corrected, then the proper
    nouns in what Grove remembers about them. Mid-sentence capitals only, since
    the first word of a line is capitalised for grammar.
  */
  static var hints: [String] {
    lock.lock(); var out = Array(Set(book.values)); lock.unlock()
    let memory = Vault.load()
    var seen = Set(out.map { $0.lowercased() })
    for line in memory.split(whereSeparator: \.isNewline) {
      let words = line.split(separator: " ").map { $0.trimmingCharacters(in: .punctuationCharacters) }
      for w in words.dropFirst() where w.count > 2 && w.first?.isUppercase == true && seen.insert(w.lowercased()).inserted {
        out.append(w)
      }
      if out.count >= 100 { break }
    }
    return Array(out.prefix(100))
  }
}
