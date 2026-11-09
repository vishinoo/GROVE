/*
  A human voice, streamed.

  AVSpeechSynthesizer cannot produce anything that sounds like a person to a
  third-party app: Siri's voice is not offered, and the enhanced voices are
  still a synthesiser. A neural voice was ruled out once for latency, because
  a whole sentence came back after three or four seconds, which is a pause
  nobody leaves in a conversation. Streamed, the first sound arrives in under
  a second (measured: 0.8s for a seven-second line), and the rest arrives
  faster than it plays.

  So the reply is sent to Gemini's speech model with the person's own key,
  the audio arrives as server-sent events of raw 24 kHz PCM, and each piece is
  scheduled on a player node the moment it lands. Speech starts before the
  sentence has finished arriving.

  It plays on the session grove-remote already holds and configures, through
  its own small engine, and touches no category, for the same reason listen.ts
  matches configureSession field for field: a second piece of code
  reconfiguring the shared session is how music got killed before.

  Anything that goes wrong before the first sound reports "error" and the JS
  side says the line with the system voice instead, so a dropped connection
  costs a worse voice, never silence.
*/

import AVFoundation
import Foundation

final class NaturalVoice {
  enum State: String { case start, end, error }

  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
  private var task: Task<Void, Never>?
  private var generation = 0
  private var wired = false

  /** Every state change, for the JS side: start when sound begins, end when it has all played. */
  var onState: ((State, String) -> Void)?

  private func wire() throws {
    if !wired {
      engine.attach(node)
      engine.connect(node, to: engine.mainMixerNode, format: format)
      wired = true
    }
    if !engine.isRunning {
      engine.prepare()
      try engine.start()
    }
  }

  func speak(text: String, key: String, model: String, voice: String, style: String) {
    stop()
    generation += 1
    let mine = generation
    task = Task { [weak self] in
      await self?.run(text: text, key: key, model: model, voice: voice, style: style, mine: mine)
    }
  }

  func stop() {
    generation += 1
    task?.cancel()
    task = nil
    quiet()
  }

  /*
    The engine goes as soon as the voice does. A running output graph in the
    background is what stops the recogniser's engine from starting (CoreAudio's
    'what', the same thing setKeepAlive pauses the silence for), and every
    reply now ends in a listening window.
  */
  private func quiet() {
    node.stop()
    if engine.isRunning { engine.stop() }
  }

  private func say(_ state: State, _ message: String = "", mine: Int) {
    DispatchQueue.main.async { [weak self] in
      guard let self, mine == self.generation else { return }
      if state != .start { self.quiet() }
      self.onState?(state, message)
    }
  }

  private func run(text: String, key: String, model: String, voice: String, style: String, mine: Int) async {
    guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):streamGenerateContent?alt=sse") else {
      say(.error, "bad model", mine: mine); return
    }
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
    // The style rides as an instruction in front of the words, which is how this
    // model takes direction; the words themselves are said exactly.
    let prompt = style.isEmpty ? text : "\(style): \(text)"
    let body: [String: Any] = [
      "contents": [["parts": [["text": prompt]]]],
      "generationConfig": [
        "responseModalities": ["AUDIO"],
        "speechConfig": ["voiceConfig": ["prebuiltVoiceConfig": ["voiceName": voice]]],
      ],
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)

    var started = false
    var pending = 0
    var finished = false
    let lock = NSLock()
    let endIfDone = { [weak self] in
      lock.lock(); let done = finished && pending == 0; lock.unlock()
      if done { self?.say(.end, mine: mine) }
    }

    do {
      try await MainActor.run { try self.wire() }
      let (bytes, response) = try await URLSession.shared.bytes(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        say(.error, "status \((response as? HTTPURLResponse)?.statusCode ?? 0)", mine: mine); return
      }
      for try await line in bytes.lines {
        if Task.isCancelled || mine != generation { return }
        guard line.hasPrefix("data:"),
              let data = line.dropFirst(5).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let parts = ((obj["candidates"] as? [[String: Any]])?.first?["content"] as? [String: Any])?["parts"] as? [[String: Any]]
        else { continue }
        for part in parts {
          guard let inline = part["inlineData"] as? [String: Any], let b64 = inline["data"] as? String,
                let pcm = Data(base64Encoded: b64), let buffer = floats(pcm) else { continue }
          lock.lock(); pending += 1; lock.unlock()
          node.scheduleBuffer(buffer) {
            lock.lock(); pending -= 1; lock.unlock()
            endIfDone()
          }
          if !started {
            started = true
            node.play()
            say(.start, mine: mine)
          }
        }
      }
      if !started { say(.error, "no audio", mine: mine); return }
      lock.lock(); finished = true; lock.unlock()
      endIfDone()
    } catch {
      if Task.isCancelled || mine != generation { return }
      // After the first sound a failure is the end of what could be said; before
      // it, the JS side says the line another way.
      say(started ? .end : .error, error.localizedDescription, mine: mine)
    }
  }

  /** 16-bit little-endian PCM to the player's float format. */
  private func floats(_ pcm: Data) -> AVAudioPCMBuffer? {
    let count = pcm.count / 2
    guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
          let out = buffer.floatChannelData?[0] else { return nil }
    pcm.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      for i in 0..<count { out[i] = Float(Int16(littleEndian: samples[i])) / 32768 }
    }
    buffer.frameLength = AVAudioFrameCount(count)
    return buffer
  }
}
