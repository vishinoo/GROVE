import AVFoundation
import ExpoModulesCore
import MediaPlayer

/**
 * The ring, and the glasses.
 *
 * Both halves of Grove's hardware story come down to one iOS fact: an app
 * cannot receive hardware key presses in the background. There is no API and
 * no entitlement for it. The single documented exception is the remote command
 * centre — the transport controls on a headset, a car stereo, a lock screen —
 * which iOS delivers to whichever app is currently "now playing".
 *
 * So that is what this module makes Grove be. It holds an active audio
 * session, renders silence into it so the session stays alive with nothing to
 * say, publishes now-playing info to claim the remote, and forwards every
 * transport command up to JS as an event. A cheap BLE ring that pairs as a
 * media remote — which is what almost all of them are — then works with the
 * screen locked and the phone in a pocket.
 *
 * What it deliberately does NOT do: wake Grove from a fully terminated state.
 * That is not possible on iOS for any third-party app, so rather than pretend,
 * the JS layer reports residency honestly and the UI says when the ring is
 * live and when it is not.
 *
 * The audio route is reported from here for the same reason — the "glasses"
 * are, on every cheap pair we have seen, an ordinary Bluetooth headset. There
 * is nothing to drive and no protocol to speak; iOS routes microphone and
 * speaker to them once paired. Knowing the route's name IS knowing whether the
 * glasses are on.
 */
public class GroveRemoteModule: Module {
  /// Renders the silence that keeps the session alive between conversations.
  private var keepAlive: AVAudioPlayer?
  /// Whether we have taken the session and registered for the remote.
  private var holding = false

