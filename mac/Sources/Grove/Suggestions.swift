/*
  The two things the notch offers, from this Mac's own stuff.

  Not "explain what I copied" — nobody opens a panel to ask that. Real things
  people do: their own playlists by name, their library on shuffle, the apps
  they open. Two at a time, turning over every few seconds through a short
  list, so the notch stays quiet and still offers something worth a click.

  Playlists come from Apple Music once at launch (it needs Automation, asked
  for in the permissions checklist) and are kept, so the list is there before
  Music answers next time.
*/

import Foundation

struct Suggestion {
  let label: String
  let kind: String
  let args: [String: String]
  var json: [String: Any] { ["label": label, "kind": kind, "args": args] }
}

enum Suggestions {
  private static let key = "grove.playlists"

  static func all() -> [Suggestion] {
    var out: [Suggestion] = []
    let lists = UserDefaults.standard.stringArray(forKey: key) ?? []
    for name in lists.prefix(3) {
      let clean = name.trimmingCharacters(in: .whitespaces)
      out.append(Suggestion(label: "Play my \(clean) playlist", kind: "music.play", args: ["what": clean, "playlist": "yes"]))
    }
    out.append(Suggestion(label: "Shuffle my music", kind: "music.play", args: [:]))
    out.append(Suggestion(label: "Open Calendar", kind: "open.app", args: ["app": "Calendar"]))
    out.append(Suggestion(label: "Open Notes", kind: "open.app", args: ["app": "Notes"]))
    return out
  }

  /** Reads the playlist names from Music in the background, then calls back. */
  static func refresh(done: @escaping () -> Void) {
    do {
      let source = """
      tell application "Music"
        set out to {}
        repeat with p in (every user playlist whose smart is false)
          if (count of tracks of p) > 0 then set end of out to name of p
        end repeat
        set AppleScript's text item delimiters to "|"
        return out as text
      end tell
      """
      Script.run(source) { ok, text in
        guard ok else { return }
        let names = text.split(separator: "|").map(String.init).filter { !$0.isEmpty && $0.count <= 28 }
        Log.say("music: \(names.count) playlists")
        UserDefaults.standard.set(Array(names.prefix(8)), forKey: key)
        done()
      }
    }
  }
}
