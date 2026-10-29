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

  enum Decision { case act(String), answer(String) }

  /**
    A free ask from the notch: answer it, or do it in the browser. The model
    decides which, because "what's a good stoic book" and "find me a stoic
    book on Amazon" differ by intent, not by any word in them.
  */
  static func decide(_ instruction: String, manner: String) async -> Decision? {
    let brief = """
    Someone typed or said this to Grove on their Mac. Decide:
    - "do": it asks for something to be done on the computer or the web — open, find, look for, order, buy, book, watch, play a video, fill in, apply, check a site. Put the goal in text, with every detail they gave.
    - "answer": it is a question or conversation you can answer from what you know. Put the answer in text, two to four plain sentences, no markdown.
    Reply as JSON: {"kind":"do"|"answer","text":"..."}
    """ + (manner.isEmpty ? "" : "\n\nFor answers, speak in this manner: \(manner.prefix(400))")
    guard let raw = await call(system: brief, user: instruction),
          let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let text = obj["text"] as? String, !text.isEmpty else { return nil }
    return (obj["kind"] as? String) == "do" ? .act(text) : .answer(text)
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
