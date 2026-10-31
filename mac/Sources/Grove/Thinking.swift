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

  enum Decision { case act(String, say: String), music(action: String, what: String, playlist: Bool, say: String), message(to: String, text: String), answer(String, gif: String), ask(String), stop(String) }

  /**
    A free ask from the notch: answer it, or do it in the browser. The model
    decides which, because "what's a good stoic book" and "find me a stoic
    book on Amazon" differ by intent, not by any word in them.
  */
  static func decide(_ instruction: String, manner: String, about: String = "", now: String = "", recent: String = "") async -> Decision? {
    let brief = """
    You are Grove, their friend who lives on their phone and their Mac, typed or spoken to on their Mac. You know them: use what is under "About them" whenever it bears on what they asked. "Right now" is what is on their screen and playing as they ask: when they say "this", "it" or "the song" with nothing else to point at, it means that, and a word about it is welcome when it fits (the song they have on, the work in front of them), the way a friend in the room would notice, never as a report. Decide:
    - "do": it asks for something to be done on the computer or the web — open, find, look for, order, buy, book, watch, play a video, fill in, apply, check a site. Put the goal in text, with every detail they gave. When they leave the choice to you ("a random movie", "something to eat", "a good video"), make it for them, not for anyone: pick something specific from what you know of their taste and situation, and put that choice in the goal ("put on Interstellar, they like Nolan"). Knowing nothing that bears on it, pick something genuinely good and say so.
    - "music": it is about music in Apple Music on this Mac, however it is phrased ("can you play my gym playlist", "put on some Calvin Harris", "pause", "skip this", "louder"). Put the action in action ("play", "pause", "resume", "next", "previous", "louder", "quieter") and for play the playlist, artist, album or song in text, without filler words (not "some", "my", "playlist"); empty text to shuffle only when they asked for shuffle. When they leave the pick to you ("something random", "something for my mood", "a song for me"), pick for them: an artist or playlist from what you know of their taste and what they are up to, and put that name in text. Set playlist to true if they said playlist.
    - "message": send someone a text — any "message", "text", "imessage", "tell X that", "let X know" aimed at a person ("message my brother saying I'm late", "text Akash test", "send akash a message saying hi", "message akash test"). This goes through the Messages app unless they named another app or site (Instagram, WhatsApp, Slack, Discord…), which is "do". With no "saying", everything after the person is the message ("message akash test" sends "test"). Put who in to — their name if they gave one, otherwise what they are to them ("brother", "mom") — and only the words to send in text, as they would read them, without "saying" or "that".
    - "stop": they want what is going on on the Mac stopped, or want to take over from you ("stop", "leave it", "I'll do it", "I've got it from here"). Put a short line for them in text.
    - "ask": a question back before anything is done. Their answer comes as the next sentence, with this one under "Just now".
    For "do" and "music", always fill "question" first, by this rule: \(askRule) It is the one question that rule calls for, or "" when it calls for none. "Let's play chess" leaves open who plays and gets a question; "play chess for me" and "beat this bot" do not. A question there means nothing is done until they answer.
    - "answer": it is a question or conversation. Answer it the way a friend who knows them would: in your own manner, using what you know about them where it fits, specific rather than generic. Two to four plain sentences, no markdown.
    "Just now" is what they asked and what you did over the last few minutes. They talk in layers, so read every sentence against it: "put on X", "play this", "now the next one", "make it bigger" carry on with that thing in the same place — the site or tab you just opened, the video already on, the game under way — unless they name somewhere else. Write the goal out in full with that place in it ("Play the Fred again Boiler Room set on YouTube, in the YouTube tab already open"), never as "it" or "this". A song or video asked for right after something was opened on YouTube is "do" on YouTube, not "music". A reply to a question you asked just now is the answer to it: do what it settles. When it says they will do it themselves ("I'll play", "I'll pick"), the goal is to set it up for them and stop there, said in the goal in so many words ("Start a game against the computer on chess.com and stop there: they will play it themselves").
    Reply as JSON: {"kind":"do"|"music"|"message"|"ask"|"stop"|"answer","question":"...","text":"...","say":"...","to":"...","action":"...","playlist":false,"gif":"..."}
    For "answer" only, "gif", written last, once the answer exists: \(Gifs.rule) For every other kind leave "gif" empty: what happens there is not known yet, and its face is picked when it is.
    Also put in "say" one short line in your own voice for the notch while it happens, when the kind is "do" or "music": what you picked and, if it fits, why or a quip ("Interstellar. You've been on a Nolan kick."). Never flat ("Opening YouTube").
    """ + (manner.isEmpty ? "" : "\n\nYour manner, for everything you write (style only, never a reason to refuse or to change what they asked for): \(manner.prefix(400))")
    let known = relevant(about, to: instruction)
    // The clock rides with the question, not in the brief, so the brief stays the same every call.
    let clock = DateFormatter.localizedString(from: Date(), dateStyle: .full, timeStyle: .short)
    let user = (known.isEmpty ? "" : "About them (what you remember; use it when it bears on this):\n\(known)\n\n") + "It is \(clock).\n" + (now.isEmpty ? "" : "Right now on their Mac:\n\(now)\n") + (recent.isEmpty ? "" : "Just now:\n\(recent)\n") + "They say: \(instruction)"
    // Once more when nothing usable came back: a dropped call or a malformed
    // reply is not a reason to tell them it could not think.
    // Cool, so the same sentence is read the same way twice: what it decides
    // is an action, and an action that changes with the dice is not one anyone
    // can rely on. The lines it writes keep their manner either way.
    var reply = await call(system: brief, user: user, temperature: 0.2)
    if parsed(reply) == nil { reply = await call(system: brief, user: user, temperature: 0.2) }
    guard let obj = parsed(reply), let kind = obj["kind"] as? String else {
      Log.say("ask: no decision from \(String(describing: reply).prefix(160))")
      return nil
    }
    let text = (obj["text"] as? String) ?? ""
    let gif = (obj["gif"] as? String) ?? ""
    if kind == "music" {
      return .music(action: ((obj["action"] as? String) ?? "play").lowercased(), what: text, playlist: (obj["playlist"] as? Bool) ?? false, say: (obj["say"] as? String) ?? "")
    }
    if kind == "message" {
      // A message to nobody in particular is still something to do, not nothing.
      if let to = obj["to"] as? String, !to.isEmpty { return .message(to: to, text: text) }
      return .act(instruction, say: "")
    }
    if kind == "ask", !text.isEmpty { return .ask(text) }
    if kind == "stop" { return .stop(text) }
    // A choice that is theirs is asked, not guessed: filled in as its own
    // field on every "do", because offered as one option beside "do", the
    // model chose "do" and started a chess game nobody said it should play.
    if kind == "do" || kind == "music", let question = obj["question"] as? String, question.count > 3 { return .ask(question) }
    if kind == "do" { return .act(text.isEmpty ? instruction : text, say: (obj["say"] as? String) ?? "") }
    return text.isEmpty ? nil : .answer(text, gif: gif)
  }

  /**
    One line for when they open the notch, from what they are doing: a quip
    about the work, a word about the song. What a friend glancing over would
    say, not a report of the screen. Its GIF follows the same rule as every
    other.
  */
  static func remark(now: String, manner: String, about: String, recent: String = "") async -> (line: String, gif: String)? {
    let brief = """
    You are Grove, their friend who lives on their Mac. They just glanced at you, and this is your hello. Greet them the way the hour calls for — morning, afternoon, evening, late at night — in your own manner, and you may add a few words about what they are doing or the song they have on, the way a friend looking over their shoulder would. Under twelve words. What you yourself are doing or just did for them (under "You just did") is not theirs: never remark on it, or on a page you opened. Never describe their screen back to them, never ask something that needs an answer, never mention an app by name unless that is the joke.
    Then "gif": \(Gifs.rule)
    Reply as JSON: {"line":"...","gif":"..."}
    """ + (manner.isEmpty ? "" : "\n\nYour manner (style only): \(manner.prefix(400))")
    let clock = DateFormatter.localizedString(from: Date(), dateStyle: .full, timeStyle: .short)
    let known = relevant(about, to: now)
    let user = (known.isEmpty ? "" : "About them:\n\(known)\n\n") + "It is \(clock).\nRight now on their Mac:\n\(now.isEmpty ? "(nothing open)" : now)" + (recent.isEmpty ? "" : "\nYou just did:\n\(recent)")
    guard let obj = parsed(await call(system: brief, user: user)), let line = obj["line"] as? String, !line.isEmpty else { return nil }
    return (line, (obj["gif"] as? String) ?? "")
  }

  /** JSON out of a model reply, with or without a code fence around it. */
  static func parsed(_ raw: String?) -> [String: Any]? {
    guard var s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    if let a = s.firstIndex(of: "{"), let b = s.lastIndex(of: "}"), a < b { s = String(s[a...b]) }
    guard let data = s.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
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

  /** One call to the light model, JSON out. Gifs.choose uses it too. */
  static func call(system: String, user: String, temperature: Double? = nil) async -> String? {
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
      "generationConfig": ["responseMimeType": "application/json", "maxOutputTokens": 800].merging(temperature.map { ["temperature": $0] } ?? [:]) { a, _ in a },
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
