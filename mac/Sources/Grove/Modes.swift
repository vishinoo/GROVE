/*
  Modes: one word that sets the room up.

  "Study mode" is a playlist, a lo-fi video on YouTube, the course site and
  Notion, opened together and closed together. They are made in the Grove
  window (Home.swift), started from there, from ⌘K, or from the phone, and
  ended the same ways.

  Not the modes the phone once had. Those were situations that narrowed what
  Grove would do, and earned their place only when they made a tool wrong;
  they went. These do nothing to Grove at all. They are a list of things to
  open, which is a job the Mac has hands for and the phone does not.

  **Ending one closes what it opened, and only that.** Its pages are in a
  Chrome window of their own, so closing that window touches none of their
  tabs. An app is quit only if the mode launched it: one that was already
  open was theirs before the mode began and stays theirs after it. Music is
  paused only in the player the mode started.

  Started and ended in code. "Study mode" means one thing, and asking a model
  what it meant is a second's wait for an answer that was never in doubt.
*/

import AppKit

struct ModeStep: Codable, Equatable {
  /** playlist, video, site or app. */
  var kind: String
  /** A playlist's name (or a Spotify link), a video's link or search, a site's address, an app's name. */
  var value: String
}

struct Mode: Codable, Equatable {
  var id: String
  var name: String
  var steps: [ModeStep]
  /** Minimise the mode's browser window once its pages are loading, so a video plays without being in the way. */
  /** Quit the apps it launched when it ends. Apps that were already open are never touched. */
  var quitApps: Bool = true
}

@MainActor
enum Modes {
  /** What a running mode opened, so ending it closes exactly that. */
  struct Opened {
    var window: String?
    var apps: [NSRunningApplication] = []
    var player: String?
    var since = Date()
  }

  private(set) static var all: [Mode] = load()
  private(set) static var running: [String: Opened] = [:]
  /** Told whenever the list or what is running changes, so the window redraws. */
  static var onChange: (() -> Void)?

  // MARK: storage

