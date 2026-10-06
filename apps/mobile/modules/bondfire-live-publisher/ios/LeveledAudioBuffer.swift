import AVFoundation

/// Recorder-owned PCM copy: never amplify the mixer's reusable/shared buffer.
/// Conversion changes only channel/sample representation, never the sample rate
/// or frame count. This also handles Float32/stereo microphone mixer output.
final class LeveledAudioBuffer {
  private let lock = NSLock()
  private let leveler = SpeechLeveler()
  private var converter: AVAudioConverter?

  func copyAndProcess(_ source: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
    lock.lock()
    defer { lock.unlock() }
    guard source.frameLength > 0,
      let format = AVAudioFormat(commonFormat: .pcmFormatInt16,
        sampleRate: source.format.sampleRate, channels: 1, interleaved: false),
      let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: source.frameLength)
    else { throw conversionError() }
    if converter?.inputFormat != source.format {
      converter = AVAudioConverter(from: source.format, to: format)
      converter?.downmix = true
    }
    guard let converter else { throw conversionError() }
    // The non-resampling conversion API consumes exactly this buffer. Do not
    // retain source after the callback or introduce priming/preroll samples.
    try converter.convert(to: output, from: source)
    guard output.frameLength == source.frameLength, let samples = output.int16ChannelData else {
      throw conversionError()
    }
    leveler.process(UnsafeMutableBufferPointer(start: samples[0], count: Int(output.frameLength)),
      sampleRate: Int(format.sampleRate))
    return output
  }

  private func conversionError() -> NSError {
    NSError(domain: "SegmentedRecorder", code: 5,
      userInfo: [NSLocalizedDescriptionKey: "Could not prepare recording audio"])
  }
}
