/*
  The four things Grove needs to be allowed, asked for in one place.

  Accessibility (⌘K: read and replace the highlighted text), Microphone and
  Speech Recognition (the instruction after ⌘K), Automation for Music (playing
  music when the phone asks). macOS asks for each one the first time it is
  used, which on an app with no window means the prompts arrive one at a time,
  at odd moments, and are easy to dismiss — and a dismissed Accessibility
  prompt is never shown again. So the menu has a checklist that shows what is
  granted and asks for, or opens the System Settings pane for, whatever is not.
*/

import AppKit
import ApplicationServices
import AVFoundation
import Speech

enum Permission: CaseIterable {
  case accessibility, microphone, speech, music

  var title: String {
    switch self {
    case .accessibility: return "Accessibility (for ⌘K)"
    case .microphone: return "Microphone"
    case .speech: return "Speech recognition"
    case .music: return "Control Music"
    }
  }

  /** nil when it cannot be known without asking — Automation is like that. */
  var granted: Bool? {
    switch self {
    case .accessibility: return AXIsProcessTrusted()
    case .microphone: return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    case .speech: return SFSpeechRecognizer.authorizationStatus() == .authorized
    case .music: return UserDefaults.standard.bool(forKey: "grove.permission.music") ? true : nil
    }
  }

  /** Ask, if macOS will still ask; otherwise open the pane where it is switched on. */
  func request(done: @escaping () -> Void) {
    switch self {
    case .accessibility:
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      if !AXIsProcessTrustedWithOptions(options) { Permission.open("Privacy_Accessibility") }
      done()
    case .microphone:
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async(execute: done) }
      case .authorized: done()
      default: Permission.open("Privacy_Microphone"); done()
      }
    case .speech:
      switch SFSpeechRecognizer.authorizationStatus() {
      case .notDetermined: SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async(execute: done) }
      case .authorized: done()
      default: Permission.open("Privacy_SpeechRecognition"); done()
      }
    case .music:
      // A harmless question to Music is what makes macOS ask.
      Script.run("tell application \"Music\" to get player state") { ok, _ in
        Log.say("permission: music \(ok ? "allowed" : "not allowed")")
        if ok { UserDefaults.standard.set(true, forKey: "grove.permission.music") } else { Permission.open("Privacy_Automation") }
        done()
      }
    }
  }

  static func open(_ pane: String) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
      NSWorkspace.shared.open(url)
    }
  }

  /** Asks for each missing one in turn, waiting for one answer before the next prompt. */
  static func requestAll(_ list: [Permission] = Permission.allCases, done: @escaping () -> Void) {
    guard let first = list.first else { done(); return }
    if first.granted == true { requestAll(Array(list.dropFirst()), done: done); return }
    Log.say("permission: asking for \(first)")
    first.request { requestAll(Array(list.dropFirst()), done: done) }
  }
}