  private static var file: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Grove")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("modes.json")
  }

  private static func load() -> [Mode] {
    guard let data = try? Data(contentsOf: file), let modes = try? JSONDecoder().decode([Mode].self, from: data) else { return [] }
    return modes
  }

  static func save(_ modes: [Mode]) {
    // An empty step is a row somebody added and has not filled in yet: kept
    // on screen, never run.
    all = modes.map { m in
      var m = m
      m.name = m.name.trimmingCharacters(in: .whitespacesAndNewlines)
      return m
    }
    if let data = try? JSONEncoder().encode(all) { try? data.write(to: file, options: .atomic) }
    for id in running.keys where !all.contains(where: { $0.id == id }) { running[id] = nil }
    onChange?()
  }

  // MARK: hearing one

  /**
    "Study mode", "start study", "end study mode", "I'm done with study mode".
    Matched on the whole sentence against the names they made, never a
    word inside a longer one: "what's a good study technique" names no mode.
  */
  static func heard(_ said: String) -> (start: Bool, mode: Mode)? {
    var t = said.lowercased()
      .replacingOccurrences(of: #"[.!?,]+"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"^\s*(ok(ay)?|hey|grove|yo|please|can you|could you|would you|i want(ed)? (you )?to|i'?d like (you )?to|let'?s)\s+"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"\s+(please|now|for me|again|will you|yeah|thanks)\s*$"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    /*
      "Turn study mode on" and "turn study mode off" put the switch after the
      name, which no amount of verbs at the front will catch. Taken off the
      end, and "off" is remembered, because it is the whole of what they said.
    */
    var endingWord = false
    if let r = t.range(of: #"\s+(on|off)$"#, options: .regularExpression) {
      endingWord = t[r].contains("off")
      t = String(t[t.startIndex..<r.lowerBound])
    }
    for mode in all where !mode.name.isEmpty {
      let name = NSRegularExpression.escapedPattern(for: mode.name.lowercased())
        .replacingOccurrences(of: #"\s+mode$"#, with: "", options: .regularExpression)
      /*
        It has to END with the name.

        Anchoring both ends meant only a sentence that was nothing but the
        mode counted, so "activate study mode" and "put on study mode" did
        nothing at all — and the verb list was never going to be complete,
        because there is no end to the ways somebody asks for a thing.

        Ending with it is the rule that generalises: everything in front is
        free, and "what's a good study technique" still names no mode because
        it does not end there. What is required instead is a SIGNAL — the
        word "mode", or a verb of starting or stopping — so that the bare
        word "study" on its own is never a command.
      */
      let tail = #"(?:^|\s)(?:the\s+|my\s+)?"# + name + #"(?:\s+mode)?$"#
      guard t.range(of: tail, options: .regularExpression) != nil else { continue }
      let stopping = endingWord || t.range(
        of: #"^(?:end|stop|close|exit|leave|quit|turn off|shut off|kill|finish|get out of|i'?m done with|done with|that'?s enough)\b"#,
        options: .regularExpression) != nil
      if stopping { return (false, mode) }
      let starting = t.contains("mode") || t.range(
        of: #"^(?:start|begin|enter|open|launch|activate|initiali[sz]e|go into|get into|switch to|switch on|turn on|put me in|put on|throw on|fire up|kick off|set up|do|run|time for|get me in(?:to)?)\b"#,
        options: .regularExpression) != nil
      if starting { return (true, mode) }
    }
    return nil
  }

  /**
    A goal the phone wrote ("Start study mode on the Mac") rather than words
    somebody said. Looser, because it is the phone's sentence, but it still
    needs "<name> mode" said out in full.
  */
  static func inGoal(_ goal: String) -> (start: Bool, mode: Mode)? {
    let t = goal.lowercased()
    for mode in all where !mode.name.isEmpty {
      let name = mode.name.lowercased().replacingOccurrences(of: #"\s+mode$"#, with: "", options: .regularExpression)
      guard t.range(of: #"\b"# + NSRegularExpression.escapedPattern(for: name) + #"\s+mode\b"#, options: .regularExpression) != nil else { continue }
      let ending = t.range(of: #"\b(end|stop|close|exit|leave|quit|turn off|finish)\b"#, options: .regularExpression) != nil
      return (!ending, mode)
    }
    return nil
  }

  // MARK: running one

  /** Set by main.swift: a mode step that is neither a page nor an app goes to the browser agent. */
  nonisolated(unsafe) static var onGoal: ((String) -> Void)?

  static func isRunning(_ id: String) -> Bool { running[id] != nil }

  /**
    What it says when a mode comes on.

    "Study mode is on." is a receipt, and this is the one moment in the whole
    feature somebody is watching — they said a word and four things happened
    at once. A line with some life in it is most of what makes that land.

    Written here rather than asked of the model: it has to arrive at the same
    instant the tabs do, and a round trip to say one sentence would put a
    second of nothing between the word and the room changing. Picked by the
    clock and the mode's own name so it is not the same line every time.
  */
  private static func quip(for mode: Mode, opened: Int) -> String {
    let name = mode.name.replacingOccurrences(of: #"(?i)\s*mode$"#, with: "", options: .regularExpression)
    let hour = Calendar.current.component(.hour, from: Date())
    let lines: [String]
    switch hour {
    case 5..<12: lines = ["\(name) mode. Right, let's get on with it.", "\(name) mode is up. Morning's yours.", "\(name) mode. Everything's where you left it."]
    case 12..<18: lines = ["\(name) mode. Go on then.", "\(name) mode is on. No excuses now.", "\(name) mode. The room's ready."]
    case 18..<23: lines = ["\(name) mode. Evening shift it is.", "\(name) mode is on. Settle in.", "\(name) mode. Lights down, let's go."]
    default: lines = ["\(name) mode, at this hour. Respect.", "\(name) mode. You and the small hours again.", "\(name) mode is on. I won't tell anyone."]
    }
    // Steady for a given mode within the hour, so saying it twice in a row is
    // not Grove performing; different tomorrow, which is the point of having
    // more than one.
    let n = abs(name.hashValue &+ hour &+ opened) % lines.count
    return lines[n]
  }

  /** Opens everything in it. The sentence to say afterwards. */
  static func start(_ mode: Mode) async -> String {
    if running[mode.id] != nil { await stop(mode) }
    let steps = mode.steps.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }
    guard !steps.isEmpty else { return "\(mode.name) has nothing in it yet." }
    var opened = Opened()
    var failed: [String] = []
    Log.say("mode: starting \(mode.name), \(steps.count) things")

    // Pages first, all into one window of its own.
    for step in steps where step.kind == "do" {
      let want = step.value.lowercased()
      if want.range(of: #"\bclose\b.*\btabs?\b"#, options: .regularExpression) != nil {
        /*
          The OTHER tabs in the front window. Not windows, never all of them,
          and before this mode has opened anything.

          **The order is the fix.** This ran after the pages, so by the time
          it looked, the front window was the one the mode had just made —
          and "close the other tabs in the front window" closed the mode's
          own. Study mode opened their Canvas and then shut it, which from
          outside is Grove undoing itself at random.

          The comment here already claimed it ran first. It did not. A
          comment that asserts an ordering the code does not have is worse
          than no comment, because the next person reads it instead of the
          code — so the two are now in the same place and `npm run verify`
          checks which comes first.

          The first version of this closed every Chrome window, which is not
          "close my other tabs", it is closing the thing they were working
          in — and it did exactly that: a mode opened a new tab and shut the
          one they were on. A step meant to tidy up cannot be allowed to
          take somebody's session with it.

          One window, its active tab kept, nothing else touched. Anything
          they had in another window is theirs and stays.
        */
        Script.run("""
        tell application "Google Chrome"
          if it is running and (count of windows) > 0 then
            set w to front window
            set keep to active tab index of w
            repeat with i from (count of tabs of w) to 1 by -1
              if i is not keep then
                try
                  close tab i of w
                end try
              end if
            end repeat
          end if
        end tell
        """) { _, _ in }
      } else if want.range(of: #"\b(do not disturb|dnd|focus|silence|quiet)\b"#, options: .regularExpression) != nil {
        Script.run("tell application \"System Events\" to keystroke \"d\" using {command down, option down, control down}") { _, _ in }
      } else if !step.value.trimmingCharacters(in: .whitespaces).isEmpty {
        // Anything else: the agent, which has hands for the rest of it.
        onGoal?(step.value)
      }
    }

    let pages = steps.filter { $0.kind == "site" || $0.kind == "video" }.compactMap { address(for: $0) }
    if !pages.isEmpty {
      if let window = await openWindow(pages) {
        opened.window = window
        /*
          Land on the first page it opened.

          A mode opens four tabs and Chrome leaves you on whichever loaded
          last, which is nobody's choice — the first one is the one they put
          at the top of the list.
        */
        Script.run("""
        tell application "Google Chrome"
          set w to (first window whose id is \(window))
          set active tab index of w to 1
          set index of w to 1
          activate
        end tell
        """) { _, _ in }
      } else {
        // No Chrome, or it would not answer: open them anyway, in whatever
        // browser is the default. Ending the mode cannot close those.
        for page in pages { if let url = URL(string: page) { NSWorkspace.shared.open(url) } }
      }
    }

    /*
      Things to do, as well as things to open.

      "Close my other Chrome tabs" is the one everybody wants from a study
      mode and it is not a page or an app, so there was nowhere to put it.
      The handful that are worth having run here in code, instantly and
      predictably; anything else is handed to the browser agent, which can
      do a great deal more and takes a great deal longer.

      Run before the pages open, so "close my other tabs" closes THEIRS and
      not the four this mode just put up.
    */
    for step in steps where step.kind == "app" {
      guard let url = Native.locate(step.value) else { failed.append(step.value); continue }
      let id = Bundle(url: url)?.bundleIdentifier
      let already = id.map { !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty } ?? false
      let config = NSWorkspace.OpenConfiguration()
      config.activates = false
      let app: NSRunningApplication? = await withCheckedContinuation { done in
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, _ in done.resume(returning: app) }
      }
      if app == nil { failed.append(step.value) } else if !already, let app { opened.apps.append(app) }
    }

    // Music last, so it starts once the room is already set up.
    if let step = steps.last(where: { $0.kind == "playlist" }) {
      let (ok, player) = await play(step.value)
      if ok { opened.player = player } else { failed.append(step.value) }
    }

    running[mode.id] = opened
    onChange?()
    if failed.isEmpty { return quip(for: mode, opened: steps.count) }
    return "\(mode.name) mode is on, but I couldn't open \(failed.joined(separator: " or "))."
  }

  /** Closes what it opened. The sentence to say afterwards. */
  static func stop(_ mode: Mode) async -> String {
    guard let opened = running[mode.id] else { return "\(mode.name) mode wasn't on." }
    running[mode.id] = nil
    Log.say("mode: ending \(mode.name)")
    if let window = opened.window {
      _ = await run("tell application \"Google Chrome\" to close (every window whose id is \(window))")
    }
    if let player = opened.player {
      _ = await run("if application \"\(player)\" is running then tell application \"\(player)\" to pause")
    }
    if mode.quitApps { for app in opened.apps where !app.isTerminated { app.terminate() } }
    onChange?()
    return "\(mode.name) mode is off."
  }

  // MARK: pieces

  /** Where a page step goes. A video that is not a link is a YouTube search, which is one click from the video. */
  static func address(for step: ModeStep) -> String? {
    var v = step.value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !v.isEmpty else { return nil }
    if step.kind == "video", !v.contains("."), !v.contains("://") {
      let q = v.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? v
      return "https://www.youtube.com/results?search_query=\(q)"
    }
    if !v.contains("://") { v = "https://" + v }
    return URL(string: v)?.host != nil ? v : nil
  }

  private static func quoted(_ s: String) -> String {
    "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }

  private static func run(_ source: String) async -> (Bool, String) {
    await withCheckedContinuation { done in Script.run(source) { ok, out in done.resume(returning: (ok, out)) } }
  }

  /**
    A new Chrome window holding the pages, without bringing Chrome forward:
    a mode is set up beside whatever they are doing, not on top of it. Its id
    is what ending the mode closes.
  */
  private static func openWindow(_ pages: [String]) async -> String? {
    guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") != nil else { return nil }
    var lines = ["set w to make new window", "set URL of active tab of w to \(quoted(pages[0]))"]
    for page in pages.dropFirst() { lines.append("make new tab at end of tabs of w with properties {URL:\(quoted(page))}") }
    lines.append("set active tab index of w to 1")
    lines.append("return id of w as text")
    let (ok, out) = await run("tell application \"Google Chrome\"\n" + lines.joined(separator: "\n") + "\nend tell")
    return ok && !out.isEmpty ? out : nil
  }

  /** A Spotify link plays in Spotify; anything else is a playlist in Music. The player it used. */
  private static func play(_ value: String) async -> (Bool, String) {
    let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if let uri = spotifyURI(v) {
      let (ok, _) = await run("tell application \"Spotify\"\nplay track \(quoted(uri))\nend tell")
      return (ok, "Spotify")
    }
    let ok: Bool = await withCheckedContinuation { done in Music.start(v, playlistOnly: true) { ok, said in done.resume(returning: ok && !said.hasPrefix(Music.elsewhere)) } }
    return (ok, "Music")
  }

  /** open.spotify.com/playlist/ID or spotify:playlist:ID, as the URI Spotify's script wants. */
  static func spotifyURI(_ v: String) -> String? {
    if v.hasPrefix("spotify:") { return v }
    guard let url = URL(string: v), url.host?.hasSuffix("spotify.com") == true else { return nil }
    let parts = url.pathComponents.filter { $0 != "/" && !$0.hasPrefix("intl-") }
    guard parts.count >= 2 else { return nil }
    return "spotify:\(parts[0]):\(parts[1])"
  }

  /** The tabs in their front Chrome window, for "add what's open now". */
  static func frontTabs() async -> [String] {
    let (ok, out) = await run("tell application \"Google Chrome\"\nif (count of windows) is 0 then return \"\"\nset AppleScript's text item delimiters to linefeed\nreturn (URL of every tab of front window) as text\nend tell")
    guard ok else { return [] }
    return out.split(separator: "\n").map(String.init).filter { $0.hasPrefix("http") }
  }

  /** Names of the apps on this Mac, for the app field's suggestions. */
  static func appNames() -> [String] {
    let fm = FileManager.default
    let dirs = ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"]
    let names = dirs.flatMap { (try? fm.contentsOfDirectory(atPath: $0)) ?? [] }
      .filter { $0.hasSuffix(".app") }
      .map { String($0.dropLast(4)) }
    return Array(Set(names)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
  }
}
