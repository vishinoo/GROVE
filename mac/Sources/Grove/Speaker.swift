/*
  Reading aloud on the Mac, for "read me this" said or typed at the Mac.

  The same shape as the phone's reading.ts: the text in short parts and a
  place in it. A part that finishes moves the place on; "stop" or "pause"
  cuts it off and the place stays, so "carry on" repeats the part that was
  interrupted and "write a note on that" has the passage they were hearing
  (`context`, which rides with every decision under "Just now").
*/

import AVFoundation

@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  static let shared = Speaker()
  private let voice = AVSpeechSynthesizer()
  private var title = ""
  private var parts: [String] = []
  private var at = 0
  private var reading = false

  override init() {
    super.init()
    voice.delegate = self
  }

  /** About two sentences a part: short enough to stop mid-thought. */
  static func parts(of text: String) -> [String] {
    let clean = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    var out: [String] = [], part = ""
    clean.enumerateSubstrings(in: clean.startIndex..., options: .bySentences) { s, _, _, _ in
      guard let s else { return }
      if !part.isEmpty && part.count + s.count > 320 { out.append(part.trimmingCharacters(in: .whitespaces)); part = "" }
      part += s
    }
    if !part.trimmingCharacters(in: .whitespaces).isEmpty { out.append(part.trimmingCharacters(in: .whitespaces)) }
    return out
  }

  func start(title: String, text: String) {
    self.title = title
    parts = Speaker.parts(of: text)
    at = 0
    play()
  }

  /** resume, back, restart, next, or stop. False when nothing is being read. */
  @discardableResult
  func steer(_ how: String) -> Bool {
    guard !parts.isEmpty else { return false }
    switch how {
    case "stop", "pause": pause()
    case "back": at = max(0, at - 1); play()
    case "restart": at = 0; play()
    case "next": at = min(parts.count - 1, at + 1); play()
    default: play()
    }
    return true
  }

  func pause() {
    reading = false
    voice.stopSpeaking(at: .immediate)
  }

  var isReading: Bool { reading }

  /** What is being read and the passage "that" means, for the next decision. */
  var context: String {
    guard !parts.isEmpty else { return "" }
    let before = at > 0 ? parts[at - 1] + " " : ""
    return "Reading aloud to them: \"\(title.prefix(100))\", part \(at + 1) of \(parts.count)\(reading ? "" : ", stopped here"). What they were just hearing (\"this\" or \"that\"): \(before.prefix(400))\(parts[at].prefix(500))"
  }

  private func play() {
    guard at < parts.count else { return }
    reading = true
    voice.stopSpeaking(at: .immediate)
    let u = AVSpeechUtterance(string: parts[at])
    u.rate = AVSpeechUtteranceDefaultSpeechRate
    voice.speak(u)
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in
      // Only a part that finished on its own moves the place on.
      guard self.reading else { return }
      if self.at + 1 < self.parts.count { self.at += 1; self.play() } else { self.reading = false }
    }
  }
}
