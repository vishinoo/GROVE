/*
  AppleScript, always on the main thread.

  NSAppleScript is not safe off the main thread, and the first sign of that
  is the one that matters most: macOS's "allow Grove to control Music?"
  question is never shown, the script fails quietly, and the playlists never
  arrive. So every script here runs on main, and its error number is logged —
  -1743 is "not allowed", which is the answer to switch on in Automation.
*/

import Foundation

enum Script {
  static func run(_ source: String, done: @escaping (Bool, String) -> Void) {
    DispatchQueue.main.async {
      var error: NSDictionary?
      let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
      if let error {
        Log.say("script: failed \(error[NSAppleScript.errorNumber] ?? "?") \(error[NSAppleScript.errorMessage] ?? "")")
        done(false, "")
      } else {
        done(true, result?.stringValue ?? "")
      }
    }
  }
}
