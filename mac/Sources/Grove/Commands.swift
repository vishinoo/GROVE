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
      guard !what.isEmpty else { return nil }
      let link = what.contains("://") || what.range(of: #"^[\w-]+(\.[\w-]+)+(/\S*)?$"#, options: .regularExpression) != nil
      return make(link ? "open.url" : "open.app", link ? ["url": what] : ["app": what])
    }
    return nil
  }
}
