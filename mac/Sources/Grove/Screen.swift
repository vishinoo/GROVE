/*
  The words in front of them, for reading aloud, and a note written down.

  "Read me this" means whatever they are looking at, and the most specific
  thing first: the text they selected, then the readable part of the page or
  document from where they are scrolled, then the focused window's text. In
  Chrome the page is read with JavaScript, which knows what is an article
  and what is a menu; anywhere else Accessibility gives the selection or the
  focused text. Nothing is kept: the words go to whoever reads them out.
*/

import AppKit
import ApplicationServices

enum Screen {
  /** A title to say what it is, and the text. Empty text when nothing readable is in front. */
  @MainActor
  static func capture() async -> (title: String, text: String) {
    guard let front = NSWorkspace.shared.frontmostApplication else { return ("", "") }
    if front.bundleIdentifier == "com.google.Chrome" {
      let (ok, out) = await Browser.run("""
      tell application "Google Chrome" to execute active tab of front window javascript "(function(){var s=String(window.getSelection()||'').trim();if(s.length>20)return document.title+'\\\\u0001'+s;var m=document.querySelector('article,main,[role=main]')||document.body;var t=(m.innerText||'').replace(/[ \\\\t]+/g,' ');var top=document.elementFromPoint(innerWidth/2,Math.min(120,innerHeight/3)),at=0;for(var k=0;k<4&&top&&!at;k++,top=top.parentElement){var p=(top.innerText||'').trim().slice(0,40);if(p.length>8){var i=t.indexOf(p);if(i>0)at=i;}}return document.title+'\\\\u0001'+t.slice(at,at+20000);})()"
      """)
      if ok, let cut = out.firstIndex(of: "\u{1}") {
        return (String(out[..<cut]), String(out[out.index(after: cut)...]))
      }
    }
    // Anywhere else: the selection, or the focused element's text.
    let app = AXUIElementCreateApplication(front.processIdentifier)
    var focused: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let element = focused {
      for attribute in [kAXSelectedTextAttribute, kAXValueAttribute] {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(element as! AXUIElement, attribute as CFString, &value) == .success,
           let text = value as? String, text.trimmingCharacters(in: .whitespacesAndNewlines).count > 20 {
          return (front.localizedName ?? "", String(text.prefix(20000)))
        }
      }
    }
    return (front.localizedName ?? "", "")
  }

  /** Into Apple Notes, in a folder of Grove's own, so its notes are easy to find and never mixed into a folder of theirs. */
  static func note(_ text: String, title: String, done: @escaping (Bool, String) -> Void) {
    func html(_ s: String) -> String {
      s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "<br>")
    }
    let heading = title.isEmpty ? String(text.prefix(60)) : title
    Script.run("""
    tell application "Notes"
      if not (exists folder "Grove") then make new folder with properties {name:"Grove"}
      make new note at folder "Grove" with properties {body:"<h1>\(html(heading))</h1><p>\(html(text))</p>"}
    end tell
    return "ok"
    """) { ok, out in
      done(ok, ok ? "Noted." : (out.lowercased().contains("not allowed") || out.lowercased().contains("not authori")
        ? "Your Mac hasn't let me use Notes. System Settings, Privacy and Security, Automation: under Grove, turn on Notes."
        : "Notes wouldn't take it."))
    }
  }
}
