import Darwin

/// Bounded mono PCM16 gain before AAC. Keep in parity with SpeechLeveler.kt.
/// This is capture level control, not whole-program LUFS normalization.
/// The owner serializes access and retains state across buffers and segments.
final class SpeechLeveler {
  // Same policy as packages/media/src/loudness.ts. The warning threshold is
  // derived from the actual DSP constants, with 2 dB below the rescue floor.
  static let targetRms = 0.125893
  static let maxGain = 31.6228
  static let lowThresholdDb = 20 * log10(targetRms / maxGain) - 2
  private var inputPower: Double?
  private(set) var sampleCount = 0
  var micLevelDb: Double? { inputPower.map { 10 * log10(max($0, 1e-12)) } }
  var appliedGainDb: Double { 20 * log10(gain * limiter) }

  private var gain = 1.0
  private var limiter = 1.0

  func process(_ samples: UnsafeMutableBufferPointer<Int16>, sampleRate: Int) {
    precondition(sampleRate > 0)
    let rise = 1 - exp(-1.0 / (Double(sampleRate) * 0.35))
    let fall = 1 - exp(-1.0 / (Double(sampleRate) * 0.04))
    let release = 1 - exp(-1.0 / (Double(sampleRate) * 0.15))
    let blockSize = max(1, sampleRate / 100)
    var offset = 0
    while offset < samples.count {
      let end = min(offset + blockSize, samples.count)
      var power = 0.0
      var peak = 0.0
      for index in offset..<end {
        let value = Double(samples[index]) / 32768.0
        power += value * value
        peak = max(peak, abs(value))
      }
      let rms = sqrt(power / Double(end - offset))
      // One-second exponential power average, measured before modifying PCM.
      let blockPower = power / Double(end - offset)
      let weight = 1 - exp(-Double(end - offset) / Double(sampleRate))
      inputPower = inputPower.map { $0 + (blockPower - $0) * weight } ?? blockPower
      sampleCount += end - offset
      let target = rms >= 0.001778 ? min(Self.maxGain, max(1.0, Self.targetRms / rms)) : 1.0
      let peakGain = peak > 0 ? 0.944061 / peak : Double.infinity
      for index in offset..<end {
        gain += (target - gain) * (target > gain ? rise : fall)
        let limitTarget = min(1.0, peakGain / gain)
        limiter = limitTarget < limiter ? limitTarget : limiter + (limitTarget - limiter) * release
        let value = Double(samples[index]) * gain * limiter
        samples[index] = Int16(max(-32768, min(32767, Int(value))))
      }
      offset = end
    }
  }
}
