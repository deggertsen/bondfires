package org.bondfires.livepublisher

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.*
import org.junit.Assert.*
import org.junit.Test

class SpeechLevelerTest {
  private val rate = 44100
  private fun tone(db: Double, seconds: Double = 0.02): ByteBuffer {
    val buffer = ByteBuffer.allocate((rate * seconds).toInt() * 2).order(ByteOrder.LITTLE_ENDIAN)
    val amplitude = 32767 * 10.0.pow(db / 20) * sqrt(2.0)
    repeat(buffer.capacity() / 2) { i -> buffer.putShort((amplitude * sin(2 * PI * 1000 * i / rate)).toInt().toShort()) }
    return buffer.flip() as ByteBuffer
  }
  private fun rms(buffer: ByteBuffer): Double {
    var sum = 0.0
    for (i in buffer.position() until buffer.limit() step 2) sum += (buffer.getShort(i) / 32768.0).pow(2)
    return 20 * log10(sqrt(sum / (buffer.remaining() / 2)))
  }

  @Test fun quietSpeechReachesTargetWithoutChangingBufferBounds() {
    val leveler = SpeechLeveler(rate)
    var last = tone(-48.0)
    repeat(150) { last = tone(-48.0); leveler.process(last) }
    assertEquals(-22.0, rms(last), 1.0)
    assertEquals(0, last.position())
    assertEquals(last.capacity(), last.limit())
  }

  @Test fun healthyHeadsetLevelsRemainUnchanged() {
    val leveler = SpeechLeveler(rate)
    repeat(100) {
      val buffer = tone(-20.0)
      val original = buffer.array().clone()
      leveler.process(buffer)
      assertArrayEquals(original, buffer.array())
    }
  }

  @Test fun silenceAndLowNoiseDoNotBuildGain() {
    val leveler = SpeechLeveler(rate)
    repeat(200) {
      val noiseFloor = tone(-65.0)
      val original = noiseFloor.array().clone()
      leveler.process(noiseFloor)
      assertArrayEquals(original, noiseFloor.array())
    }
    val silence = ByteBuffer.allocate(2048)
    leveler.process(silence)
    assertArrayEquals(ByteArray(2048), silence.array())
  }

  @Test fun gainIsBoundedAndSuddenLoudInputDoesNotClip() {
    val leveler = SpeechLeveler(rate)
    var last = tone(-54.0)
    repeat(150) { last = tone(-54.0); leveler.process(last) }
    assertTrue(rms(last) <= -23.5) // 30 dB maximum lift.
    repeat(30) {
      val loud = tone(-5.0)
      leveler.process(loud)
      for (i in 0 until loud.limit() step 2) assertTrue(abs(loud.getShort(i).toInt()) <= 29205)
    }
  }

  @Test fun onlyActiveBufferRangeIsModified() {
    val leveler = SpeechLeveler(rate)
    repeat(100) { leveler.process(tone(-40.0)) }
    val buffer = ByteBuffer.allocateDirect(2048).order(ByteOrder.LITTLE_ENDIAN)
    repeat(1024) { buffer.putShort(1000) }
    buffer.position(12); buffer.limit(2000)
    leveler.process(buffer)
    assertEquals(12, buffer.position()); assertEquals(2000, buffer.limit())
    buffer.clear()
    assertEquals(1000, buffer.getShort(0).toInt())
    assertEquals(1000, buffer.getShort(2000).toInt())
    assertTrue(buffer.getShort(12) > 1000)
  }
}
