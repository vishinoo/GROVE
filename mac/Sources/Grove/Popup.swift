/*
  The reaction GIF, as its own little window in the corner of the screen.

  Not on the notch's card: the card is for what happened, and closes when
  that has been read. The GIF is for fun, so it sits out of the way above
  everything, plays for a while, and goes. A click sends it away early. It
  never takes focus, so it cannot steal a keystroke from whatever is in front.
*/

import AppKit

@MainActor
enum Popup {
  private static var panel: NSPanel?
  private static var timer: Timer?

  /*
    How often a face may appear, enforced here because here is the only place
    every one of them passes through.

    The rule was written down as "one a minute at most, never over a reaction
    already up" and lived in `reactToPhone` — one of five callers. A remark,
    a song, a finished task and any answer carrying a `gif` all reached
    `react()` directly with no spacing at all, which is why saying hello a few
    times produced a wall of them.

    A window is the thing that knows whether a window is already up, so the
    spacing belongs to the window rather than to each of the things that
    might want one.
  */
  private static var lastShown = Date.distantPast
  private static let apart: TimeInterval = 60

  /** Whether a face would be allowed right now. Asked before the search, to save it. */
  static var welcome: Bool {
    panel == nil && Date().timeIntervalSince(lastShown) > apart
  }
  static let seconds: TimeInterval = 12

  static func show(_ address: String) async {
    // The gate, on the way in rather than at each caller. A reaction still up
    // is never replaced: the second one would be the first one being
    // interrupted, which is the opposite of what a reaction is for.
    guard welcome else {
      Log.say("gif: not shown — \(panel == nil ? "too soon after the last" : "one is already up")")
      return
    }
    lastShown = Date()
    guard let url = URL(string: address),
          let (data, _) = try? await URLSession.shared.data(from: url),
          let image = NSImage(data: data), image.size.width > 0 else { Log.say("gif: could not load \(address.prefix(80))"); return }
    close(animated: false)

    // About 240 wide, never taller than 240.
    let scale = min(240 / image.size.width, 240 / image.size.height)
    let size = NSSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
    // The screen with the notch, beside the panel it comes from; the main one without.
    let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? NSScreen.screens[0]
    let area = screen.visibleFrame
    let frame = NSRect(x: area.maxX - size.width - 20, y: area.minY + 20, width: size.width, height: size.height)

    let p = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    p.hidesOnDeactivate = false

    let view = ClickImage(frame: NSRect(origin: .zero, size: size))
    view.image = image
    view.animates = true
    view.imageScaling = .scaleProportionallyUpOrDown
    view.wantsLayer = true
    view.layer?.cornerRadius = 16
    view.layer?.masksToBounds = true
    view.onClick = { MainActor.assumeIsolated { close(animated: true) } }
    p.contentView = view

    p.alphaValue = 0
    p.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; p.animator().alphaValue = 1 }, completionHandler: nil)
    panel = p
    Log.say("gif: showing at \(Int(frame.minX)),\(Int(frame.minY)) on a \(Int(area.width))-wide screen")
    timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
      Task { @MainActor in close(animated: true) }
    }
  }

  static func close(animated: Bool) {
    timer?.invalidate()
    timer = nil
    guard let p = panel else { return }
    panel = nil
    guard animated else { p.orderOut(nil); return }
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; p.animator().alphaValue = 0 }, completionHandler: { p.orderOut(nil) })
  }
}

private final class ClickImage: NSImageView {
  var onClick: (() -> Void)?
  override func mouseDown(with event: NSEvent) { onClick?() }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
