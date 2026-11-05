/*
  What just happened on this Mac, for the next sentence to build on.

  Every ask used to be decided as though the conversation had just started.
  "Open YouTube", then "put on that Fred again set", and the second sentence
  knew nothing of the first: it opened YouTube again in another tab, or played
  the set in Music. People talk in layers — a thing, then more of it, then a
  change to it — and the second layer only means something against the first.

  So each exchange leaves a line: what they said, what Grove did with it, and
  how it ended (where, for a page). The last few ride with the next decision
  and with the browser agent, which is what lets "put this video" mean "in the
  YouTube you just opened". Kept in memory only, for twenty minutes: like the
  phone's transcript, it keeps what was done, not a record of the day.
*/

import Foundation

enum Recent {
  private struct Line { let at: Date; let text: String }
  // Written from link callbacks and the main thread both, so behind a lock.
  nonisolated(unsafe) private static var lines: [Line] = []
  private static let lock = NSLock()
  private static let keep: TimeInterval = 20 * 60

  /** A new exchange: what they said and what Grove decided to do with it. */
  static func said(_ words: String, did: String, from phone: Bool = false) {
    lock.lock(); defer { lock.unlock() }
    lines.append(Line(at: Date(), text: "\(phone ? "From the phone: " : "They said: ")\"\(words.prefix(160))\" → \(did.prefix(200))"))
    trim()
  }

  /** How the latest exchange ended, appended to its line. */
  static func ended(_ outcome: String) {
    lock.lock(); defer { lock.unlock() }
    guard !lines.isEmpty else { return }
    lines[lines.count - 1] = Line(at: Date(), text: lines[lines.count - 1].text + " — \(outcome.prefix(220))")
  }

  /**
    The last few exchanges, oldest first, with how long ago. Empty when
    nothing is recent.

    **It says what it is for.** A bare list of what Grove just did reads as a
    menu, and a model that has not understood the sentence in front of it
    will take something off that menu rather than admit it: a misheard
    "goon session" became whatever the last task was, because the last task
    was the most available thing in the prompt. The list exists so that
    "this", "that one" and "again" mean something, and for nothing else.

    The same lesson as the phone's long memory, from the other direction.
    There the framing had taught the model that memory was wallpaper; here
    the absence of any framing taught it that history was instructions.
  */
  static var text: String {
    lock.lock(); defer { lock.unlock() }
    trim()
    let recent = lines.suffix(5).map { line in
      let mins = Int(Date().timeIntervalSince(line.at) / 60)
      return "\(mins < 1 ? "just now" : "\(mins) min ago"): \(line.text)"
    }
    guard !recent.isEmpty else { return "" }
    return ([
      "What has just happened, so that \"this\", \"that one\" and \"again\" mean something. It is not a list of things to do and not a pattern to copy: if what they just said does not make sense on its own, ask them what they mean — never reach for one of these instead.",
    ] + recent).joined(separator: "\n")
  }

  private static func trim() {
    lines.removeAll { Date().timeIntervalSince($0.at) > keep }
    if lines.count > 8 { lines.removeFirst(lines.count - 8) }
  }
}

extension Thinking {
  /**
    What a line about them may be made of. The same sentence as the phone's
    (mannerDirective in persona.ts), so the two Groves have one character.
    Told to be in a teasing manner and given a window title, it made things
    up — "still poking that wave like it's going to hatch", their posture —
    and every line was a dig. A friend who knows you jokes about what is
    true, and mostly does not need to.
  */
  static let groundRule = """
  Anything you say about them — a joke, a tease, a remark — comes only from what you actually know: what they just said, this conversation, what is in front of them, and what you remember about them. Never invent a habit, a body, a mood or a situation to make a line land (their posture, how they slept, what they have been doing all day, what they are avoiding). If you do not know it, do not say it. Be warm before you are clever: mostly just be good company and useful, tease rarely and lightly, never put them down, and match what they said — a hello gets a hello back, thanks gets a you're welcome.
  """

  /**
    When to ask before doing, shared by the decision and the browser agent so
    the two cannot drift. Asking well is a judgement about the job, not a list
    of jobs: the choices that are theirs (who plays, which of a few real
    options, anything that costs money) against the ones that are not (what
    is obvious, cheap to undo, or already said).
  */
  static let askRule = """
  Before a job with real setup, work out what would change how you do it and is theirs to decide, the way someone good at the job would before starting: for a game, who plays and how (you or them, against a bot or a person, how long); for a film, what they are in the mood for and where they watch; for an email, who it goes to if that is not clear; anything that spends money. Ask all of it at once, in one short spoken line that names the options, so there is one question and not three: "You or me playing, against a bot or someone online, and how long a game?". Then get on with it. Skip anything already settled by what they said, by what they told you before, or by what just happened. Never ask what is obvious or cheap to change afterwards, never ask whether to carry on, and if nothing is open, do not ask at all.
  """
}
