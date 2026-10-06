import Darwin

@main
struct SpeechLevelerTests {
  static func tone(_ db: Double, rate: Int, seconds: Double = 0.02) -> [Int16] {
    let amplitude = 32767 * pow(10, db / 20) * sqrt(2.0)
    return (0..<Int(Double(rate) * seconds)).map {
      Int16(amplitude * sin(2 * .pi * 1000 * Double($0) / Double(rate)))
    }
  }
  static func rms(_ samples: [Int16]) -> Double {
    20 * log10(sqrt(samples.reduce(0.0) { $0 + pow(Double($1) / 32768.0, 2) } / Double(samples.count)))
  }
  static func main() throws {
    for rate in [44100, 48000] {
      let leveler = SpeechLeveler()
      var quiet = [Int16]()
      for _ in 0..<150 {
        quiet = tone(-48, rate: rate)
        quiet.withUnsafeMutableBufferPointer { leveler.process($0, sampleRate: rate) }
      }
      precondition(abs(rms(quiet) + 18) < 1, "Quiet speech target")
      for _ in 0..<30 {
        var loud = tone(-5, rate: rate)
        loud.withUnsafeMutableBufferPointer { leveler.process($0, sampleRate: rate) }
        precondition(loud.allSatisfy { abs(Int($0)) <= 30935 }, "Sudden peak limiter")
      }
      let bounded = SpeechLeveler()
      for _ in 0..<150 {
        quiet = tone(-54, rate: rate)
        quiet.withUnsafeMutableBufferPointer { bounded.process($0, sampleRate: rate) }
      }
      precondition(rms(quiet) <= -23.5, "30 dB gain bound")
      for db in [-65.0, -16.0] {
        let unity = SpeechLeveler()
        for _ in 0..<200 {
          var input = tone(db, rate: rate)
          let original = input
          input.withUnsafeMutableBufferPointer { unity.process($0, sampleRate: rate) }
          precondition(input == original, "Noise gate / healthy input")
        }
      }
      var samples = [Int16](repeating: 1000, count: 1024)
      samples.withUnsafeMutableBufferPointer {
        bounded.process(UnsafeMutableBufferPointer(rebasing: $0[6..<1000]), sampleRate: rate)
      }
      precondition(samples[0] == 1000 && samples[1000] == 1000 && samples[6] > 1000, "Active buffer range")
      var silence = [Int16](repeating: 0, count: rate)
      silence.withUnsafeMutableBufferPointer { bounded.process($0, sampleRate: rate) }
      precondition(silence.allSatisfy { $0 == 0 }, "Silence")
      // Buffer/segment boundaries do not reset gain or limiter state.
      var whole = tone(-40, rate: rate, seconds: 1)
      var split = whole
      let continuous = SpeechLeveler()
      let segmented = SpeechLeveler()
      whole.withUnsafeMutableBufferPointer { continuous.process($0, sampleRate: rate) }
      split.withUnsafeMutableBufferPointer { samples in
        let boundary = (rate / 100) * 20
        segmented.process(UnsafeMutableBufferPointer(rebasing: samples[..<boundary]), sampleRate: rate)
        segmented.process(UnsafeMutableBufferPointer(rebasing: samples[boundary...]), sampleRate: rate)
      }
      precondition(whole == split, "State spans buffers/segments")
    }
    print("PASS: Swift leveler (44.1/48 kHz), limiter, gate, bounds, state continuity")
  }
}
