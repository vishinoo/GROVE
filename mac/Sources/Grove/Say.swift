/*
  A line Grove says, in its own words, when code only knows the fact.

  Code knows that a message was sent, that a page would not load, that it has
  stopped. Written into the code those became the same sentence every time —
  "Sent.", "I couldn't read that page in Chrome" — and a person who hears the
  same sentence twice stops hearing a person. So a plain line goes to the light
  model with the manner and the last few things said, and comes back as Grove
  would say it now: every fact kept, the wording its own, not what it said a
  minute ago. Bounded: past the limit, the plain line stands, because a fact
  said plainly beats a pause.
*/

import Foundation

enum Say {
  nonisolated(unsafe) static var manner = ""
  nonisolated(unsafe) private static var said: [String] = []
  private static let lock = NSLock()

  static func line(_ plain: String, about situation: String = "", within seconds: Double = 2.5) async -> String {
    let fact = plain.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !fact.isEmpty else { return plain }
    let recent = remembered()
    let system = """
    You are Grove, a friend who does things for them on their Mac. Say what is below to them, out loud, in one or two short sentences of your own: keep every fact (what happened, names, numbers, what they can do next) and add nothing that is not there. Natural and warm, the way you would say it in the room, and not the same words as anything you said recently. \(Thinking.groundRule) \(manner.isEmpty ? "" : "Your manner, style only: \(manner.prefix(300))")
    Reply as JSON: {"line":"..."}
    """
    let user = "What to say: \(fact)\(situation.isEmpty ? "" : "\nWhat it was about: \(situation.prefix(200))")\(recent.isEmpty ? "" : "\nYou said recently, so not these words again:\n\(recent)")"
    let worded: String? = await withTaskGroup(of: String?.self) { group in
      group.addTask { Thinking.parsed(await Thinking.call(system: system, user: user, temperature: 0.9))?["line"] as? String }
      group.addTask { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); return nil }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
    let out = worded.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 } ?? fact
    remember(out)
    Log.say("said: \(out.prefix(120))\(worded == nil ? " (plain: the model did not answer in time)" : "")")
    return out
  }

  private static func remembered() -> String {
    lock.lock(); defer { lock.unlock() }
    return said.suffix(6).joined(separator: "\n")
  }

  private static func remember(_ line: String) {
    lock.lock(); defer { lock.unlock() }
    said.append(line)
    if said.count > 12 { said.removeFirst(said.count - 12) }
  }
}
