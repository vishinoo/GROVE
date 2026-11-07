/*
  What Grove has learned about doing things on the web, kept between tasks.

  Every task used to start from nothing. It would work out that the
  Washington Post's crossword sits behind a cookie banner and inside a frame,
  finish, and the next day work it out again — or not, and give up. A person
  who has done something once does it faster the second time; that is the
  whole of what "learning" means here.

  So when a task that took some doing ends, one small call reads what
  happened and writes down what is worth knowing next time: how a site works
  ("the puzzle is in a frame from amuselabs; open the frame's address"), or
  a way of working that helped or failed ("a cookie banner's Accept closes
  it; the page underneath is usable"). Kept by site, and handed to every
  later task that lands on that site, with the general ones always.

  Not about the person: what they asked for, typed or bought is not kept,
  and the call is told so. Sealed in the vault like the memory, a few lines
  per site, newest kept.
*/

import Foundation

enum Lessons {
  private static let perSite = 6
  private static let general = "*"
  nonisolated(unsafe) private static var book: [String: [String]] = {
    let raw = Vault.load("lessons")
    let kept = (try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: [String]]) ?? [:]
    return kept.mapValues { $0.filter { !aboutPlumbing($0) } }.filter { !$0.value.isEmpty }
  }()

  /**
    A lesson about Grove's own plumbing is not a lesson about the site. A run
    that failed because Chrome refused JavaScript taught "handle browser
    permission blocks before puzzles" for nytimes.com, which would have been
    handed to every later task there as advice.
  */
  private static func aboutPlumbing(_ lesson: String) -> Bool {
    lesson.range(of: #"(?i)javascript|apple ?script|apple events|permission|developer menu|chrome setting|automation"#, options: .regularExpression) != nil
  }
  private static let lock = NSLock()

  static func site(_ url: String) -> String {
    (URL(string: url)?.host ?? "").replacingOccurrences(of: "www.", with: "")
  }

  /** What is known for this page's site, plus the general lessons, for the prompt. */
  static func known(for url: String, goal: String = "") -> String {
    lock.lock(); defer { lock.unlock() }
    let here = site(url)
    var lines: [String] = []
    if !here.isEmpty { lines += (book[here] ?? []).map { "On \(here): \($0)" } }
    // Before there is a page, sites the goal names ("on the Washington Post").
    if here.isEmpty, !goal.isEmpty {
      let words = goal.lowercased().replacingOccurrences(of: " ", with: "")
      for (name, said) in book where name != general {
        let stem = name.split(separator: ".").first.map(String.init) ?? name
        if stem.count > 3, words.contains(stem) { lines += said.map { "On \(name): \($0)" } }
      }
    }
    lines += (book[general] ?? []).suffix(4)
    return lines.prefix(10).joined(separator: "\n")
  }

  /**
    Reads a finished task and keeps what is worth knowing next time. Only for
    tasks that took some doing: a task that went straight there teaches
    nothing a lesson could improve on.
  */
  static func learn(goal: String, history: [String], outcome: String, sites: [String]) async {
    guard history.count >= 4 else { return }
    let here = Array(Set(sites.filter { !$0.isEmpty })).prefix(4)
    let already = sitesKnown(Array(here))
    let system = """
    You just finished a task in a web browser for someone. Write down what you would want to know the next time you are on these sites, as at most two short lessons that will still be true on another day: how the site works (where things are, what to close or accept first, how to start or use the thing, what is inside a frame and where it lives), or a way of working that helped or that wasted moves. Each is one plain sentence an assistant can act on. Nothing about the person, what they asked for, or anything they typed, bought or read. Nothing already known below. Nothing if the task went smoothly and there is nothing new.
    Reply as JSON: {"lessons":[{"site":"example.com or * for anything general","lesson":"..."}]}
    """
    let user = "Task: \(goal.prefix(200))\nHow it ended: \(outcome.prefix(200))\nSites: \(here.joined(separator: ", "))\nWhat happened:\n\(history.suffix(24).joined(separator: "\n"))\n\nAlready known:\n\(already.isEmpty ? "(nothing)" : already)"
    guard let obj = Thinking.parsed(await Thinking.call(system: system, user: user, temperature: 0.2)),
          let found = obj["lessons"] as? [[String: Any]], !found.isEmpty else { return }
    keep(found, here: Array(here))
  }

  private static func sitesKnown(_ here: [String]) -> String {
    lock.lock(); defer { lock.unlock() }
    return here.map { s in "\(s): " + ((book[s] ?? []).joined(separator: " | ")) }.joined(separator: "\n")
  }

  private static func keep(_ found: [[String: Any]], here: [String]) {
    lock.lock()
    for item in found.prefix(2) {
      guard let lesson = (item["lesson"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), lesson.count > 12, !aboutPlumbing(lesson) else { continue }
      var place = ((item["site"] as? String) ?? general).lowercased().replacingOccurrences(of: "www.", with: "")
      if place != general, !here.contains(place) { place = here.first { $0.hasSuffix(place) || place.hasSuffix($0) } ?? general }
      var list = book[place] ?? []
      guard !list.contains(lesson) else { continue }
      list.append(String(lesson.prefix(240)))
      book[place] = Array(list.suffix(place == general ? 10 : perSite))
      Log.say("lesson: \(place): \(lesson.prefix(120))")
    }
    let data = (try? JSONSerialization.data(withJSONObject: book)) ?? Data()
    lock.unlock()
    Vault.save(String(decoding: data, as: UTF8.self), as: "lessons")
  }
}

/*
  Routes: the moves that got a job done, kept so the next one like it is fast.

  Lessons are advice ("accept the cookies first"); a route is the path itself
  — the address, the buttons by their words, what was typed, the keys. A job
  done once, with their corrections along the way, leaves its route, and the
  next job like it is handed that route first and can send several of its
  moves at once instead of working each one out. So a game someone walked it
  through step by step is played straight off the second time. Only routes
  from jobs the check accepted are kept, and a newer one for the same kind of
  job replaces the older.
*/
enum Routes {
  private struct Route: Codable { var goal: String; var steps: [String]; var at: Date; var used: Int }
  nonisolated(unsafe) private static var book: [Route] = {
    (try? JSONDecoder().decode([Route].self, from: Data(Vault.load("routes").utf8))) ?? []
  }()
  private static let lock = NSLock()

  private static func words(_ s: String) -> Set<String> {
    let small: Set<String> = ["the", "and", "for", "with", "on", "in", "to", "a", "an", "of", "my", "me", "it", "this", "that", "play", "open", "find", "on", "youtube", "google"]
    return Set(s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 && !small.contains($0) })
  }

  private static func likeness(_ a: String, _ b: String) -> Double {
    let x = words(a), y = words(b)
    guard !x.isEmpty, !y.isEmpty else { return 0 }
    return Double(x.intersection(y).count) / Double(min(x.count, y.count))
  }

  static func keep(goal: String, steps: [String]) {
    let useful = steps.filter { !$0.isEmpty }
    guard useful.count >= 2 else { return }
    lock.lock()
    book.removeAll { likeness($0.goal, goal) >= 0.8 }
    book.append(Route(goal: String(goal.prefix(200)), steps: Array(useful.suffix(14)), at: Date(), used: 0))
    if book.count > 60 { book.removeFirst(book.count - 60) }
    let data = (try? JSONEncoder().encode(book)) ?? Data()
    lock.unlock()
    Vault.save(String(decoding: data, as: UTF8.self), as: "routes")
    Log.say("route: kept \(useful.count) moves for \(goal.prefix(60))")
  }

  /** The routes for jobs like this one, as numbered moves for the prompt. */
  static func like(_ goal: String) -> String {
    lock.lock(); defer { lock.unlock() }
    let near = book.map { ($0, likeness($0.goal, goal)) }.filter { $0.1 >= 0.5 }.sorted { $0.1 > $1.1 }.prefix(2)
    return near.map { route, _ in
      "For \"\(route.goal.prefix(100))\":\n" + route.steps.enumerated().map { "  \($0.offset + 1). \($0.element)" }.joined(separator: "\n")
    }.joined(separator: "\n")
  }
}
