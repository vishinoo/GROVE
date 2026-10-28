/*
  Listening for what to do with the highlighted text.

  On-device speech where the Mac has it, so an instruction about someone's
  private writing does not have to leave the laptop. It ends itself: a second
  and a half after the words stop, or eight seconds in, whichever is first —
  and if nothing was said the panel simply offers the choices instead.
*/

import AVFoundation
import Speech

final class Voice {
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var quiet: Timer?
  private var cap: Timer?
  private var finished: ((String?) -> Void)?
  private var latest = ""

  func listen(partial: @escaping (String) -> Void, done: @escaping (String?) -> Void) {
    stop()
    finished = done
    latest = ""
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async {
        guard status == .authorized else { self.end(); return }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
          DispatchQueue.main.async { granted ? self.start(partial) : self.end() }
        }
      }
    }
  }

  private func start(_ partial: @escaping (String) -> Void) {
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { end(); return }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    self.request = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    engine.prepare()
    do { try engine.start() } catch { end(); return }

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self else { return }
      DispatchQueue.main.async {
        if let result {
          self.latest = result.bestTranscription.formattedString
          partial(self.latest)
          self.quiet?.invalidate()
          self.quiet = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { _ in self.end() }
          if result.isFinal { self.end() }
        } else if error != nil {
          self.end()
        }
      }
    }
    cap = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in self?.end() }
  }

  private func end() {
    let said = latest.trimmingCharacters(in: .whitespacesAndNewlines)
    let callback = finished
    finished = nil
    stop()
    callback?(said.isEmpty ? nil : said)
  }

  func stop() {
    quiet?.invalidate(); quiet = nil
    cap?.invalidate(); cap = nil
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio(); request = nil
    task?.cancel(); task = nil
  }
}
