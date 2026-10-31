/*
  What the Mac can do when asked.

  A short list on purpose, because each one is a promise: music in Apple Music,
  the volume, and opening a link or an app. Driving a website is Agent.swift,
  and the only path here that can end in spending money — it stops for a yes.
*/

import AppKit

struct Job {
  let id: String
  let kind: String
  let args: [String: String]
  let fromPhone: Bool
}

enum Jobs {
  static func title(for job: Job) -> String {
    switch job.kind {
    case "music.play": return (job.args["what"] ?? "").isEmpty ? "Playing music" : "Playing \(job.args["what"]!)"
    case "music.pause": return "Pausing music"
    case "music.next": return "Next song"
    case "music.previous": return "Previous song"
    case "open.url": return "Opening \(job.args["url"] ?? "a link")"
    case "open.app": return "Opening \(job.args["app"] ?? "an app")"
    default: return "Working on it"
    }
  }

  static func steps(for job: Job) -> [String] {
    switch job.kind {
    case "music.play": return ["Opening Music", "Finding it", "Playing"]
    case "open.url": return ["Opening the link"]
    case "open.app": return ["Opening the app"]
    default: return ["Doing it"]
    }
  }

  static func run(_ job: Job, done: @escaping (Bool, String) -> Void) {
    switch job.kind {
    case "music.play": Music.play(job.args["what"] ?? "", playlistOnly: job.args["playlist"] == "yes", done: done)
    case "music.pause": Music.simple("pause", spoken: "Paused.", done: done)
    case "music.resume": Music.simple("play", spoken: "Playing.", done: done)
    case "music.next": Music.simple("next track", spoken: "Skipped.", done: done)
    case "music.previous": Music.simple("previous track", spoken: "Back one.", done: done)
    case "volume.up": Music.volume(by: 12, done: done)
    case "volume.down": Music.volume(by: -12, done: done)
    case "open.url": openURL(job.args["url"] ?? "", done: done)
    case "open.app": openApp(job.args["app"] ?? "", done: done)
    default: done(false, "Your Mac can't do that yet.")
    }
  }

  private static func openURL(_ raw: String, done: (Bool, String) -> Void) {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.contains("://") { s = "https://" + s }
    guard let url = URL(string: s), url.host != nil else { done(false, "That doesn't look like a link I can open."); return }
    NSWorkspace.shared.open(url)
    done(true, "Opened \(url.host ?? "it") on your Mac.")
  }

  private static func openApp(_ name: String, done: @escaping (Bool, String) -> Void) {
    let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
    let fm = FileManager.default
    var found: URL?
    for dir in dirs {
      guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
      if let hit = items.first(where: { $0.lowercased() == wanted.lowercased() + ".app" })
        ?? items.first(where: { $0.lowercased().hasSuffix(".app") && $0.lowercased().contains(wanted.lowercased()) }) {
        found = URL(fileURLWithPath: dir).appendingPathComponent(hit)
        break
      }
    }
    // Not an app: most things people name are websites ("open instagram"), so
    // try the site in the browser rather than saying no.
    guard let url = found else {
      let site = wanted.lowercased().replacingOccurrences(of: " ", with: "")
      if !site.isEmpty, !wanted.contains(" ") || wanted.contains("."), site.count <= 30, site.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." }), let web = URL(string: "https://\(site.contains(".") ? site : "www.\(site).com")") {
        NSWorkspace.shared.open(web)
        done(true, "Opened \(web.host ?? site) in your browser.")
      } else {
        done(false, "I couldn't find \(wanted) on your Mac.")
      }
      return
    }
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
      DispatchQueue.main.async {
        done(error == nil, error == nil ? "Opened \(url.deletingPathExtension().lastPathComponent)." : "\(url.deletingPathExtension().lastPathComponent) wouldn't open.")
      }
    }
  }
}

/*
  Apple Music, through AppleScript.

  The library, not the catalogue: AppleScript can play any playlist, album,
  artist or song someone has, and nothing they do not. A name that matches a
  playlist wins, then a song or artist; nothing named shuffles the library.
*/
enum Music {
  /** The start of the line `play` answers with when the song is not theirs: main.swift plays it on YouTube. */
  static let elsewhere = "elsewhere:"

