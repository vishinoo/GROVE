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
    The GIF is your face as you say this: what a funny friend would send with it. Work it out in two steps. First, find the single funniest or most vivid thing in what you said or in what is happening right now. Then picture the GIF of exactly that. When your line paints a picture, the GIF is that picture acted out; when it is a feeling, it is someone showing that feeling at this moment's size and in its mood, not a bigger or happier one. For a song, think about that particular song (its tempo, its mood, what people actually do while it plays) and react the way someone listening to it would; two different songs should almost never get the same face. Write it as two to four plain words a GIF site would understand, the action first, a name only if it is famous. Build the words from this moment; never reach for a stock reaction you would use anywhere. Leave it empty when no face would add anything: a plain fact, bad news, anything private.
    """

  /** Search words for a moment that has happened: what it was, and what Grove said about it. */
  static func choose(happened: String, said: String, manner: String) async -> String {
    let system = rule + (manner.isEmpty ? "" : "\nYour manner, which the face should match: \(manner.prefix(300))") + "\nReply as JSON: {\"gif\":\"...\"}"
    let user = "\(happened)\nYou said: \(said.isEmpty ? "(nothing)" : said)"
    let words = (Thinking.parsed(await Thinking.call(system: system, user: user))?["gif"] as? String) ?? ""
    Log.say("gif: chose \"\(words)\" for \(happened.prefix(70).replacingOccurrences(of: "\n", with: " "))")
    return words
  }

  /** A small GIF's address for these words, one of the best few. */
  static func find(_ words: String) async -> String? {
    let q = words.trimmingCharacters(in: .whitespacesAndNewlines)
    guard on, !q.isEmpty, let query = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
    let info = Bundle.main.infoDictionary ?? [:]
    func key(_ name: String) -> String? { (info[name] as? String).flatMap { $0.isEmpty ? nil : $0 } }

    if let giphy = key("GroveGiphyKey") {
      // The model's words, then the reaction alone: "rap beat headnod" finds
      // nothing, "headnod" finds plenty, and the reaction is the half that matters.
      let words = q.split(separator: " ").map(String.init)
      for attempt in [q, words.suffix(2).joined(separator: " "), words.last ?? ""].reduce(into: [String](), { if !$1.isEmpty && !$0.contains($1) { $0.append($1) } }) {
        guard let term = attempt.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { continue }
        let root = await get("https://api.giphy.com/v1/gifs/search?api_key=\(giphy)&q=\(term)&limit=4&rating=pg-13")
        let urls = (root?["data"] as? [[String: Any]])?.compactMap {
          (($0["images"] as? [String: Any])?["fixed_height"] as? [String: Any])?["url"] as? String
        } ?? []
        if let url = urls.randomElement() { Log.say("gif: \"\(attempt)\" from GIPHY"); return url }
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
      if let url = urls.randomElement() { Log.say("gif: \"\(q)\" from Tenor"); return url }
      Log.say("gif: nothing for \"\(q)\"")
    }
    return nil
  }

  private static func get(_ address: String) async -> [String: Any]? {
    guard let url = URL(string: address) else { return nil }
    guard let (data, response) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 6)),
          (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }
}
