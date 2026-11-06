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
    case "music.play": MainActor.assumeIsolated { Music.start(job.args["what"] ?? "", playlistOnly: job.args["playlist"] == "yes", done: done) }
    case "music.pause": MainActor.assumeIsolated { Player.transport("pause", what: job.args["what"] ?? "", done: done) }
    case "music.resume": MainActor.assumeIsolated { Player.transport("play", what: job.args["what"] ?? "", done: done) }
    case "music.next": MainActor.assumeIsolated { Player.transport("next track", what: job.args["what"] ?? "", done: done) }
    case "music.previous": MainActor.assumeIsolated { Player.transport("previous track", what: job.args["what"] ?? "", done: done) }
    case "music.shuffle": Music.simple("set shuffle enabled to true\n  if player state is not playing then play", spoken: "Shuffling.", done: done)
    case "volume.up": Music.volume(by: 12, done: done)
    case "volume.down": Music.volume(by: -12, done: done)
    case "open.url": openURL(job.args["url"] ?? "", done: done)
    case "open.app": openApp(job.args["app"] ?? "", done: done)
    default: done(false, "Your Mac can't do that yet.")
    }
  }

  private static func openURL(_ raw: String, done: @escaping (Bool, String) -> Void) {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.contains("://") { s = "https://" + s }
    guard let url = URL(string: s), url.host != nil else { done(false, "That doesn't look like a link I can open."); return }
    Task { @MainActor in
      if !(await Browser.focusOrOpen(s)) { NSWorkspace.shared.open(url) }
      done(true, "Opened \(url.host ?? "it") on your Mac.")
    }
  }

  private static func openApp(_ name: String, done: @escaping (Bool, String) -> Void) {
    let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines)
    Task { @MainActor in
      if let opened = await Native.focus(wanted) { done(true, "Opened \(opened)."); return }
      // Not an app: most things people name are websites ("open instagram").
      let site = wanted.lowercased().replacingOccurrences(of: " ", with: "")
      if !site.isEmpty, site.count <= 30, !wanted.contains(" ") || wanted.contains("."), site.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." }) {
        openURL(site.contains(".") ? site : "www.\(site).com", done: done)
      } else {
        done(false, "\(Music.elsewhere)\(wanted)")
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
  /**
    "Play" after something was paused means carry on with it.

    The model will not fix this and should not be asked to: **"play" is the
    word**. Told to answer with "resume", it still says "play" for "play",
    "play it", "keep playing" and "start it again" — measured, with the song
    and its paused state in front of it — because that is what the word
    means in English, and a rule telling a model to call a thing by a name
    nobody uses is a rule that gets quietly ignored.

    So code decides, which is the rule this app is built on. What arrived
    was `play` with nothing named, and what that meant depended on something
    the model could not see: whether anything was paused. If something was,
    this went to the library and started **shuffling it** — pause your song,
    say "play", and get your whole library on random. The second nudge was
    naming the song again.

    `play` naming the track that is already loaded is the same request
    wearing a name ("play it" comes back as "Vancouver 3"), and re-finding
    it in the library restarts it from the beginning rather than resuming
    where it stopped. Both are the same answer: carry on.
  */
  @MainActor
  static func start(_ what: String, playlistOnly: Bool = false, done: @escaping (Bool, String) -> Void) {
    // Grove paused it, so Grove knows where it is — a video in Chrome or
    // Spotify as readily as Music, which the script below cannot see.
    if what.isEmpty, !playlistOnly, Player.hasPaused {
      Log.say("music: play with nothing named, and something is paused — carrying on")
      Player.transport("play", done: done)
      return
    }
    play(what, playlistOnly: playlistOnly, done: done)
  }

  static func play(_ what: String, playlistOnly: Bool = false, done: @escaping (Bool, String) -> Void) {
    let q = what.replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    let script: String
    if q.isEmpty {
      script = """
      tell application "Music"
        -- Paused, and they said nothing about what to play: carry on. Grove
        -- may not have been the one that paused it — a keyboard key, or a
        -- launch ago — so this is asked of Music rather than remembered.
        if player state is paused then
          play
          delay 0.4
          try
            return "resumed|" & name of current track & "|" & artist of current track
          on error
            return "resumed||"
          end try
        end if
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
        \(playlistOnly ? "" : """
        -- "Play it" and "start it again" come back naming the song that is
        -- already loaded. Finding it in the library again restarts it from
        -- the beginning; what they asked for is where they left off.
        if player state is paused then
          try
            set here to name of current track
            if here contains wanted or wanted contains here then
              play
              delay 0.4
              return "resumed|" & here & "|" & artist of current track
            end if
          end try
        end if
        """)
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
          delay 1
          if player state is not playing then
            play found
            delay 1.5
          end if
          return "playlist|" & name of found & "|" & (player state as text)
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
              delay 1
              if player state is not playing then
                play h
                delay 1.5
              end if
              if player state is not playing then return "stalled|" & name of h
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
    // Once more if it failed: Music still waking up is the usual reason, and
    // the second attempt finds it awake.
    func attempt(_ again: Bool, _ then: @escaping (Bool, String) -> Void) {
      Script.run(script) { ok, out in
        if !ok && again {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { attempt(false, then) }
        } else {
          then(ok, out)
        }
      }
    }
    attempt(true) { ok, out in
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
      // Said to play is not playing, and nothing used to check: a cloud track
      // that would not start was reported as playing. Then it is on YouTube.
      case "stalled": done(true, Music.elsewhere + q)
      case "playlist" where bits.count > 2 && bits[2] != "playing":
        done(false, "Your \(bits[1]) playlist wouldn't start in Music.")
      case "playlist": done(true, "Playing your \(bits.count > 1 ? bits[1] : q) playlist.")
      case "library": done(true, "Shuffling your music.")
      case "resumed":
        let back = bits.count > 1 ? bits[1] : ""
        done(true, back.isEmpty ? "Back on." : "Back on — \(back).")
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
    Script.run("tell application \"Music\"\n\(command)\nend tell") { ok, _ in done(ok, ok ? spoken : "Music wouldn't respond.") }
  }
}
