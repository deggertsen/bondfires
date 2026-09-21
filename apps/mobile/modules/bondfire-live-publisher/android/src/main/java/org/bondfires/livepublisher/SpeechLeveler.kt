package org.bondfires.livepublisher

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sqrt

/** Bounded mono PCM16 gain before AAC, independent of vendor AGC availability.
 *
 * Quiet speech approaches -22 dBFS RMS with at most 30 dB of gain. Healthy
 * input stays at unity. Below -55 dBFS we release toward unity rather than
 * chasing the noise floor. A fast peak limiter reserves 1 dB of headroom.
 * State spans buffers/segments, including preview, and resets per capture.
 * This is capture level control, not whole-program LUFS normalization.
 */
internal class SpeechLeveler(private val sampleRate: Int) {
  private var gain = 1.0
  private var limiter = 1.0
  private val rise = 1 - exp(-1.0 / (sampleRate * 0.35))
  private val fall = 1 - exp(-1.0 / (sampleRate * 0.04))
  private val release = 1 - exp(-1.0 / (sampleRate * 0.15))

  init { require(sampleRate > 0) }

  fun process(buffer: ByteBuffer) {
    // Absolute reads/writes preserve the pool buffer's position and limit.
    val pcm = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    require(pcm.remaining() % 2 == 0) { "Expected PCM16 samples" }
    var offset = pcm.position()
    val blockBytes = maxOf(1, sampleRate / 100) * 2
    while (offset < pcm.limit()) {
      val end = min(offset + blockBytes, pcm.limit())
      var power = 0.0
      var peak = 0.0
      var index = offset
      while (index < end) {
        val value = pcm.getShort(index) / 32768.0
        power += value * value
        peak = maxOf(peak, abs(value))
        index += 2
      }
      val rms = sqrt(power / ((end - offset) / 2))
      val target = if (rms >= 0.001778) (0.079433 / rms).coerceIn(1.0, 31.6228) else 1.0
      // Use the whole 10 ms block's peak for immediate protection, so a
      // sudden loud word after quiet speech cannot hit the PCM rails.
      val peakGain = if (peak > 0) 0.891251 / peak else Double.POSITIVE_INFINITY
      index = offset
      while (index < end) {
        gain += (target - gain) * if (target > gain) rise else fall
        val limitTarget = min(1.0, peakGain / gain)
        limiter = if (limitTarget < limiter) limitTarget else limiter + (limitTarget - limiter) * release
        val value = pcm.getShort(index) * gain * limiter
        pcm.putShort(index, value.toInt().coerceIn(-32768, 32767).toShort())
        index += 2
      }
      offset = end
    }
  }
}