  /**
    The ways a request can name a song. People say the title and the artist in
    one breath — "Feel Good Inc. Gorillaz" — and Music's search wants one
    field at a time, so that found nothing, opened the catalogue and played
    nothing. Each split is tried as a title with the rest as the artist,
    both ways round, after the whole phrase.
  */
  static func tries(_ q: String) -> [(String, String)] {
    let words = q.replacingOccurrences(of: #"(?i)\s+by\s+"#, with: " ", options: .regularExpression).split(separator: " ").map(String.init)
    var out: [(String, String)] = [(q, "")]
    guard words.count > 1 else { return out }
    for k in stride(from: words.count - 1, through: 1, by: -1) {
      out.append((words.prefix(k).joined(separator: " "), words.dropFirst(k).joined(separator: " ")))
      out.append((words.dropFirst(words.count - k).joined(separator: " "), words.prefix(words.count - k).joined(separator: " ")))
    }
    return Array(out.prefix(12))
  }

  /**
    A playlist when one is asked for, and only a playlist: "play my agent
    playlist" once found a song called "FREE AGENTS" instead, because the
    library search ran when the playlist one should have answered. An exact
    name beats a partial one (names carry stray spaces, so both are trimmed),
    and Music is shown the playlist, not just the song it starts on.
  */
  static func play(_ what: String, playlistOnly: Bool = false, done: @escaping (Bool, String) -> Void) {
    let q = what.replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    let script: String
    if q.isEmpty {
      script = """
      tell application "Music"
        set shuffle enabled to true
        play library playlist 1
        delay 0.6
        try
          return "library|" & name of current track & "|" & artist of current track
        on error
          return "library||"
        end try
      end tell
      """
    } else {
      script = """
      tell application "Music"
        set wanted to "\(q)"
        set found to missing value
        repeat with p in (every user playlist)
          set n to name of p
          if n is wanted or n is (wanted & " ") or n is (" " & wanted) or n is (wanted & "  ") then
            set found to p
            exit repeat
          end if
        end repeat
        if found is missing value then
          set partial to (every user playlist whose name contains wanted)
          if (count of partial) > 0 then set found to item 1 of partial
        end if
        if found is not missing value then
          reveal found
          play found
          return "playlist|" & name of found
        end if
        \(playlistOnly ? "return \"none\"" : """
        repeat with t in {\(Music.tries(q).map { "{\"\($0.0)\", \"\($0.1)\"}" }.joined(separator: ", "))}
          set hint to item 2 of t
          if hint is "" then
            set hits to (search library playlist 1 for (item 1 of t))
          else
            set hits to (search library playlist 1 for (item 1 of t) only songs)
          end if
          repeat with h in hits
            if hint is "" or (artist of h) contains hint then
              play h
              delay 0.6
              try
                return "song|" & name of current track & "|" & artist of current track
              on error
                return "song|" & name of h & "|"
              end try
            end if
          end repeat
        end repeat
        return "none"
        """)
      end tell
      """
    }
    Script.run(script) { ok, out in
      if !ok { done(false, "Music wouldn't respond. Grove may need permission to control it, in the Grove menu's checklist."); return }
      if out == "none" {
        // Not in their library. AppleScript cannot play the catalogue, and
        // opening Music's search played nothing, so it goes to YouTube.
        if !playlistOnly {
          done(true, Music.elsewhere + q)
        } else {
          done(false, "I couldn't find a playlist called \(q).")
        }
        return
      }
      let bits = out.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      switch bits.first {
      case "playlist": done(true, "Playing your \(bits.count > 1 ? bits[1] : q) playlist.")
      case "library": done(true, "Shuffling your music.")
      default:
        let title = bits.count > 1 ? bits[1] : "it"
        let artist = bits.count > 2 ? bits[2] : ""
        done(true, artist.isEmpty ? "Playing \(title)." : "Playing \(title) by \(artist).")
      }
    }
  }

  /** The Mac's own volume, not Music's: louder means louder, whatever is playing. */
  static func volume(by step: Int, done: @escaping (Bool, String) -> Void) {
    let source = "set v to (output volume of (get volume settings)) + (\(step))\nif v > 100 then set v to 100\nif v < 0 then set v to 0\nset volume output volume v\nreturn v as text"
    Script.run(source) { ok, level in done(ok, ok ? "Volume \(level)." : "I couldn't change the volume.") }
  }

  static func simple(_ command: String, spoken: String, done: @escaping (Bool, String) -> Void) {
    Script.run("tell application \"Music\" to \(command)") { ok, _ in done(ok, ok ? spoken : "Music wouldn't respond.") }
  }
}
