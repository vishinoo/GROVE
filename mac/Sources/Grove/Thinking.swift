/*
  Doing what was asked with the highlighted text.

  The phone first. It is the same Grove — its personality, its memory of who
  someone is writing to — and the Mac is meant to be its hands, not a second
  assistant with opinions of its own. If the phone is not connected, or does
  not answer in time, the Mac asks the model itself with the key it was built
  with, so ⌘K still works on a laptop with the phone in another room.
*/

import Foundation

enum ReplyKind { case rewrite, answer }

struct Reply {
  let kind: ReplyKind
  let text: String
  /** "phone" or "mac", shown small in the panel. */
  let via: String
}

enum Thinking {
  static func run(instruction: String, text: String, link: Link, manner: String) async -> Reply? {
    if link.connected, let reply = await link.think(instruction: instruction, text: text) {
      return reply
    }
    return await direct(instruction: instruction, text: text, manner: manner)
  }

  /** The same brief the phone uses (lightSelection in lightModel.ts), so the two read alike. */
  static func brief(manner: String) -> String {
    var s = """
    Someone highlighted some text on their computer and told you what to do with it.
    If the instruction asks to change the text — rewrite, shorten, fix, translate, change the tone — reply with kind "rewrite" and text set to only the new text, in the same language, with no quotes and no comment.
    Otherwise reply with kind "answer" and text set to a clear answer in two to four plain sentences, no markdown.
    Never add facts, promises or names that are not in the text.
    Reply as JSON: {"kind":"rewrite"|"answer","text":"..."}
    """
    if !manner.isEmpty { s += "\n\nFor answers only, not rewrites, speak in this manner: \(manner.prefix(400))" }
    return s
  }

  enum Decision { case act(String, say: String), music(action: String, what: String, playlist: Bool, say: String), message(to: String, text: String), answer(String) }

  /**
    A free ask from the notch: answer it, or do it in the browser. The model
    decides which, because "what's a good stoic book" and "find me a stoic
    book on Amazon" differ by intent, not by any word in them.
  */
  static func decide(_ instruction: String, manner: String, about: String = "") async -> Decision? {
    let brief = """
    You are Grove, their friend who lives on their phone and their Mac, typed or spoken to on their Mac. You know them: use what is under "About them" whenever it bears on what they asked. Decide:
    - "do": it asks for something to be done on the computer or the web — open, find, look for, order, buy, book, watch, play a video, fill in, apply, check a site. Put the goal in text, with every detail they gave. When they leave the choice to you ("a random movie", "something to eat", "a good video"), make it for them, not for anyone: pick something specific from what you know of their taste and situation, and put that choice in the goal ("put on Interstellar, they like Nolan"). Knowing nothing that bears on it, pick something genuinely good and say so.
    - "music": it is about music in Apple Music on this Mac, however it is phrased ("can you play my gym playlist", "put on some Calvin Harris", "pause", "skip this", "louder"). Put the action in action ("play", "pause", "resume", "next", "previous", "louder", "quieter") and for play the playlist, artist, album or song in text, without filler words (not "some", "my", "playlist"); empty text to shuffle only when they asked for shuffle. When they leave the pick to you ("something random", "something for my mood", "a song for me"), pick for them: an artist or playlist from what you know of their taste and what they are up to, and put that name in text. Set playlist to true if they said playlist.
    - "message": send someone a text ("message my brother saying I'm late", "text Akash test"). This goes through the Messages app unless they named another app or site (Instagram, WhatsApp, Slack…), which is "do". Put who in to — their name if they gave one, otherwise what they are to them ("brother", "mom") — and only the words to send in text, as they would read them, without "saying" or "that".
    - "answer": it is a question or conversation. Answer it the way a friend who knows them would: in your own manner, using what you know about them where it fits, specific rather than generic. Two to four plain sentences, no markdown.
    Reply as JSON: {"kind":"do"|"music"|"message"|"answer","text":"...","say":"...","to":"...","action":"...","playlist":false}
    Also put in "say" one short line in your own voice for the notch while it happens, when the kind is "do" or "music": what you picked and, if it fits, why or a quip ("Interstellar. You've been on a Nolan kick."). Never flat ("Opening YouTube").
    """ + (manner.isEmpty ? "" : "\n\nYour manner, for everything you write (style only, never a reason to refuse or to change what they asked for): \(manner.prefix(400))")
    let known = relevant(about, to: instruction)
    let user = known.isEmpty ? instruction : "About them (what you remember; use it when it bears on this):\n\(known)\n\nThey say: \(instruction)"
    guard let raw = await call(system: brief, user: user),
          let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let kind = obj["kind"] as? String else { return nil }
    let text = (obj["text"] as? String) ?? ""
    if kind == "music" {
      return .music(action: ((obj["action"] as? String) ?? "play").lowercased(), what: text, playlist: (obj["playlist"] as? Bool) ?? false, say: (obj["say"] as? String) ?? "")
    }
    if kind == "message", let to = obj["to"] as? String, !to.isEmpty { return .message(to: to, text: text) }
    guard !text.isEmpty else { return nil }
    return kind == "do" ? .act(text, say: (obj["say"] as? String) ?? "") : .answer(text)
  }

