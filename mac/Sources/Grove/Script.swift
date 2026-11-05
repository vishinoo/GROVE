/*
  AppleScript, always on the main thread, and never one-shot.

  NSAppleScript is not safe off the main thread, and the first sign of that
  is the one that matters most: macOS's "allow Grove to control Music?"
  question is never shown, the script fails quietly, and the playlists never
  arrive. So every script here runs on main, and its error number is logged —
  -1743 is "not allowed", which is the answer to switch on in Automation.

  **And some of these failures mean "ask again", not "no".** A scripting
  connection to an app goes stale — the app was relaunched, or was still
  coming up when we spoke to it — and the answer is -609 "Connection is
  invalid", or -600 "Application isn't running", or a timeout. Every one of
  them works on the next attempt, which is why the symptom was never a
  failure anyone saw: it was being told to pause the music and having to say
  it again, with nothing on screen either time to say why.

  That is the whole of it, measured in a real log — a -609 on Music at
  12:57:35, and fourteen seconds later the person typing "can you initialize
  my music please". One request, one failure, one silence, one second nudge.

  Retried exactly the way every network call here already is, including the
  exclusions: never on -1743, which is a permission and would fail
  identically, and never on a syntax error or a missing object, where the
  second attempt only doubles the wait before the same honest answer.
*/

import Foundation

enum Script {
  /**
    Errors that mean the app was not ready, rather than that it said no.

    -600 the app is not running (or was still launching), -609 the scripting
    connection is stale, -1712 the Apple event timed out, -1708 it did not
    handle the event yet. Deliberately short: anything not on this list is
    treated as a real answer, because retrying a real answer is how a
    one-second failure becomes a two-second one.
  */
  static let worthAnotherGo: Set<Int> = [-600, -609, -1708, -1712]

  static func run(_ source: String, done: @escaping (Bool, String) -> Void) {
    attempt(source, again: true, done: done)
  }

  private static func attempt(_ source: String, again: Bool, done: @escaping (Bool, String) -> Void) {
    DispatchQueue.main.async {
      var error: NSDictionary?
      let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
      guard let error else {
        done(true, result?.stringValue ?? "")
        return
      }
      let number = (error[NSAppleScript.errorNumber] as? Int) ?? 0
      let message = "\(error[NSAppleScript.errorMessage] ?? "")"
      if again, worthAnotherGo.contains(number) {
        Log.say("script: \(number) \(message.prefix(80)) — not ready, trying once more")
        // Long enough for an app that is launching to finish doing it, short
        // enough that nobody waiting on a pause notices the difference.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
          attempt(source, again: false, done: done)
        }
        return
      }
      Log.say("script: failed \(number) \(message)")
      done(false, message)
    }
  }
}
