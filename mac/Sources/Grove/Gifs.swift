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

  /**
    The moments that get a face at all.

    Narrowed to the two that are worth interrupting someone for — something
    genuinely funny, and something that actually went well — plus a song,
    which is the one case where the picture is the point rather than a
    comment on it.

    Greeting, thanks, bad-luck and done are gone. They are most of what gets
    said, so including them meant a face on nearly every exchange, and a
    reaction that arrives every time is not a reaction: saying hello twice
    produced two of them, which is how this came to feel like spam rather
    than like a friend.

    Named here and read by `Thinking.decide` as well, because it was written
    out twice — so narrowing one list would have left every hello still
    getting a face through the other path, which is worse than not narrowing
    at all.
  */
  /**
    The moments that get no GIF, which is a short list on purpose: with GIFs
    on, they asked for Grove to have a face, and a face that only shows up
    for three kinds of moment is a face that is mostly absent. Everything
    else can get one; what to show is the model's choice of the best point.
  */
  static let quiet: Set<String> = ["private", "bad-news"]
  static func wants(_ moment: String) -> Bool { !quiet.contains(moment.lowercased()) }

  /** How Grove picks its face. Shared by Thinking.decide and choose, so the two cannot drift apart. */
  static let rule = """
    GIFs are on, so be expressive: nearly every exchange gets one. Pick the single best point in what they said or what you said — the most vivid, funny or alive thing in it — and make the GIF of that. It can be the subject itself (a person, a place, a film, an event, an animal: Alexander the Great charging, a rocket launching), a famous person doing something, an action, or your own reaction to the moment (a cheeky grin at a joke, celebrating good news, sympathy). For a song, the artist doing something that fits it, or what someone listening would be doing. Match the feeling at its size, and make it different from the faces you showed lately. Never a put-down of them. Two to five plain English words a GIF site understands, the subject first. Leave it empty only for something private or upsetting.
    """

  /** Search words for a moment that has happened: what it was, and what Grove said about it. */
  static func choose(happened: String, said: String, manner: String) async -> String {
    let system = rule + (manner.isEmpty ? "" : "\nYour manner, which the face should match: \(manner.prefix(300))") + "\nFirst name the moment, one of joke, tease, good-news, surprise, sympathy, song, topic, fact, question, greeting, thanks, done, private, bad-news, other.\nReply as JSON: {\"moment\":\"...\",\"gif\":\"...\"}"
    let user = "\(happened)\nYou said: \(said.isEmpty ? "(nothing)" : said)\(lately.isEmpty ? "" : "\nFaces you showed lately (not these again): \(lately.joined(separator: "; "))")"
    let obj = Thinking.parsed(await Thinking.call(system: system, user: user))
    // The same gate as an answer's, from the same set, so the two cannot drift.
    let picked = wants((obj?["moment"] as? String) ?? "") ? ((obj?["gif"] as? String) ?? "") : ""
    let words = echoes(picked, of: happened) ? "" : picked
    Log.say("gif: chose \"\(words)\" for \(happened.prefix(70).replacingOccurrences(of: "\n", with: " "))\(words.isEmpty && !picked.isEmpty ? " (dropped \"\(picked)\": a name, not a reaction)" : "")")
    return words
  }

  /**
    Whether the search words are just the thing's own name read back.

    Asked for a face for a Mac DeMarco record, the model wrote "mac demarco"
    — so GIPHY was searched for an artist, which returns whatever anyone has
    ever tagged with that name: fan pictures, a couple kissing, strangers.
    Not a bad choice of reaction; not a reaction at all.

    Told in the rule never to use a name, it will still sometimes do it, and
    this is cheaper than hoping. Every meaningful word of the search already
    appearing in what happened means the model described the thing instead of
    reacting to it, and no face is better than a stranger.
  */
  static func echoes(_ words: String, of happened: String) -> Bool {
    let small: Set<String> = ["a", "an", "the", "to", "in", "at", "on", "of", "with", "and", "for", "by", "song", "music", "playing", "played", "track", "video"]
    let parts = words.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { !small.contains($0) && $0.count > 2 }
    // Nothing but filler left ("the song", "a video") is a search with nothing
    // in it, and is dropped. A name is not: a GIF of the thing they are talking
    // about (Alexander the Great, a rocket launch) is the point of the face.
    _ = happened
    return parts.isEmpty
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
        let root = await get("https://api.giphy.com/v1/gifs/search?api_key=\(giphy)&q=\(term)&limit=16&rating=pg-13&lang=en")
        let found = (root?["data"] as? [[String: Any]])?.compactMap { item -> (id: String, url: String)? in
          guard let url = ((item["images"] as? [String: Any])?["fixed_height"] as? [String: Any])?["url"] as? String else { return nil }
          return ((item["id"] as? String) ?? url, url)
        } ?? []
        // Never the same GIF twice: the first result for the same search is the
        // same picture every time, so it is one of the best few not shown lately.
        let fresh = found.filter { !shown.contains($0.id) }
        let urls = (fresh.isEmpty ? found : fresh).prefix(5).shuffled().map(\.url)
        if let pick = (fresh.isEmpty ? found : fresh).first(where: { $0.url == urls.first }) { remember(pick.id, query: attempt) }
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

  /** GIFs shown lately, and the searches behind them, so neither repeats. */
  private static var shown: [String] { UserDefaults.standard.stringArray(forKey: "grove.gifs.shown") ?? [] }
  static var lately: [String] { UserDefaults.standard.stringArray(forKey: "grove.gifs.lately") ?? [] }

  private static func remember(_ id: String, query: String) {
    UserDefaults.standard.set(Array((shown + [id]).suffix(120)), forKey: "grove.gifs.shown")
    UserDefaults.standard.set(Array((lately + [query]).suffix(10)), forKey: "grove.gifs.lately")
  }

  private static func get(_ address: String) async -> [String: Any]? {
    guard let url = URL(string: address) else { return nil }
    guard let (data, response) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 6)),
          (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }
}