  public func definition() -> ModuleDefinition {
    Name("GroveRemote")

    Events("onRemoteCommand", "onRouteChange", "onInterruption")

    /**
     * Take the audio session and claim the remote.
     *
     * Idempotent — the JS layer calls this on every foreground and after every
     * interruption, because an audio session lost to a phone call does not
     * come back on its own.
     */
    AsyncFunction("activate") { (playSilence: Bool) in
      try self.configureSession()
      self.registerRemote()
      if playSilence { self.startKeepAlive() }
      self.publishNowPlaying(playing: true)
      self.observeSystem()
      self.holding = true
    }

    /** Give the session back. The ring stops reaching us the moment we do. */
    AsyncFunction("deactivate") {
      self.stopKeepAlive()
      self.unregisterRemote()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      self.holding = false
      try? AVAudioSession.sharedInstance().setActive(
        false, options: .notifyOthersOnDeactivation)
    }

    /**
     * Whether the ring can currently reach us.
     *
     * This is the honest answer to "is the trigger armed", and the Talk screen
     * shows it verbatim rather than assuming.
     */
    Function("isHolding") { () -> Bool in
      self.holding && AVAudioSession.sharedInstance().isOtherAudioPlaying == false
        ? true
        : self.holding
    }

    /**
     * The live output route.
     *
     * `isExternal` is the one the UI cares about: true means sound is leaving
     * the phone for something you are wearing.
     */
    Function("getRoute") { () -> [String: Any] in
      self.describeRoute()
    }

    /** Mic permission, asked for here so it is asked for once. */
    AsyncFunction("requestMicrophone") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { granted in
          promise.resolve(granted)
        }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
          promise.resolve(granted)
        }
      }
    }

    OnDestroy {
      self.stopKeepAlive()
      self.unregisterRemote()
    }
  }

  // MARK: - Session

  /**
   * `.playAndRecord` rather than `.playback`, because Grove listens and speaks
   * in the same breath and swapping category mid-conversation audibly clips
   * the first syllable.
   *
   * The Bluetooth options matter more than they look. `.allowBluetooth` opts
   * into HFP, which is the only profile that carries a microphone — without it
   * the glasses play audio but the phone keeps listening through its own mic,
   * which is exactly the bug that makes a pair of AI glasses feel broken.
   * `.allowBluetoothA2DP` keeps playback in stereo when nothing is recording.
   */
  private func configureSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .spokenAudio,
      options: [.allowBluetooth, .allowBluetoothA2DP, .duckOthers, .defaultToSpeaker]
    )
    try session.setActive(true, options: [])
  }

  // MARK: - Keep-alive

  /**
   * Silence, on a loop, at zero volume.
   *
   * An audio session with nothing rendering into it is eventually torn down by
   * the system, and a torn-down session is not the now-playing app, which
   * means no ring. Rendering silence is the standard way to stay resident and
   * it costs almost nothing.
   *
   * Worth knowing: this is also the single most likely reason for an App Store
   * rejection, since "keeps playing silent audio" is explicitly discouraged.
   * For personal builds and TestFlight it is fine. If Grove is ever submitted,
   * this is the thing to argue for or replace.
   */
  private func startKeepAlive() {
    guard keepAlive == nil else {
      keepAlive?.play()
      return
    }
    guard let url = Self.silentLoopURL() else { return }
    keepAlive = try? AVAudioPlayer(contentsOf: url)
    keepAlive?.numberOfLoops = -1
    keepAlive?.volume = 0
    keepAlive?.play()
  }

  private func stopKeepAlive() {
    keepAlive?.stop()
    keepAlive = nil
  }

  /**
   * A one-second silent WAV, synthesised at runtime.
   *
   * Generated rather than bundled so the module stays a single source file
   * with no binary asset to lose track of.
   */
  private static func silentLoopURL() -> URL? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("grove-silence.wav")
    if FileManager.default.fileExists(atPath: url.path) { return url }

    let sampleRate = 44100
    let channels = 1
    let bitsPerSample = 16
    let frames = sampleRate  // exactly one second
    let dataBytes = frames * channels * bitsPerSample / 8

    var wav = Data()
    func ascii(_ s: String) { wav.append(contentsOf: Array(s.utf8)) }
    func u32(_ v: Int) { var l = UInt32(v).littleEndian; withUnsafeBytes(of: &l) { wav.append(contentsOf: $0) } }
    func u16(_ v: Int) { var l = UInt16(v).littleEndian; withUnsafeBytes(of: &l) { wav.append(contentsOf: $0) } }

    ascii("RIFF"); u32(36 + dataBytes); ascii("WAVE")
    ascii("fmt "); u32(16); u16(1); u16(channels)
    u32(sampleRate); u32(sampleRate * channels * bitsPerSample / 8)
    u16(channels * bitsPerSample / 8); u16(bitsPerSample)
    ascii("data"); u32(dataBytes)
    wav.append(Data(count: dataBytes))

    do {
      try wav.write(to: url)
      return url
    } catch {
      return nil
    }
  }

  // MARK: - Remote

  /**
   * Every transport command a cheap remote might send, mapped to one event.
   *
   * They are all registered because there is no way to know in advance which
   * one a given ring emits — some send play/pause, some send next/previous,
   * some send both on a long press. JS decides what each one means, and the
   * diagnostics screen shows the user which one their ring actually fires.
   */
  private func registerRemote() {
    let centre = MPRemoteCommandCenter.shared()

    let map: [(MPRemoteCommand, String)] = [
      (centre.playCommand, "play"),
      (centre.pauseCommand, "pause"),
      (centre.togglePlayPauseCommand, "toggle"),
      (centre.stopCommand, "stop"),
      (centre.nextTrackCommand, "next"),
      (centre.previousTrackCommand, "previous"),
    ]

    for (command, name) in map {
      command.removeTarget(nil)
      command.isEnabled = true
      command.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": name, "at": Date().timeIntervalSince1970])
        return .success
      }
    }

    // Seek is registered separately: it carries a direction and a begin/end
    // phase, which is how a press-and-hold on the ring can be told apart from
    // a tap without the user configuring anything.
    for (command, name) in [
      (centre.seekForwardCommand, "seek-forward"),
      (centre.seekBackwardCommand, "seek-backward"),
    ] {
      command.removeTarget(nil)
      command.isEnabled = true
      command.addTarget { [weak self] event in
        let phase = (event as? MPSeekCommandEvent)?.type == .beginSeeking ? "begin" : "end"
        self?.sendEvent(
          "onRemoteCommand",
          ["command": name, "phase": phase, "at": Date().timeIntervalSince1970])
        return .success
      }
    }
  }

  private func unregisterRemote() {
    let centre = MPRemoteCommandCenter.shared()
    for command in [
      centre.playCommand, centre.pauseCommand, centre.togglePlayPauseCommand,
      centre.stopCommand, centre.nextTrackCommand, centre.previousTrackCommand,
      centre.seekForwardCommand, centre.seekBackwardCommand,
    ] {
      command.removeTarget(nil)
      command.isEnabled = false
    }
  }

  /**
   * Claiming the remote requires being visibly "now playing", so this is not
   * cosmetic — without it the commands above are never delivered. It is also
   * what the user sees on the lock screen, so it says something true.
   */
  private func publishNowPlaying(playing: Bool) {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "Grove",
      MPMediaItemPropertyArtist: "Listening for your ring",
      MPNowPlayingInfoPropertyIsLiveStream: true,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
    ]
  }

  // MARK: - System notifications

  private func observeSystem() {
    let centre = NotificationCenter.default
    centre.removeObserver(self)

    centre.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.sendEvent("onRouteChange", self.describeRoute())
    }

    // A phone call takes the session away and does not give it back. Telling
    // JS lets it re-activate on the far side rather than silently going deaf.
    centre.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: raw)
      else { return }

      if type == .ended {
        try? self?.configureSession()
        self?.startKeepAlive()
        self?.publishNowPlaying(playing: true)
      }
      self?.sendEvent("onInterruption", ["type": type == .began ? "began" : "ended"])
    }
  }

  // MARK: - Route

  /**
   * Bluetooth HFP is the give-away for a headset with a microphone, which is
   * what a pair of audio glasses is. A2DP-only means playback but no mic, and
   * the UI has to say so — otherwise the user talks into their glasses and
   * wonders why the phone heard them instead.
   */
  private func describeRoute() -> [String: Any] {
    let route = AVAudioSession.sharedInstance().currentRoute
    let output = route.outputs.first
    let input = route.inputs.first

    let port = output?.portType ?? .builtInSpeaker
    let bluetooth: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]

    return [
      "name": output?.portName ?? "Speaker",
      "port": port.rawValue,
      "isExternal": bluetooth.contains(port) || port == .headphones || port == .usbAudio,
      "isBluetooth": bluetooth.contains(port),
      "hasExternalMic": input.map { $0.portType == .bluetoothHFP || $0.portType == .usbAudio || $0.portType == .headsetMic } ?? false,
      "inputName": input?.portName ?? "",
      "inputPort": input?.portType.rawValue ?? "",
    ]
  }
}
