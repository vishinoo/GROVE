/*
  A plain log at ~/Library/Logs/Grove/grove.log.

  An app with no window has nowhere to say what went wrong, and "⌘K does
  nothing" has five possible causes that all look the same from outside — no
  Accessibility, a tap macOS disabled, an app that would not say what was
  selected, a press that never reached the tap, a panel that never drew. One
  line per event is enough to tell them apart. Kept short: trimmed to the last
  thousand lines on launch.
*/

import Foundation

enum Log {
  static let url: URL = {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Grove")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("grove.log")
  }()

  private static let queue = DispatchQueue(label: "grove.log")
  private static let stamp: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss.SSS"
    return f
  }()

  static func trim() {
    queue.async {
      guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
      let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
      if lines.count > 1000 { try? lines.suffix(1000).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8) }
    }
  }

  static func say(_ line: String) {
    let text = "\(stamp.string(from: Date())) \(line)\n"
    queue.async {
      guard let data = text.data(using: .utf8) else { return }
      if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
      } else {
        try? data.write(to: url)
      }
    }
  }
}
