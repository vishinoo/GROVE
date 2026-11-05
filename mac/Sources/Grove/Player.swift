/*
  Pause, play, next and back, on whatever is actually playing.

  "Pause" used to mean Apple Music, then Apple Music or a video in Chrome, and
  said "Paused." either way, so a song in Spotify, Safari or anything else
  played on while Grove reported success, with nothing in the log to show it.
  Now each place that can be asked is asked, in order of how sure the answer
  is: Music, video in Chrome, Spotify. If none of them is playing but the Mac
  is still making sound, the system's own play/pause key is pressed, which
  reaches whichever app owns Now Playing. If nothing is making sound, it says
  so rather than claiming to have paused something.

  "Play" resumes whatever this paused, so "pause" then "carry on" is the same
  song in the same place.
*/

import AppKit
import CoreAudio

enum Player {
  private enum Source: String { case music, chrome, spotify, system }
  nonisolated(unsafe) private static var paused: Source?
  /** Something here paused something, so "play" with nothing named means carry on with it. */
  static var hasPaused: Bool { paused != nil }

  @MainActor
  static func transport(_ command: String, done: @escaping (Bool, String) -> Void) {
    Task { @MainActor in
      let result = await act(command)
      Log.say("player: \(command) → \(result.said)")
      done(result.ok, result.said)
    }
  }

  @MainActor
  private static func act(_ command: String) async -> (ok: Bool, said: String) {
    switch command {
    case "pause":
      if await appPlaying("Music") { _ = await tell("Music", "pause"); paused = .music; return (true, "Paused.") }
      if await Browser.everyTab(video("pause")) { paused = .chrome; return (true, "Paused.") }
      if await appPlaying("Spotify") { _ = await tell("Spotify", "pause"); paused = .spotify; return (true, "Paused.") }
      if soundPlaying() { mediaKey(16); paused = .system; return (true, "Paused.") }
      return (true, "Nothing's playing.")
    case "play":
      let from = paused
      paused = nil
      switch from {
      case .chrome: if await Browser.everyTab(video("play")) { return (true, "Playing.") }
      case .spotify: _ = await tell("Spotify", "play"); return (true, "Playing.")
      case .system: mediaKey(16); return (true, "Playing.")
      default: break
      }
      return await tell("Music", "play") ? (true, "Playing.") : (false, "Music wouldn't respond.")
    default:
      let next = command == "next track"
      if await appPlaying("Music") { _ = await tell("Music", command); return (true, next ? "Skipped." : "Back one.") }
      if await Browser.everyTab(video(next ? "next" : "previous")) { return (true, next ? "Skipped." : "Back one.") }
      if await appPlaying("Spotify") { _ = await tell("Spotify", command); return (true, next ? "Skipped." : "Back one.") }
      if soundPlaying() { mediaKey(next ? 17 : 18); return (true, next ? "Skipped." : "Back one.") }
      return (true, "Nothing's playing.")
    }
  }

  /**
    What is playing, as words another player could search for: the song in
    Music, or the title of a video playing in Chrome without the site's name.
    Empty when nothing is.
  */
  @MainActor
  static func nowPlaying() async -> String {
    if NSWorkspace.shared.runningApplications.contains(where: { $0.localizedName == "Music" }) {
      let (ok, out) = await Browser.run("tell application \"Music\" to if player state is not stopped then return (name of current track) & \" \" & (artist of current track)")
      if ok, !out.isEmpty { return out }
    }
    let (ok, out) = await Browser.run("""
    tell application "Google Chrome"
      if not running then return ""
      repeat with w in windows
        repeat with t in tabs of w
          if (URL of t) starts with "http" then
            try
              with timeout of 2 seconds
                set r to execute t javascript "(function(){var v=Array.from(document.querySelectorAll('video,audio')).find(function(e){return !e.paused;});return v?document.title:'';})()"
              end timeout
              if r is not "" then return r
            end try
          end if
        end repeat
      end repeat
      return ""
    end tell
    """)
    guard ok else { return "" }
    return out.replacingOccurrences(of: #"^\(\d+\)\s*|\s*[-–|]\s*YouTube.*$"#, with: "", options: .regularExpression)
  }

  /** Only asked when it is running: asking an app that is closed opens it. */
  @MainActor
  private static func appPlaying(_ app: String) async -> Bool {
    guard NSWorkspace.shared.runningApplications.contains(where: { $0.localizedName == app }) else { return false }
    let (ok, state) = await Browser.run("tell application \"\(app)\" to get player state as text")
    if !ok || state != "playing" { Log.say("player: \(app) says \(ok ? state : "nothing (failed)")") }
    return ok && state == "playing"
  }

  private static func tell(_ app: String, _ command: String) async -> Bool {
    await Browser.run("tell application \"\(app)\"\n\(command)\nend tell").0
  }

  /** A playing video or audio element in a tab, acted on; "hit" when there was one. */
  private static func video(_ what: String) -> String {
    switch what {
    case "pause": return "(function(){var v=Array.from(document.querySelectorAll('video,audio')).find(function(e){return !e.paused;});if(v){v.pause();return 'hit';}return '';})()"
    case "play": return "(function(){var v=Array.from(document.querySelectorAll('video,audio')).find(function(e){return e.paused&&e.currentTime>0;});if(v){v.play();return 'hit';}return '';})()"
    default:
      let button = what == "next" ? ".ytp-next-button" : ".ytp-prev-button"
      return "(function(){var v=Array.from(document.querySelectorAll('video,audio')).find(function(e){return !e.paused;});var b=document.querySelector('\(button)');if(v&&b){b.click();return 'hit';}return '';})()"
    }
  }

  /** Whether anything is coming out of the speakers at all. */
  private static func soundPlaying() -> Bool {
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return false }
    var running = UInt32(0)
    size = UInt32(MemoryLayout<UInt32>.size)
    address.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
  }

  /** The keyboard's own media key: 16 play/pause, 17 next, 18 previous. */
  @MainActor
  private static func mediaKey(_ key: Int32) {
    for down in [true, false] {
      let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
      let data1 = Int((key << 16) | ((down ? 0xA : 0xB) << 8))
      NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0,
                         context: nil, subtype: 8, data1: data1, data2: -1)?.cgEvent?.post(tap: .cghidEventTap)
    }
  }
}
