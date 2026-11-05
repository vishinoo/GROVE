/*
  What they said about themselves at the Mac, and what they said was wrong.

  The phone is where memory lives, and nothing said at the Mac ever reached
  it: "I'm working on a psych midterm" was gone in twenty minutes, and the next
  day Grove guessed "building Grove, or the markets in Tokyo?". Told it was
  wrong, it apologised and said the same thing tomorrow, because an apology
  changes nothing that is stored.

  So a decision can carry `remember` and `wrong`. They apply here at once,
  sealed in the vault, so the very next sentence knows, and go to the phone
  (Link.news) so the real memory learns too, whenever it is next connected.
  What was told outranks anything synced, and a line called wrong is kept out
  of what the model sees even if the phone has not caught up.
*/

import Foundation

enum Told {
  private struct Book: Codable { var told: [String] = []; var wrong: [String] = [] }
  nonisolated(unsafe) private static var book: Book = {
    (try? JSONDecoder().decode(Book.self, from: Data(Vault.load("told").utf8))) ?? Book()
  }()
  private static let lock = NSLock()

  private static func words(_ s: String) -> Set<String> {
    Set(s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 3 && !["they", "them", "their", "that", "this", "with", "from", "have", "does"].contains($0) })
  }

  static func note(told line: String = "", wrong: String = "") {
    let line = line.trimmingCharacters(in: .whitespacesAndNewlines), wrong = wrong.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !line.isEmpty || !wrong.isEmpty else { return }
    lock.lock()
    if !line.isEmpty, !book.told.contains(line) { book.told = Array((book.told + [line]).suffix(40)) }
    if !wrong.isEmpty, !book.wrong.contains(wrong) {
      book.wrong = Array((book.wrong + [wrong]).suffix(40))
      book.told.removeAll { overlaps($0, wrong) }
    }
    let data = (try? JSONEncoder().encode(book)) ?? Data()
    lock.unlock()
    Vault.save(String(decoding: data, as: UTF8.self), as: "told")
    Log.say("told: \(line.isEmpty ? "" : "+ \(line.prefix(90)) ")\(wrong.isEmpty ? "" : "- \(wrong.prefix(90))")")
  }

  /** Most of the wrong line's unusual words are in this one. */
  private static func overlaps(_ line: String, _ wrong: String) -> Bool {
    let w = words(wrong)
    return !w.isEmpty && Double(w.intersection(words(line)).count) / Double(w.count) >= 0.6
  }

  /** Memory from the phone, without anything they have said is wrong. */
  static func cleaned(_ about: String) -> String {
    lock.lock(); defer { lock.unlock() }
    guard !book.wrong.isEmpty else { return about }
    return about.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      .filter { line in !book.wrong.contains { overlaps(line, $0) } }.joined(separator: "\n")
  }

  static var block: String {
    lock.lock(); defer { lock.unlock() }
    let told = book.told.suffix(20).joined(separator: "\n")
    let wrong = book.wrong.suffix(12).joined(separator: "\n")
    return (told.isEmpty ? "" : "They told you themselves (trust this over anything else):\n\(told)\n\n")
      + (wrong.isEmpty ? "" : "They said these are NOT true of them; never say or imply them:\n\(wrong)\n\n")
  }
}
