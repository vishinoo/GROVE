import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

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
  /// Tokens for the block-based notification observers, so they can actually
  /// be removed again. See observeSystem().
  private var observers: [NSObjectProtocol] = []

  /// Offscreen, and present for two reasons: it is the only public way to set
  /// the system volume, and having one in the hierarchy suppresses the volume
  /// HUD that would otherwise flash on every trigger press.
  private var volumeView: MPVolumeView?
  private var volumeObservation: NSKeyValueObservation?
  private var volumeTriggerOn = false
  /// The level we return to after each press, so there is always room to go
  /// down again. Kept off both ends of the range for that reason.
  private var volumeAnchor: Float = 0.5
  /// Our own correction changes the volume too. Without a blind window it
  /// reads back as the user turning it up.
  private var ignoreVolumeUntil = Date.distantPast

  private static let anchorFloor: Float = 0.15
  private static let anchorCeiling: Float = 0.85

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
      self.stopObserving()
      DispatchQueue.main.async { self.stopVolumeTrigger() }
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
      // Whether we still hold the session, which is all we can honestly know.
      // This used to read `holding && !isOtherAudioPlaying ? true : holding`,
      // which is just `holding` — the isOtherAudioPlaying test could not
      // change the result and only implied a check that was never happening.
      // Losing the now-playing role to another app is not observable here; JS
      // re-arms on every foreground for exactly that reason.
      self.holding
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

    /**
     * The volume-button trigger — a last resort for rings that send no
     * transport commands at all.
     *
     * Some cheap remotes emit only `VolumeDown`, which iOS swallows into the
     * system volume HUD and never delivers to an app. The press is invisible,
     * but its *effect* is not: `outputVolume` changes. Watching that turns an
     * otherwise unreachable button into a usable trigger.
     *
     * Opt-in, and it has to be, because it is genuinely lossy: it takes
     * volume-down away from the user, and the phone's own volume-down button
     * fires it too. There is no way to tell the two apart — all iOS reports is
     * the new level, never who caused it.
     */
    AsyncFunction("setVolumeTrigger") { (enabled: Bool) in
      DispatchQueue.main.async {
        if enabled { self.startVolumeTrigger() } else { self.stopVolumeTrigger() }
      }
    }

    Function("isVolumeTriggerOn") { () -> Bool in
      self.volumeTriggerOn
    }

    /**
     * Play something from the user's own music library.
     *
     * `systemMusicPlayer` rather than `applicationMusicPlayer`, deliberately:
     * the system player is the one the lock screen, the ring and CarPlay all
     * control, and it keeps playing when Grove is backgrounded. The application
     * player stops with the app, which is useless for something you talk to
     * with the phone in your pocket.
     *
     * Searched across song, artist, album and playlist because "play my
     * favourite song" and "put on the Sunday playlist" arrive the same way and
     * a person does not distinguish them.
     */
    AsyncFunction("playMusic") { (query: String, promise: Promise) in
      DispatchQueue.main.async {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else {
          promise.resolve(["ok": false, "reason": "empty"])
          return
        }

        MPMediaLibrary.requestAuthorization { status in
          DispatchQueue.main.async {
            guard status == .authorized else {
              promise.resolve(["ok": false, "reason": "denied"])
              return
            }
            promise.resolve(self.startPlayback(matching: wanted))
          }
        }
      }
    }

    AsyncFunction("controlMusic") { (action: String, promise: Promise) in
      DispatchQueue.main.async {
        let player = MPMusicPlayerController.systemMusicPlayer
        switch action {
        case "pause": player.pause()
        case "play": player.play()
        case "next": player.skipToNextItem()
        case "previous": player.skipToPreviousItem()
        default: break
        }
        promise.resolve(["ok": true, "title": player.nowPlayingItem?.title ?? ""])
      }
    }

    Function("nowPlaying") { () -> [String: Any] in
      let item = MPMusicPlayerController.systemMusicPlayer.nowPlayingItem
      return [
        "title": item?.title ?? "",
        "artist": item?.artist ?? "",
        "playing": MPMusicPlayerController.systemMusicPlayer.playbackState == .playing,
      ]
    }

    OnDestroy {
      self.stopKeepAlive()
      self.unregisterRemote()
      self.stopObserving()
      self.stopVolumeTrigger()
    }
  }

  // MARK: - Music

  /**
   * Finds the best match for a spoken phrase and plays it.
   *
   * Tried in order of how specific the match is: a playlist named outright, then
   * a song, then an artist, then an album. Songs before artists because "play
   * Yesterday" means the track, and artists before albums because people name
   * the artist far more often than the record.
   */
  private func startPlayback(matching wanted: String) -> [String: Any] {
    let player = MPMusicPlayerController.systemMusicPlayer

    let attempts: [(MPMediaItemProperty: String, grouping: MPMediaGrouping)] = [
      (MPMediaPlaylistPropertyName, .playlist),
      (MPMediaItemPropertyTitle, .title),
      (MPMediaItemPropertyArtist, .artist),
      (MPMediaItemPropertyAlbumTitle, .album),
    ]

    for attempt in attempts {
      let predicate = MPMediaPropertyPredicate(
        value: wanted,
        forProperty: attempt.MPMediaItemProperty,
        comparisonType: .contains
      )
      let query = MPMediaQuery(filterPredicates: [predicate])
      query.groupingType = attempt.grouping

      guard let items = query.items, !items.isEmpty else { continue }

      player.setQueue(with: MPMediaItemCollection(items: items))
      // Shuffling a named song would play something else; shuffling a playlist
      // or an artist is what people expect.
      player.shuffleMode = attempt.grouping == .title ? .off : .songs
      player.play()

      return [
        "ok": true,
        "title": player.nowPlayingItem?.title ?? items[0].title ?? wanted,
        "artist": player.nowPlayingItem?.artist ?? items[0].artist ?? "",
        "count": items.count,
      ]
    }

    return ["ok": false, "reason": "notFound"]
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

  // MARK: - Volume trigger

  private func startVolumeTrigger() {
    guard !volumeTriggerOn else { return }

    installVolumeView()

    let session = AVAudioSession.sharedInstance()
    volumeAnchor = min(max(session.outputVolume, Self.anchorFloor), Self.anchorCeiling)
    setSystemVolume(volumeAnchor)

    volumeObservation = session.observe(\.outputVolume, options: [.new]) {
      [weak self] _, change in
      guard let self, let value = change.newValue else { return }
      DispatchQueue.main.async { self.handleVolume(value) }
    }

    volumeTriggerOn = true
  }

  private func stopVolumeTrigger() {
    volumeObservation?.invalidate()
    volumeObservation = nil
    volumeView?.removeFromSuperview()
    volumeView = nil
    volumeTriggerOn = false
  }

  /**
   * Only a fall counts as a press.
   *
   * A rise is the user deliberately turning the volume up — on this hardware
   * the ring cannot send one — so it is followed rather than fought, which
   * leaves the phone's volume-up button working normally. The cost is that
   * volume-down belongs to Grove for as long as this is switched on.
   */
  private func handleVolume(_ value: Float) {
    guard volumeTriggerOn, Date() >= ignoreVolumeUntil else { return }

    if value < volumeAnchor - 0.005 {
      sendEvent(
        "onRemoteCommand",
        ["command": "volume-down", "at": Date().timeIntervalSince1970])
      restoreVolume()
    } else if value > volumeAnchor + 0.005 {
      volumeAnchor = min(max(value, Self.anchorFloor), Self.anchorCeiling)
    }
  }

  /**
   * Put the level back so the next press has somewhere to fall to.
   *
   * Deferred rather than immediate: setting the volume inside the observation
   * that the volume changed is a good way to fight the system's own animation
   * and lose.
   */
  private func restoreVolume() {
    ignoreVolumeUntil = Date().addingTimeInterval(0.6)
    let target = volumeAnchor
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
      self?.setSystemVolume(target)
    }
  }

  private func setSystemVolume(_ value: Float) {
    guard let slider = volumeView?.subviews.compactMap({ $0 as? UISlider }).first else { return }
    slider.value = value
    slider.sendActions(for: .valueChanged)
  }

  private func installVolumeView() {
    guard volumeView == nil, let window = Self.hostWindow() else { return }
    // Offscreen rather than hidden: a view with `isHidden` set does not
    // suppress the volume HUD, and an unattached one cannot set the volume.
    let view = MPVolumeView(frame: CGRect(x: -3000, y: -3000, width: 1, height: 1))
    view.alpha = 0.001
    view.isUserInteractionEnabled = false
    window.addSubview(view)
    volumeView = view
  }

  private static func hostWindow() -> UIWindow? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  // MARK: - System notifications

  private func observeSystem() {
    let centre = NotificationCenter.default
    // These are block-based observers, so the thing to remove is the token
    // addObserver returns — NOT `self`, which was never registered as an
    // observer and so matched nothing. activate() runs on every foreground and
    // after every interruption, so each call used to leave another live pair
    // behind: one route change then fired N events, and one interruption ran N
    // handlers that each re-configured the session and re-notified JS, which
    // called activate() again.
    stopObserving()

    observers.append(centre.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.sendEvent("onRouteChange", self.describeRoute())
    })

    // A phone call takes the session away and does not give it back. Telling
    // JS lets it re-activate on the far side rather than silently going deaf.
    observers.append(centre.addObserver(
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
    })
  }

  /// Drops every notification observer this module registered.
  private func stopObserving() {
    let centre = NotificationCenter.default
    for token in observers { centre.removeObserver(token) }
    observers.removeAll()
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
