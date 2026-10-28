/*
  What this person asks Grove for, counted.

  The notch's options used to be play, pause and next — three ways to do one
  thing nobody needs a panel for. They are the things actually asked for most
  now, counted on this Mac, with a few useful starting points until there is
  anything to count. Counts only, by phrasing; nothing else of what was said.
*/

import Foundation

enum Asks {
  private static let key = "grove.asks"
  private static let starters = [
    "What does what I copied mean?",
    "Summarise what I copied",
    "Make what I copied more casual",
    "How does this work?",
  ]

  private static var counts: [String: Int] {
    get { (UserDefaults.standard.dictionary(forKey: key) as? [String: Int]) ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: key) }
  }

  static func count(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t.count <= 80 else { return }
    var c = counts
    let existing = c.keys.first { $0.lowercased() == t.lowercased() } ?? t
    c[existing, default: 0] += 1
    if c.count > 60 { c = Dictionary(uniqueKeysWithValues: c.sorted { $0.value > $1.value }.prefix(40).map { ($0.key, $0.value) }) }
    counts = c
  }

  /** The four to show: most asked first, starters filling any gaps. */
  static func top() -> [String] {
    var out = counts.sorted { $0.value > $1.value }.map(\.key)
    for s in starters where !out.contains(where: { $0.lowercased() == s.lowercased() }) { out.append(s) }
    return Array(out.prefix(4))
  }
}
