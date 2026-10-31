/*
  What is going on on the Mac right now, in a few lines, for the model.

  A friend in the room can see what you are doing; Grove could not, so "what
  do you think of this song" was answered from whatever happened to be on the
  clipboard, because a word gate decided "this" meant the clipboard. The model
  is better at deciding what "this" means than any word list, as long as it is
  told what is there: the app in front and its window, and the song playing.

  Cheap on purpose, since it rides on every ask: a few hundred characters, no
  screenshot, nothing read from inside a window except its title. Music is
  only asked when it is already running, because asking launches it.
*/

import AppKit
import ApplicationServices

struct Now {
  var app = ""
  var window = ""
  var song = ""
  var playing = false

  /** One short block for a prompt. Empty when there is nothing to say. */
  var text: String {
    var lines: [String] = []
    if !app.isEmpty { lines.append("In front: \(app)\(window.isEmpty || window == app ? "" : " — \(window)")") }
    if !song.isEmpty { lines.append("\(playing ? "Playing" : "Paused") in Music: \(song)") }
    return lines.joined(separator: "\n")
  }

  /** What would make a fresh remark worth making: a different song, or different work. */
  var signature: String { "\(app)|\(window.prefix(40))|\(playing ? song : "")" }
}

enum Context {
  @MainActor
  static func now() async -> Now {
    var now = Now()
    if let front = NSWorkspace.shared.frontmostApplication {
      now.app = front.localizedName ?? ""
      now.window = String(windowTitle(pid: front.processIdentifier).prefix(120))
    }
    let musicRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.apple.Music" }
    if musicRunning {
      let out = await script(#"tell application "Music" to if player state is not stopped then return (player state as text) & "|" & (name of current track) & "|" & (artist of current track) & "|" & (genre of current track)"#)
      let bits = out.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      if bits.count == 4, !bits[1].isEmpty {
        now.playing = bits[0] == "playing"
        now.song = "\u{201C}\(bits[1])\u{201D} by \(bits[2])\(bits[3].isEmpty ? "" : " (\(bits[3]))")"
      }
    }
    return now
  }

  /** The focused window's title, through Accessibility, which Grove already has for ⌘K. */
  private static func windowTitle(pid: pid_t) -> String {
    let app = AXUIElementCreateApplication(pid)
    var window: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success, let window else { return "" }
    var title: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return "" }
    return (title as? String) ?? ""
  }

  private static func script(_ source: String) async -> String {
    await withCheckedContinuation { done in Script.run(source) { ok, out in done.resume(returning: ok ? out : "") } }
  }
}