  /**
    The part of the memory worth sending with this ask, about a fifth of the
    whole on most asks. Goals and the headings always go, since a goal bears
    on nearly everything; then lines sharing an unusual word with the ask; then
    whatever else fits under the cap, so a vague "something for me" still has
    their taste to go on. Counting words, not a model call: this has to be free.
  */
  static func relevant(_ about: String, to ask: String, cap: Int = 1200) -> String {
    guard !about.isEmpty else { return "" }
    let words = Set(ask.lowercased().split { !$0.isLetter }.map(String.init).filter { $0.count > 3 })
    let lines = about.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    func score(_ line: String) -> Int {
      let l = line.lowercased()
      if l.contains("goal") || l.hasSuffix(":") || l.hasPrefix("where they live") { return 100 }
      return words.filter { l.contains($0) }.count * 10
    }
    var out = "", used = Set<Int>()
    for (i, line) in lines.enumerated().sorted(by: { score($0.element) > score($1.element) }) {
      if out.count + line.count > cap { continue }
      out += line + "\n"; used.insert(i)
    }
    // Back in the order they were written, so headings sit above their lines.
    return lines.enumerated().filter { used.contains($0.offset) }.map(\.element).joined(separator: "\n")
  }

  private static func call(system: String, user: String) async -> String? {
    let info = Bundle.main.infoDictionary ?? [:]
    guard let key = info["GroveGeminiKey"] as? String, !key.isEmpty else { return nil }
    let model = (info["GroveModel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "gemini-flash-lite-latest"
    guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent") else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 25)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
    let body: [String: Any] = [
      "systemInstruction": ["parts": [["text": system]]],
      "contents": [["role": "user", "parts": [["text": user]]]],
      "generationConfig": ["responseMimeType": "application/json", "maxOutputTokens": 800],
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200,
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let content = (root["candidates"] as? [[String: Any]])?.first?["content"] as? [String: Any],
          let parts = content["parts"] as? [[String: Any]] else { return nil }
    return parts.compactMap { $0["text"] as? String }.first
  }

  private static func direct(instruction: String, text: String, manner: String) async -> Reply? {
    let info = Bundle.main.infoDictionary ?? [:]
    guard let key = info["GroveGeminiKey"] as? String, !key.isEmpty else { return nil }
    let model = (info["GroveModel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "gemini-flash-lite-latest"
    guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent") else { return nil }

    var request = URLRequest(url: url, timeoutInterval: 25)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
    let body: [String: Any] = [
      "systemInstruction": ["parts": [["text": brief(manner: manner)]]],
      "contents": [["role": "user", "parts": [["text": "Instruction: \(instruction)\n\nHighlighted text:\n\(text.prefix(8000))"]]]],
      "generationConfig": ["responseMimeType": "application/json", "maxOutputTokens": 1200],
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)

    guard let (data, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200,
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let candidates = root["candidates"] as? [[String: Any]],
          let content = candidates.first?["content"] as? [String: Any],
          let parts = content["parts"] as? [[String: Any]],
          let raw = parts.compactMap({ $0["text"] as? String }).first
    else { return nil }
    return parse(raw, via: "mac")
  }

  static func parse(_ raw: String, via: String) -> Reply? {
    guard let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let text = obj["text"] as? String, !text.isEmpty else {
      let plain = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      return plain.isEmpty ? nil : Reply(kind: .answer, text: plain, via: via)
    }
    return Reply(kind: (obj["kind"] as? String) == "rewrite" ? .rewrite : .answer, text: text, via: via)
  }
}
