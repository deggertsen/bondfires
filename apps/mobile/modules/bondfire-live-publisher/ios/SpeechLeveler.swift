import Darwin

/// Bounded mono PCM16 gain before AAC. Keep in parity with SpeechLeveler.kt.
/// This is capture level control, not whole-program LUFS normalization.
/// The owner serializes access and retains state across buffers and segments.
final class SpeechLeveler {
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
      let target = rms >= 0.001778 ? min(31.6228, max(1.0, 0.125893 / rms)) : 1.0
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
