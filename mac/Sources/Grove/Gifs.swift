/*
  Finding a reaction GIF for a song, a finished task or a hello, when they
  turned it on. Popup.swift shows it.

  Off by default: it is a toy, and a toy that nobody asked for is noise.

  One rule picks every reaction (`rule`), applied once what happened is
  known and never before: an answer picks its GIF in the same call that
  writes it, at no extra cost; a song or a finished task picks one when it
  has actually played or finished, with one small call (`choose`). Picking
  from the request rather than the result is how every song got the same
  head bob: "play something" says nothing about whether it was Adele.

  GIPHY when build.sh found a GIPHY_API_KEY in .env; otherwise Tenor, with a
  Tenor key or the Google key the Mac already has (which works only if the
  Tenor API is switched on for that key's project). Nothing found is nothing
  shown, never an error: the card is complete without it.
*/

import Foundation

enum Gifs {
  static var on: Bool {
    get { UserDefaults.standard.bool(forKey: "grove.gifs") }
    set { UserDefaults.standard.set(newValue, forKey: "grove.gifs") }
  }

  /** How Grove picks its face. Shared by Thinking.decide and choose, so the two cannot drift apart. */
  static let rule = """
    The GIF is the plain, obvious reaction a friend would send back, matching what actually happened at its size and in its mood: someone waving back at a hello, a thumbs up for thanks or a job done, cheering for good news, someone dancing or nodding along to a song in that song's mood, a sympathetic face for bad luck, a laugh only when something was genuinely funny. Never sarcasm or judgement (no eye rolls, facepalms, side eyes, blank stares or skeletons), never a joke about them, never a pun or a clever concept. Two or three plain words a GIF site understands, the reaction first. Leave it empty when no reaction fits: a plain fact, a question answered, bad news, anything private.
    """

  /** Search words for a moment that has happened: what it was, and what Grove said about it. */
  static func choose(happened: String, said: String, manner: String) async -> String {
    let system = rule + (manner.isEmpty ? "" : "\nYour manner, which the face should match: \(manner.prefix(300))") + "\nFirst name the moment, one of greeting, thanks, good-news, bad-luck, joke, song, done, fact, question, other.\nReply as JSON: {\"moment\":\"...\",\"gif\":\"...\"}"
    let user = "\(happened)\nYou said: \(said.isEmpty ? "(nothing)" : said)"
    let obj = Thinking.parsed(await Thinking.call(system: system, user: user))
    // The same gate as an answer's: a face only for a moment a friend would send one for.
    let faces: Set<String> = ["greeting", "thanks", "good-news", "bad-luck", "joke", "song", "done"]
    let words = faces.contains(((obj?["moment"] as? String) ?? "").lowercased()) ? ((obj?["gif"] as? String) ?? "") : ""
    Log.say("gif: chose \"\(words)\" for \(happened.prefix(70).replacingOccurrences(of: "\n", with: " "))")
    return words
  }

  /** A small GIF's address for these words, one of the best few. */
  static func find(_ words: String) async -> String? {
    let q = words.trimmingCharacters(in: .whitespacesAndNewlines)
    guard on, !q.isEmpty, let query = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
    // Asked before the request rather than after it: a face that is not
    // going to be shown is not worth a round trip to GIPHY.
    guard await Popup.welcome else { Log.say("gif: skipped the search — too soon, or one is up"); return nil }
    let info = Bundle.main.infoDictionary ?? [:]
    func key(_ name: String) -> String? { (info[name] as? String).flatMap { $0.isEmpty ? nil : $0 } }

    if let giphy = key("GroveGiphyKey") {
      for attempt in attempts(q) {
        guard let term = attempt.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { continue }
        // `lang=en` because the search is written in English and the results
        // were not: without it a weak query comes back with whatever is
        // popular anywhere, which is most of how a hello became a stranger.
        let root = await get("https://api.giphy.com/v1/gifs/search?api_key=\(giphy)&q=\(term)&limit=4&rating=pg-13&lang=en")
        let urls = (root?["data"] as? [[String: Any]])?.compactMap {
          (($0["images"] as? [String: Any])?["fixed_height"] as? [String: Any])?["url"] as? String
        } ?? []
        /*
          The first result for the strongest query that found anything.

          It was one of the best two, at random, which is a reasonable way to
          stop the same face every time and a bad one once the query has
          degraded: a weak query's second result is a coin toss on something
          nobody searched for. The ladder already provides the variety, by
          trying the specific phrase before the general one.
        */
        if let url = urls.first { Log.say("gif: \"\(attempt)\" from GIPHY"); return url }
      }
      Log.say("gif: nothing for \"\(q)\"")
      return nil
    }
    if let tenor = key("GroveTenorKey") ?? key("GroveGeminiKey") {
      let root = await get("https://tenor.googleapis.com/v2/search?q=\(query)&key=\(tenor)&limit=8&media_filter=tinygif,gif&contentfilter=medium")
      let urls = (root?["results"] as? [[String: Any]])?.compactMap { r -> String? in
        let m = r["media_formats"] as? [String: Any]
        return ((m?["gif"] ?? m?["tinygif"]) as? [String: Any])?["url"] as? String
      } ?? []
      if let url = urls.first { Log.say("gif: \"\(q)\" from Tenor"); return url }
      Log.say("gif: nothing for \"\(q)\"")
    }
    return nil
  }

  /**
    What to search for, from the most specific down. The model is asked for
    two to four words and often writes six, and a long query finds nothing.
    The fallback used to keep the last two words, which threw away the action
    — "pretending to DJ in bedroom" searched as "in bedroom", "man staring
    blankly at chessboard" as "at chessboard". The action comes first, so the
    filler goes and the front is kept.
  */
  static func attempts(_ q: String) -> [String] {
    let filler: Set<String> = ["a", "an", "the", "to", "in", "at", "on", "of", "with", "while", "for", "and", "into", "from", "by", "his", "her", "their", "my", "your"]
    let words = q.lowercased().split(separator: " ").map(String.init).filter { !filler.contains($0) }
    /*
      Never down to one word.

      The ladder used to end at `words.first`, so a search that found nothing
      finished by asking GIPHY for "hello" — and a one-word search on a GIF
      site is not a search, it is the front page. That is where the Korean
      drama clips, the stickers and the unrelated people came from: not a bad
      reaction, a query with nothing in it to be wrong about.

      Two words is the floor. A reaction needs an action and a subject, and
      if two words find nothing then nothing is the right answer — the card
      is complete without a face, and no face at all beats a stranger.
    */
    let tries = [q, words.joined(separator: " "), words.prefix(3).joined(separator: " "), words.prefix(2).joined(separator: " ")]
    return tries
      .filter { $0.split(separator: " ").count >= 2 }
      .reduce(into: [String]()) { if !$1.isEmpty && !$0.contains($1) { $0.append($1) } }
  }

  private static func get(_ address: String) async -> [String: Any]? {
    guard let url = URL(string: address) else { return nil }
    guard let (data, response) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 6)),
          (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }
}
