import AVFoundation

@main
struct LeveledAudioBufferTests {
  static func main() throws {
    // Exercise the actual pre-encode copy/conversion on Apple's audio framework.
    for commonFormat in [AVAudioCommonFormat.pcmFormatInt16, .pcmFormatFloat32] {
      for channels: AVAudioChannelCount in [1, 2] {
        let format = AVAudioFormat(commonFormat: commonFormat, sampleRate: 48000,
          channels: channels, interleaved: false)!
        let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
        source.frameLength = 960
        for channel in 0..<Int(channels) {
          for frame in 0..<1024 {
            if let data = source.int16ChannelData { data[channel][frame] = 1000 }
            if let data = source.floatChannelData { data[channel][frame] = 1000.0 / 32768 }
          }
        }
        let pipeline = LeveledAudioBuffer()
        let output = try pipeline.copyAndProcess(source)
        precondition(output.frameLength == 960 && source.frameLength == 960)
        precondition(output.format.channelCount == 1 && output.format.commonFormat == .pcmFormatInt16)
        precondition(output.format.sampleRate == source.format.sampleRate)
        for channel in 0..<Int(channels) {
          if let data = source.int16ChannelData { precondition(data[channel][0] == 1000 && data[channel][960] == 1000) }
          if let data = source.floatChannelData { precondition(data[channel][0] == 1000.0 / 32768 && data[channel][960] == 1000.0 / 32768) }
        }
        precondition(output.int16ChannelData![0][959] > 1000, "Pre-encode gain")
      }
    }
    print("PASS: PCM16/Float32 mono/stereo copy/conversion, frame count and sample rate")
  }
}
