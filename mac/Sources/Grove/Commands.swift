/*
  Typed commands, recognised on the Mac.

  "Play my agent playlist", "pause", "skip", "open Notes": things to do, with
  one obvious meaning, which the Mac can do itself in a moment. Recognised by
  their first words rather than sent to the model, which cannot press play and
  answers as if asked a question. Anything that is not one of these is a
  question and goes to Grove as before.
*/

import Foundation

enum Commands {
  static func job(for raw: String) -> Job? {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      .replacingOccurrences(of: "please ", with: "").replacingOccurrences(of: "can you ", with: "")
    let id = UUID().uuidString
    func make(_ kind: String, _ args: [String: String] = [:]) -> Job { Job(id: id, kind: kind, args: args, fromPhone: false) }

    // While the Mac is doing something, "stop" means stop that, not the music.
    if Agent.shared.running, text.range(of: #"^(stop|cancel|stop it|stop that|enough)$"#, options: .regularExpression) != nil { return make("agent.stop") }
    if text.range(of: #"^(pause|stop)( the)?( music| song| it)?$"#, options: .regularExpression) != nil { return make("music.pause") }
    if text.range(of: #"^(next|skip)( song| track| this| it)?$"#, options: .regularExpression) != nil { return make("music.next") }
    if text.range(of: #"^(previous|back|go back|last song)( song| track)?$"#, options: .regularExpression) != nil { return make("music.previous") }
    if text.range(of: #"^(resume|unpause|continue)( the)?( music)?$"#, options: .regularExpression) != nil { return make("music.resume") }
    if text.range(of: #"^(turn it up|louder|volume up|increase( the)? volume|raise( the)? volume)"#, options: .regularExpression) != nil { return make("volume.up") }
    if text.range(of: #"^(turn it down|quieter|volume down|decrease( the)? volume|lower( the)? volume)"#, options: .regularExpression) != nil { return make("volume.down") }

    if let m = text.range(of: #"^(play|put on|shuffle)\b"#, options: .regularExpression) {
      var what = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst(text.distance(from: text.startIndex, to: m.upperBound)))
      for filler in [" playlist", "my ", "the ", "some ", "music", "something"] {
        what = what.replacingOccurrences(of: filler, with: " ", options: .caseInsensitive)
      }
      var args = ["what": what.trimmingCharacters(in: .whitespacesAndNewlines)]
      if text.contains("playlist") { args["playlist"] = "yes" }
      return make("music.play", args)
    }

    if let m = text.range(of: #"^open\b"#, options: .regularExpression) {
      let what = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst(text.distance(from: text.startIndex, to: m.upperBound)))
        .trimmingCharacters(in: .whitespacesAndNewlines)
      // "open Notes", "open instagram.com" — a name, not a sentence. "Open my
      // email and check who replied" is a task, and taken as an app name it
      // became a .com made of the whole sentence.
      guard !what.isEmpty, what.split(separator: " ").count <= 3,
            what.range(of: #"(?i)\b(and|then|my|to|for|check|find|see|if)\b"#, options: .regularExpression) == nil else { return nil }
      let link = what.contains("://") || what.range(of: #"^[\w-]+(\.[\w-]+)+(/\S*)?$"#, options: .regularExpression) != nil
      return make(link ? "open.url" : "open.app", link ? ["url": what] : ["app": what])
    }
    return nil
  }
}
