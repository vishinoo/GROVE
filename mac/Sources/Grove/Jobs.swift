/*
  What the Mac can do when asked.

  A short list on purpose, because each one is a promise: music in Apple Music,
  and opening a link or an app. Driving a website — clicking through a form,
  a booking, an order — is the next thing and the one that needs the most care,
  and it is not here yet; asked for one, the Mac says so plainly rather than
  pretending.

  Nothing here spends money. When that arrives it will set the job up and stop
  for a press, the same rule as the phone.
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
    case "music.play": Music.play(job.args["what"] ?? "", done: done)
    case "music.pause": Music.simple("pause", spoken: "Paused.", done: done)
    case "music.resume": Music.simple("play", spoken: "Playing.", done: done)
    case "music.next": Music.simple("next track", spoken: "Skipped.", done: done)
    case "music.previous": Music.simple("previous track", spoken: "Back one.", done: done)
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
    guard let url = found else { done(false, "I couldn't find an app called \(wanted) on your Mac."); return }
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
  static func play(_ what: String, done: @escaping (Bool, String) -> Void) {
    let q = what.replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    let script: String
    if q.isEmpty {
      script = """
      tell application "Music"
        set shuffle enabled to true
        play library playlist 1
        return name of current track & "|" & artist of current track
      end tell
      """
    } else {
      script = """
      tell application "Music"
        set lists to (every user playlist whose name contains "\(q)")
        if (count of lists) > 0 then
          play item 1 of lists
          return name of current track & "|" & artist of current track
        end if
        set hits to (every track of library playlist 1 whose name contains "\(q)" or artist contains "\(q)" or album contains "\(q)")
        if (count of hits) > 0 then
          play item 1 of hits
          return name of current track & "|" & artist of current track
        end if
        return "none"
      end tell
      """
    }
    DispatchQueue.global(qos: .userInitiated).async {
      let (ok, out) = runScript(script)
      DispatchQueue.main.async {
        if !ok { done(false, "Music wouldn't respond. Grove may need permission to control it, in System Settings › Privacy › Automation."); return }
        if out == "none" { done(false, "I couldn't find \(q) in your music."); return }
        let bits = out.split(separator: "|").map(String.init)
        let title = bits.first ?? "music"
        let artist = bits.count > 1 ? bits[1] : ""
        done(true, artist.isEmpty ? "Playing \(title)." : "Playing \(title) by \(artist).")
      }
    }
  }

  static func simple(_ command: String, spoken: String, done: @escaping (Bool, String) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let (ok, _) = runScript("tell application \"Music\" to \(command)")
      DispatchQueue.main.async { done(ok, ok ? spoken : "Music wouldn't respond.") }
    }
  }

  private static func runScript(_ source: String) -> (Bool, String) {
    var error: NSDictionary?
    guard let script = NSAppleScript(source: source) else { return (false, "") }
    let result = script.executeAndReturnError(&error)
    if error != nil { return (false, "") }
    return (true, result.stringValue ?? "")
  }
}
